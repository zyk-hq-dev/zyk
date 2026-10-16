import type { IncomingMessage } from "http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateKey,
  createApiKey,
  createTenant,
  extractKey,
  generateKey,
  hashKey,
  revokeApiKey,
} from "../../src/auth/keys.js";
import { resetData, testPool } from "../helpers/db.js";

const pool = testPool();

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetData(pool);
});

function req(url: string, authorization?: string): IncomingMessage {
  return { url, headers: authorization ? { authorization } : {} } as IncomingMessage;
}

describe("api keys", () => {
  it("generates 256-bit keys and stores only their hash", async () => {
    const key = generateKey();
    expect(key).toMatch(/^zyk_[A-Za-z0-9_-]{43}$/);
    const { tenantId, key: initial } = await createTenant(pool, "Acme");
    const { rows } = await pool.query("SELECT key_hash, key_prefix FROM api_keys WHERE tenant_id = $1", [tenantId]);
    expect(rows[0].key_hash).toBe(hashKey(initial));
    expect(JSON.stringify(rows)).not.toContain(initial);
  });

  it("authenticates active keys and rejects unknown, malformed, and revoked ones", async () => {
    const { tenantId, key } = await createTenant(pool, "Acme");
    expect(await authenticateKey(pool, key, "mcp")).toMatchObject({ tenantId, keyPrefix: key.slice(0, 12), scope: "mcp" });
    expect(await authenticateKey(pool, generateKey(), "mcp")).toBeNull();
    expect(await authenticateKey(pool, "not-a-key", "mcp")).toBeNull();

    const second = await createApiKey(pool, tenantId, "scheduled run");
    expect(await revokeApiKey(pool, key.slice(0, 12))).toBe(1);
    expect(await authenticateKey(pool, key, "mcp")).toBeNull();
    expect(await authenticateKey(pool, second, "mcp")).not.toBeNull();
  });

  it("only accepts a key for its own scope", async () => {
    const { tenantId, key } = await createTenant(pool, "Acme");
    const hook = await createApiKey(pool, tenantId, "mail forwarder", "webhook");
    expect(await authenticateKey(pool, hook, "webhook")).toMatchObject({ tenantId, scope: "webhook" });
    expect(await authenticateKey(pool, hook, "mcp")).toBeNull();
    expect(await authenticateKey(pool, key, "webhook")).toBeNull();
  });
});

describe("extractKey", () => {
  const key = generateKey();

  it("reads a bearer header", () => {
    expect(extractKey(req("/mcp", `Bearer ${key}`))).toEqual({ key, path: "/mcp" });
  });

  it("reads a key from the URL path and strips it", () => {
    expect(extractKey(req(`/mcp/k/${key}`))).toEqual({ key, path: "/mcp" });
    expect(extractKey(req(`/mcp/k/${key}?x=1`))).toEqual({ key, path: "/mcp" });
  });

  it("returns no key when there is none", () => {
    expect(extractKey(req("/mcp"))).toEqual({ key: null, path: "/mcp" });
    expect(extractKey(req("/healthz"))).toEqual({ key: null, path: "/healthz" });
  });
});
