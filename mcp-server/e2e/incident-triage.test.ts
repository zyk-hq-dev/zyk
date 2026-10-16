/**
 * End-to-end: real Hatchet engine, real Postgres, a scripted worker standing in for the
 * assistant. Durations are scaled by ZYK_TIME_SCALE=0.001 (4h SLA → 14s).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listAuditForInstance } from "../src/audit/log.js";
import { getInstanceDetails, startInstance, type InstanceRow } from "../src/engine/instances.js";
import { startHatchetEngine, type Engine } from "../src/engine/hatchet.js";
import { loadPlaybooks, PlaybookCatalog, registerPlaybooks } from "../src/playbooks/loader.js";
import { completeTask, completeUserTask, fetchAndLock, type TaskRow } from "../src/tasks/store.js";
import { insertTenant, resetData, testPool } from "../test/helpers/db.js";

if (!process.env.HATCHET_CLIENT_TOKEN) {
  throw new Error("HATCHET_CLIENT_TOKEN is not set (create one with: node scripts/generate-token.js)");
}

const pool = testPool();
const playbooks = loadPlaybooks();
const catalog = new PlaybookCatalog(playbooks);
let engine: Engine;
let tenant: string;

beforeAll(async () => {
  await resetData(pool);
  await registerPlaybooks(pool, playbooks);
  engine = await startHatchetEngine({ pool, catalog });
});

afterAll(async () => {
  await engine?.stop();
  await pool.end();
});

beforeEach(async () => {
  tenant = await insertTenant(pool, `e2e-${Date.now()}`);
});

type Answer = { result?: Record<string, unknown>; decision?: string; comment?: string; silent?: boolean };

/**
 * Plays the assistant: fetches due tasks and answers them from per-step queues. `silent`
 * answers skip the resolution event, so only the outbox can wake the step.
 */
