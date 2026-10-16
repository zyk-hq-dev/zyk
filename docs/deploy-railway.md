# Deploying zyk on Railway

zyk runs as three Railway services in one project:

| Service | Source | Public? |
|---|---|---|
| `Postgres` | Railway Postgres template | no |
| `hatchet-engine` | Docker image `ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.107.2` | **no** |
| `zyk-mcp` | this repo, root directory `mcp-server/` | yes (HTTPS domain) |

Only `zyk-mcp` gets a public domain. The assistant connects to `https://<zyk-mcp domain>/mcp`
and the optional mail forwarder posts to `/webhooks/...`. Hatchet (UI, REST API, gRPC) is
reached only over Railway's private network.

> **Use a new Railway project for v2.** It keeps a v1 deployment running untouched. It also
> gets a fresh Hatchet admin account with your own password, and private networking with both
> IPv4 and IPv6 (Railway environments created after 2025-10-16 have both; older ones are IPv6 only).

## 1. Postgres

Add **Postgres** from the Railway template. Hatchet uses its default database (`railway`).
zyk creates and migrates its own `zyk` database on first start.

## 2. hatchet-engine

**New service → Docker image** `ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.107.2`, named
`hatchet-engine` (the name is the private DNS name).

**Volume:** mount one at `/config`. Hatchet generates its config there on first start, including
the keys that sign API tokens. Without a volume, every redeploy creates new keys, and zyk's
Hatchet token stops working ("invalid auth token").

**Do not generate a public domain**, and do not add a TCP proxy. zyk reaches Hatchet at
`hatchet-engine.railway.internal`.

Variables:

```
DATABASE_URL                   = ${{Postgres.DATABASE_URL}}
ADMIN_EMAIL                    = <your email>
ADMIN_PASSWORD                 = <long random password>
SERVER_AUTH_COOKIE_SECRETS     = <two random 32+ character strings, space-separated>
SERVER_AUTH_COOKIE_DOMAIN      = hatchet-engine.railway.internal
SERVER_GRPC_BIND_ADDRESS       = 0.0.0.0
SERVER_GRPC_PORT               = 7077
SERVER_GRPC_BROADCAST_ADDRESS  = hatchet-engine.railway.internal:7077
SERVER_GRPC_INSECURE           = t
SERVER_AUTH_SET_EMAIL_VERIFIED = t
SERVER_AUTH_COOKIE_INSECURE    = t
SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD = 168h
```

- `ADMIN_EMAIL` / `ADMIN_PASSWORD` replace Hatchet Lite's built-in development login
  (`admin@example.com` / `Admin123!!`). Hatchet uses them when it creates the admin on first start,
  so set them **before the first deploy** (verified on v0.107.2: the default login is then rejected).
- **Retention:** Hatchet keeps run data, including step results (titles, summaries), for 720h
  (30 days) by default. `SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD` only applies to tenants
  created later; the tenant Hatchet Lite creates on first start keeps 720h (verified on
  v0.107.2, and the tenant API ignores the field). Set it once after the first deploy, e.g.
  with `railway connect Postgres` or the Postgres service's data tab:

  ```sql
  UPDATE "Tenant" SET "dataRetentionPeriod" = '168h';   -- in the Hatchet database (railway)
  ```

  168h (7 days) matches zyk's data minimization. zyk's own audit log and step results live in
  the zyk database and are not affected; mail text never enters Hatchet
  (`docs/v2-architecture.md` §8).
- Generate secrets with `openssl rand -hex 32`.
- Gotcha: `SERVER_GRPC_INSECURE=t` is fine because gRPC never leaves the private network.

If you must look at the Hatchet UI, generate a domain for `hatchet-engine` temporarily and
remove it afterwards. The admin password must not be the default.

## 3. zyk-mcp

**New service → GitHub repo**, branch `v2`, **root directory `mcp-server`**. Railway picks up
`mcp-server/railway.toml` (Dockerfile build, health check on `/healthz`).

Variables:

