/**
 * Task store — the external-task queue the assistant works from.
 *
 * Semantics (docs/v2-architecture.md §6):
 * - Claim: one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED). Row locks last only for
 *   that statement; concurrent workers never receive the same task.
 * - Fencing: complete / fail / extend are compare-and-set on (status='locked', lock_token).
 *   A stale token gets an actionable error explaining what happened.
 * - Idempotent resolution: repeating complete/fail with the token that resolved the task
 *   returns the stored outcome instead of an error (lost-response retries are safe).
 * - Every state change appends an audit entry in the same transaction.
 *
 * All timestamps come from the database clock.
 */

import { appendAudit, type Actor } from "../audit/log.js";
import { withTransaction, type Pool, type PoolClient } from "../db/pool.js";
import { ZykError } from "../errors.js";
import { validateAgainstSchema, assertValidSchema } from "./validate.js";

export type TaskKind = "system" | "user";
export type TaskStatus = "pending" | "locked" | "completed" | "failed" | "cancelled";
export type DecidedVia = "conversation" | "elicitation" | "ui";

export interface TaskRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  step_key: string;
  iteration: number;
  kind: TaskKind;
  topic: string;
  instructions: string;
  input: Record<string, unknown>;
  untrusted_content: unknown;
  untrusted_expires_at: Date | null;
  result_schema: Record<string, unknown>;
  allowed_tools: string[];
  idempotency_key: string | null;
  status: TaskStatus;
  lock_token: string | null;
  locked_by: string | null;
  lock_expires_at: Date | null;
  attempts: number;
  max_attempts: number;
  due_at: Date;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  decided_via: DecidedVia | null;
  resolved_by_token: string | null;
  event_published_at: Date | null;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const DEFAULT_UNTRUSTED_RETENTION_DAYS = 14;

