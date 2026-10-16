# Contributing to zyk

Thank you for your interest in contributing! v2 is under active development on the `v2` branch.
Read [`docs/v2-architecture.md`](docs/v2-architecture.md) first — it is the source of truth for
design decisions.

## Dev setup

### Prerequisites

- Node.js 20+
- Docker Desktop (for Hatchet + Postgres)

### 1. Clone and install

```bash
git clone https://github.com/zyk-hq/zyk.git
cd zyk
cd mcp-server && npm install
```

### 2. Start Hatchet

```bash
docker compose up -d postgres hatchet-engine
```

Postgres is published on host port **5433** (override with `POSTGRES_PORT`).

Wait ~15 seconds for Hatchet to initialise, then open http://localhost:8888 to confirm it's running.

### 3. Configure env

```bash
cp .env.example .env
```

Leave `HATCHET_CLIENT_TOKEN` empty to auto-generate one on first start, or create one with
`node scripts/generate-token.js` and set it in `.env`.

### 4. Start the server

```bash
cd mcp-server && npm run dev
```

The server creates and migrates the `zyk` database on start. The MCP endpoint is
http://localhost:3100/mcp (health check: `/healthz`).

### 5. Create an API key

```bash
cd mcp-server && npm run build && npm run admin -- tenant:create local-dev
```

Connect an MCP client with `Authorization: Bearer <key>`, or use
`http://localhost:3100/mcp/k/<key>` if the client cannot send headers. To start workflows from external events (e.g. a mail forwarder), create a webhook key with
`npm run admin -- webhook-key:create <tenant_id>` and POST the playbook input:

```bash
curl -X POST http://localhost:3100/webhooks/incident-triage \n  -H "Authorization: Bearer <webhook key>" -H "Content-Type: application/json" \n  -d '{"message_id":"<m1@example.com>","from":"Ada <ada@example.com>","subject":"Checkout down","body":"…","received_at":"2026-10-16T09:00:00Z"}'
```

For Claude Code:

```bash
claude mcp add --transport http zyk http://localhost:3100/mcp --header "Authorization: Bearer <key>"
```

## Tests

```bash
cd mcp-server
npm test
```

Tests need the Compose Postgres and drop/recreate the `zyk_test` database on every run.

End-to-end tests run the incident-triage playbook on a real Hatchet engine with durations
scaled down (`ZYK_TIME_SCALE=0.001`):

```bash
docker compose up -d postgres hatchet-engine
HATCHET_CLIENT_TOKEN=<token> npm run test:e2e
```

## Typecheck and build

```bash
cd mcp-server
npm run typecheck   # type-check without emitting
npm run build       # compile TypeScript to dist/
```

## Code style

- **TypeScript strict mode** — all types explicit, no implicit `any`
- **Few dependencies** — ask in an issue before adding a major one
- **Minimal abstractions** — three similar lines of code is better than a premature helper
- **Actionable errors** — anything returned to an assistant says what is wrong and how to fix it
- **Tests** — locking and claim behaviour is tested against real Postgres

## Ports (local)

| Service | URL |
|---------|-----|
| zyk MCP endpoint | http://localhost:3100/mcp |
| Postgres | localhost:5433 |
| Hatchet UI | http://localhost:8888 |
| Hatchet REST API | http://localhost:8080 |
| Hatchet gRPC | localhost:7077 |

Hatchet UI credentials (local only): `admin@example.com` / `Admin123!!`

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your changes. Keep commits focused and messages descriptive.
3. Run `npm run typecheck && npm run build` locally.
4. Open a PR against `v2` (or `main` once v2 is merged). Fill in the PR template.
5. A maintainer will review within a few days.

## Reporting bugs

Use the GitHub issue tracker. The bug report template will ask for your Node.js version, Docker
version, and the relevant error output.

## Feature requests

Open a GitHub issue with the feature request template. Describe the use case — which process
would this enable that isn't possible today?
