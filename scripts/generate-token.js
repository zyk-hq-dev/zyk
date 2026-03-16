#!/usr/bin/env node
/**
 * Generates a Hatchet API token via the REST API.
 * Works with both local HTTP and Railway HTTPS deployments.
 *
 * Usage:
 *   node scripts/generate-token.js
 *
 * Environment variables:
 *   HATCHET_BASE_URL   Full base URL — takes precedence over the two below.
 *                      Local:   http://localhost:8080  (default)
 *                      Railway: https://hatchet-engine.up.railway.app
 *   HATCHET_API_HOST   Hostname only (default: localhost)
 *   HATCHET_API_PORT   Port only     (default: 8080)
 *
 * Prints the token to stdout, errors to stderr. Exit 0 on success, 1 on failure.
 */

"use strict";

const http  = require("http");
const https = require("https");

// ── Resolve base URL ──────────────────────────────────────────────────────────

const rawBase =
  process.env.HATCHET_BASE_URL ||
  `http://${process.env.HATCHET_API_HOST || "localhost"}:${process.env.HATCHET_API_PORT || "8080"}`;

let parsedBase;
try {
  parsedBase = new URL(rawBase);
} catch {
  process.stderr.write(`Invalid HATCHET_BASE_URL: "${rawBase}"\n`);
  process.exit(1);
}

const isHttps = parsedBase.protocol === "https:";
const driver  = isHttps ? https : http;
const HOST    = parsedBase.hostname;
const PORT    = parseInt(parsedBase.port || (isHttps ? "443" : "8080"), 10);

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = driver.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: opts.method || "GET",
        headers: {
          ...(opts.headers || {}),
          ...(bodyStr
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : {} });
          } catch {
            reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Login with default admin credentials
  const loginRes = await request("/api/v1/users/login", {
    method: "POST",
    body: { email: "admin@example.com", password: "Admin123!!" },
  });

  if (loginRes.status !== 200) {
    process.stderr.write(
      `Login failed (HTTP ${loginRes.status}): ${JSON.stringify(loginRes.body)}\n`
    );
    process.exit(1);
  }

  const cookie = (loginRes.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .join("; ");

  if (!cookie) {
    process.stderr.write("No session cookie in login response\n");
    process.exit(1);
  }

  // 2. Get tenant memberships
  const membershipsRes = await request("/api/v1/users/memberships", {
    headers: { Cookie: cookie },
  });

  if (membershipsRes.status !== 200) {
    process.stderr.write(
      `Failed to get memberships (HTTP ${membershipsRes.status}): ${JSON.stringify(membershipsRes.body)}\n`
    );
    process.exit(1);
  }

  const rows = membershipsRes.body.rows || [];
  if (rows.length === 0) {
    process.stderr.write(
      "No tenant memberships found for admin user.\n" +
        "Make sure Hatchet has finished initializing and try again.\n"
    );
    process.exit(1);
  }

  const tenantId = rows[0].tenant?.metadata?.id;
  if (!tenantId) {
    process.stderr.write(
      `Could not extract tenant ID:\n${JSON.stringify(rows[0], null, 2)}\n`
    );
    process.exit(1);
  }

  // 3. Create an API token for this tenant
  const tokenRes = await request(`/api/v1/tenants/${tenantId}/api-tokens`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: { name: `zyk-${Date.now()}` },
  });

  if (tokenRes.status !== 200 && tokenRes.status !== 201) {
    process.stderr.write(
      `Token creation failed (HTTP ${tokenRes.status}): ${JSON.stringify(tokenRes.body)}\n`
    );
    process.exit(1);
  }

  const token = tokenRes.body.token;
  if (!token) {
    process.stderr.write(
      `No token field in response: ${JSON.stringify(tokenRes.body)}\n`
    );
    process.exit(1);
  }

  process.stdout.write(token);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
