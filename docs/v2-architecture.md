# zyk v2 — Architecture

> Living document. Updated as decisions are made. Last updated: 2026-10-16.

## 1. Idea

AI assistants can act in all of a user's tools via MCP, but they have no clock, no durable
state, and no memory across days. zyk v2 is the **durable brain**; the user's assistant is the
**worker**.

This is the external task pattern (Camunda fetch-and-lock) with the assistant as the external
worker:

- zyk (on Hatchet) owns process state, timers, waits, retries, approvals, and audit.
- The assistant pulls tasks via MCP, executes them with the user's own connectors (GitHub,
  Gmail, Slack, CRM, ...), and reports structured results back.
- Human steps are **user tasks**: the assistant asks the user and returns the answer.
- **zyk never stores third-party credentials.**
- The protocol is plain MCP tools + instructions, usable by any MCP client with remote-server
  support. Client-specific features (MCP Apps, elicitation) are optional layers with fallbacks.

zyk never wakes the assistant. Workers are triggered by the user ("what's next?") or by a
scheduled cloud run of the assistant (e.g. hourly), which is why zyk is a hosted remote MCP
server (Streamable HTTP).

## 2. Terminology

| Term | Meaning |
|---|---|
| **Playbook** | A ready-to-use, versioned workflow: fixed backbone + declared extension points. Authored by zyk, not by users. |
| **Playbook version** | Immutable release of a playbook (semver). Running instances are pinned to one. |
| **Extension point** | A typed, constrained field of a playbook that users may customize (durations, counts, toggles, templates, instructions). |
| **Customization** | A versioned overlay of extension-point values on top of a playbook (milestone 2). |
| **Instance** | One execution of a playbook (= one Hatchet workflow run). |
| **Task** | One external step of an instance, executed by the assistant. `system` (assistant uses tools) or `user` (assistant asks the human). |
| **Worker** | Any assistant session that fetches and completes tasks. |

## 3. Architecture

```
User's assistant (project chat + scheduled cloud run)
  ├─ Agent ──MCP (Streamable HTTP)──► zyk (hosted)
  │                                    ├─ Task API (MCP tools, prompts, instructions)
  │                                    ├─ Playbook registry + customization service
  │                                    ├─ zyk DB: tasks, instances, audit log (Postgres)
  │                                    ├─ Hatchet engine: one workflow per playbook version
  │                                    └─ Diagram UI (MCP App + browser fallback, milestone 2)
  └─ User's connectors (GitHub, Gmail, ...) — credentials stay here
```

Stack: TypeScript / Node 20, `@modelcontextprotocol/sdk`, `@hatchet-dev/typescript-sdk`,
Postgres. New dependencies for v2: `pg`, `ajv` + `ajv-formats`, `yaml`, `vitest` (dev).

## 4. Hatchet integration

**Hatchet is the execution engine — every instance is a Hatchet run, every wait, timer,
timeout, and retry is a Hatchet durable primitive.** The zyk DB holds only what Hatchet does
not: the assistant-facing task queue, lock tokens, the audit log, and playbook versions.

### 4.1 One specific workflow per playbook version

Each playbook consists of:

- **Workflow code** — a hand-written TypeScript Hatchet workflow (never generated), registered
  at startup under its own name, e.g. `incident-triage-v1`. A new playbook major version is a
  new registration; running instances stay on the code they started with.
- **Manifest** (YAML) — extension points (types, constraints, defaults), per-step task
  templates (instructions, result schema, allowed tools, idempotency key pattern), and the
  step graph used for diagrams.

Customization values are **data**: the effective config (playbook defaults + overlay) is
resolved at instance start, stored on the instance, and passed as workflow input. A
customization never requires a new Hatchet workflow.

Why specific workflows rather than one generic interpreter: traceability in the Hatchet UI
(named runs, per-step status), and full use of Hatchet features (parallelism, child runs,
conditions) as playbooks grow, instead of re-implementing an engine on top of an engine.

### 4.2 External steps as child runs

Each external step runs as a child run of a shared `zyk-step` workflow:

1. Create the zyk task (idempotent on `(instance_id, step_key, iteration)`).
2. Durably wait for `Or(event zyk.task.resolved{task_id}, sleep(timeout))`.
3. On wake, read the task's status from the zyk DB (source of truth), mark it `consumed`,
   return the result or raise the timeout/failure path.

Every step appears in the Hatchet UI as its own linked run, tagged with its step key. Durable
waits ("wait 3 days") are durable sleeps in the parent run.

Playbook code calls steps via a typed helper, e.g. `zyk.systemTask(ctx, "triage", input)`,
which rejects step keys not declared in the manifest. A test asserts that every step the code
can reach exists in the manifest graph, so the diagram cannot drift from the code.

### 4.3 Event delivery (outbox)

Two failure modes: an event published before the waiter is registered, and a DB commit that
succeeds while the Hatchet publish fails. Mitigation:

