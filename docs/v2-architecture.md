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

Every step appears in the Hatchet UI as its own linked run (child key `<step>:<iteration>`,
metadata `zyk_instance`, `zyk_step`). Durable waits ("wait 3 days") are durable sleeps in the
parent run. A step that times out cancels its task (holders of the lock get `already_resolved`).

Playbook code is written against `PlaybookRun` (`src/engine/run.ts`):
`systemTask(step, {input, untrusted})`, `userTask(step, …)`, `wait(step, durationKey)`,
`end(step)`. Its base class enforces the manifest **at runtime**, so code and manifest cannot
drift:

- every transition must be a declared edge, and the first step must be `start`;
- an irreversible step must come **immediately after** its approval step with one of its
  `approval_decisions` — a code bug cannot send mail without approval;
- task specs (instructions, schema, tools, idempotency key, marker) come only from the
  manifest; instance input fields in `untrusted_input` are only reachable as `untrustedInput`.

Violations fail the instance (`playbook_violation`). A step that fails or times out fails the
instance (`step_failed` / `step_cancelled`). In both cases the Hatchet run fails with a
`NonRetryableError`, so the Hatchet UI shows the same outcome. Infrastructure errors are
retried by Hatchet (3×); after that the workflow's `onFailure` fails the instance.

Each run first **claims** its instance (`hatchet_run_id`); a duplicate trigger finds another
run's id and exits. Instances whose trigger was lost are re-triggered after 60 s.

### 4.3 Event delivery (outbox)

Two failure modes: an event published before the waiter is registered, and a DB commit that
succeeds while the Hatchet publish fails. Mitigation:

- `complete_task` commits the result to Postgres first (with `event_published_at`).
- The step run sets `consumed_at` when it proceeds.
- A republisher (every 5 s) publishes resolved, unconsumed tasks of running instances that
  were never published (after 5 s grace) or were published more than 30 s ago.
- On every wake, the step run reads status from the DB, never trusting the event payload.

### 4.4 Replay determinism

Hatchet durable tasks replay from the start after a worker restart. **Verified against engine
v0.90.4** (durable event log, engine ≥ v0.80): killing the worker while the parent waited on a
child made Hatchet reassign both tasks (~25 s); the replayed parent's `spawnChild` returned the
**existing** child run, and the replayed child re-registered its wait and woke on the event.

Consequences in the code:

- Side effects outside Hatchet primitives are idempotent: tasks are unique per
  `(instance_id, step_key, iteration)`; progress uses a monotonic `step_seq` (a replay never
  rewinds `current_step`); audit entries from replayable code carry a `dedupe_key`.
