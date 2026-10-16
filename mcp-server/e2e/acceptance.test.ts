/**
 * Milestone 1 acceptance criteria (docs/v2-architecture.md §12), end to end:
 * webhook → Hatchet → MCP tools → simulated assistants acting in a fake GitHub/Gmail.
 *
 *  1. A mail arriving via webhook flows through all steps using the simulated worker.
 *  2. Concurrent workers never process the same task.
 *  3. Killing a worker mid-task: the task is retried after lease expiry, without duplicate effects.
 *  4. Stale completions are rejected; invalid results get helpful errors.
 *  5. Every step and decision is visible via get_instance.
 *
 * Durations run at ZYK_TIME_SCALE=0.001 (the 4h sev1 SLA takes ~14s).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWorld } from "./support/fake-world.js";
import { SimWorker, type Script, type WorkerEvent } from "./support/sim-worker.js";
import { createTenantKeys, deliverMail, mailFor, startStack, type Stack } from "./support/stack.js";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

async function allEnded(ids: string[]): Promise<boolean> {
  const { rows } = await stack.pool.query("SELECT count(*)::int AS n FROM instances WHERE id = ANY($1) AND status = 'running'", [ids]);
  return rows[0].n === 0;
}

/** Maintainer behaviour in the fake GitHub, run in the background. */
function maintainer(world: FakeWorld, act: (world: FakeWorld) => void): () => void {
  const timer = setInterval(() => act(world), 100);
  return () => clearInterval(timer);
}

/** Every task was fetched by exactly one worker and resolved exactly once. */
function expectExclusive(events: WorkerEvent[]) {
  const fetchedBy = new Map<string, Set<string>>();
  const resolved = new Map<string, number>();
  for (const e of events) {
    if (e.action === "fetched") fetchedBy.set(e.task_id, (fetchedBy.get(e.task_id) ?? new Set()).add(e.worker));
    if (e.action === "completed" || e.action === "decided") resolved.set(e.task_id, (resolved.get(e.task_id) ?? 0) + 1);
  }
  for (const [taskId, workers] of fetchedBy) expect(workers.size, `task ${taskId} fetched by ${[...workers]}`).toBe(1);
  for (const [taskId, n] of resolved) expect(n, `task ${taskId} resolved ${n}×`).toBe(1);
  return { tasks: fetchedBy.size };
}

