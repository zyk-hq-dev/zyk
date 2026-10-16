/**
 * The API playbook code is written against, and the runtime checks that keep it honest.
 *
 * Playbook code (e.g. src/playbooks/incident-triage/workflow.ts) only calls PlaybookRun. The
 * base class TrackedRun enforces the manifest on every call, so code and manifest cannot drift:
 *   - every transition must be a declared edge (the first step must be `start`);
 *   - an irreversible step must directly follow its approval step with an allowed decision;
 *   - task specs (instructions, schema, tools, idempotency key) come from the manifest only.
 * HatchetRun (hatchet.ts) runs steps as durable child runs; tests use a scripted subclass.
 */

import { parseDuration, renderInstructions, renderTemplate } from "../playbooks/config.js";
import type { Config, PlaybookManifest, Step, TaskStep } from "../playbooks/types.js";

export interface TaskSpec {
  stepKey: string;
  iteration: number;
  kind: "system" | "user";
  topic: string;
  instructions: string;
  input: Record<string, unknown>;
  untrustedContent?: unknown;
  resultSchema: Record<string, unknown>;
  allowedTools: string[];
  idempotencyKey?: string;
  maxAttempts: number;
  timeoutSeconds: number;
}

export type StepOutcome =
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "failed"; error: Record<string, unknown> | null }
  | { status: "cancelled"; error: Record<string, unknown> | null };

export interface UserDecision {
  decision: string;
  comment?: string;
}

export interface TaskOptions {
  /** Structured data for the task. Never put external text here — use `untrusted`. */
  input?: Record<string, unknown>;
  /** External text (mail bodies, comments). Delivered as untrusted_content. */
  untrusted?: unknown;
}

export interface PlaybookRun {
  readonly instanceId: string;
  readonly manifest: PlaybookManifest;
  readonly config: Config;
  /** Instance input without the fields listed in `untrusted_input`. */
  readonly trustedInput: Record<string, unknown>;
  /** Only the instance input fields listed in `untrusted_input`. */
  readonly untrustedInput: Record<string, unknown>;
  systemTask(stepKey: string, opts?: TaskOptions): Promise<Record<string, unknown>>;
  userTask(stepKey: string, opts?: TaskOptions): Promise<UserDecision>;
  /** Waits for the duration in extension point `durationKey` (must be listed by the wait step). */
  wait(stepKey: string, durationKey: string): Promise<void>;
  end(stepKey: string): Promise<void>;
}

/** A step did not complete (failed after retries, timed out, or was cancelled). */
export class StepFailedError extends Error {
  constructor(
    readonly stepKey: string,
    readonly outcome: StepOutcome
  ) {
    const reason = outcome.status === "completed" ? "unknown" : String(outcome.error?.message ?? outcome.status);
    super(`Step ${stepKey} ${outcome.status}: ${reason}`);
    this.name = "StepFailedError";
  }
}

/** Playbook code broke a manifest rule. Always a bug in the code, never retried into success. */
export class PlaybookViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybookViolationError";
  }
}

