/**
 * Hatchet engine. Registers one durable workflow per playbook major version (e.g.
 * `incident-triage-v1`) plus the shared `zyk-step` workflow, and runs the worker in-process.
 *
 *   playbook run (durable) ──spawnChild──► zyk-step (durable): create task → wait for
 *                                          Or(resolution event, timeout) → read DB → return
 *
 * Verified against engine v0.90.4: a replayed durable task gets the existing child run back
 * from spawnChild instead of spawning a new one, and executionTimeout includes waiting time.
 */

import {
  NonRetryableError,
  Or,
  SleepCondition,
  UserEventCondition,
  type DurableContext,
  type JsonObject,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { Pool } from "../db/pool.js";
import { getHatchetClient } from "../hatchet/client.js";
import { parseDuration } from "../playbooks/config.js";
import type { PlaybookCatalog } from "../playbooks/loader.js";
import { findDefinition, PLAYBOOK_DEFINITIONS, workflowName } from "../playbooks/registry.js";
import type { Config, PlaybookManifest } from "../playbooks/types.js";
import {
  cancelOpenTasks,
  createTask,
  getTask,
  isResolved,
  markConsumed,
  type TaskRow,
} from "../tasks/store.js";
import {
  claimRun,
  failInstance,
  finishInstance,
  loadInstance,
  recordStep,
  untriggeredInstances,
  type InstanceRow,
} from "./instances.js";
import { publishResolution, republishPending } from "./outbox.js";
import {
  PlaybookViolationError,
  StepFailedError,
  timeScale,
  TrackedRun,
  type StepOutcome,
  type TaskSpec,
} from "./run.js";

export const TASK_RESOLVED_EVENT = "zyk.task.resolved";

/** Upper bound for one instance's lifetime (Hatchet counts waiting time against it). */
const INSTANCE_TIMEOUT = "8760h";

interface StepInput {
  tenant_id: string;
  instance_id: string;
  spec: TaskSpec;
}

type StepOutput = StepOutcome;

interface InstanceInput {
  instance_id: string;
}

type AnyDurableContext = DurableContext<JsonObject>;

export interface Engine {
  /** Starts the Hatchet run for a newly created instance. */
  triggerInstance(instance: InstanceRow): Promise<void>;
  /** Wakes the step run waiting for this task; call after the resolving transaction commits. */
  notifyTaskResolved(taskId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface EngineDeps {
  pool: Pool;
  catalog: PlaybookCatalog;
}

// ── zyk-step ──────────────────────────────────────────────────────────────────

function outcomeOf(task: TaskRow): StepOutput {
  if (task.status === "completed") return { status: "completed", result: task.result ?? {} };
  if (task.status === "failed") return { status: "failed", error: task.error };
  return { status: "cancelled", error: task.error };
}

function firedKeys(waitResult: Record<string, unknown>): string[] {
  const created = (waitResult.CREATE ?? waitResult) as Record<string, unknown>;
  return Object.keys(created ?? {});
}

async function runStep(pool: Pool, input: StepInput, ctx: AnyDurableContext): Promise<StepOutput> {
  const { spec } = input;
  const { task } = await createTask(pool, {
    tenantId: input.tenant_id,
    instanceId: input.instance_id,
    stepKey: spec.stepKey,
    iteration: spec.iteration,
    kind: spec.kind,
    topic: spec.topic,
    instructions: spec.instructions,
    input: spec.input,
    untrustedContent: spec.untrustedContent,
    resultSchema: spec.resultSchema,
    allowedTools: spec.allowedTools,
    idempotencyKey: spec.idempotencyKey,
    maxAttempts: spec.maxAttempts,
  });

  let current = await getTask(pool, input.tenant_id, task.id);
  while (!isResolved(current)) {
    const fired = firedKeys(
      await ctx.waitFor(
        Or(
          new SleepCondition(`${spec.timeoutSeconds}s`, `timeout:${task.id}`),
          new UserEventCondition(TASK_RESOLVED_EVENT, `input.task_id == "${task.id}"`, `resolved:${task.id}`)
        )
      )
    );
    current = await getTask(pool, input.tenant_id, task.id);
    if (!isResolved(current) && fired.some((k) => k.startsWith("timeout:"))) {
      await cancelOpenTasks(pool, { taskId: task.id }, `Timed out: no result within ${spec.timeoutSeconds}s`);
      current = await getTask(pool, input.tenant_id, task.id);
    }
  }
  await markConsumed(pool, task.id);
  return outcomeOf(current);
}

// ── Playbook runs ─────────────────────────────────────────────────────────────

class HatchetRun extends TrackedRun {
  constructor(
    private readonly pool: Pool,
    private readonly instance: InstanceRow,
    manifest: PlaybookManifest,
    private readonly ctx: AnyDurableContext,
    private readonly stepWorkflow: Parameters<AnyDurableContext["spawnChild"]>[0]
  ) {
    super({
      instanceId: instance.id,
      externalKey: instance.external_key,
      manifest,
      config: instance.effective_config as Config,
      input: instance.input,
    });
  }

  protected async runTask(spec: TaskSpec): Promise<StepOutcome> {
    const input: StepInput = { tenant_id: this.instance.tenant_id, instance_id: this.instance.id, spec };
    return (await this.ctx.spawnChild(this.stepWorkflow, input as unknown as JsonObject, {
      key: `${spec.stepKey}:${spec.iteration}`,
      additionalMetadata: { zyk_instance: this.instance.id, zyk_step: spec.stepKey },
    })) as unknown as StepOutcome;
  }

  protected async sleep(seconds: number, stepKey: string, iteration: number): Promise<void> {
    await this.ctx.sleepFor(`${seconds}s`, `wait:${stepKey}:${iteration}`);
  }

  protected async onEnter(seq: number, stepKey: string, event: string, data: Record<string, unknown>) {
    await recordStep(this.pool, this.instance, seq, stepKey, event, data);
  }

  protected async onEnd(stepKey: string, outcome: string) {
    await finishInstance(this.pool, this.instance, stepKey, outcome);
  }
}

async function loadPinnedManifest(pool: Pool, instance: InstanceRow): Promise<PlaybookManifest> {
  const { rows } = await pool.query<{ manifest: PlaybookManifest }>(
    "SELECT manifest FROM playbook_versions WHERE playbook_id = $1 AND version = $2",
    [instance.playbook_id, instance.playbook_version]
  );
  if (rows.length === 0) throw new Error(`Playbook ${instance.playbook_id}@${instance.playbook_version} not registered`);
  return rows[0].manifest;
}

// ── Engine ────────────────────────────────────────────────────────────────────

/** Longest task timeout across all manifests, plus margin, as a Hatchet duration. */
function stepTimeout(catalog: PlaybookCatalog): string {
  let max = 3600;
  for (const manifest of catalog.list()) {
    for (const version of catalog.versions(manifest.id)) {
      for (const step of Object.values(catalog.get(manifest.id, version)!.steps)) {
        if (step.kind === "system" || step.kind === "user") max = Math.max(max, parseDuration(step.timeout) ?? 0);
      }
    }
  }
  return `${Math.ceil((max * timeScale() + 3600) / 3600)}h`;
}

export async function startHatchetEngine(deps: EngineDeps): Promise<Engine> {
  const { pool, catalog } = deps;
  const hatchet = getHatchetClient();
  if (timeScale() !== 1) console.error(`[engine] WARNING: ZYK_TIME_SCALE=${timeScale()} — durations are scaled`);

  const stepWorkflow = hatchet.durableTask({
    name: "zyk-step",
    executionTimeout: stepTimeout(catalog) as `${number}h`,
    retries: 3,
    fn: async (input: JsonObject, ctx: AnyDurableContext) =>
      (await runStep(pool, input as unknown as StepInput, ctx)) as unknown as JsonObject,
  });

  const playbookWorkflows = new Map<string, ReturnType<typeof hatchet.workflow<JsonObject>>>();
  for (const def of PLAYBOOK_DEFINITIONS) {
    const wf = hatchet.workflow<JsonObject>({ name: workflowName(def.id, def.major) });
    wf.durableTask({
      name: "run",
      executionTimeout: INSTANCE_TIMEOUT,
      retries: 3,
      fn: async (rawInput: JsonObject, ctx: AnyDurableContext) => {
        const input = rawInput as unknown as InstanceInput;
        const instance = await loadInstance(pool, input.instance_id);
        if (instance.status !== "running") return { skipped: "instance already ended" };
        if (!(await claimRun(pool, instance.id, ctx.workflowRunId()))) return { skipped: "duplicate run" };

        const definition = findDefinition(instance.playbook_id, instance.playbook_version);
        if (!definition) throw new Error(`No code for ${instance.playbook_id}@${instance.playbook_version}`);
        const manifest = await loadPinnedManifest(pool, instance);
        const run = new HatchetRun(pool, instance, manifest, ctx, stepWorkflow);
        try {
          await definition.run(run);
          if (!run.hasEnded) throw new PlaybookViolationError("Playbook code returned without reaching an end step");
          return { ended: true };
        } catch (err) {
          // Deterministic failures: fail the instance, and fail the Hatchet run without retries
          // so the Hatchet UI shows the same outcome.
          if (err instanceof StepFailedError) {
            await failInstance(pool, instance.id, {
              message: err.message,
              step_key: err.stepKey,
              code: `step_${err.outcome.status}`,
            });
            throw new NonRetryableError(err.message);
          }
          if (err instanceof PlaybookViolationError) {
            await failInstance(pool, instance.id, { message: err.message, code: "playbook_violation" });
            throw new NonRetryableError(err.message);
          }
          throw err; // infrastructure error: Hatchet retries, onFailure fails the instance at the end
        }
      },
    });
    wf.onFailure({
      name: "on-failure",
      fn: async (input: JsonObject) => {
        await failInstance(pool, String(input.instance_id), { message: "Workflow run failed after retries", code: "engine_error" });
        return {};
      },
    });
    playbookWorkflows.set(def.id, wf);
  }

  const worker = await hatchet.worker("zyk-engine", {
    workflows: [stepWorkflow, ...playbookWorkflows.values()],
    slots: 50,
    durableSlots: 1000,
  });
  worker.start().catch((err) => console.error("[engine] worker stopped:", err));

  const publish = async (taskId: string) => {
    await hatchet.events.push(TASK_RESOLVED_EVENT, { task_id: taskId });
  };

  const engine: Engine = {
    async triggerInstance(instance) {
      const wf = playbookWorkflows.get(instance.playbook_id);
      if (!wf) throw new Error(`No workflow for playbook ${instance.playbook_id}`);
      await wf.runNoWait(
        { instance_id: instance.id },
        { additionalMetadata: { zyk_instance: instance.id, zyk_tenant: instance.tenant_id } }
      );
    },
    async notifyTaskResolved(taskId) {
      await publishResolution(pool, publish, taskId);
    },
    async stop() {
      clearInterval(outboxTimer);
      clearInterval(triggerTimer);
      await worker.stop();
    },
  };

  // Outbox and trigger recovery. Safe on several replicas: duplicates are harmless.
  const outboxTimer = setInterval(() => {
    republishPending(pool, publish).catch((err) => console.error("[outbox] error:", err.message));
  }, 5_000);
  const triggerTimer = setInterval(async () => {
    try {
      for (const instance of await untriggeredInstances(pool)) await engine.triggerInstance(instance);
    } catch (err) {
      console.error("[engine] trigger recovery error:", (err as Error).message);
    }
  }, 60_000);
  outboxTimer.unref();
  triggerTimer.unref();

  return engine;
}