- `complete_task` commits the result to Postgres first (with `event_published_at`).
- The step run sets `consumed_at` when it proceeds.
- A republisher re-publishes events for tasks that are completed but not consumed after ~30 s.
- On every wake, the step run reads status from the DB, never trusting the event payload.

### 4.4 Replay determinism

Hatchet durable tasks replay from the start after a worker restart. All side effects in
playbook code must be idempotent (deterministic keys). *To verify early in implementation:
whether child spawns from a durable task are deduplicated on replay; if not, use deterministic
child keys.*

### 4.5 Time control in tests

Unit tests use a thin fake of the zyk step context to test playbook logic in milliseconds.
End-to-end tests run against real Hatchet with durations shortened via extension points.

## 5. Data model (zyk DB)

Separate database on the same Postgres server as Hatchet. Every table carries `tenant_id`
from day one.

- `tenants`, `api_keys` (hashed)
- `playbook_versions` — `playbook_id`, `version`, `manifest` jsonb, content hash
- `instances` — `playbook_id`, `playbook_version`, `customization_version`, `effective_config`,
  `status`, `input`, `current_step`, `hatchet_run_id`, `external_key` (dedupe), timestamps
- `tasks` — `id`, `instance_id`, `step_key`, `iteration`, `kind` (`system`|`user`), `topic`,
  `instructions`, `input`, `untrusted_content`, `untrusted_expires_at`, `result_schema`,
  `allowed_tools`, `idempotency_key`, `status` (`pending`|`locked`|`completed`|`failed`|`cancelled`),
  `lock_token`, `locked_by`, `lock_expires_at`, `attempts`, `max_attempts`, `due_at`,
  `result`, `error`, `decided_via`, `event_published_at`, `consumed_at`, timestamps
- `audit_log` — append-only: `id` bigserial, `tenant_id`, `instance_id`, `task_id`,
  `actor_type` (`worker`|`user`|`reaper`|`webhook`|`engine`|`admin`), `actor_id`, `event`,
  `data` jsonb, `at`
- Milestone 2: `customizations` (overlay versions), `customization_proposals`

## 6. Locking semantics

- **Claim** (`fetch_and_lock`) is a single statement:
  `UPDATE tasks SET status='locked', lock_token=gen_random_uuid(), ... , attempts=attempts+1
   WHERE id IN (SELECT id ... WHERE status='pending' AND due_at<=now() ... FOR UPDATE SKIP LOCKED LIMIT n)
   RETURNING *`. Row locks last only for that statement.
- **Fencing:** complete / fail / extend require `id`, `lock_token`, and `status='locked'`.
  Zero rows matched → actionable "stale lock" error.
- **Lease expiry:** the reaper returns expired locks to `pending`, or `failed` when
  `attempts >= max_attempts`.
- **Idempotency keys** cover the crash-after-effect window: every system task instructs the
  worker to check for an existing effect before creating anything.

Delivery is at-least-once; effects are exactly-once via claim + idempotency.

## 7. MCP surface

Worker: `fetch_and_lock`, `extend_lock`, `complete_task`, `fail_task`, `complete_user_task`.
Overview: `list_open_tasks`, `start_workflow`, `get_instance`.
Playbooks: `list_playbooks`, `get_playbook`.
Milestone 2: `propose_customization`, `preview_customization`, `apply_customization`,
`list_versions`, `rollback`, `show_workflow`.
Prompt: `/zyk-work`.
HTTP: `POST /webhooks/:tenant/:playbook_id` (per-tenant secret header, dedupe on external key).

Guidance authority (strongest first): user's project instructions → server instructions +
tool descriptions → `/zyk-work` prompt → per-task instructions → actionable errors.
External text only ever appears in `untrusted_content`.

## 8. Security

- No third-party credentials, ever.
- **Auth (M1):** API key per tenant, carried in the URL path (`/mcp/k/<key>`) because Claude
  custom connectors cannot send custom headers (to be re-verified). Behind an auth interface so
  OAuth can replace it. Keys are created by an admin CLI (`npm run tenant:create`).
- **Approvals:** user tasks gate every irreversible external action. Scheduled runs never
  complete user tasks — they summarize them for the user. Each decision records `decided_via`
  (`conversation` | `elicitation` | `ui`). When the client supports MCP elicitation, approvals
  use it. Milestone 2: approvals via MCP App buttons.
- **Data minimization:** store process data and results, not full mail bodies.
  `untrusted_content` is purged after 14 days (configurable).
- The Hatchet UI and admin login are not exposed publicly on the hosted deployment.

## 9. Playbooks

### 9.1 Format

Manifest in YAML (comments, multi-line instructions), validated against a JSON Schema
meta-schema. Extension point types: `duration`, `integer`, `boolean`, `enum`, `string_list`,
`template`, `text`, `branch_toggle`. Branch conditions use a small built-in language
(`eq`, `in`, `not`, `and`, `or`, `exists`) — no `eval`.

