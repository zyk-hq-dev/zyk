import { readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { Pool } from "./pool.js";

/** `mcp-server/migrations` — same relative path from src/db (tsx) and dist/db (node). */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Arbitrary constant; serializes concurrent migrators (e.g. two replicas booting at once).
const MIGRATION_LOCK_ID = 7_301_904_221;

/**
 * Applies pending `NNN_name.sql` files in order, each in its own transaction, and records them
 * in `schema_migrations`. Safe to call concurrently. Returns the versions applied.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version     text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    const newlyApplied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const sql = readFileSync(join(dir, file), "utf-8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      newlyApplied.push(version);
    }
    return newlyApplied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
