import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { App } from "../app.js";
import { authenticateKey, extractKey } from "../auth/keys.js";
import { startInstance } from "../engine/instances.js";
import { ZykError } from "../errors.js";
import { formatInstance } from "../mcp/format.js";
import { createMcpServer } from "../mcp/server.js";

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const UNAUTHORIZED = {
  error: "unauthorized",
  message: "Missing or invalid zyk API key.",
  hint:
    "Send `Authorization: Bearer <key>`, or use the URL https://<host>/mcp/k/<key> if your client " +
    "cannot send headers. Create a key with: npm run admin -- tenant:create <name>",
};

async function handleRequest(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const { key, path } = extractKey(req);

  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true, engine: app.engine() ? "running" : "starting" });
    return;
  }

  if (path === "/mcp") {
    const auth = key ? await authenticateKey(app.pool, key, "mcp") : null;
    if (!auth) {
      sendJson(res, 401, UNAUTHORIZED);
      return;
    }
    if (method !== "POST") {
      // Stateless server: no SSE stream for GET, no sessions to DELETE.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let body: unknown;
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(app, auth);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  const webhook = /^\/webhooks\/([a-z][a-z0-9-]*)$/.exec(path);
  if (webhook) {
    await handleWebhook(app, req, res, key, webhook[1]);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

const WEBHOOK_UNAUTHORIZED = {
  error: "unauthorized",
  message: "Missing or invalid zyk webhook key.",
  hint:
    "Send `Authorization: Bearer <webhook key>`, or use the URL /webhooks/k/<webhook key>/<playbook_id>. " +
    "Create a webhook key with: npm run admin -- webhook-key:create <tenant_id>. MCP API keys do not work here.",
};

/**
 * POST /webhooks/<playbook_id> starts an instance from an external event (e.g. a forwarded
 * mail). The JSON body is the playbook input. Repeated deliveries of the same event are
 * deduplicated by the playbook's external key.
 */
async function handleWebhook(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  key: string | null,
  playbookId: string
): Promise<void> {
  const auth = key ? await authenticateKey(app.pool, key, "webhook") : null;
  if (!auth) {
    sendJson(res, 401, WEBHOOK_UNAUTHORIZED);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, {
      error: "unsupported_media_type",
      message: "Send the playbook input as JSON (Content-Type: application/json).",
    });
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    const tooLarge = (err as Error).message.includes("too large");
    sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? "payload_too_large" : "invalid_json",
      message: tooLarge ? `The body exceeds ${MAX_BODY_BYTES} bytes.` : "The body is not valid JSON.",
    });
    return;
  }
  try {
    const { instance, created } = await startInstance(app.pool, app.catalog, {
      tenantId: auth.tenantId,
      playbookId,
      input,
      actor: { type: "webhook", id: auth.keyPrefix },
    });
    const engine = app.engine();
    if (created && engine) await engine.triggerInstance(instance);
    sendJson(res, created ? 202 : 200, { ...formatInstance(instance, app.catalog), created });
  } catch (err) {
    if (err instanceof ZykError) {
      sendJson(res, err.code === "unknown_playbook" ? 404 : 400, err.toJSON());
      return;
    }
    throw err;
  }
}

export function createHttpServer(app: App): Server {
  return createServer((req, res) => {
    handleRequest(app, req, res).catch((err) => {
      console.error("[http] Unhandled error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
}
