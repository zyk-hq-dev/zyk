#!/usr/bin/env node
/**
 * Admin commands (run where the server's ZYK_DATABASE_URL is set):
 *   npm run admin -- tenant:create <name>        creates a tenant and prints its first API key
 *   npm run admin -- tenant:list
 *   npm run admin -- key:create <tenant_id> [label]
 *   npm run admin -- key:revoke <key_prefix>
 */
import "../env.js";
import { createApiKey, createTenant, revokeApiKey } from "../auth/keys.js";
import { migrate } from "../db/migrate.js";
import { closePool, databaseUrl, ensureDatabase, getPool } from "../db/pool.js";

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error("Usage: admin tenant:create <name> | tenant:list | key:create <tenant_id> [label] | key:revoke <key_prefix>");
  process.exit(1);
}

try {
  await ensureDatabase(databaseUrl());
  await migrate(getPool());
  const pool = getPool();

  switch (command) {
    case "tenant:create": {
      if (!args[0]) usage();
      const { tenantId, key } = await createTenant(pool, args.join(" "));
      console.log(`Tenant: ${tenantId}`);
      console.log(`API key (shown once, store it now): ${key}`);
      break;
    }
    case "tenant:list": {
      const { rows } = await pool.query(
        `SELECT t.id, t.name, t.created_at,
                count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys,
                string_agg(k.key_prefix, ', ') FILTER (WHERE k.revoked_at IS NULL) AS key_prefixes
           FROM tenants t LEFT JOIN api_keys k ON k.tenant_id = t.id
          GROUP BY t.id ORDER BY t.created_at`
      );
      console.table(rows);
      break;
    }
    case "key:create": {
      if (!args[0]) usage();
      console.log(`API key (shown once, store it now): ${await createApiKey(pool, args[0], args[1])}`);
      break;
    }
    case "key:revoke": {
      if (!args[0]) usage();
      console.log(`Revoked ${await revokeApiKey(pool, args[0])} key(s)`);
      break;
    }
    default:
      usage();
  }
} finally {
  await closePool();
}