async function work(
  instance: InstanceRow,
  answers: Record<string, Answer[]>,
  opts: { until?: (task: TaskRow) => boolean; timeoutMs?: number } = {}
): Promise<string[]> {
  const handled: string[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);
  for (;;) {
    const details = await getInstanceDetails(pool, tenant, instance.id);
    if (details.instance.status !== "running") return handled;
    if (Date.now() > deadline) {
      throw new Error(`Timed out at ${details.instance.current_step}; handled ${handled.join(", ")}`);
    }
    const tasks = await fetchAndLock(pool, { tenantId: tenant, workerId: "sim", maxTasks: 5, lockSeconds: 60 });
    for (const task of tasks) {
      if (opts.until?.(task)) return handled;
      const answer = answers[task.step_key]?.shift();
      if (!answer) throw new Error(`No scripted answer for ${task.step_key}`);
      if (task.kind === "user") {
        await completeUserTask(pool, {
          tenantId: tenant, taskId: task.id, lockToken: task.lock_token!,
          decision: answer.decision!, comment: answer.comment, decidedVia: "conversation", workerId: "sim",
        });
      } else {
        await completeTask(pool, {
          tenantId: tenant, taskId: task.id, lockToken: task.lock_token!, result: answer.result ?? {}, workerId: "sim",
        });
      }
      if (!answer.silent) await engine.notifyTaskResolved(task.id);
      handled.push(task.step_key);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const mail = (id: string) => ({
  message_id: id,
  from: "Ada Lovelace <ada@example.com>",
  subject: "Checkout is down",
  body: "Nobody can pay since 9:00.",
  received_at: "2026-10-16T09:00:00Z",
});

const triage = {
  severity: "sev1", title: "Checkout is down", summary: "Customers cannot pay since 9:00.", reporter_name: "Ada Lovelace",
};
const issue = { issue_number: 42, issue_url: "https://github.com/acme/shop/issues/42" };

async function start(messageId: string): Promise<InstanceRow> {
  const { instance } = await startInstance(pool, catalog, {
    tenantId: tenant, playbookId: "incident-triage", input: mail(messageId), actor: { type: "webhook" },
  });
  await engine.triggerInstance(instance);
  return instance;
}

describe("incident-triage on Hatchet", () => {
  it("runs to resolution through tasks, an SLA wait, and a lost event", async () => {
    const instance = await start(`<happy-${Date.now()}@example.com>`);
    const handled = await work(instance, {
      triage: [{ result: triage, silent: true }], // only the outbox can deliver this one
      confirm: [{ decision: "sev1" }],
      create_issue: [{ result: issue }],
      draft_ack: [{ result: { draft_id: "d-1", text: "Hi Ada" } }],
      approve_ack: [{ decision: "send" }],
      send_ack: [{ result: { sent_message_id: "<ack@x>" } }],
      check_status: [{ result: { state: "closed", has_activity: true, resolution_summary: "Rolled back." } }],
      draft_resolution: [{ result: { draft_id: "d-2", text: "Resolved" } }],
      approve_resolution: [{ decision: "skip" }],
    });
    expect(handled).toEqual([
      "triage", "confirm", "create_issue", "draft_ack", "approve_ack", "send_ack",
      "check_status", "draft_resolution", "approve_resolution",
    ]);

    const details = await getInstanceDetails(pool, tenant, instance.id);
    expect(details.instance).toMatchObject({ status: "completed", outcome: "resolved", current_step: "end_resolved" });
    expect(details.instance.hatchet_run_id).toBeTruthy();
    expect(details.tasks.every((t) => t.consumed_at !== null)).toBe(true);
    const events = details.history.map((h) => h.event);
    expect(events).toContain("instance.waiting");
    expect(events.at(-1)).toBe("instance.completed");
    // Exactly one task per step entry, despite replays and duplicate events.
    const created = details.history.filter((h) => h.event === "task.created").map((h) => h.data.step_key);
    expect(created).toEqual(handled);

    // The mail body reached the triage task as untrusted content, but no Hatchet run input.
    const triageTask = details.tasks.find((t) => t.step_key === "triage")!;
    expect(triageTask.untrusted_content).toMatchObject({ body: "Nobody can pay since 9:00." });
    const { getHatchetClient } = await import("../src/hatchet/client.js");
    const hatchet = getHatchetClient();
    const runs = await hatchet.runs.list({
      since: new Date(Date.now() - 3600_000),
      additionalMetadata: { zyk_instance: instance.id },
      limit: 100,
    });
    expect(runs.rows?.length).toBeGreaterThanOrEqual(handled.length);
    for (const row of runs.rows ?? []) {
      const detail = await hatchet.runs.get(row.metadata.id);
      expect(JSON.stringify(detail.run.input ?? {})).not.toContain("Nobody can pay");
    }
  });

  it("survives an engine restart mid-run without duplicating tasks", async () => {
    const instance = await start(`<restart-${Date.now()}@example.com>`);
    // Answer triage, then stop at confirm and restart the engine while the run waits on it.
    await work(instance, { triage: [{ result: { ...triage, severity: "sev2" } }] }, {
      until: (task) => task.step_key === "confirm",
    });
    await engine.stop();
    engine = await startHatchetEngine({ pool, catalog });

    // The simulated worker "crashed" holding the confirm lock; release it as the reaper would.
    await pool.query("UPDATE tasks SET status = 'pending', lock_token = NULL, lock_expires_at = NULL WHERE instance_id = $1 AND status = 'locked'", [instance.id]);
    await work(instance, { confirm: [{ decision: "dismiss" }] });

    const details = await getInstanceDetails(pool, tenant, instance.id);
    expect(details.instance).toMatchObject({ status: "completed", outcome: "dismissed" });
    const created = (await listAuditForInstance(pool, tenant, instance.id))
      .filter((h) => h.event === "task.created")
      .map((h) => h.data.step_key);
    expect(created).toEqual(["triage", "confirm"]);
  });

  it("fails the instance when a step fails permanently", async () => {
    const instance = await start(`<fail-${Date.now()}@example.com>`);
    await work(instance, { triage: [{ result: triage }], confirm: [{ decision: "sev3" }] }, {
      until: (task) => task.step_key === "create_issue",
    });
    const [task] = (await getInstanceDetails(pool, tenant, instance.id)).tasks.filter((t) => t.step_key === "create_issue");
    // The scripted worker locked create_issue in its last fetch; fail it as not retryable.
    const { failTask } = await import("../src/tasks/store.js");
    await failTask(pool, {
      tenantId: tenant, taskId: task.id, lockToken: task.lock_token!, error: "Repository not found", retryable: false, workerId: "sim",
    });
    await engine.notifyTaskResolved(task.id);

    const deadline = Date.now() + 30_000;
    let status = "running";
    while (status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      status = (await getInstanceDetails(pool, tenant, instance.id)).instance.status;
    }
    const details = await getInstanceDetails(pool, tenant, instance.id);
    expect(details.instance).toMatchObject({ status: "failed", error: { step_key: "create_issue", code: "step_failed" } });

    // The Hatchet run shows the failure too (traceability), without retries.
    const { getHatchetClient } = await import("../src/hatchet/client.js");
    let runStatus = "";
    for (let i = 0; i < 40 && runStatus !== "FAILED"; i++) {
      runStatus = String((await getHatchetClient().runs.get(details.instance.hatchet_run_id!)).run.status);
      if (runStatus !== "FAILED") await new Promise((r) => setTimeout(r, 250));
    }
    expect(runStatus).toBe("FAILED");
  });
});