function untrustedRetentionDays(): number {
  const v = parseInt(process.env.ZYK_UNTRUSTED_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_UNTRUSTED_RETENTION_DAYS;
}

/** Delay before a retryable failure is offered again: 30s, 60s, 120s, … capped at 1h. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface NewTask {
  tenantId: string;
  instanceId: string;
  stepKey: string;
  iteration?: number;
  kind: TaskKind;
  topic: string;
  instructions: string;
  input?: Record<string, unknown>;
  untrustedContent?: unknown;
  resultSchema: Record<string, unknown>;
  allowedTools?: string[];
  idempotencyKey?: string;
  maxAttempts?: number;
  dueAt?: Date;
}

/**
 * Creates the task for (instance, step, iteration), or returns the existing one. Safe to call
 * again when a durable Hatchet task replays.
 */
export async function createTask(
  pool: Pool,
  t: NewTask,
  actor: Actor = { type: "engine" }
): Promise<{ task: TaskRow; created: boolean }> {
  assertValidSchema(t.resultSchema);
  return withTransaction(pool, async (client) => {
    const hasUntrusted = t.untrustedContent !== undefined && t.untrustedContent !== null;
    const { rows } = await client.query<TaskRow>(
      `INSERT INTO tasks (tenant_id, instance_id, step_key, iteration, kind, topic, instructions,
                          input, untrusted_content, untrusted_expires_at, result_schema,
                          allowed_tools, idempotency_key, max_attempts, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $10::boolean THEN now() + make_interval(days => $11) END,
               $12, $13, $14, $15, COALESCE($16, now()))
       ON CONFLICT (instance_id, step_key, iteration) DO NOTHING
       RETURNING *`,
      [
        t.tenantId,
        t.instanceId,
        t.stepKey,
        t.iteration ?? 0,
        t.kind,
        t.topic,
        t.instructions,
        t.input ?? {},
        hasUntrusted ? JSON.stringify(t.untrustedContent) : null,
        hasUntrusted,
        untrustedRetentionDays(),
        t.resultSchema,
        t.allowedTools ?? [],
        t.idempotencyKey ?? null,
        t.maxAttempts ?? 3,
        t.dueAt ?? null,
      ]
    );
    if (rows.length > 0) {
      const task = rows[0];
      await appendAudit(client, {
        tenantId: task.tenant_id,
        instanceId: task.instance_id,
        taskId: task.id,
        actor,
        event: "task.created",
        data: { step_key: task.step_key, iteration: task.iteration, kind: task.kind, topic: task.topic },
      });
      return { task, created: true };
    }
    const existing = await client.query<TaskRow>(
      "SELECT * FROM tasks WHERE instance_id = $1 AND step_key = $2 AND iteration = $3",
      [t.instanceId, t.stepKey, t.iteration ?? 0]
    );
    return { task: existing.rows[0], created: false };
  });
}

// ── Claim ─────────────────────────────────────────────────────────────────────

export interface FetchAndLockParams {
  tenantId: string;
  workerId: string;
  topics?: string[];
  /** Restrict to system or user tasks, e.g. scheduled runs fetch only system tasks. */
  kinds?: TaskKind[];
  maxTasks: number;
  lockSeconds: number;
}

/** Locks and returns up to `maxTasks` due pending tasks, oldest due first. */
export async function fetchAndLock(pool: Pool, p: FetchAndLockParams): Promise<TaskRow[]> {
  if (p.maxTasks < 1) throw invalidArgument("max_tasks must be at least 1");
  if (p.lockSeconds < 1) throw invalidArgument("lock_seconds must be at least 1");
  const topics = p.topics && p.topics.length > 0 ? p.topics : null;
  const kinds = p.kinds && p.kinds.length > 0 ? p.kinds : null;

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks t
          SET status = 'locked',
              lock_token = gen_random_uuid(),
              locked_by = $2,
              lock_expires_at = now() + make_interval(secs => $3),
              attempts = t.attempts + 1,
              updated_at = now()
        WHERE t.id IN (
          SELECT id FROM tasks
           WHERE tenant_id = $1
             AND status = 'pending'
             AND due_at <= now()
             AND ($4::text[] IS NULL OR topic = ANY($4))
             AND ($6::text[] IS NULL OR kind = ANY($6))
           ORDER BY due_at, created_at
           LIMIT $5
           FOR UPDATE SKIP LOCKED)
       RETURNING t.*`,
      [p.tenantId, p.workerId, p.lockSeconds, topics, p.maxTasks, kinds]
    );
    rows.sort((a, b) => a.due_at.getTime() - b.due_at.getTime());
    for (const task of rows) {
      await appendAudit(client, {
        tenantId: task.tenant_id,
        instanceId: task.instance_id,
        taskId: task.id,
        actor: { type: "worker", id: p.workerId },
        event: "task.locked",
        data: { attempt: task.attempts, lock_expires_at: task.lock_expires_at },
      });
    }
    return rows;
  });
}

// ── Lock checks ───────────────────────────────────────────────────────────────

type Operation = "complete" | "fail" | "extend";

async function loadTask(db: Pool | PoolClient, tenantId: string, taskId: string): Promise<TaskRow> {
  // A malformed id is just "not found" for the caller.
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw taskNotFound(taskId);
  const { rows } = await db.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2", [
    taskId,
    tenantId,
  ]);
  if (rows.length === 0) throw taskNotFound(taskId);
  return rows[0];
}

/**
 * Decides what a call with `lockToken` means for `task` when the token is not the current lock:
 * an idempotent repeat of an earlier successful call (returns true), or an error.
 */
function checkLock(task: TaskRow, lockToken: string, op: Operation): "locked" | "repeat" {
  if (task.status === "locked" && task.lock_token === lockToken) return "locked";

  const sameToken = task.resolved_by_token === lockToken;
  if (sameToken && op === "complete" && task.status === "completed") return "repeat";
  if (sameToken && op === "fail" && (task.status === "failed" || task.status === "pending")) return "repeat";

  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    throw new ZykError(
      "already_resolved",
      `Task ${task.id} is already ${task.status}${sameToken ? "" : " (resolved by another worker or the engine)"}.`,
      "Do nothing more for this task and do not repeat its side effects. Call fetch_and_lock for the next task."
    );
  }
  const what =
    task.status === "pending"
      ? "Your lock expired and the task was returned to the queue."
      : "Your lock expired and another worker has claimed the task.";
  throw new ZykError(
    "stale_lock",
    `Lock token is no longer valid for task ${task.id}. ${what}`,
    "Stop working on this task. If you already created external effects, leave them — the next " +
      "attempt checks for them" +
      (task.idempotency_key ? ` using idempotency key \`${task.idempotency_key}\`` : "") +
      ". Call fetch_and_lock to continue. For long tasks, call extend_lock before the lock expires."
  );
}

// ── Extend ────────────────────────────────────────────────────────────────────

export interface ExtendLockParams {
  tenantId: string;
  taskId: string;
  lockToken: string;
  seconds: number;
  workerId: string;
}

