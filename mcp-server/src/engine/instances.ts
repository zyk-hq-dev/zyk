/**
 * Workflow instances: start (validated, deduped, audited), progress recording, and completion.
 *
 * Functions called from playbook runs (claimRun, recordStep, finishInstance) are idempotent,
 * because Hatchet durable tasks replay from the start after a worker restart.
 */

import { appendAudit, listAuditForInstance, type Actor, type AuditRow } from "../audit/log.js";
import { withTransaction, type Pool } from "../db/pool.js";
import { ZykError } from "../errors.js";
import { resolveConfig } from "../playbooks/config.js";
import type { PlaybookCatalog } from "../playbooks/loader.js";
import type { Config } from "../playbooks/types.js";
import { cancelOpenTasks, type TaskRow } from "../tasks/store.js";
import { validateAgainstSchema } from "../tasks/validate.js";

export type InstanceStatus = "running" | "completed" | "failed" | "cancelled";

export interface InstanceRow {
  id: string;
  tenant_id: string;
  playbook_id: string;
  playbook_version: string;
  customization_version: number | null;
  effective_config: Config;
  input: Record<string, unknown>;
  status: InstanceStatus;
  current_step: string | null;
  step_seq: number;
  outcome: string | null;
  error: Record<string, unknown> | null;
  hatchet_run_id: string | null;
  external_key: string | null;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
}

export interface StartInstanceParams {
  tenantId: string;
  playbookId: string;
  input: unknown;
  actor: Actor;
}

/**
 * Creates an instance pinned to the latest playbook version with its effective config. If the
 * input's external key was seen before, returns the existing instance (`created: false`).
 * The caller triggers the Hatchet run for new instances.
 */
export async function startInstance(
  pool: Pool,
  catalog: PlaybookCatalog,
  p: StartInstanceParams
): Promise<{ instance: InstanceRow; created: boolean }> {
  const manifest = catalog.get(p.playbookId);
  if (!manifest) {
    const known = catalog.list().map((m) => m.id);
    throw new ZykError(
      "invalid_argument",
      `Unknown playbook \`${p.playbookId}\`.`,
      `Use one of: ${known.join(", ") || "(none installed)"}. Call list_playbooks to see them.`
    );
  }
  const problems = validateAgainstSchema(manifest.input_schema, p.input, "input");
  if (problems.length) {
    throw new ZykError(
      "invalid_argument",
      `Input for ${manifest.id} is invalid: ${problems.join("; ")}.`,
      "Fix the listed fields and call again. get_playbook shows the expected input.",
      { problems, input_schema: manifest.input_schema }
    );
  }
  const input = p.input as Record<string, unknown>;
  // M1: no customizations yet, so the effective config is the playbook defaults.
  const { config } = resolveConfig(manifest);
  const externalKey = manifest.external_key ? String(input[manifest.external_key]) : null;

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<InstanceRow>(
      `INSERT INTO instances (tenant_id, playbook_id, playbook_version, effective_config, input, external_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, playbook_id, external_key) WHERE external_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [p.tenantId, manifest.id, manifest.version, config, input, externalKey]
    );
    if (rows.length === 0) {
      const existing = await client.query<InstanceRow>(
        "SELECT * FROM instances WHERE tenant_id = $1 AND playbook_id = $2 AND external_key = $3",
        [p.tenantId, manifest.id, externalKey]
      );
      return { instance: existing.rows[0], created: false };
    }
    const instance = rows[0];
    await appendAudit(client, {
      tenantId: p.tenantId,
      instanceId: instance.id,
      actor: p.actor,
      event: "instance.started",
      data: { playbook_id: manifest.id, playbook_version: manifest.version, external_key: externalKey },
    });
    return { instance, created: true };
  });
}

/** Engine-internal read (no tenant scoping). */
export async function loadInstance(pool: Pool, instanceId: string): Promise<InstanceRow> {
  const { rows } = await pool.query<InstanceRow>("SELECT * FROM instances WHERE id = $1", [instanceId]);
  if (rows.length === 0) throw new Error(`Instance ${instanceId} not found`);
  return rows[0];
}

/**
 * Binds the instance to a Hatchet run. Returns false if another run already owns it (a
 * duplicate trigger), in which case that run must do nothing.
 */
export async function claimRun(pool: Pool, instanceId: string, runId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE instances SET hatchet_run_id = $2, updated_at = now()
      WHERE id = $1 AND (hatchet_run_id IS NULL OR hatchet_run_id = $2)`,
    [instanceId, runId]
  );
  return rowCount === 1;
}