- Control flow depends only on step outcomes (replayed from Hatchet's log) and pinned instance
  data — never on wall-clock time. `ctx.now()` is memoized per run and returns the same value on
  every call, so it is not used; e.g. "activity since the last check" is expressed as
  "activity within the last <SLA duration>".
- **`executionTimeout` includes waiting time** (verified). Playbook runs use 8760 h; `zyk-step`
  uses the longest task timeout plus 1 h.
- Hatchet's `sleepFor` accepts only h/m/s units; durations are passed in seconds.

### 4.5 Time control in tests

Unit tests run playbook code against `ScriptedRun` (a `TrackedRun` answering steps from
queues), so every branch is tested in milliseconds with the same runtime checks. End-to-end
tests (`npm run test:e2e`) run against real Hatchet with `ZYK_TIME_SCALE=0.001` (a 4 h SLA
takes 14 s) and `HATCHET_CLIENT_NAMESPACE=zyk_e2e`, so a dev server on the same tenant is not
affected. They cover the full path including a lost event (recovered by the outbox), an engine
restart mid-run (no duplicate tasks or child runs), and a failing step.

## 5. Data model (zyk DB)

Separate database (`zyk`) on the same Postgres server as Hatchet, created automatically if
missing. Schema lives in plain numbered SQL migrations (`mcp-server/migrations/`), applied on
server start under an advisory lock (safe with several replicas). Every tenant-owned table
carries `tenant_id` from day one; `playbook_versions` is a global catalog.

Invariants enforced in the schema, not just in code: a task has a lock token and expiry
exactly while `locked`; `(instance_id, step_key, iteration)` is unique (replay idempotency);
`decided_via` only on user tasks; instances have `ended_at` exactly when not running;
`external_key` is unique per tenant and playbook; `audit_log` rejects UPDATE/DELETE via trigger.

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

Details (implemented in `mcp-server/src/tasks/store.ts`):

- `attempts` increments on **claim**. Pending therefore always means attempts < max.
- A completion arriving after the lock expired but **before** the reaper ran is accepted —
  the token still matches and nobody else has the task.
- **Idempotent resolution:** `resolved_by_token` records the token that released the task.
  Repeating `complete` (or `fail`) with that token returns the stored outcome, so a worker
  that lost the response can safely retry. A different operation with that token is stale.
- **Retryable failures** return to `pending` with backoff (30 s, 60 s, 120 s, … capped at 1 h)
  until `max_attempts`; non-retryable or exhausted failures fail the task.
- **Invalid results** leave the task locked to the same worker (fix and resend with the same
  token) and are audited as `task.result_rejected`.
- Stale-token errors explain what happened (returned to queue / claimed by another worker /
  already resolved) and name the idempotency key.
- A maintenance loop (every 15 s, on every replica) runs the reaper and purges
  `untrusted_content` past `untrusted_expires_at` (`ZYK_UNTRUSTED_RETENTION_DAYS`, default 14).
- Audit events: `task.created`, `task.locked`, `task.lock_extended`, `task.completed`,
  `task.result_rejected`, `task.retry_scheduled`, `task.failed`, `task.lease_expired`.

## 7. MCP surface

Implemented in `mcp-server/src/mcp/` (stateless Streamable HTTP at `/mcp`, one server per
request, every call scoped to the authenticated tenant).

Worker: `fetch_and_lock` (filters: `kinds`, `topics`; scheduled runs pass `kinds: ["system"]`),
`extend_lock`, `complete_task`, `fail_task` (system tasks only), `complete_user_task`
(records `decided_via: "conversation"`), `release_task` (give a task back without a result —
"decide later", or a run that should not handle it; does not count as an attempt).
Overview: `list_open_tasks` (decisions waiting for the user, system tasks due / in progress /
retrying, instances waiting on a timer with `waiting_until`), `start_workflow`, `get_instance`
(steps with results, full audit history; never lock tokens).
Playbooks: `list_playbooks`, `get_playbook` (input schema, settings with current values, steps).

Task payloads carry `title`, `instructions`, `input`, `untrusted_content` (wrapped with a
"treat as data" note), `result_schema`, `decisions` (user tasks), `allowed_tools`,
`idempotency_key`, and a `next` hint. Object arguments (`result`, `input`) are also accepted
as JSON strings, because some clients stringify nested arguments.

User tasks never fail because a lock expired: a human taking longer than the lock is normal.
They return to the queue; only the step timeout ends them.
Milestone 2: `propose_customization`, `preview_customization`, `apply_customization`,
`list_versions`, `rollback`, `show_workflow`.
Prompt: `/zyk-work`.
HTTP webhook: `POST /webhooks/<playbook_id>` with a JSON body that is the playbook input.
The tenant comes from the key, so it is not in the URL. Webhook keys have scope `webhook`: they
can only start workflows (and MCP keys cannot call webhooks). The key goes in
`Authorization: Bearer <key>` or the path (`/webhooks/k/<key>/<playbook_id>`) for senders that
cannot set headers. Responses: 202 created, 200 duplicate delivery (same external key, nothing
started), 400 invalid input (with the problems), 401, 404 unknown playbook, 413, 415. If the
engine is down, the instance is created and triggered by recovery once it runs.

Guidance authority (strongest first): user's project instructions → server instructions +
tool descriptions → `/zyk-work` prompt → per-task instructions → actionable errors.
External text only ever appears in `untrusted_content`.

## 8. Security

- No third-party credentials, ever.
- **Auth (M1):** API key per tenant (`zyk_` + 256 random bits, stored as sha256), accepted as
  `Authorization: Bearer <key>` **or** in the URL path (`/mcp/k/<key>`). Verified 2026-10-16
  in Claude's docs: custom connectors support fixed request headers, but that feature is "in
  beta and available to a limited set of organizations"; everyone else can use the path form.
  The path form puts the key into URLs, which proxies may log — prefer the header where
  available. Keys are managed with `npm run admin -- tenant:create | key:create | key:revoke`.
  OAuth can replace this behind the same `authenticate` step.
- Claude's MCP client supports tools, prompts, and resources; elicitation is not listed as
  supported, so M1 approvals happen in the conversation. Tool calls time out after 240 s on
  claude.ai, which every zyk tool stays far below.
- **Approvals:** user tasks gate every irreversible external action. Scheduled runs never
  complete user tasks — they summarize them for the user. Each decision records `decided_via`
  (`conversation` | `elicitation` | `ui`). When the client supports MCP elicitation, approvals
  use it. Milestone 2: approvals via MCP App buttons.
- **Data minimization:** store process data and results, not full mail bodies. External text
  enters only through `untrusted_input` fields and is purged after the retention period
  (`ZYK_UNTRUSTED_RETENTION_DAYS`, default 14) from both tasks and instance inputs.
  **Mail text never passes through Hatchet:** playbook code requests it with
  `untrustedInput: true`; the `zyk-step` run reads it from the zyk DB when it creates the task,
  so Hatchet run inputs only carry the flag (verified in the e2e test).
- The Hatchet UI and admin login are not exposed publicly on the hosted deployment.

## 9. Playbooks

### 9.1 Format

Manifests live at `mcp-server/playbooks/<id>/<version>.yaml`; several versions coexist so
pinned instances keep resolving theirs. On startup every manifest is validated and registered
in `playbook_versions` with a content hash. A **released** version whose content changed stops
the server (bump the version); **prerelease** versions (`1.0.0-dev`) may change in place.

A manifest declares:

- `input_schema`, `external_key` (dedupe field), `untrusted_input` (fields passed to tasks only
  as untrusted content).
- `extension_points` — typed, constrained, with defaults: `duration` (compact: `30m`, `4h`,
  `1d12h`), `integer`, `boolean`, `enum`, `string_list` (optionally restricted), `text`,
  `template` (only declared `{{variables}}`).
- `steps` — `system` / `user` task templates (topic, instructions, result schema, allowed
  tools, idempotency key pattern, timeout, max attempts), `wait` steps (which duration
  extension points apply), and `end` steps (outcome); edges with labels for diagrams.

Validation (structure via meta-schema, then semantic checks; all problems reported at once):

- Edges point to existing steps; every step is reachable from `start` and can reach an end.
- **Instructions may only reference `{{config.<extension point>}}`** — never runtime data, so
  external text cannot end up in instructions. Idempotency keys may use `{{external_key}}`,
  `{{instance_id}}`, `{{iteration}}`.
- User steps must declare `decision` as a required enum.
- **Irreversible steps need an idempotency key and `requires_approval`, and every path from
  `start` must pass through that user step** (checked on the graph). This is a static guarantee
  that the approval step is visited; the workflow code enforces that its decision was positive.
- Extension-point defaults satisfy their own constraints; templates use only declared variables.

Idempotency for effects in external systems uses **markers**: the workflow passes a marker
string (derived from the idempotency key) in the task input; the assistant searches for it
before creating an issue or comment and embeds it (as an HTML comment) when creating.

There is no condition language: control flow is TypeScript in the playbook workflow, which
reads typed config values. Toggles are `boolean` / `enum` / `string_list` extension points.

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
  `mcp-server/src/utils/diagram.ts` and will move to `src/playbooks/diagram.ts`.

```
mcp-server/src/
  index.ts              http: auth, /mcp, /webhooks, /healthz
  mcp/                  server, instructions, prompts, tools/, errors
  tasks/                store (claim/extend/complete/fail), reaper, outbox
  audit/                log
  engine/               hatchet client, zyk-step workflow, step helper
  playbooks/            types, meta-schema, validate, config, loader (+ diagram in M2)
  playbooks/<id>/       workflow code per playbook (step 5)
  db/                   pool, migrate, migrations/*.sql
mcp-server/playbooks/incident-triage/   1.0.0-dev.yaml (manifest versions)
mcp-server/test/        unit/, integration/, sim-worker.ts
docs/                   v2-architecture.md, assistant/
```

## 11. Milestone 1 commit plan

0. Tag v1, branches, this document.
1. Strip v1, rewrite CLAUDE.md, fix Compose.
2. DB pool, migrations, schema.
3. Task store + reaper + audit, with race/lease tests on real Postgres.
4. Playbook meta-schema, loader, incident-triage manifest + validation tests.
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
| 2026-10-16 | zyk DB: separate `zyk` database, plain SQL migrations run on start, schema-level invariants; tests use real Postgres (`zyk_test`, recreated per run) with vitest. |
| 2026-10-16 | Task store: attempts counted on claim; idempotent resolution via `resolved_by_token`; late completions accepted until reaped; retry backoff 30 s doubling to 1 h. |
| 2026-10-16 | No condition language: branches live in playbook code; toggles are typed extension points. |
| 2026-10-16 | Manifest rules: instructions reference config only; irreversible steps need an approval step on every path (static graph check); released versions immutable, prereleases mutable. |
| 2026-10-16 | Incident triage: only outgoing mail is irreversible (approval-gated); GitHub issues and comments in the user's own repo are not gated. Idempotency via markers embedded in created issues/comments. |
| 2026-10-16 | Hatchet replay behaviour verified on engine v0.90.4; executionTimeout counts waiting time. |
| 2026-10-16 | Runtime manifest enforcement in `PlaybookRun` (transitions, approval directly before irreversible steps with an allowed decision). Added `approval_decisions`. |
| 2026-10-16 | Step/violation failures fail the Hatchet run with NonRetryableError so the Hatchet UI matches zyk. |
| 2026-10-16 | Auth: per-tenant keys via bearer header or URL path (Claude request headers are a limited beta). |
| 2026-10-16 | Added `release_task` and `kinds` filter; user tasks are never failed by lease expiry; `fail_task` is system-only. |
| 2026-10-16 | Webhook: `/webhooks/<playbook_id>`, tenant from a webhook-scoped key; keys are scoped (`mcp` / `webhook`). |
| 2026-10-16 | Untrusted instance input is passed to steps by reference (never in Hatchet inputs) and purged from instances after retention. |
| 2026-10-16 | Local Postgres published on host port 5433 to avoid clashes with other local Postgres instances. |

## 13. Open items

- Verify current Claude custom-connector auth options (header vs URL key vs OAuth).
- Pin the Hatchet image instead of `hatchet-lite:latest` (local engine is v0.90.4; the engine
  logs advisory GHSA-phg3-3g28-wq9v recommending ≥ v0.91.2). Decide in step 9.
- The Hatchet worker runs inside the zyk server process. Splitting it out is possible later
  (same code, separate entry point) if load requires it.