/** Sets the lock to expire `seconds` from now. */
export async function extendLock(pool: Pool, p: ExtendLockParams): Promise<TaskRow> {
  if (p.seconds < 1) throw invalidArgument("seconds must be at least 1");
  return withTransaction(pool, async (client) => {
    const task = await loadTask(client, p.tenantId, p.taskId);
    checkLock(task, p.lockToken, "extend");
    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks SET lock_expires_at = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'locked' AND lock_token = $3
       RETURNING *`,
      [p.taskId, p.tenantId, p.lockToken, p.seconds]
    );
    if (rows.length === 0) return raceLost(client, p.tenantId, p.taskId, p.lockToken, "extend");
    await appendAudit(client, {
      tenantId: p.tenantId,
      instanceId: rows[0].instance_id,
      taskId: p.taskId,
      actor: { type: "worker", id: p.workerId },
      event: "task.lock_extended",
      data: { lock_expires_at: rows[0].lock_expires_at },
    });
    return rows[0];
  });
}

// ── Complete ──────────────────────────────────────────────────────────────────

export interface ResolveOutcome {
  task: TaskRow;
  /** True when this call repeated an earlier successful call with the same token. */
  repeated: boolean;
}

export interface CompleteTaskParams {
  tenantId: string;
  taskId: string;
  lockToken: string;
  result: unknown;
  workerId: string;
}

/** Completes a system task after validating `result` against its result schema. */
export async function completeTask(pool: Pool, p: CompleteTaskParams): Promise<ResolveOutcome> {
  return resolveWithResult(pool, p, "system", p.result, null);
}

export interface CompleteUserTaskParams {
  tenantId: string;
  taskId: string;
  lockToken: string;
  decision: string;
  comment?: string;
  decidedVia: DecidedVia;
  workerId: string;
}

/** Records the human's decision for a user task. */
export async function completeUserTask(pool: Pool, p: CompleteUserTaskParams): Promise<ResolveOutcome> {
  const result: Record<string, unknown> = { decision: p.decision };
  if (p.comment !== undefined && p.comment !== "") result.comment = p.comment;
  return resolveWithResult(pool, p, "user", result, p.decidedVia);
}

async function resolveWithResult(
  pool: Pool,
  p: { tenantId: string; taskId: string; lockToken: string; workerId: string },
  expectedKind: TaskKind,
  result: unknown,
  decidedVia: DecidedVia | null
): Promise<ResolveOutcome> {
  const actor: Actor = { type: "worker", id: p.workerId };
  return withTransaction(pool, async (client) => {
    const task = await loadTask(client, p.tenantId, p.taskId);
    if (task.kind !== expectedKind) throw wrongKind(task);
    if (checkLock(task, p.lockToken, "complete") === "repeat") return { task, repeated: true };

    const problems = validateAgainstSchema(task.result_schema, result);
    if (problems.length > 0) {
      // Rejections are part of the task's history, but must survive the error rollback.
      await appendAudit(pool, {
        tenantId: p.tenantId,
        instanceId: task.instance_id,
        taskId: task.id,
        actor,
        event: "task.result_rejected",
        data: { problems },
      });
      throw new ZykError(
        "result_invalid",
        `Result for task ${task.id} does not match its result schema: ${problems.join("; ")}.`,
        "Fix the listed fields and call again with the same lock_token — the task is still locked " +
          "to you. If a value must come from an external system (e.g. an id), read the record " +
          "back instead of guessing.",
        { problems, result_schema: task.result_schema }
      );
    }

    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks
          SET status = 'completed', result = $4, decided_via = $5, resolved_by_token = $3,
              lock_token = NULL, lock_expires_at = NULL,
              completed_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'locked' AND lock_token = $3
       RETURNING *`,
      [p.taskId, p.tenantId, p.lockToken, JSON.stringify(result), decidedVia]
    );
    if (rows.length === 0) return { task: await raceLost(client, p.tenantId, p.taskId, p.lockToken, "complete"), repeated: true };
    await appendAudit(client, {
      tenantId: p.tenantId,
      instanceId: task.instance_id,
      taskId: task.id,
      actor,
      event: "task.completed",
      data: { result, ...(decidedVia ? { decided_via: decidedVia } : {}) },
    });
    return { task: rows[0], repeated: false };
  });
}

// ── Fail ──────────────────────────────────────────────────────────────────────

export interface FailTaskParams {
  tenantId: string;
  taskId: string;
  lockToken: string;
  error: string;
  retryable: boolean;
  workerId: string;
}

