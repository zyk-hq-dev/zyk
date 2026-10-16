import { resolveConfig } from "../../src/playbooks/config.js";
import type { PlaybookManifest } from "../../src/playbooks/types.js";
import { TrackedRun, type StepOutcome, type TaskSpec } from "../../src/engine/run.js";

type Answer = Record<string, unknown> | StepOutcome;

/**
 * Runs playbook code without Hatchet: each step's result comes from a per-step queue.
 * Records every task spec, wait, and the path taken.
 */
export class ScriptedRun extends TrackedRun {
  readonly tasks: TaskSpec[] = [];
  readonly waits: { stepKey: string; seconds: number }[] = [];
  readonly path: string[] = [];
  readonly entries: { seq: number; stepKey: string; event: string }[] = [];
  outcome?: { stepKey: string; outcome: string };

  private readonly queues: Map<string, Answer[]>;

  constructor(
    manifest: PlaybookManifest,
    answers: Record<string, Answer[]>,
    opts: { overlay?: Record<string, unknown>; input?: Record<string, unknown>; externalKey?: string } = {}
  ) {
    const { config, problems } = resolveConfig(manifest, opts.overlay);
    if (problems.length) throw new Error(problems.join("; "));
    super({
      instanceId: "00000000-0000-4000-8000-000000000001",
      externalKey: opts.externalKey ?? "<msg-1@example.com>",
      manifest,
      config,
      input: opts.input ?? {},
    });
    this.queues = new Map(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  }

  protected async runTask(spec: TaskSpec): Promise<StepOutcome> {
    this.tasks.push(spec);
    this.path.push(spec.stepKey);
    const answer = this.queues.get(spec.stepKey)?.shift();
    if (answer === undefined) throw new Error(`No scripted answer left for ${spec.stepKey} (iteration ${spec.iteration})`);
    return "status" in answer && typeof answer.status === "string" && ["completed", "failed", "cancelled"].includes(answer.status)
      ? (answer as StepOutcome)
      : { status: "completed", result: answer as Record<string, unknown> };
  }

  protected async sleep(seconds: number, stepKey: string): Promise<void> {
    this.waits.push({ stepKey, seconds });
    this.path.push(stepKey);
  }

  protected async onEnter(seq: number, stepKey: string, event: string): Promise<void> {
    this.entries.push({ seq, stepKey, event });
  }

  protected async onEnd(stepKey: string, outcome: string): Promise<void> {
    this.path.push(stepKey);
    this.outcome = { stepKey, outcome };
  }

  specs(stepKey: string): TaskSpec[] {
    return this.tasks.filter((t) => t.stepKey === stepKey);
  }
}
