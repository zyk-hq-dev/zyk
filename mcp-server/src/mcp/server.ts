/**
 * MCP surface (docs/v2-architecture.md §7). One server per request (stateless HTTP); every
 * call is scoped to the authenticated tenant.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { App } from "../app.js";
import { listAuditForInstance } from "../audit/log.js";
import type { AuthContext } from "../auth/keys.js";
import { getInstanceDetails, startInstance } from "../engine/instances.js";
import { ZykError } from "../errors.js";
import {
  completeTask,
  completeUserTask,
  extendLock,
  failTask,
  fetchAndLock,
  releaseTask,
  type TaskRow,
} from "../tasks/store.js";
import {
  formatHistory,
  formatInstance,
  formatLockedTask,
  formatOpenTask,
  formatSteps,
  waitingUntil,
  type TaskContext,
} from "./format.js";
import { SERVER_INSTRUCTIONS, zykWorkPrompt } from "./instructions.js";


const VERSION = "2.0.0-dev";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown): CallToolResult {
  if (err instanceof ZykError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toJSON(), null, 2) }] };
  }
  console.error("[mcp] tool error:", err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "internal_error",
          message: "zyk hit an internal error.",
          hint: "Try the call again in a moment. Nothing was changed if the call did not succeed.",
        }),
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return failure(err);
  }
}

/** Accepts an object, or a JSON string of one (some clients stringify nested arguments). */
const jsonObject = z.union([z.record(z.unknown()), z.string()]);

function parseObject(value: Record<string, unknown> | string, field: string): Record<string, unknown> {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  throw new ZykError("invalid_argument", `\`${field}\` must be a JSON object.`, `Pass ${field} as an object, e.g. {"key": "value"}.`);
}

const taskRef = {
  task_id: z.string().describe("task_id from fetch_and_lock"),
  lock_token: z.string().describe("lock_token from fetch_and_lock"),
};

