/**
 * Per-tenant API keys (milestone 1 auth; OAuth can replace this behind the same `authenticate`).
 * Keys look like `zyk_<43 base64url chars>` (256 bits). Only a sha256 hash is stored.
 */

import { createHash, randomBytes } from "crypto";
import type { IncomingMessage } from "http";
import { appendAudit } from "../audit/log.js";
import { withTransaction, type Pool } from "../db/pool.js";

export type KeyScope = "mcp" | "webhook";

export interface AuthContext {
  tenantId: string;
  keyId: string;
  scope: KeyScope;
  /** First characters of the key, safe to show and log. */
  keyPrefix: string;
}

const KEY_RE = /^zyk_[A-Za-z0-9_-]{43}$/;

export function generateKey(): string {
  return `zyk_${randomBytes(32).toString("base64url")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

export async function createTenant(pool: Pool, name: string): Promise<{ tenantId: string; key: string }> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name]);
    const tenantId = rows[0].id;
    const key = generateKey();
    await client.query(
      "INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)",
      [tenantId, hashKey(key), keyPrefix(key), "initial"]
    );
    await appendAudit(client, {
      tenantId,
      actor: { type: "admin" },
      event: "tenant.created",
      data: { name, key_prefix: keyPrefix(key) },
    });
    return { tenantId, key };
  });
}

export async function createApiKey(
  pool: Pool,
  tenantId: string,
  label?: string,
  scope: KeyScope = "mcp"
): Promise<string> {
  const key = generateKey();
  await withTransaction(pool, async (client) => {
    await client.query(
      "INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label, scope) VALUES ($1, $2, $3, $4, $5)",
      [tenantId, hashKey(key), keyPrefix(key), label ?? null, scope]
    );
    await appendAudit(client, {
      tenantId,
      actor: { type: "admin" },
      event: "api_key.created",
      data: { key_prefix: keyPrefix(key), label: label ?? null, scope },
    });
  });
  return key;
}

/** Revokes by prefix (as shown in listings). Returns the number of keys revoked. */
export async function revokeApiKey(pool: Pool, prefix: string): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ tenant_id: string; key_prefix: string }>(
      "UPDATE api_keys SET revoked_at = now() WHERE key_prefix = $1 AND revoked_at IS NULL RETURNING tenant_id, key_prefix",
      [prefix]
    );
    for (const row of rows) {
      await appendAudit(client, {
        tenantId: row.tenant_id,
        actor: { type: "admin" },
        event: "api_key.revoked",
        data: { key_prefix: row.key_prefix },
      });
    }
    return rows.length;
  });
}

/** Returns the key's context if it is active and has the required scope. */
export async function authenticateKey(pool: Pool, key: string, scope: KeyScope): Promise<AuthContext | null> {
  if (!KEY_RE.test(key)) return null;
  const { rows } = await pool.query<{ id: string; tenant_id: string; key_prefix: string; scope: KeyScope }>(
    "SELECT id, tenant_id, key_prefix, scope FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hashKey(key)]
  );
  if (rows.length === 0 || rows[0].scope !== scope) return null;
  return { tenantId: rows[0].tenant_id, keyId: rows[0].id, keyPrefix: rows[0].key_prefix, scope: rows[0].scope };
}

/**
 * Finds the key in `Authorization: Bearer <key>` or in the URL path (`/mcp/k/<key>`, for clients
 * that cannot send headers). Returns the key and the request path without it.
 */
export function extractKey(req: IncomingMessage): { key: string | null; path: string } {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = url.pathname;
  let key: string | null = null;
  const m = /^(\/[a-z]+)\/k\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    key = decodeURIComponent(m[2]);
    path = m[1] + (m[3] ?? "");
  }
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) key = header.slice("Bearer ".length).trim();
  return { key, path };
}