/**
 * Releases the task with an error. Retryable failures go back to the queue with backoff until
 * max_attempts is reached; everything else fails the task.
 */
export async function failTask(pool: Pool, p: FailTaskParams): Promise<ResolveOutcome> {
  return withTransaction(pool, async (client) => {
    const task = await loadTask(client, p.tenantId, p.taskId);
    if (task.kind === "user") {
      throw new ZykError(
        "wrong_task_kind",
        `Task ${task.id} is a user task and cannot fail.`,
        "If the user cannot answer now, call release_task; the task stays open and is offered again."
      );
    }
    if (checkLock(task, p.lockToken, "fail") === "repeat") return { task, repeated: true };

    const retry = p.retryable && task.attempts < task.max_attempts;
    const error = { message: p.error, retryable: p.retryable, attempt: task.attempts };
    const delay = retryDelaySeconds(task.attempts);
    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks
          SET status = CASE WHEN $5 THEN 'pending' ELSE 'failed' END,
              due_at = CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE due_at END,
              completed_at = CASE WHEN $5 THEN NULL ELSE now() END,
              error = $4, resolved_by_token = $3,
              lock_token = NULL, lock_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'locked' AND lock_token = $3
       RETURNING *`,
      [p.taskId, p.tenantId, p.lockToken, error, retry, delay]
    );
    if (rows.length === 0) return { task: await raceLost(client, p.tenantId, p.taskId, p.lockToken, "fail"), repeated: true };
    await appendAudit(client, {
      tenantId: p.tenantId,
      instanceId: task.instance_id,
      taskId: task.id,
      actor: { type: "worker", id: p.workerId },
      event: retry ? "task.retry_scheduled" : "task.failed",
      data: { ...error, ...(retry ? { retry_in_seconds: delay } : {}) },
    });
    return { task: rows[0], repeated: false };
  });
}

// ── Release ───────────────────────────────────────────────────────────────────

export interface ReleaseTaskParams {
  tenantId: string;
  taskId: string;
  lockToken: string;
  workerId: string;
}

/**
 * Gives the task back without a result (e.g. the user wants to answer later, or a scheduled run
 * fetched a task it should not do). It is offered again immediately. Does not count as failure:
 * the claim's attempt is returned.
 */
export async function releaseTask(pool: Pool, p: ReleaseTaskParams): Promise<TaskRow> {
  return withTransaction(pool, async (client) => {
    const task = await loadTask(client, p.tenantId, p.taskId);
    checkLock(task, p.lockToken, "extend");
    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks
          SET status = 'pending', lock_token = NULL, lock_expires_at = NULL,
              attempts = GREATEST(attempts - 1, 0), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'locked' AND lock_token = $3
       RETURNING *`,
      [p.taskId, p.tenantId, p.lockToken]
    );
    if (rows.length === 0) return raceLost(client, p.tenantId, p.taskId, p.lockToken, "extend");
    await appendAudit(client, {
      tenantId: p.tenantId,
      instanceId: task.instance_id,
      taskId: task.id,
      actor: { type: "worker", id: p.workerId },
      event: "task.released",
    });
    return rows[0];
  });
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export interface ReapResult {
  requeued: TaskRow[];
  failed: TaskRow[];
}

/**
 * Releases locks that expired before `now` (default: DB clock). System tasks with attempts left
 * go back to `pending`; the rest fail with `lease_expired`. User tasks always go back to
 * `pending` — a human taking longer than the lock is not a failure; the step timeout bounds them.
 * Safe to run on several replicas at once.
 */
export async function reapExpiredLocks(pool: Pool, opts: { now?: Date } = {}): Promise<ReapResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<TaskRow>(
      `WITH expired AS (
         SELECT id FROM tasks
          WHERE status = 'locked' AND lock_expires_at < COALESCE($1, now())
          FOR UPDATE SKIP LOCKED)
       UPDATE tasks t
          SET status = CASE WHEN t.kind = 'system' AND t.attempts >= t.max_attempts THEN 'failed' ELSE 'pending' END,
              error = CASE WHEN t.kind = 'system' AND t.attempts >= t.max_attempts
                           THEN jsonb_build_object('message', 'Lock expired on the final attempt',
                                                   'code', 'lease_expired', 'attempt', t.attempts)
                           ELSE t.error END,
              completed_at = CASE WHEN t.kind = 'system' AND t.attempts >= t.max_attempts THEN now() END,
              lock_token = NULL, lock_expires_at = NULL, updated_at = now()
         FROM expired
        WHERE t.id = expired.id
       RETURNING t.*`,
      [opts.now ?? null]
    );
    const result: ReapResult = { requeued: [], failed: [] };
    for (const task of rows) {
      (task.status === "failed" ? result.failed : result.requeued).push(task);
      await appendAudit(client, {
        tenantId: task.tenant_id,
        instanceId: task.instance_id,
        taskId: task.id,
        actor: { type: "reaper" },
        event: task.status === "failed" ? "task.failed" : "task.lease_expired",
        data: {
          locked_by: task.locked_by,
          attempt: task.attempts,
          outcome: task.status === "failed" ? "failed" : "requeued",
        },
      });
    }
    return result;
  });
}

