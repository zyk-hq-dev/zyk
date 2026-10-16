import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let _pool: pg.Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.ZYK_DATABASE_URL;
  if (!url) {
    throw new Error(
      "ZYK_DATABASE_URL is not set. Example: postgresql://hatchet:hatchet@localhost:5433/zyk"
    );
  }
  return url;
}

/** Shared pool for the server process. */
export function getPool(): pg.Pool {
  if (!_pool) _pool = createPool(databaseUrl());
  return _pool;
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Idle-client errors (e.g. server restart) must not crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    const pool = _pool;
    _pool = null;
    await pool.end();
  }
}

/** Runs fn in a transaction; rolls back and rethrows on error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates the database named in `connectionString` if it does not exist, by connecting to the
 * `postgres` maintenance database on the same server. Needs CREATEDB permission; a no-op when
 * the database already exists.
 */
export async function ensureDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName) throw new Error("ZYK_DATABASE_URL must include a database name");

  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
      console.error(`[db] created database ${dbName}`);
    }
  } catch (err) {
    // Another process may have created it concurrently.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await client.end();
  }
}
