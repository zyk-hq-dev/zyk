#!/usr/bin/env node
import "./env.js";
import type { App } from "./app.js";
import { migrate } from "./db/migrate.js";
import { databaseUrl, ensureDatabase, getPool } from "./db/pool.js";
import { startHatchetEngine, type Engine } from "./engine/hatchet.js";
import { ensureHatchetToken } from "./hatchet/bootstrap.js";
import { createHttpServer } from "./http/server.js";
import { loadPlaybooks, PlaybookCatalog, registerPlaybooks } from "./playbooks/loader.js";
import { assertDefinitionsFor } from "./playbooks/registry.js";
import { startMaintenance } from "./tasks/store.js";

async function main() {
  const port = parseInt(process.env.PORT ?? "3100", 10);
  const pool = getPool();

  // Fail fast if the zyk DB is unreachable — every tool depends on it.
  await ensureDatabase(databaseUrl());
  const applied = await migrate(pool);
  if (applied.length) console.error(`[db] applied migrations: ${applied.join(", ")}`);

  // Invalid manifests, edited released versions, or missing playbook code stop the server here.
  const playbooks = loadPlaybooks();
  await registerPlaybooks(pool, playbooks);
  const catalog = new PlaybookCatalog(playbooks);
  assertDefinitionsFor(catalog);
  console.error(`[playbooks] ${playbooks.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(", ") || "none"}`);

  // Lock reaper + untrusted-content retention. Safe on several replicas.
  startMaintenance(pool);

  let engine: Engine | null = null;
  const app: App = { pool, catalog, engine: () => engine };

  createHttpServer(app).listen(port, () => {
    console.error(`zyk listening on http://0.0.0.0:${port}/mcp`);
  });

  // The MCP endpoint stays up while Hatchet is unavailable; started instances are triggered
  // and resolution events published once the engine runs.
  ensureHatchetToken()
    .then(() => startHatchetEngine({ pool, catalog }))
    .then((started) => {
      engine = started;
      console.error("[engine] Hatchet worker started");
    })
    .catch((err) => console.error("Warning: Hatchet engine failed to start:", err));
}

// The Hatchet SDK starts background gRPC connections that can fail asynchronously.
// Those failures must not kill the HTTP server.
process.on("unhandledRejection", (reason) => {
  console.error("[WARN] Unhandled promise rejection (server continuing):", reason);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