/** Drops external content past its retention date. Returns the number of tasks purged. */
export async function purgeExpiredUntrustedContent(pool: Pool, opts: { now?: Date } = {}): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE tasks SET untrusted_content = NULL, untrusted_expires_at = NULL, updated_at = now()
      WHERE untrusted_content IS NOT NULL AND untrusted_expires_at < COALESCE($1, now())`,
    [opts.now ?? null]
  );
  return rowCount ?? 0;
}

/** Runs the reaper and retention purge periodically. Returns a stop function. */
export function startMaintenance(pool: Pool, intervalMs = 15_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { requeued, failed } = await reapExpiredLocks(pool);
      if (requeued.length || failed.length) {
        console.error(`[reaper] requeued ${requeued.length}, failed ${failed.length}`);
      }
      await purgeExpiredUntrustedContent(pool);
    } catch (err) {
      console.error("[reaper] error:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ── Engine operations ─────────────────────────────────────────────────────────

/**
 * Cancels open (pending or locked) tasks — one task, or all of an instance's. Holders of a lock
 * get `already_resolved` on their next call. Returns the cancelled tasks.
 */
export async function cancelOpenTasks(
  pool: Pool,
  target: { taskId: string } | { instanceId: string },
  reason: string,
  actor: Actor = { type: "engine" }
): Promise<TaskRow[]> {
  const byTask = "taskId" in target;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks
          SET status = 'cancelled', error = jsonb_build_object('message', $2::text, 'code', 'cancelled'),
              lock_token = NULL, lock_expires_at = NULL, completed_at = now(), updated_at = now()
        WHERE ${byTask ? "id" : "instance_id"} = $1 AND status IN ('pending', 'locked')
       RETURNING *`,
      [byTask ? target.taskId : target.instanceId, reason]
    );
    for (const task of rows) {
      await appendAudit(client, {
        tenantId: task.tenant_id,
        instanceId: task.instance_id,
        taskId: task.id,
        actor,
        event: "task.cancelled",
        data: { reason },
      });
    }
    return rows;
  });
}

/** The step run has read the task's outcome; the outbox stops re-publishing it. */
export async function markConsumed(pool: Pool, taskId: string): Promise<void> {
  await pool.query("UPDATE tasks SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL", [taskId]);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getTask(pool: Pool, tenantId: string, taskId: string): Promise<TaskRow> {
  return loadTask(pool, tenantId, taskId);
}

export function isResolved(task: TaskRow): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The CAS update matched no row: the task changed after we read it. Re-read and explain. */
async function raceLost(
  client: PoolClient,
  tenantId: string,
  taskId: string,
  lockToken: string,
  op: Operation
): Promise<TaskRow> {
  const task = await loadTask(client, tenantId, taskId);
  checkLock(task, lockToken, op); // throws unless it is an idempotent repeat
  return task;
}

function taskNotFound(taskId: string): ZykError {
  return new ZykError(
    "task_not_found",
    `No task with id ${taskId}.`,
    "Use the task_id exactly as returned by fetch_and_lock. Call fetch_and_lock to get current tasks."
  );
}

function wrongKind(task: TaskRow): ZykError {
  return task.kind === "user"
    ? new ZykError(
        "wrong_task_kind",
        `Task ${task.id} is a user task.`,
        "Ask the user the question in the task instructions, then call complete_user_task with their decision."
      )
    : new ZykError(
        "wrong_task_kind",
        `Task ${task.id} is a system task.`,
        "Perform the task with your tools, then call complete_task with a result matching result_schema."
      );
}

function invalidArgument(message: string): ZykError {
  return new ZykError("invalid_argument", message, "Correct the argument and call again.");
}
