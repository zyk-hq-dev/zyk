import { migrate } from "../src/db/migrate.js";
import { recreateDatabase, TEST_DATABASE_URL, testPool } from "./helpers/db.js";

// Fresh test database per run, so every run also exercises the migrations from scratch.
export async function setup(): Promise<void> {
  try {
    await recreateDatabase(TEST_DATABASE_URL);
  } catch (err) {
    throw new Error(
      `Cannot reach the test Postgres at ${TEST_DATABASE_URL} (${(err as Error).message}). ` +
        "Start it with: docker compose up -d postgres"
    );
  }
  const pool = testPool();
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
