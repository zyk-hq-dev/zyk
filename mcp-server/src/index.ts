#!/usr/bin/env node

import "./env.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ensureHatchetToken } from "./hatchet/bootstrap.js";
import { databaseUrl, ensureDatabase, getPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { startMaintenance } from "./tasks/store.js";

// ── MCP server factory ────────────────────────────────────────────────────────
// Stateless: each POST gets its own server + transport (SDK allows one connect per server).
// Tools, prompts, and server instructions are added in milestone 1 step 6.

function createMcpServer(): McpServer {
  return new McpServer({ name: "zyk", version: "2.0.0-dev" });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Temporary single-key auth (Authorization: Bearer <ZYK_API_KEY>).
// Replaced by per-tenant keys in step 6.
function isAuthorized(req: IncomingMessage): boolean {
  const apiKey = process.env.ZYK_API_KEY;
  if (!apiKey) return true;
  const header = req.headers["authorization"] ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    return provided.length > 0 && timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey));
  } catch {
    return false; // length mismatch
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url === "/mcp" || url.startsWith("/mcp?")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized: invalid or missing API key" });
      return;
    }
    if (method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { /* let the transport report the parse error */ }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    await server.close().catch(() => {});
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  const port = parseInt(process.env.PORT ?? "3100", 10);

  // Fail fast if the zyk DB is unreachable — every tool depends on it.
  await ensureDatabase(databaseUrl());
  const applied = await migrate(getPool());
  if (applied.length) console.error(`[db] applied migrations: ${applied.join(", ")}`);

  // Lock reaper + untrusted-content retention. Safe on several replicas.
  startMaintenance(getPool());

  createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[http] Unhandled error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    });
  }).listen(port, () => {
    console.error(`zyk listening on http://0.0.0.0:${port}/mcp`);
  });

  ensureHatchetToken().catch((err) => {
    console.error("Warning: Hatchet bootstrap failed:", err);
  });
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