describe("acceptance", () => {
  it("1 + 2 + 5: a webhook mail flows through every step with two concurrent workers", async () => {
    const { key, webhookKey } = await createTenantKeys(stack, "acceptance-1");
    const world = new FakeWorld();
    const scripts = new Map<string, Script>();

    const { instanceId } = await deliverMail(stack, webhookKey, mailFor(`a1-${Date.now()}`));
    scripts.set(instanceId, {
      triage: { severity: "sev1" },
      decisions: {
        confirm: [{ decision: "sev1" }],
        approve_ack: [{ decision: "revise", comment: "Mention the status page" }, { decision: "send" }],
        approve_resolution: [{ decision: "send" }],
      },
    });

    // GitHub: someone comments before the first check; the issue is closed after it.
    let checkedOnce = false;
    const stopMaintainer = maintainer(world, (w) => {
      const issue = w.issues[0];
      if (!issue) return;
      if (!checkedOnce && issue.state === "open" && !w.activity.has(issue.number) && issue.comments.length === 0) {
        w.activity.add(issue.number);
        issue.comments.push({ body: "Looking into it", url: `${issue.url}#c0` });
      } else if (issue.comments.length > 0 && !w.activity.has(issue.number) && issue.state === "open") {
        checkedOnce = true;
        w.close(issue.number, "Rolled back the payment service release.");
      }
    });

    const chat = await new SimWorker("chat", stack.mcpUrl, key, world, scripts).connect();
    const scheduled = await new SimWorker("scheduled-run", stack.mcpUrl, key, world, scripts, { kinds: ["system"] }).connect();
    try {
      await Promise.all([chat, scheduled].map((w) => w.runUntil(() => allEnded([instanceId]))));
    } finally {
      stopMaintainer();
    }

    // Effects in the outside world: exactly one issue, exactly two mails.
    expect(world.issues).toHaveLength(1);
    expect(world.sent.map((m) => m.to)).toEqual(["Ada Lovelace <ada@example.com>", "Ada Lovelace <ada@example.com>"]);
    expect(world.sent[0].text).toContain("[revised: Mention the status page]");
    expect(world.sent[1].text).toContain("Rolled back the payment service release.");

    // Workers: no task twice; the scheduled run never decided anything.
    const events = [...chat.events, ...scheduled.events];
    const { tasks } = expectExclusive(events);
    expect(tasks).toBe(13);
    expect(scheduled.events.filter((e) => e.action === "decided")).toEqual([]);
    expect(scheduled.events.some((e) => e.action === "completed")).toBe(true);

    // Everything is visible via get_instance.
    const { body: instance } = await chat.call("get_instance", { instance_id: instanceId });
    expect(instance).toMatchObject({ status: "completed", outcome: "resolved", current_step: "end_resolved" });
    expect(instance.steps.map((s: { step: string }) => s.step)).toEqual([
      "triage", "confirm", "create_issue",
      "draft_ack", "approve_ack", "draft_ack", "approve_ack", "send_ack",
      "check_status", "check_status",
      "draft_resolution", "approve_resolution", "send_resolution",
    ]);
    const decisions = instance.steps.filter((s: { kind: string }) => s.kind === "user");
    expect(decisions.map((d: { result: { decision: string } }) => d.result.decision)).toEqual(["sev1", "revise", "send", "send"]);
    expect(decisions.every((d: { decided_via: string }) => d.decided_via === "conversation")).toBe(true);
    const history = instance.history.map((h: { event: string }) => h.event);
    expect(history[0]).toBe("instance.started");
    expect(instance.history[0].actor).toMatch(/^webhook:zyk_/);
    expect(history.filter((e: string) => e === "instance.waiting")).toHaveLength(2);
    expect(history.at(-1)).toBe("instance.completed");

    await chat.close();
    await scheduled.close();
  });

  it("3 + 4: a worker killed mid-task is replaced after lease expiry without a duplicate issue", async () => {
    const { key, webhookKey } = await createTenantKeys(stack, "acceptance-2");
    const world = new FakeWorld();
    const scripts = new Map<string, Script>();
    const { instanceId } = await deliverMail(stack, webhookKey, mailFor(`a2-${Date.now()}`));
    scripts.set(instanceId, {
      triage: { severity: "sev1" },
      decisions: { confirm: [{ decision: "sev1" }], approve_ack: [{ decision: "skip" }], approve_resolution: [{ decision: "skip" }] },
    });
    const stopMaintainer = maintainer(world, (w) => w.issues.forEach((i) => i.state === "open" && w.close(i.number, "Fixed.")));

    const a = await new SimWorker("worker-a", stack.mcpUrl, key, world, scripts).connect();
    const b = await new SimWorker("worker-b", stack.mcpUrl, key, world, scripts).connect();
    try {
      // Worker A handles intake, then creates the issue and dies before reporting back.
      let crashed: Awaited<ReturnType<SimWorker["fetch"]>>[number] | undefined;
      const deadline = Date.now() + 60_000;
      while (!crashed) {
        if (Date.now() > deadline) throw new Error("create_issue never arrived");
        for (const task of await a.fetch(1)) {
          if (task.step === "create_issue") {
            a.performAndCrash(task);
            crashed = task;
          } else await a.handle(task);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(world.issues).toHaveLength(1);

      // Time passes beyond the lock (simulated); the real reaper returns the task to the queue.
      await stack.pool.query("UPDATE tasks SET lock_expires_at = now() - interval '1 second' WHERE id = $1", [crashed.task_id]);
      const until = Date.now() + 10_000;
      for (;;) {
        const { rows } = await stack.pool.query("SELECT status FROM tasks WHERE id = $1", [crashed.task_id]);
        if (rows[0].status === "pending") break;
        if (Date.now() > until) throw new Error("reaper did not requeue the task");
        await new Promise((r) => setTimeout(r, 100));
      }

      // Worker B picks it up (attempt 2).
      const [retry] = await b.fetch(1);
      expect(retry).toMatchObject({ task_id: crashed.task_id, step: "create_issue" });

      // Worker A comes back to life and reports: stale lock, with guidance.
      const stale = await a.call("complete_task", {
        task_id: crashed.task_id, lock_token: crashed.lock_token, result: { issue_number: 1, issue_url: world.issues[0].url },
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error).toBe("stale_lock");
      expect(stale.body.message).toContain("another worker has claimed the task");
      expect(stale.body.hint).toContain("idempotency key");

      // Worker B first sends an invalid result and gets told exactly what is wrong.
      const invalid = await b.call("complete_task", { task_id: retry.task_id, lock_token: retry.lock_token, result: { issue_number: "one" } });
      expect(invalid.isError).toBe(true);
      expect(invalid.body.message).toContain("field `issue_number` must be of type integer");
      expect(invalid.body.message).toContain("field `issue_url` is missing");
      expect(invalid.body.hint).toContain("same lock_token");

      // Then does it right: the marker finds A's issue, so no duplicate is created.
      await b.handle(retry);
      await b.runUntil(() => allEnded([instanceId]));
    } finally {
      stopMaintainer();
    }

    expect(world.issues).toHaveLength(1);
    const { body: instance } = await b.call("get_instance", { instance_id: instanceId });
    expect(instance).toMatchObject({ status: "completed", outcome: "resolved" });
    const createIssue = instance.steps.find((s: { step: string }) => s.step === "create_issue");
    expect(createIssue).toMatchObject({ status: "completed", attempts: 2, result: { issue_number: 1 } });
    const history = instance.history.map((h: { event: string }) => h.event);
    expect(history).toContain("task.lease_expired");
    expect(history).toContain("task.result_rejected");

    await a.close();
    await b.close();
  });

  it("2: many incidents, three workers, no task processed twice and no duplicate effects", async () => {
    const { key, webhookKey } = await createTenantKeys(stack, "acceptance-3");
    const world = new FakeWorld();
    const scripts = new Map<string, Script>();
    const mails = Array.from({ length: 5 }, (_, i) => mailFor(`a3-${Date.now()}-${i}`, `Incident ${i}`));

    const delivered = await Promise.all([...mails, mails[0]].map((m) => deliverMail(stack, webhookKey, m)));
    const ids = [...new Set(delivered.map((d) => d.instanceId))];
    expect(ids).toHaveLength(5); // the duplicate delivery did not start a sixth instance
    for (const id of ids) {
      scripts.set(id, {
        triage: { severity: "sev1" },
        decisions: { confirm: [{ decision: "sev1" }], approve_ack: [{ decision: "send" }], approve_resolution: [{ decision: "send" }] },
      });
    }
    const stopMaintainer = maintainer(world, (w) => w.issues.forEach((i) => i.state === "open" && w.close(i.number, "Fixed.")));

    const workers = await Promise.all([
      new SimWorker("chat-1", stack.mcpUrl, key, world, scripts).connect(),
      new SimWorker("chat-2", stack.mcpUrl, key, world, scripts).connect(),
      new SimWorker("scheduled-run", stack.mcpUrl, key, world, scripts, { kinds: ["system"] }).connect(),
    ]);
    try {
      await Promise.all(workers.map((w) => w.runUntil(() => allEnded(ids))));
    } finally {
      stopMaintainer();
    }

    const { tasks } = expectExclusive(workers.flatMap((w) => w.events));
    expect(tasks).toBe(5 * 10); // triage … send_resolution: 10 tasks per incident
    expect(world.issues).toHaveLength(5);
    expect(world.sent).toHaveLength(10);
    const { rows } = await stack.pool.query(
      "SELECT outcome, count(*)::int AS n FROM instances WHERE id = ANY($1) GROUP BY outcome",
      [ids]
    );
    expect(rows).toEqual([{ outcome: "resolved", n: 5 }]);
    await Promise.all(workers.map((w) => w.close()));
  });
});
