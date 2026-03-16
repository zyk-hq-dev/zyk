/**
 * Auto-bootstrap: if HATCHET_CLIENT_TOKEN is not set, attempt to generate one
 * by calling the Hatchet REST API. The generated token is cached to disk so it
 * survives container restarts (important on Railway with a persistent volume).
 *
 * Environment variables:
 *   HATCHET_CLIENT_TOKEN   If already set, this module is a no-op.
 *   HATCHET_REST_URL       Full base URL for the Hatchet HTTP API.
 *                          Default: derived from HATCHET_HOST_PORT (replacing port 7077 → 8080),
 *                          or http://localhost:8080 if neither is set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { WORKFLOWS_DIR } from "./worker.js";
import { join } from "path";

const TOKEN_CACHE_PATH = join(WORKFLOWS_DIR, ".token");

// ── HTTP helpers ───────────────────────────────────────────────────────────────

interface HatchetResponse {
  status: number;
  setCookies: string[];
  body: unknown;
}

async function hatchetRequest(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<HatchetResponse> {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.headers ?? {}),
      ...(bodyStr ? { "Content-Type": "application/json" } : {}),
    },
    body: bodyStr,
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  // getSetCookie() returns all Set-Cookie headers as an array (Node 20+).
  // Fall back to the singular header for older runtimes.
  const setCookies: string[] =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")?.split(/,\s*(?=\w+=)/) ?? [];

  return { status: res.status, setCookies, body };
}

// ── Readiness probe ────────────────────────────────────────────────────────────

async function waitForHatchet(baseUrl: string, maxAttempts = 36): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await hatchetRequest(baseUrl, "/api/ready");
      if (res.status === 200) {
        console.error("[bootstrap] Hatchet is ready");
        return;
      }
    } catch {
      // not up yet
    }
    const delay = Math.min(2_000 + i * 1_000, 10_000); // 2s → 10s ramp
    console.error(
      `[bootstrap] Waiting for Hatchet (attempt ${i + 1}/${maxAttempts}, retry in ${delay / 1_000}s)`
    );
    await new Promise<void>((r) => setTimeout(r, delay));
  }
  throw new Error(
    `Hatchet at ${baseUrl} did not become ready after ${maxAttempts} attempts. ` +
    "Check that the Hatchet service is healthy and HATCHET_REST_URL is correct."
  );
}

// ── Token generation ──────────────────────────────────────────────────────────

async function generateToken(baseUrl: string): Promise<string> {
  // 1. Login
  const loginRes = await hatchetRequest(baseUrl, "/api/v1/users/login", {
    method: "POST",
    body: { email: "admin@example.com", password: "Admin123!!" },
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `Hatchet login failed (HTTP ${loginRes.status}): ${JSON.stringify(loginRes.body)}`
    );
  }

  const cookie = loginRes.setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("No session cookie in Hatchet login response");

  // 2. Get tenant memberships
  const membershipsRes = await hatchetRequest(baseUrl, "/api/v1/users/memberships", {
    headers: { Cookie: cookie },
  });
  if (membershipsRes.status !== 200) {
    throw new Error(
      `Failed to get Hatchet memberships (HTTP ${membershipsRes.status}): ${JSON.stringify(membershipsRes.body)}`
    );
  }

  const rows = (
    membershipsRes.body as { rows?: Array<{ tenant?: { metadata?: { id?: string } } }> }
  ).rows ?? [];
  const tenantId = rows[0]?.tenant?.metadata?.id;
  if (!tenantId) {
    throw new Error(
      "Could not extract tenant ID from Hatchet memberships response. " +
      "Hatchet may still be initializing — retry in a moment."
    );
  }

  // 3. Create API token
  const tokenRes = await hatchetRequest(
    baseUrl,
    `/api/v1/tenants/${tenantId}/api-tokens`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: { name: `zyk-auto-${Date.now()}` },
    }
  );
  if (tokenRes.status !== 200 && tokenRes.status !== 201) {
    throw new Error(
      `Hatchet token creation failed (HTTP ${tokenRes.status}): ${JSON.stringify(tokenRes.body)}`
    );
  }

  const token = (tokenRes.body as { token?: string }).token;
  if (!token) {
    throw new Error(`No token field in Hatchet response: ${JSON.stringify(tokenRes.body)}`);
  }
  return token;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensures HATCHET_CLIENT_TOKEN is set in process.env.
 *
 * Order of precedence:
 *   1. HATCHET_CLIENT_TOKEN env var (already set — no-op)
 *   2. Token cached on disk at <WORKFLOWS_DIR>/.token (from a previous auto-generate)
 *   3. Auto-generate: poll Hatchet until ready, login, create token, cache to disk
 */
export async function ensureHatchetToken(): Promise<void> {
  if (process.env.HATCHET_CLIENT_TOKEN) return;

  // Check disk cache first (survives container restarts via Railway volume)
  if (existsSync(TOKEN_CACHE_PATH)) {
    const cached = readFileSync(TOKEN_CACHE_PATH, "utf-8").trim();
    if (cached) {
      process.env.HATCHET_CLIENT_TOKEN = cached;
      console.error("[bootstrap] Loaded Hatchet token from disk cache");
      return;
    }
  }

  // Derive the Hatchet REST base URL
  const baseUrl =
    process.env.HATCHET_REST_URL ??
    (process.env.HATCHET_HOST_PORT
      ? `http://${process.env.HATCHET_HOST_PORT.replace(/:7077$/, ":8080")}`
      : "http://localhost:8080");

  console.error(
    `[bootstrap] HATCHET_CLIENT_TOKEN not set — auto-generating from ${baseUrl}`
  );

  await waitForHatchet(baseUrl);
  const token = await generateToken(baseUrl);

  // Persist so future restarts skip this flow
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  writeFileSync(TOKEN_CACHE_PATH, token, { encoding: "utf-8", mode: 0o600 });

  process.env.HATCHET_CLIENT_TOKEN = token;
  console.error("[bootstrap] Hatchet token generated and cached to disk");
}