/** Time scale for tests (ZYK_TIME_SCALE=0.001 turns 4h into ~14s). 1 in production. */
export function timeScale(): number {
  const v = parseFloat(process.env.ZYK_TIME_SCALE ?? "");
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function scaledSeconds(duration: string): number {
  const secs = parseDuration(duration);
  if (secs === null) throw new Error(`Invalid duration ${duration}`);
  return Math.max(1, Math.round(secs * timeScale()));
}

export interface RunContext {
  instanceId: string;
  externalKey: string | null;
  manifest: PlaybookManifest;
  config: Config;
  input: Record<string, unknown>;
}

export abstract class TrackedRun implements PlaybookRun {
  readonly instanceId: string;
  readonly manifest: PlaybookManifest;
  readonly config: Config;
  readonly trustedInput: Record<string, unknown>;
  readonly untrustedInput: Record<string, unknown>;

  private readonly externalKey: string | null;
  private previous: { stepKey: string; decision?: string } | null = null;
  private readonly iterations = new Map<string, number>();
  private seq = 0;
  private ended = false;

  get hasEnded(): boolean {
    return this.ended;
  }

  constructor(ctx: RunContext) {
    this.instanceId = ctx.instanceId;
    this.externalKey = ctx.externalKey;
    this.manifest = ctx.manifest;
    this.config = ctx.config;
    const untrustedFields = new Set(ctx.manifest.untrusted_input ?? []);
    this.trustedInput = Object.fromEntries(Object.entries(ctx.input).filter(([k]) => !untrustedFields.has(k)));
    this.untrustedInput = Object.fromEntries(Object.entries(ctx.input).filter(([k]) => untrustedFields.has(k)));
  }

  // ── Implemented by the runtime ──────────────────────────────────────────────

  protected abstract runTask(spec: TaskSpec): Promise<StepOutcome>;
  protected abstract sleep(seconds: number, stepKey: string, iteration: number): Promise<void>;
  /** Persist progress; called once per step entry with a strictly increasing seq. */
  protected abstract onEnter(seq: number, stepKey: string, event: string, data: Record<string, unknown>): Promise<void>;
  protected abstract onEnd(stepKey: string, outcome: string): Promise<void>;

  // ── PlaybookRun ─────────────────────────────────────────────────────────────

  async systemTask(stepKey: string, opts: TaskOptions = {}): Promise<Record<string, unknown>> {
    const outcome = await this.task(stepKey, "system", opts);
    this.previous = { stepKey };
    return outcome;
  }

  async userTask(stepKey: string, opts: TaskOptions = {}): Promise<UserDecision> {
    const result = await this.task(stepKey, "user", opts);
    const decision = { decision: String(result.decision), ...(result.comment ? { comment: String(result.comment) } : {}) };
    this.previous = { stepKey, decision: decision.decision };
    return decision;
  }

  async wait(stepKey: string, durationKey: string): Promise<void> {
    const step = this.enter(stepKey, "wait");
    if (step.kind !== "wait" || !step.durations.includes(durationKey)) {
      throw new PlaybookViolationError(`Wait step ${stepKey} does not declare duration \`${durationKey}\``);
    }
    const iteration = this.nextIteration(stepKey);
    const duration = String(this.config[durationKey]);
    const seconds = scaledSeconds(duration);
    await this.onEnter(++this.seq, stepKey, "instance.waiting", { iteration, duration, duration_key: durationKey });
    await this.sleep(seconds, stepKey, iteration);
    this.previous = { stepKey };
  }

  async end(stepKey: string): Promise<void> {
    const step = this.enter(stepKey, "end");
    if (step.kind !== "end") throw new PlaybookViolationError(`${stepKey} is not an end step`);
    this.ended = true;
    await this.onEnd(stepKey, step.outcome);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async task(stepKey: string, kind: "system" | "user", opts: TaskOptions): Promise<Record<string, unknown>> {
    const step = this.enter(stepKey, kind) as TaskStep;
    this.checkApproval(stepKey, step);
    const iteration = this.nextIteration(stepKey);
    const spec = this.buildSpec(stepKey, step, iteration, opts);
    await this.onEnter(++this.seq, stepKey, "instance.step_started", { iteration, kind });
    const outcome = await this.runTask(spec);
    if (outcome.status !== "completed") throw new StepFailedError(stepKey, outcome);
    return outcome.result;
  }

  /** Checks that `stepKey` exists, has the expected kind, and is a declared transition. */
  private enter(stepKey: string, kind: Step["kind"]): Step {
    if (this.ended) throw new PlaybookViolationError(`Step ${stepKey} entered after the run ended`);
    const step = this.manifest.steps[stepKey];
    if (!step) throw new PlaybookViolationError(`Unknown step ${stepKey}`);
    if (step.kind !== kind) {
      throw new PlaybookViolationError(`Step ${stepKey} is a ${step.kind} step, not ${kind}`);
    }
    if (this.previous === null) {
      if (stepKey !== this.manifest.start) {
        throw new PlaybookViolationError(`The first step must be ${this.manifest.start}, not ${stepKey}`);
      }
    } else {
      const from = this.manifest.steps[this.previous.stepKey];
      const declared = from.kind !== "end" && (from.next ?? []).some((e) => e.to === stepKey);
      if (!declared) {
        throw new PlaybookViolationError(`Undeclared transition ${this.previous.stepKey} → ${stepKey}`);
      }
    }
    return step;
  }

  private checkApproval(stepKey: string, step: TaskStep): void {
    if (!step.requires_approval) return;
    const allowed = step.approval_decisions ?? [];
    const prev = this.previous;
    if (!prev || prev.stepKey !== step.requires_approval || !prev.decision || !allowed.includes(prev.decision)) {
      throw new PlaybookViolationError(
        `Step ${stepKey} requires approval ${step.requires_approval} with decision ` +
          `${allowed.join("/")} immediately before it` +
          (prev ? ` (previous: ${prev.stepKey}${prev.decision ? ` = ${prev.decision}` : ""})` : "")
      );
    }
  }

  private nextIteration(stepKey: string): number {
    const n = this.iterations.get(stepKey) ?? 0;
    this.iterations.set(stepKey, n + 1);
    return n;
  }

  private buildSpec(stepKey: string, step: TaskStep, iteration: number, opts: TaskOptions): TaskSpec {
    const input: Record<string, unknown> = { ...(opts.input ?? {}) };
    let idempotencyKey: string | undefined;
    if (step.idempotency_key) {
      idempotencyKey = renderTemplate(step.idempotency_key, {
        external_key: this.externalKey ?? this.instanceId,
        instance_id: this.instanceId,
        iteration,
      });
      // Embedded by the assistant in what it creates, and searched for before creating.
      input.marker = `zyk:${idempotencyKey}`;
    }
    return {
      stepKey,
      iteration,
      kind: step.kind,
      topic: step.topic,
      instructions: renderInstructions(step.instructions, this.config),
      input,
      untrustedContent: opts.untrusted,
      resultSchema: step.result_schema,
      allowedTools: step.allowed_tools ?? [],
      idempotencyKey,
      maxAttempts: step.max_attempts ?? 3,
      timeoutSeconds: scaledSeconds(step.timeout),
    };
  }
}

/** A playbook's code: one per playbook id and major version. */
export interface PlaybookDefinition {
  id: string;
  major: number;
  run(run: PlaybookRun): Promise<void>;
}
