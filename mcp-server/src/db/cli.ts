#!/usr/bin/env node
// Usage: npm run db:migrate   (reads ZYK_DATABASE_URL from env or the repo-root .env)
import "../env.js";
import { closePool, databaseUrl, ensureDatabase, getPool } from "./pool.js";
import { migrate } from "./migrate.js";

const command = process.argv[2];

if (command !== "migrate") {
  console.error("Usage: cli.js migrate");
  process.exit(1);
}

try {
  await ensureDatabase(databaseUrl());
  const applied = await migrate(getPool());
  console.error(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await closePool();
}
