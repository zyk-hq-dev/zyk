import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { App } from "../app.js";
import { authenticateKey, extractKey } from "../auth/keys.js";
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
    const auth = key ? await authenticateKey(app.pool, key) : null;
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

  sendJson(res, 404, { error: "not_found" });
}

export function createHttpServer(app: App): Server {
  return createServer((req, res) => {
    handleRequest(app, req, res).catch((err) => {
      console.error("[http] Unhandled error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
}
