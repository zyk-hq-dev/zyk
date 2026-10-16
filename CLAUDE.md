# zyk — CLAUDE.md

## What zyk is (v2)

zyk is a **durable process layer for AI assistants**. AI assistants can act in all of a user's
tools via MCP, but they have no clock, no durable state, and no memory across days. zyk is the
durable brain; the user's assistant is the worker.

- zyk (on Hatchet) owns process state, timers, waits, retries, approvals, and the audit log.
- The assistant **pulls tasks** from zyk over MCP (fetch-and-lock), executes them with the
  user's own connectors (GitHub, Gmail, CRM, ...), and reports structured results back.
- Human steps are **user tasks**: the assistant asks the user and returns the answer.
- **zyk never stores third-party credentials.**
- Processes come from **playbooks**: versioned, ready-to-use workflows with a fixed backbone and
  typed **extension points** users can customize conversationally.

**The source of truth for design decisions is [`docs/v2-architecture.md`](docs/v2-architecture.md).**
Read it before making changes, and update it (including the decision log) whenever a design
decision is made or changed.

v1 (an MCP server that generated and ran user workflow code) is preserved at tag `v1.0.0` and
branch `v1`. v2 is developed on the `v2` branch. Do not reintroduce code generation or
execution of user-supplied code.

## Status

Milestone 1 is in progress; see the commit plan in `docs/v2-architecture.md` §11.
Done: step 0 (tag/branches/architecture doc), step 1 (v1 removal), step 2 (DB + migrations).

## Stack

- TypeScript, Node 20, ESM (`mcp-server/`)
- `@modelcontextprotocol/sdk` — high-level `McpServer`, stateless Streamable HTTP at `/mcp`
- `@hatchet-dev/typescript-sdk` — the **only** execution engine. Every instance is a Hatchet run;
  every wait, timer, timeout, and retry is a Hatchet durable primitive.
- Postgres — Hatchet's DB plus a separate zyk DB (tasks, instances, audit log, playbook versions)
- Docker Compose for local dev (Postgres + Hatchet Lite + zyk); Railway for hosting

## Core rules

- **One Hatchet workflow per playbook version** (e.g. `incident-triage-v1`), hand-written in
  TypeScript. External steps run as `zyk-step` child runs. Customizations are data passed as
  input, never new code.
- **Hatchet durable tasks replay.** All side effects in playbook code must be idempotent
  (deterministic keys such as `(instance_id, step_key, iteration)`).
- **The zyk DB is the source of truth for task state.** Events only wake waiters.
- **Task claims** are a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
  Complete/fail/extend must check `lock_token` (fencing). No long-held locks.
- **Every state change writes an audit log entry** (append-only).
- **Instructions come only from playbooks/customizations.** External text (mail bodies, issue
  comments, CRM notes) goes in `untrusted_content`, never in `instructions`.
- **No irreversible external action without an approved user task.** Scheduled runs never
  complete user tasks.
- **Errors returned to the assistant must be actionable**: say exactly what is wrong and how
  to fix it.
- `tenant_id` on every tenant-owned table (`playbook_versions` is a global catalog).
- Schema changes are new numbered SQL files in `mcp-server/migrations/`; never edit a migration
  that has been released.

## Working agreements

- Small, reviewable commits with tests.
- Ask before deleting substantial code, adding major dependencies, or changing the stack.
- Tests for locking/claim behaviour run against real Postgres, not mocks.

## Commands

```bash
cd mcp-server
npm install
npm run dev        # tsx src/index.ts
npm run build      # tsc → dist/
npm run typecheck  # src + tests
npm test           # vitest; needs Postgres (drops/recreates zyk_test)
npm run db:migrate # create + migrate the zyk DB (the server also does this on start)
docker compose up -d postgres hatchet-engine   # from repo root
node scripts/generate-token.js                 # Hatchet API token for .env
```

## Ports (local)

- Postgres: localhost:5433 (host port; 5432 inside Compose). DBs: `hatchet`, `zyk`, `zyk_test`
- zyk MCP endpoint: http://localhost:3100/mcp (health: `/healthz`)
- Hatchet REST API: http://localhost:8080 · Web UI: http://localhost:8888 · gRPC: localhost:7077