```
ZYK_DATABASE_URL         = postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/zyk
HATCHET_HOST_PORT        = hatchet-engine.railway.internal:7077
HATCHET_CLIENT_HOST_PORT = hatchet-engine.railway.internal:7077
HATCHET_REST_URL         = http://hatchet-engine.railway.internal:8080
HATCHET_ADMIN_EMAIL      = ${{hatchet-engine.ADMIN_EMAIL}}
HATCHET_ADMIN_PASSWORD   = ${{hatchet-engine.ADMIN_PASSWORD}}
ZYK_UNTRUSTED_RETENTION_DAYS = 14
```

- Without `HATCHET_CLIENT_TOKEN`, zyk logs in to Hatchet with the admin login on first start,
  creates an API token, and caches it in `ZYK_DATA_DIR` (default `./data`). Mount a volume at
  `/data` and set `ZYK_DATA_DIR=/data` to keep the same token across redeploys. Without a volume
  zyk simply creates a new token on each start.
- Alternatively, create a token in the Hatchet UI and set `HATCHET_CLIENT_TOKEN`; then the
  `HATCHET_ADMIN_*` variables are not needed.
- `HATCHET_CLIENT_TLS_STRATEGY=none` is set in the Dockerfile (private network).

**Generate a domain** (Settings → Networking). Then check
`https://<domain>/healthz` → `{"ok":true,"engine":"running"}`. `"starting"` means zyk cannot
reach Hatchet yet; the deploy logs say why.

## 4. Tenant and API keys

Keys live in the zyk database and are shown **once**. Create them inside the running container:

```bash
railway ssh --service zyk-mcp
npm run admin -- tenant:create <your name>        # prints tenant id + MCP key
npm run admin -- webhook-key:create <tenant_id> "mail forwarder"   # optional, for webhooks
npm run admin -- tenant:list
npm run admin -- key:revoke <key prefix>
```

Store the MCP key in your password manager. Then connect your assistant:
[`docs/assistant/claude-setup.md`](assistant/claude-setup.md).

## Updating

- **zyk:** push to `v2`; Railway redeploys. Migrations run on start. Released playbook versions
  are immutable; zyk refuses to start if one was edited.
- **Hatchet:** the image is pinned. To upgrade, read the
  [release notes](https://github.com/hatchet-dev/hatchet/releases), bump the tag here and in
  `docker-compose.yml`, run `npm run test:e2e` locally against the new image, then change the
  Railway image. Upgrades migrate the Hatchet database forward; take a Postgres backup first.
  The pinned version is recorded in `docs/v2-architecture.md` (decision log).

## Security checklist

- [ ] `hatchet-engine` has no public domain and no TCP proxy.
- [ ] `ADMIN_PASSWORD` is set and not the default.
- [ ] A volume is mounted at `/config` on `hatchet-engine`.
- [ ] Hatchet retention is set on the existing tenant (the `UPDATE "Tenant"` statement above).
- [ ] Postgres has no public TCP proxy.
- [ ] API keys are stored in a password manager, not in project files or chats.
- [ ] If a key is in the connector URL (`/mcp/k/<key>`): Railway's HTTP logs show request paths
      to project members. Use the header form where your client supports it, and revoke keys
      you no longer use.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/healthz` says `"engine":"starting"` | zyk cannot reach Hatchet. Check `HATCHET_*` variables and that the service is named `hatchet-engine`. |
| `invalid auth token` in zyk logs | Hatchet keys changed (no `/config` volume) or a stale cached token. Add the volume, delete `/data/.token` (or the cached token), redeploy zyk. |
| `Hatchet login failed (HTTP 401)` | `HATCHET_ADMIN_*` does not match the Hatchet admin. Note that `ADMIN_PASSWORD` only applies at first start. |
| Connection timeouts to `*.railway.internal` | Legacy (IPv6-only) environment. Use a new project, or try `SERVER_GRPC_BIND_ADDRESS=::` (untested). |
| Assistant gets `401 unauthorized` | Wrong key, revoked key, or a webhook key used for MCP (keys are scoped). |
