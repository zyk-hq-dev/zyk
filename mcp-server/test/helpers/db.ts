import { createPool, type Pool } from "../../src/db/pool.js";

export const TEST_DATABASE_URL =
  process.env.ZYK_TEST_DATABASE_URL ?? "postgresql://hatchet:hatchet@localhost:5433/zyk_test";

/** URL for another database on the test server (for tests that need a pristine DB). */
export function siblingDatabaseUrl(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export function testPool(url: string = TEST_DATABASE_URL): Pool {
  return createPool(url);
}

/** Removes all rows from zyk tables. TRUNCATE bypasses the audit_log row trigger. */
export async function resetData(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE audit_log, tasks, instances, playbook_versions, api_keys, tenants RESTART IDENTITY CASCADE"
  );
}

/** Drops and recreates a database on the test server. */
export async function recreateDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  target.pathname = "/postgres";
  const admin = createPool(target.toString());
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  target.pathname = "/postgres";
  const admin = createPool(target.toString());
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export async function insertTenant(pool: Pool, name = "test-tenant"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
    [name]
  );
  return rows[0].id;
}

export async function insertPlaybookVersion(
  pool: Pool,
  playbookId = "test-playbook",
  version = "1.0.0"
): Promise<void> {
  await pool.query(
    `INSERT INTO playbook_versions (playbook_id, version, manifest, content_hash)
     VALUES ($1, $2, '{}', 'hash') ON CONFLICT DO NOTHING`,
    [playbookId, version]
  );
}

export async function insertInstance(
  pool: Pool,
  tenantId: string,
  opts: { externalKey?: string } = {}
): Promise<string> {
  await insertPlaybookVersion(pool);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO instances (tenant_id, playbook_id, playbook_version, effective_config, input, external_key)
     VALUES ($1, 'test-playbook', '1.0.0', '{}', '{}', $2) RETURNING id`,
    [tenantId, opts.externalKey ?? null]
  );
  return rows[0].id;
}
