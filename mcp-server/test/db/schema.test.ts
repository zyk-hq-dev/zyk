import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { insertInstance, insertTenant, resetData, testPool } from "../helpers/db.js";

const pool = testPool();

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetData(pool);
});

async function insertTask(
  tenantId: string,
  instanceId: string,
  fields: Record<string, unknown> = {}
): Promise<string> {
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    instance_id: instanceId,
    step_key: "triage",
    kind: "system",
    topic: "github",
    instructions: "Do the thing",
    result_schema: {},
    ...fields,
  };
  const cols = Object.keys(row);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(row)
  );
  return rows[0].id;
}

describe("tasks constraints", () => {
  it("creates a pending task with defaults", async () => {
    const tenant = await insertTenant(pool);
    const instance = await insertInstance(pool, tenant);
    const id = await insertTask(tenant, instance);
    const { rows } = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, max_attempts: 3, iteration: 0 });
  });

  it("rejects a second task for the same step and iteration (replay idempotency)", async () => {
    const tenant = await insertTenant(pool);
    const instance = await insertInstance(pool, tenant);
    await insertTask(tenant, instance);
    await expect(insertTask(tenant, instance)).rejects.toThrow(/duplicate key/);
    // Next loop round is a different task.
    await insertTask(tenant, instance, { iteration: 1 });
  });

  it("requires lock fields exactly when locked", async () => {
    const tenant = await insertTenant(pool);
    const instance = await insertInstance(pool, tenant);
    await expect(insertTask(tenant, instance, { status: "locked" })).rejects.toThrow(/check constraint/);
    await expect(
      insertTask(tenant, instance, { lock_token: "6f1c2a52-6a3b-4f7e-9f0e-3c1d2b4a5e6f" })
    ).rejects.toThrow(/check constraint/);
    await expect(
      insertTask(tenant, instance, { lock_expires_at: new Date(Date.now() + 60_000) })
    ).rejects.toThrow(/check constraint/);
    await insertTask(tenant, instance, {
      status: "locked",
      lock_token: "6f1c2a52-6a3b-4f7e-9f0e-3c1d2b4a5e6f",
      lock_expires_at: new Date(Date.now() + 60_000),
    });
  });

  it("only allows decided_via on user tasks", async () => {
    const tenant = await insertTenant(pool);
    const instance = await insertInstance(pool, tenant);
    await expect(insertTask(tenant, instance, { decided_via: "conversation" })).rejects.toThrow(
      /check constraint/
    );
    await insertTask(tenant, instance, { kind: "user", step_key: "confirm", decided_via: "elicitation" });
  });

  it("rejects unknown kinds and statuses", async () => {
    const tenant = await insertTenant(pool);
    const instance = await insertInstance(pool, tenant);
    await expect(insertTask(tenant, instance, { kind: "robot" })).rejects.toThrow(/check constraint/);
    await expect(insertTask(tenant, instance, { status: "done" })).rejects.toThrow(/check constraint/);
  });
});

describe("instances constraints", () => {
  it("dedupes on external key per tenant and playbook", async () => {
    const tenantA = await insertTenant(pool, "a");
    const tenantB = await insertTenant(pool, "b");
    await insertInstance(pool, tenantA, { externalKey: "<msg-1@example.com>" });
    await expect(insertInstance(pool, tenantA, { externalKey: "<msg-1@example.com>" })).rejects.toThrow(
      /duplicate key/
    );
    // Same key in another tenant is fine; so are instances without a key.
    await insertInstance(pool, tenantB, { externalKey: "<msg-1@example.com>" });
    await insertInstance(pool, tenantA);
    await insertInstance(pool, tenantA);
  });

  it("requires ended_at exactly when not running", async () => {
    const tenant = await insertTenant(pool);
    const id = await insertInstance(pool, tenant);
    await expect(pool.query("UPDATE instances SET status = 'completed' WHERE id = $1", [id])).rejects.toThrow(
      /check constraint/
    );
    await pool.query("UPDATE instances SET status = 'completed', ended_at = now() WHERE id = $1", [id]);
  });

  it("requires a registered playbook version", async () => {
    const tenant = await insertTenant(pool);
    await expect(
      pool.query(
        `INSERT INTO instances (tenant_id, playbook_id, playbook_version, effective_config, input)
         VALUES ($1, 'unknown', '9.9.9', '{}', '{}')`,
        [tenant]
      )
    ).rejects.toThrow(/foreign key/);
  });
});

describe("audit_log", () => {
  it("is append-only", async () => {
    const tenant = await insertTenant(pool);
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO audit_log (tenant_id, actor_type, event) VALUES ($1, 'admin', 'test') RETURNING id",
      [tenant]
    );
    await expect(pool.query("UPDATE audit_log SET event = 'x' WHERE id = $1", [rows[0].id])).rejects.toThrow(
      /append-only/
    );
    await expect(pool.query("DELETE FROM audit_log WHERE id = $1", [rows[0].id])).rejects.toThrow(
      /append-only/
    );
  });

  it("rejects unknown actor types", async () => {
    const tenant = await insertTenant(pool);
    await expect(
      pool.query("INSERT INTO audit_log (tenant_id, actor_type, event) VALUES ($1, 'martian', 'x')", [tenant])
    ).rejects.toThrow(/check constraint/);
  });
});