### 9.2 Customization overlay (milestone 2, designed now)

Overlay = map of `extension_point_id → value`. Effective config = playbook defaults ⊕ overlay,
validated against the manifest. On playbook upgrade, conflicts (removed keys, changed types,
values now violating constraints) are flagged to the user, never dropped. Backbone edits are
not expressible. Rollback = switch to a previous overlay version. Instances stay pinned.

### 9.3 Milestone 1 playbook: incident triage (mail → GitHub)

1. **Trigger:** the scheduled run finds new incident mails and calls `start_workflow`
   (default), or a webhook from a mail forwarder. Dedupe on Message-ID.
2. **System task `triage`:** classify severity, search open GitHub issues for duplicates,
   summarize. Mail body is `untrusted_content`. Result `{severity, duplicate_of?, summary}`.
3. If duplicate: **system task** comment on the existing issue → end.
4. **User task `confirm`:** confirm severity and approve issue creation
   *(optional branch: auto-create for configured severities)*.
5. **System task `create_issue`** (idempotency key = Message-ID).
6. **System task** draft acknowledgement → **user task** approve → **system task** send.
7. **Durable wait:** SLA by severity *(extension point; defaults sev1 4h, sev2 1d, sev3 3d)*.
8. **System task `check_status`:**
   - closed → draft resolution mail → approve → send → end;
   - open without activity → escalate (mention assignee on the issue, notify the user) →
     back to 7; after N rounds *(default 3)* mark stale.

Extension points: severity rules, SLAs, auto-create severities, escalation rounds,
escalation target, three mail templates.

A lead follow-up playbook follows later as the second playbook.

## 10. Repository

- `v1.0.0` tag and `v1` branch preserve v1 (code-generating MCP server).
- v2 is built on the `v2` branch. v1 code generation and user-code workers are removed.
- Reuse references for milestone 2 (diagram MCP App): the v1 dashboard's Mermaid rendering,
  pan/zoom (`initDiagramZoom`), and theme live in `v1.0.0:mcp-server/src/server/webhook.ts`
  (inline script, ~lines 576–725). The structured Mermaid generator is kept in
  `mcp-server/src/utils/diagram.ts` and will move to `playbooks/diagram.ts`.

```
mcp-server/src/
  index.ts              http: auth, /mcp, /webhooks, /healthz
  mcp/                  server, instructions, prompts, tools/, errors
  tasks/                store (claim/extend/complete/fail), reaper, outbox
  audit/                log
  engine/               hatchet client, zyk-step workflow, step helper
  playbooks/            meta-schema, loader, resolve, conditions, diagram
  db/                   pool, migrate, migrations/*.sql
mcp-server/playbooks/incident-triage/   manifest.yaml, workflow.ts, samples.json
mcp-server/test/        unit/, integration/, sim-worker.ts
docs/                   v2-architecture.md, assistant/
```

## 11. Milestone 1 commit plan

0. Tag v1, branches, this document.
1. Strip v1, rewrite CLAUDE.md, fix Compose.
2. DB pool, migrations, schema.
3. Task store + reaper + audit, with race/lease tests on real Postgres.
4. Playbook meta-schema, loader, conditions, incident-triage manifest + validation tests.
5. Hatchet integration: `zyk-step` child workflow, outbox, incident-triage workflow code.
6. MCP tools, server instructions, `/zyk-work`, auth.
7. Webhook trigger.
8. Simulated worker + end-to-end suite (concurrency, crash, stale, invalid results).
9. Assistant docs + Railway deployment.

## 12. Decision log

| Date | Decision |
|---|---|
| 2026-10-16 | Keep TypeScript stack and Hatchet; Hatchet is the sole execution engine. |
| 2026-10-16 | One specific Hatchet workflow per playbook version; external steps as `zyk-step` child runs. |
| 2026-10-16 | Outbox + DB-as-source-of-truth for task completion events. |
| 2026-10-16 | Claim via single `UPDATE … FOR UPDATE SKIP LOCKED` statement; fencing via lock token. |
| 2026-10-16 | Manifests in YAML + JSON Schema; overlays as extension-point value maps. |
| 2026-10-16 | Milestone 1 demo is incident triage (mail → GitHub); lead follow-up later. |
| 2026-10-16 | M1 auth: API key in URL path; admin CLI creates tenants/keys. |
| 2026-10-16 | Approvals: scheduled runs never complete user tasks; `decided_via` recorded; elicitation when supported. |
| 2026-10-16 | Default trigger for incident mails: scheduled run polls inbox; webhook documented. |
| 2026-10-16 | "Pack" renamed to **playbook**. |

## 13. Open items

- Verify current Claude custom-connector auth options (header vs URL key vs OAuth).
- Verify Hatchet child-spawn dedupe on durable-task replay.
