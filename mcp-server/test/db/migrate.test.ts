import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { ensureDatabase } from "../../src/db/pool.js";
import { dropDatabase, siblingDatabaseUrl, testPool } from "../helpers/db.js";

describe("migrate", () => {
  const pristineUrl = siblingDatabaseUrl("zyk_test_migrate");

  afterAll(async () => {
    await dropDatabase(pristineUrl);
  });

  it("creates the zyk schema", async () => {
    const pool = testPool();
    try {
      const { rows } = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        "api_keys",
        "audit_log",
        "instances",
        "playbook_versions",
        "schema_migrations",
        "tasks",
        "tenants",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("is a no-op when everything is applied", async () => {
    const pool = testPool();
    try {
      expect(await migrate(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("applies each migration exactly once under concurrent migrators", async () => {
    await dropDatabase(pristineUrl);
    await ensureDatabase(pristineUrl);
    const pools = [testPool(pristineUrl), testPool(pristineUrl), testPool(pristineUrl)];
    try {
      const results = await Promise.all(pools.map((p) => migrate(p)));
      const appliedAnywhere = results.flat();
      expect(appliedAnywhere).toContain("001_init");
      expect(new Set(appliedAnywhere).size).toBe(appliedAnywhere.length);

      const { rows } = await pools[0].query("SELECT version FROM schema_migrations");
      expect(rows.length).toBe(appliedAnywhere.length);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});

describe("ensureDatabase", () => {
  it("is idempotent", async () => {
    const url = siblingDatabaseUrl("zyk_test_ensure");
    try {
      await ensureDatabase(url);
      await ensureDatabase(url);
    } finally {
      await dropDatabase(url);
    }
  });
});
