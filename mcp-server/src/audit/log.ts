import type { PoolClient, Pool } from "../db/pool.js";

export type ActorType = "worker" | "user" | "reaper" | "webhook" | "engine" | "admin";

export interface Actor {
  type: ActorType;
  /** Worker id, user id, etc. Optional for system actors. */
  id?: string;
}

export interface AuditEntry {
  tenantId: string;
  instanceId?: string | null;
  taskId?: string | null;
  actor: Actor;
  event: string;
  data?: Record<string, unknown>;
}

/** Appends one entry. Pass the transaction's client so the entry commits with the change. */
export async function appendAudit(db: PoolClient | Pool, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (tenant_id, instance_id, task_id, actor_type, actor_id, event, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tenantId,
      entry.instanceId ?? null,
      entry.taskId ?? null,
      entry.actor.type,
      entry.actor.id ?? null,
      entry.event,
      entry.data ?? {},
    ]
  );
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  instance_id: string | null;
  task_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  event: string;
  data: Record<string, unknown>;
  at: Date;
}

export async function listAuditForInstance(
  db: PoolClient | Pool,
  tenantId: string,
  instanceId: string
): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    "SELECT * FROM audit_log WHERE tenant_id = $1 AND instance_id = $2 ORDER BY id",
    [tenantId, instanceId]
  );
  return rows;
}