export function createMcpServer(app: App, auth: AuthContext): McpServer {
  const server = new McpServer({ name: "zyk", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const { pool, catalog } = app;
  const tenantId = auth.tenantId;
  const workerId = (name?: string) => `${name?.trim() || "assistant"}@${auth.keyPrefix}`;

  async function contexts(tasks: TaskRow[]): Promise<Map<string, TaskContext>> {
    const ids = [...new Set(tasks.map((t) => t.instance_id))];
    if (ids.length === 0) return new Map();
    const { rows } = await pool.query<{ id: string; playbook_id: string; playbook_version: string }>(
      "SELECT id, playbook_id, playbook_version FROM instances WHERE id = ANY($1)",
      [ids]
    );
    return new Map(rows.map((r) => [r.id, { playbookId: r.playbook_id, playbookVersion: r.playbook_version }]));
  }

  async function notify(taskId: string) {
    // Without a running engine the outbox publishes once it is up (event_published_at is NULL).
    await app.engine()?.notifyTaskResolved(taskId);
  }

  // ── Worker tools ────────────────────────────────────────────────────────────

  server.registerTool(
    "fetch_and_lock",
    {
      title: "Fetch and lock tasks",
      description:
        "Returns due tasks and locks them for you. Each task has instructions, input, result_schema, " +
        "and a lock_token you need to finish it. System tasks: do the work, then complete_task. " +
        "User tasks: ask the user, then complete_user_task. In unattended runs pass kinds=[\"system\"].",
      inputSchema: {
        kinds: z.array(z.enum(["system", "user"])).optional().describe("Only these task kinds"),
        topics: z.array(z.string()).optional().describe("Only these topics, e.g. [\"github\"]"),
        max_tasks: z.number().int().min(1).max(20).default(5),
        lock_seconds: z.number().int().min(60).max(3600).default(600).describe("How long the lock lasts"),
        worker: z.string().max(64).optional().describe("Name for this worker, e.g. \"scheduled-run\" or \"chat\""),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const tasks = await fetchAndLock(pool, {
          tenantId,
          workerId: workerId(args.worker),
          kinds: args.kinds,
          topics: args.topics,
          maxTasks: args.max_tasks,
          lockSeconds: args.lock_seconds,
        });
        if (tasks.length > 0) {
          const ctx = await contexts(tasks);
          return {
            tasks: tasks.map((t) => formatLockedTask(t, catalog, ctx.get(t.instance_id))),
            summary: `${tasks.length} task(s) locked for ${args.lock_seconds}s. Handle them in order.`,
          };
        }
        const { rows } = await pool.query<{ kind: string; due_later: string; due_now: string; locked: string; next_due: Date | null }>(
          `SELECT kind,
                  count(*) FILTER (WHERE status = 'pending' AND due_at > now()) AS due_later,
                  count(*) FILTER (WHERE status = 'pending' AND due_at <= now()) AS due_now,
                  count(*) FILTER (WHERE status = 'locked') AS locked,
                  min(due_at) FILTER (WHERE status = 'pending' AND due_at > now()) AS next_due
             FROM tasks WHERE tenant_id = $1 AND status IN ('pending', 'locked') GROUP BY kind`,
          [tenantId]
        );
        const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
        const userWaiting = Number(by.user?.due_now ?? 0);
        return {
          tasks: [],
          summary: "No tasks to do right now.",
          ...(userWaiting && args.kinds?.length === 1 && args.kinds[0] === "system"
            ? { user_tasks_waiting: userWaiting, note: "User tasks are waiting for a decision. List them for the user with list_open_tasks." }
            : {}),
          in_progress_elsewhere: rows.reduce((n, r) => n + Number(r.locked), 0),
          next_due_at: rows.map((r) => r.next_due).filter(Boolean).sort()[0] ?? null,
        };
      })
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a system task",
      description:
        "Reports the result of a system task. `result` must match the task's result_schema; if it " +
        "does not, the error lists each problem and the task stays locked to you so you can fix and resend.",
      inputSchema: { ...taskRef, result: jsonObject.describe("Result object matching result_schema") },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { task, repeated } = await completeTask(pool, {
          tenantId,
          taskId: args.task_id,
          lockToken: args.lock_token,
          result: parseObject(args.result, "result"),
          workerId: workerId(),
        });
        if (!repeated) await notify(task.id);
        return { ok: true, task_id: task.id, status: task.status, ...(repeated ? { repeated: true } : {}), next: "Call fetch_and_lock for further tasks." };
      })
  );

  server.registerTool(
    "complete_user_task",
    {
      title: "Record the user's decision",
      description:
        "Records the decision the user gave for a user task. Only call this with an answer the user " +
        "actually stated in this conversation — never decide for them and never in unattended runs.",
      inputSchema: {
        ...taskRef,
        decision: z.string().describe("One of the task's decisions"),
        comment: z.string().max(2000).optional().describe("The user's comment or requested changes, if any"),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { task, repeated } = await completeUserTask(pool, {
          tenantId,
          taskId: args.task_id,
          lockToken: args.lock_token,
          decision: args.decision,
          comment: args.comment,
          decidedVia: "conversation",
          workerId: workerId(),
        });
        if (!repeated) await notify(task.id);
        return { ok: true, task_id: task.id, decision: args.decision, ...(repeated ? { repeated: true } : {}), next: "Call fetch_and_lock for further tasks." };
      })
  );

  server.registerTool(
    "fail_task",
    {
      title: "Fail a system task",
      description:
        "Reports that a system task could not be done. retryable=true for temporary problems " +
        "(the task is offered again later); false for problems a retry cannot fix.",
      inputSchema: {
        ...taskRef,
        error: z.string().min(1).max(2000).describe("What went wrong, specifically"),
        retryable: z.boolean().default(false),
      },
      annotations: { openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { task, repeated } = await failTask(pool, {
          tenantId,
          taskId: args.task_id,
          lockToken: args.lock_token,
          error: args.error,
          retryable: args.retryable,
          workerId: workerId(),
        });
        if (!repeated && task.status === "failed") await notify(task.id);
        return task.status === "pending"
          ? { ok: true, task_id: task.id, status: "retry_scheduled", retry_at: task.due_at }
          : { ok: true, task_id: task.id, status: "failed", note: "The playbook instance handles the failure." };
      })
  );

  server.registerTool(
    "extend_lock",
    {
      title: "Extend a task lock",
      description: "Keeps a task locked to you for `seconds` more, for work that takes longer than the lock.",
      inputSchema: { ...taskRef, seconds: z.number().int().min(60).max(3600) },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const task = await extendLock(pool, {
          tenantId, taskId: args.task_id, lockToken: args.lock_token, seconds: args.seconds, workerId: workerId(),
        });
        return { ok: true, task_id: task.id, lock_expires_at: task.lock_expires_at };
      })
  );

  server.registerTool(
    "release_task",
    {
      title: "Release a task",
      description:
        "Gives a locked task back without a result, e.g. the user wants to decide later or this run " +
        "should not handle it. It is offered again right away and does not count as a failure.",
      inputSchema: taskRef,
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const task = await releaseTask(pool, { tenantId, taskId: args.task_id, lockToken: args.lock_token, workerId: workerId() });
        return { ok: true, task_id: task.id, status: task.status };
      })
  );

  // ── Overview tools ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_open_tasks",
    {
      title: "List open tasks",
      description:
        "Overview for the user: decisions waiting for them, system tasks due or in progress, and " +
        "instances waiting on a timer. Does not lock anything.",
      inputSchema: {
        playbook_id: z.string().optional(),
        instance_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { rows: tasks } = await pool.query<TaskRow>(
          `SELECT t.* FROM tasks t JOIN instances i ON i.id = t.instance_id
            WHERE t.tenant_id = $1 AND t.status IN ('pending', 'locked')
              AND ($2::text IS NULL OR i.playbook_id = $2)
              AND ($3::text IS NULL OR t.instance_id::text = $3)
            ORDER BY t.due_at`,
          [tenantId, args.playbook_id ?? null, args.instance_id ?? null]
        );
        const ctx = await contexts(tasks);
        const fmt = (t: TaskRow) => formatOpenTask(t, catalog, ctx.get(t.instance_id));
        const now = Date.now();

        const { rows: running } = await pool.query(
          `SELECT * FROM instances WHERE tenant_id = $1 AND status = 'running'
              AND ($2::text IS NULL OR playbook_id = $2) AND ($3::text IS NULL OR id::text = $3)
            ORDER BY created_at`,
          [tenantId, args.playbook_id ?? null, args.instance_id ?? null]
        );
        const busy = new Set(tasks.map((t) => t.instance_id));
        const waiting = [];
        for (const instance of running.filter((i) => !busy.has(i.id))) {
          const until = waitingUntil(await listAuditForInstance(pool, tenantId, instance.id));
          waiting.push({ ...formatInstance(instance, catalog), ...(until ? { waiting_until: until } : {}) });
        }

        const userTasks = tasks.filter((t) => t.kind === "user").map(fmt);
        const due = tasks.filter((t) => t.kind === "system" && t.status === "pending" && t.due_at.getTime() <= now).map(fmt);
        const later = tasks.filter((t) => t.kind === "system" && t.status === "pending" && t.due_at.getTime() > now).map(fmt);
        const inProgress = tasks.filter((t) => t.kind === "system" && t.status === "locked").map(fmt);
        return {
          summary:
            `${userTasks.length} decision(s) waiting for the user, ${due.length} system task(s) due, ` +
            `${inProgress.length} in progress, ${later.length} scheduled for retry, ` +
            `${waiting.length} instance(s) waiting on a timer or the engine. ${running.length} running instance(s) in total.`,
          waiting_for_user: userTasks,
          system_tasks_due: due,
          in_progress: inProgress,
          retry_scheduled: later,
          waiting_instances: waiting,
        };
      })
  );

  server.registerTool(
    "start_workflow",
    {
      title: "Start a playbook",
      description:
        "Starts a new instance of a playbook with the given input (see get_playbook for the input " +
        "schema). Starting twice with the same external key (e.g. the same mail Message-ID) returns the existing instance.",
      inputSchema: {
        playbook_id: z.string(),
        input: jsonObject.describe("Input matching the playbook's input_schema"),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { instance, created } = await startInstance(pool, catalog, {
          tenantId,
          playbookId: args.playbook_id,
          input: parseObject(args.input, "input"),
          actor: { type: "worker", id: workerId() },
        });
        const engine = app.engine();
        if (created && engine) await engine.triggerInstance(instance);
        return {
          ...formatInstance(instance, catalog),
          created,
          message: !created
            ? "An instance for this input already exists (same external key); nothing new was started."
            : engine
              ? "Started. Its first tasks will appear in fetch_and_lock shortly."
              : "Created. It starts as soon as the zyk engine is available.",
        };
      })
  );

  server.registerTool(
    "get_instance",
    {
      title: "Get an instance",
      description: "Status, current step, step results, and full history of a playbook instance.",
      inputSchema: { instance_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { instance, tasks, history } = await getInstanceDetails(pool, tenantId, args.instance_id);
        const ctx = { playbookId: instance.playbook_id, playbookVersion: instance.playbook_version };
        const until = instance.status === "running" ? waitingUntil(history) : null;
        return {
          ...formatInstance(instance, catalog),
          ...(until ? { waiting_until: until } : {}),
          input: instance.input,
          config: instance.effective_config,
          steps: formatSteps(tasks, catalog, ctx),
          history: formatHistory(history),
        };
      })
  );

  // ── Playbooks ───────────────────────────────────────────────────────────────

  server.registerTool(
    "list_playbooks",
    {
      title: "List playbooks",
      description: "Playbooks this zyk server can run.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => ({
        playbooks: catalog.list().map((m) => ({
          playbook_id: m.id,
          version: m.version,
          title: m.title,
          description: m.description,
          required_input: (m.input_schema.required ?? []) as string[],
        })),
      }))
  );

  server.registerTool(
    "get_playbook",
    {
      title: "Get a playbook",
      description:
        "A playbook's input schema, its customizable settings (extension points) with current " +
        "values, and its steps.",
      inputSchema: { playbook_id: z.string(), version: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const m = catalog.get(args.playbook_id, args.version);
        if (!m) {
          throw new ZykError(
            "invalid_argument",
            `Unknown playbook ${args.playbook_id}${args.version ? `@${args.version}` : ""}.`,
            `Available: ${catalog.list().map((p) => p.id).join(", ")}. Versions are listed by get_playbook without a version.`
          );
        }
        return {
          playbook_id: m.id,
          version: m.version,
          versions: catalog.versions(m.id),
          title: m.title,
          description: m.description,
          input_schema: m.input_schema,
          external_key: m.external_key,
          untrusted_input: m.untrusted_input ?? [],
          settings: Object.fromEntries(
            Object.entries(m.extension_points).map(([id, ext]) => {
              const { label, description, type, default: current, ...constraints } = ext;
              // M1: no customizations yet, so current values are the defaults.
              return [id, { label, description, type, current, ...constraints }];
            })
          ),
          start: m.start,
          steps: Object.entries(m.steps).map(([key, step]) => ({
            step: key,
            kind: step.kind,
            title: step.title,
            ...(step.kind === "end" ? { outcome: step.outcome } : { next: step.next }),
            ...(step.kind === "system" || step.kind === "user"
              ? {
                  ...(step.irreversible ? { irreversible: true, requires_approval: step.requires_approval } : {}),
                  timeout: step.timeout,
                }
              : {}),
            ...(step.kind === "wait" ? { durations: step.durations } : {}),
          })),
        };
      })
  );

  // ── Prompt ──────────────────────────────────────────────────────────────────

  server.registerPrompt(
    "zyk-work",
    {
      title: "Work through zyk tasks",
      description: "Process due zyk tasks. Use mode \"scheduled\" for unattended runs.",
      argsSchema: { mode: z.enum(["interactive", "scheduled"]).optional() },
    },
    (args) => ({
      messages: [{ role: "user", content: { type: "text", text: zykWorkPrompt(args.mode ?? "interactive") } }],
    })
  );

  return server;
}
