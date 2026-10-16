import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { listAuditForInstance } from "../../src/audit/log.js";
import { createApiKey, createTenant } from "../../src/auth/keys.js";
import type { Engine } from "../../src/engine/hatchet.js";
import { createHttpServer } from "../../src/http/server.js";
import { loadPlaybooks, PlaybookCatalog, registerPlaybooks } from "../../src/playbooks/loader.js";
import { resetData, testPool } from "../helpers/db.js";

const pool = testPool();
const playbooks = loadPlaybooks();
const triggered: string[] = [];
let engineUp = true;
const engine: Engine = {
  async triggerInstance(i) {
    triggered.push(i.id);
  },
  async notifyTaskResolved() {},
  async stop() {},
};
const app: App = { pool, catalog: new PlaybookCatalog(playbooks), engine: () => (engineUp ? engine : null) };

let http: Server;
let base: string;
let tenantId: string;
let mcpKey: string;
let hookKey: string;

beforeAll(async () => {
  http = createHttpServer(app);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
  await pool.end();
});

beforeEach(async () => {
  await resetData(pool);
  await registerPlaybooks(pool, playbooks);
  ({ tenantId, key: mcpKey } = await createTenant(pool, "Acme"));
  hookKey = await createApiKey(pool, tenantId, "mail forwarder", "webhook");
  triggered.length = 0;
  engineUp = true;
});

const mail = {
  message_id: "<msg-1@example.com>",
  from: "Ada <ada@example.com>",
  subject: "Checkout down",
  body: "Nobody can pay",
  received_at: "2026-10-16T09:00:00Z",
};

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

describe("POST /webhooks/<playbook_id>", () => {
  it("starts an instance with a webhook key and triggers the engine", async () => {
    const res = await post("/webhooks/incident-triage", mail, bearer(hookKey));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ created: true, status: "running", playbook: "incident-triage" });
    expect(triggered).toEqual([res.body.instance_id]);
    const audit = await listAuditForInstance(pool, tenantId, res.body.instance_id);
    expect(audit[0]).toMatchObject({ event: "instance.started", actor_type: "webhook", actor_id: hookKey.slice(0, 12) });
  });

  it("accepts the key in the URL path", async () => {
    const res = await post(`/webhooks/k/${hookKey}/incident-triage`, mail);
    expect(res.status).toBe(202);
  });

  it("dedupes repeated deliveries of the same mail", async () => {
    const first = await post("/webhooks/incident-triage", mail, bearer(hookKey));
    const again = await post("/webhooks/incident-triage", { ...mail, subject: "Re: Checkout down" }, bearer(hookKey));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, instance_id: first.body.instance_id });
    expect(triggered).toHaveLength(1);
  });

  it("rejects missing keys and MCP keys", async () => {
    expect((await post("/webhooks/incident-triage", mail)).status).toBe(401);
    const withMcpKey = await post("/webhooks/incident-triage", mail, bearer(mcpKey));
    expect(withMcpKey.status).toBe(401);
    expect(withMcpKey.body.hint).toContain("webhook-key:create");
  });

  it("does not let a webhook key use the MCP endpoint", async () => {
    const res = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(hookKey));
    expect(res.status).toBe(401);
  });

  it("explains invalid input, unknown playbooks, and bad requests", async () => {
    const invalid = await post("/webhooks/incident-triage", { from: "x" }, bearer(hookKey));
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toContain("field `message_id` is missing");

    const unknown = await post("/webhooks/nope", mail, bearer(hookKey));
    expect(unknown.status).toBe(404);
    expect(unknown.body.hint).toContain("incident-triage");

    expect((await post("/webhooks/incident-triage", "{not json", bearer(hookKey))).status).toBe(400);
    const text = await fetch(`${base}/webhooks/incident-triage`, {
      method: "POST", headers: { ...bearer(hookKey), "Content-Type": "text/plain" }, body: "hi",
    });
    expect(text.status).toBe(415);
    const get = await fetch(`${base}/webhooks/incident-triage`, { headers: bearer(hookKey) });
    expect(get.status).toBe(405);
  });

  it("creates the instance while the engine is down; recovery triggers it later", async () => {
    engineUp = false;
    const res = await post("/webhooks/incident-triage", mail, bearer(hookKey));
    expect(res.status).toBe(202);
    expect(triggered).toEqual([]);
    const { rows } = await pool.query("SELECT hatchet_run_id FROM instances WHERE id = $1", [res.body.instance_id]);
    expect(rows[0].hatchet_run_id).toBeNull(); // picked up by untriggeredInstances()
  });
});