/**
 * Records that the run entered step number `seq`. Replays re-enter earlier steps with lower
 * numbers; those neither rewind current_step nor write duplicate audit entries.
 */
export async function recordStep(
  pool: Pool,
  instance: Pick<InstanceRow, "id" | "tenant_id">,
  seq: number,
  stepKey: string,
  event: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE instances SET current_step = $3, step_seq = $2, updated_at = now()
        WHERE id = $1 AND step_seq < $2 AND status = 'running'`,
      [instance.id, seq, stepKey]
    );
    await appendAudit(client, {
      tenantId: instance.tenant_id,
      instanceId: instance.id,
      actor: { type: "engine" },
      event,
      data: { step_key: stepKey, seq, ...data },
      dedupeKey: `instance:${instance.id}:seq:${seq}:${event}`,
    });
  });
}

export async function finishInstance(
  pool: Pool,
  instance: Pick<InstanceRow, "id" | "tenant_id">,
  endStep: string,
  outcome: string
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE instances SET status = 'completed', outcome = $2, current_step = $3,
              ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [instance.id, outcome, endStep]
    );
    await appendAudit(client, {
      tenantId: instance.tenant_id,
      instanceId: instance.id,
      actor: { type: "engine" },
      event: "instance.completed",
      data: { end_step: endStep, outcome },
      dedupeKey: `instance:${instance.id}:completed`,
    });
  });
}

/** Fails a running instance and cancels its open tasks. No-op if it already ended. */
export async function failInstance(
  pool: Pool,
  instanceId: string,
  error: { message: string; step_key?: string; code?: string }
): Promise<void> {
  const ended = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<InstanceRow>(
      `UPDATE instances SET status = 'failed', outcome = 'failed', error = $2,
              ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [instanceId, error]
    );
    if (rows.length === 0) return false;
    await appendAudit(client, {
      tenantId: rows[0].tenant_id,
      instanceId,
      actor: { type: "engine" },
      event: "instance.failed",
      data: error,
      dedupeKey: `instance:${instanceId}:failed`,
    });
    return true;
  });
  if (ended) await cancelOpenTasks(pool, { instanceId }, `Instance failed: ${error.message}`);
}

/** Running instances that never got a Hatchet run (trigger failed after the insert). */
export async function untriggeredInstances(pool: Pool, olderThanSeconds = 60): Promise<InstanceRow[]> {
  const { rows } = await pool.query<InstanceRow>(
    `SELECT * FROM instances
      WHERE status = 'running' AND hatchet_run_id IS NULL
        AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at LIMIT 50`,
    [olderThanSeconds]
  );
  return rows;
}

export interface InstanceDetails {
  instance: InstanceRow;
  tasks: TaskRow[];
  history: AuditRow[];
}

/** Instance with its tasks and audit history, scoped to the tenant. */
export async function getInstanceDetails(
  pool: Pool,
  tenantId: string,
  instanceId: string
): Promise<InstanceDetails> {
  const notFound = new ZykError(
    "invalid_argument",
    `No instance with id ${instanceId}.`,
    "Use an instance_id from start_workflow or list_open_tasks."
  );
  if (!/^[0-9a-f-]{36}$/i.test(instanceId)) throw notFound;
  const { rows } = await pool.query<InstanceRow>("SELECT * FROM instances WHERE id = $1 AND tenant_id = $2", [
    instanceId,
    tenantId,
  ]);
  if (rows.length === 0) throw notFound;
  const tasks = await pool.query<TaskRow>("SELECT * FROM tasks WHERE instance_id = $1 ORDER BY created_at", [
    instanceId,
  ]);
  const history = await listAuditForInstance(pool, tenantId, instanceId);
  return { instance: rows[0], tasks: tasks.rows, history };
}
