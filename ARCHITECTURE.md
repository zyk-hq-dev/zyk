# Zyk — Architecture

## Table of Contents

1. [Overview](#overview)
2. [System Diagram](#system-diagram)
3. [Process Model](#process-model)
4. [Data Flow — Creating a Workflow](#data-flow--creating-a-workflow)
5. [Data Flow — Running a Workflow](#data-flow--running-a-workflow)
6. [Component Reference](#component-reference)
7. [Storage Layout](#storage-layout)
8. [MCP Tool Reference](#mcp-tool-reference)
9. [Workflow Code Contract](#workflow-code-contract)
10. [Key Design Decisions](#key-design-decisions)
11. [Known Limitations](#known-limitations)
12. [Next Steps](#next-steps)

---

## Overview

Zyk bridges two systems: the **Model Context Protocol (MCP)** and **Hatchet** (a durable workflow engine). Claude acts as the user interface and code generator. The MCP server is the glue layer — it takes workflow descriptions from Claude, stores the generated TypeScript, and manages the Hatchet worker subprocesses that execute them.

```
User (natural language)
      ↓
Claude
      ↓  (MCP protocol over stdio)
Zyk MCP Server  ←→  workflows/ (disk: .ts files + registry.json)
      ↓  (fork per workflow)
Worker Subprocesses (one per registered workflow)
      ↓  (gRPC)
Hatchet Engine  (Docker)
      ↓
PostgreSQL  (Docker)
```

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude                                   │
│                                                                 │
│  "Create a workflow that posts Stripe revenue to Slack daily"   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ MCP (stdio)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Zyk MCP Server  (node dist/index.js)                           │
│                                                                 │
│  ┌──────────────┐  ┌────────────┐  ┌───────────┐               │
│  │create_workflow│  │run_workflow│  │ get_status│  ...          │
│  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘               │
│         │                │               │                      │
│  ┌──────▼────────────────▼───────────────▼──────────────────┐  │
│  │  hatchet/register.ts  (workflow registry, in-memory +     │  │
│  │  disk at workflows/registry.json)                         │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                             │  fork()                           │
│    ┌────────────────────────▼──────────────────────────────┐   │
│    │  Worker Subprocess Pool (one process per workflow)     │   │
│    │                                                        │   │
│    │  worker-process.js  →  import(workflow.ts)             │   │
│    │  worker.start()  →  long-running gRPC poll loop        │   │
│    └────────────────────────┬───────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────┘
                              │ gRPC (port 7077)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hatchet Engine  (Docker — hatchet-lite)                        │
│  Dashboard UI at :8080                                          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL  (Docker)                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Process Model

This is the most important thing to understand about Zyk's runtime.

### The MCP server process

`node dist/index.js` — a single long-running Node.js process. It communicates with Claude over **stdio** using the MCP protocol. It is single-threaded and async. All tool calls are handled here. It maintains an **in-memory map** of active worker child processes.

On startup, it reads `workflows/registry.json` and re-forks a worker for every previously registered workflow (so registrations survive MCP server restarts).

### Worker subprocesses (one per workflow)

Each registered workflow gets its own forked child process. The fork runs `dist/hatchet/worker-process.js` with `tsx/esm` as the ESM loader (so it can dynamically `import()` `.ts` source files at runtime without a compile step).

The worker process:
1. `import()`s the workflow's `.ts` file
2. Calls `default.start()` on the exported object
3. Enters a **blocking gRPC poll loop** with Hatchet — waiting for jobs to execute

The worker process runs indefinitely until it is killed by the MCP server (on `delete_workflow` or graceful shutdown). If it crashes, the MCP server detects the exit and removes it from the in-memory map (so `get_status` will correctly report `worker_status: "stopped"`).

### IPC: parent ↔ worker

`child_process.fork()` sets up a message channel. The worker sends one IPC message back to the parent:

```
{ type: "ready", workflowId } — worker has started successfully
{ type: "error", error: "..." } — worker failed to start
```

The parent's `startWorker()` promise resolves/rejects on these messages. After that, IPC is not used — communication goes through Hatchet's gRPC.

---

## Data Flow — Creating a Workflow

```
Claude calls create_workflow({name, description, code, trigger, diagram})
    │
    ▼
src/tools/create-workflow.ts
    │
    ├── validateWorkflowCode(code)         ← static analysis (no execution)
    │       checks: default export, hardcoded secrets, try/catch, Hatchet import
    │
    ├── generate id: "wf-{8 hex chars}"
    │
    └── registerWorkflow(id, name, code, ...)
            │
            ├── saveWorkflowCode(id, code)
            │       writes  workflows/{id}.ts  to disk
            │
            ├── update  workflows/registry.json  (id → WorkflowRegistryEntry)
            │
            └── startWorker(id, filePath)
                    │
                    ├── fork(worker-process.js, [filePath, id], {execArgv: ["--import","tsx/esm"]})
                    │
                    └── wait for IPC { type: "ready" }
                            │
                            ▼
                        Worker process:
                            import(filePath)            ← tsx transpiles .ts on the fly
                            mod.default.start()         ← connects to Hatchet gRPC
                            process.send({ type: "ready" })
```

Return to Claude:
```json
{
  "success": true,
  "workflow_id": "wf-a1b2c3d4",
  "name": "Daily Revenue Report",
  "trigger": "schedule",
  "schedule": "0 8 * * *",
  "created_at": "2026-02-22T09:00:00.000Z",
  "diagram": "flowchart TD\n  A([⏰ Schedule: 0 8 * * *]) --> ..."
}
```

---

## Data Flow — Running a Workflow

```
Claude calls run_workflow({ workflow_id: "wf-a1b2c3d4", params: {} })
    │
    ▼
src/tools/run-workflow.ts
    │
    ├── getWorkflow("wf-a1b2c3d4")    ← lookup in registry.json
    │
    └── hatchet.runNoWait(entry.name, params, {})
            │
            │  HTTP to Hatchet REST API
            ▼
        Hatchet engine creates a WorkflowRun record in PostgreSQL
        and dispatches a job to the worker subprocess via gRPC
            │
            ▼
        Worker subprocess executes each task step in sequence
        Each step is retried independently on failure (Hatchet guarantee)
```

Return to Claude:
```json
{
  "success": true,
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Workflow triggered successfully."
}
```

---

## Component Reference

### `src/index.ts` — MCP Server Entry Point

- Creates the MCP `Server` instance with stdio transport
- Registers tool schemas (JSON Schema, passed to Claude)
- Routes `CallToolRequest` to the appropriate tool function
- On startup: calls `restoreWorkersOnStartup()`
- On `SIGINT`/`SIGTERM`: calls `stopAllWorkers()` then exits

### `src/tools/create-workflow.ts`

Handles `create_workflow`. Generates a short ID, validates the code, delegates to `register.ts`. Returns the result including the diagram if provided.

### `src/tools/run-workflow.ts`

Handles `run_workflow`. Looks up the workflow name, calls `hatchet.runNoWait()`, and returns the `workflowRunId`.

### `src/tools/get-status.ts`

Handles `get_status`. Without `run_id`: returns worker process state from the in-memory map. With `run_id`: calls `hatchet.runs.get_status(run_id)` to query Hatchet.

### `src/tools/list-workflows.ts`

Handles `list_workflows`. Reads `registry.json` and cross-references with the in-memory worker map to report `worker_status`.

### `src/tools/delete-workflow.ts`

Handles `delete_workflow`. Stops the worker subprocess (SIGTERM), deletes the `.ts` file, removes from `registry.json`.

### `src/hatchet/client.ts`

Singleton that lazily calls `Hatchet.init()`. Reads `HATCHET_CLIENT_TOKEN` from env. Used by `run-workflow.ts` and `get-status.ts` to call Hatchet's REST/gRPC APIs.

### `src/hatchet/register.ts`

Owns the workflow registry. Manages:
- `registry.json` on disk (source of truth across restarts)
- Delegating file I/O to `worker.ts`
- Delegating subprocess lifecycle to `worker.ts`
- `restoreWorkersOnStartup()` — re-forks workers on MCP server restart

### `src/hatchet/worker.ts`

Manages the subprocess pool. Owns:
- `Map<workflowId, ChildProcess>` — in-memory worker tracking
- `saveWorkflowCode()` — writes `.ts` to disk
- `startWorker()` — forks `worker-process.js`, waits for `ready` IPC
- `stopWorker()` — sends SIGTERM
- `isWorkerRunning()` — checks if child process is alive

### `src/hatchet/worker-process.ts`

The child process entry point. Compiled to `dist/hatchet/worker-process.js`. At runtime:
1. Receives `filePath` and `workflowId` as argv
2. `import(filePath)` — tsx transpiles the `.ts` workflow on the fly
3. Sends `{ type: "ready" }` to parent — **before** calling `start()`
4. Calls `mod.default.start()` — enters Hatchet's blocking gRPC poll loop (never returns)

### `src/utils/code-runner.ts`

Static code analysis before a workflow is saved. Regex-based. Checks for:
- Missing `export default`
- Hardcoded secrets (OpenAI, Slack, GitHub, AWS patterns)
- `fetch()` calls without `try/catch`
- Missing Hatchet import

### `src/utils/diagram.ts`

Utilities for generating Mermaid `flowchart TD` diagrams from workflow metadata. Intended as a fallback — Claude is expected to generate the diagram itself as part of `create_workflow`.

---

## Storage Layout

```
zyk-mcp/
└── workflows/                      ← created at runtime by the MCP server
    ├── registry.json               ← persisted index of all registered workflows
    ├── wf-a1b2c3d4.ts             ← generated workflow code (Claude-authored)
    ├── wf-b2c3d4e5.ts
    └── ...
```

`registry.json` schema:
```json
{
  "wf-a1b2c3d4": {
    "id": "wf-a1b2c3d4",
    "name": "Daily Revenue Report",
    "description": "Fetches Stripe revenue and posts to Slack",
    "trigger": "schedule",
    "schedule": "0 8 * * *",
    "createdAt": "2026-02-22T09:00:00.000Z",
    "filePath": "/absolute/path/to/workflows/wf-a1b2c3d4.ts"
  }
}
```

---

## MCP Tool Reference

| Tool | Required inputs | Optional inputs | Returns |
|------|----------------|-----------------|---------|
| `create_workflow` | `name`, `description`, `code` | `trigger`, `schedule`, `diagram` | `workflow_id`, `created_at` |
| `update_workflow` | `workflow_id` | `code`, `description`, `trigger`, `schedule`, `diagram` | updated entry |
| `run_workflow` | `workflow_id` | `params` | `run_id` |
| `get_status` | `workflow_id` | `run_id` | worker status or run status |
| `list_workflows` | — | — | array of registered workflows |
| `delete_workflow` | `workflow_id` | — | success/failure |

---

## Workflow Code Contract

Every workflow `.ts` file stored by Zyk must satisfy this contract:

```typescript
// 1. Import Hatchet
import Hatchet from "@hatchet-dev/typescript-sdk";
const hatchet = Hatchet.init();

// 2. Define tasks
const myTask = hatchet.task({
  name: "my-task",
  fn: async (input: MyInput) => { ... }
});

// 3. Define workflow
const myWorkflow = hatchet.workflow({
  name: "my-workflow",      // must match the name used in create_workflow
  steps: [myTask],
  on: { crons: ["0 8 * * *"] }  // for scheduled workflows
});

// 4. Create and start worker — MUST be async top-level await
const worker = await hatchet.worker("my-worker", { workflows: [myWorkflow] });

// 5. Default export MUST have a start() method
export default {
  start: () => worker.start(),
};
```

Rules enforced by `code-runner.ts`:
- `export default` is required (hard error)
- Hatchet import expected (warning)
- Hardcoded secrets detected (warning)
- `fetch()` without `try/catch` (warning)

---

## Key Design Decisions

### One worker process per workflow

Each workflow runs in its own forked process rather than all workflows sharing a single worker. This means:
- **Isolation**: a buggy or crashing workflow does not affect other workflows
- **Simplicity**: each workflow's code is a self-contained module with its own Hatchet client
- **Cost**: more processes, more memory. Acceptable for small teams

### TypeScript executed at runtime via tsx

Workflow files are stored as `.ts` source and executed via `--import tsx/esm`. This means:
- Claude writes TypeScript directly — no compile step between creation and execution
- The full TypeScript ecosystem is available to generated code
- No transpile-then-execute cycle on `create_workflow`

### Disk-persisted registry

`registry.json` is the source of truth. The in-memory worker map is ephemeral and rebuilt from disk on startup. This means:
- Registered workflows survive MCP server restarts
- The registry can be inspected and edited manually

### Hatchet as the execution engine

Rather than building a custom scheduler and retry system, Zyk delegates all durable execution concerns to Hatchet:
- Step-level retries
- Run history and monitoring UI (at `:8080`)
- Cron scheduling
- Workflow run state persistence

Zyk's value-add over raw Hatchet is the **conversational interface** — Claude generates the code and Zyk manages the worker lifecycle.

---

## Known Limitations

### 1. ~~`ready` signal timing bug~~ — Fixed

Moved `process.send({ type: "ready" })` to before `workflow.start()` in `worker-process.ts`. `start()` blocks forever, so the signal must be sent before entering the poll loop.

### 2. Worker liveness check is pid-based, not Hatchet-aware

`isWorkerRunning()` checks whether the child process is alive (`!worker.killed`), not whether the worker has a live gRPC connection to Hatchet. A worker process can be "running" but disconnected (e.g., Hatchet restarted). `get_status` will report `worker_status: "running"` even when the worker is not processing jobs.

**Partial mitigation:** The exit handler now removes the worker from the map on _any_ exit (not just non-zero), so crashed or cleanly exited workers are detected immediately. Full Hatchet-connectivity awareness would require IPC heartbeats from the worker process — deferred.

### 3. ~~No auto-restart of crashed workers~~ — Fixed

Workers now auto-restart with exponential backoff (1s → 2s → 4s … → 60s, max 5 attempts). Intentional stops via `stopWorker()` are tracked in `stoppedIntentionally` so they are not restarted. Retry state is cleared on successful restart or `startWorker()`.

### 4. ~~`filePath` in registry is absolute~~ — Fixed

`registry.json` now stores `fileName` (basename only, e.g. `wf-a1b2c3d4.ts`). The absolute path is resolved at load time by joining with `WORKFLOWS_DIR`. The registry is portable across machine moves and directory renames.

### 5. ~~No workflow update~~ — Fixed

`update_workflow` tool added. Accepts `workflow_id` plus any of `code`, `description`, `trigger`, `schedule`, `diagram`. Stops the current worker, overwrites the code file if needed, updates the registry, and restarts the worker. Workflow ID is preserved.

### 6. ~~No webhook receiver~~ — Fixed

`src/server/webhook.ts` starts an HTTP server alongside the MCP server (default port 3100, overridable via `WEBHOOK_PORT`). `POST /webhook/:workflow_id` parses the JSON body and calls `hatchet.runNoWait()`, returning the `run_id`. Workflows with `trigger: "webhook"` can now be triggered externally.

---

## Next Steps

Ordered by impact.

### Critical — must do before real use

**1. End-to-end smoke test**
Run the full stack with `docker compose up`, get a real Hatchet token, and create a simple workflow through Claude. This will surface integration issues that static analysis can't catch.

**2. Validate env vars on startup**
In `src/index.ts`, check for `HATCHET_CLIENT_TOKEN` before connecting and emit a clear error message if missing, rather than failing on the first tool call.

### High priority — needed for a usable product

**3. Add a `get_runs` tool**
Let Claude (and users) list recent executions of a workflow:
```typescript
hatchet.runs.list({ workflowNames: [entry.name], onlyTasks: false })
```
This makes the product conversationally useful — users can ask "did my revenue report run today?"

**4. Worker Hatchet-connectivity check**
Add IPC heartbeats from the worker process so `get_status` can distinguish "process alive" from "actually connected to Hatchet and processing."

### Medium priority — quality of life

**5. Sandboxing for generated code**
Currently, generated workflow code runs with full Node.js permissions and inherits all parent env vars. For multi-user settings, consider running workers under a restricted OS user or with seccomp.

**6. Webhook auth**
The webhook receiver currently accepts unauthenticated requests. Add HMAC signature verification or a bearer token check before triggering workflows.

### Future / post-MVP

**7. Cloud-hosted option**
Connect to Hatchet Cloud instead of a local Docker instance. The only config change would be `HATCHET_HOST_PORT` and `HATCHET_CLIENT_TOKEN`.

**8. Workflow versioning**
Track code history per workflow — store timestamped `.ts` snapshots so previous versions can be restored.

**9. Multi-user / tenant isolation**
Requires per-user Hatchet tokens, separate workflow namespaces, and auth on the webhook receiver.

**10. NPM publish**
Package as an npm package so users can run `npx zyk-mcp` without cloning the repo.
