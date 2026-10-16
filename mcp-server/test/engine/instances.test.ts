import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listAuditForInstance } from "../../src/audit/log.js";
import { ZykError } from "../../src/errors.js";
import {
  claimRun,
  failInstance,
  finishInstance,
  getInstanceDetails,
  loadInstance,
  recordStep,
  startInstance,
  untriggeredInstances,
  untrustedInputOf,
} from "../../src/engine/instances.js";
import { republishPending } from "../../src/engine/outbox.js";
import { loadPlaybooks, PlaybookCatalog, registerPlaybooks } from "../../src/playbooks/loader.js";
import { completeTask, createTask, fetchAndLock, getTask, markConsumed, purgeExpiredUntrustedContent } from "../../src/tasks/store.js";
import { insertTenant, resetData, testPool } from "../helpers/db.js";

const pool = testPool();
const playbooks = loadPlaybooks();
const catalog = new PlaybookCatalog(playbooks);

afterAll(async () => {
  await pool.end();
});

let tenant: string;

beforeEach(async () => {
  await resetData(pool);
  await registerPlaybooks(pool, playbooks);
  tenant = await insertTenant(pool);
});

const mail = (id = "<msg-1@example.com>") => ({
  message_id: id,
  from: "Ada <ada@example.com>",
  subject: "Checkout down",
  body: "Nobody can pay",
  received_at: "2026-10-16T09:00:00Z",
});

async function start(input: unknown = mail()) {
  return startInstance(pool, catalog, {
    tenantId: tenant,
    playbookId: "incident-triage",
    input,
    actor: { type: "worker", id: "w1" },
  });
}

describe("startInstance", () => {
  it("pins the latest version and default config, and audits the start", async () => {
    const { instance, created } = await start();
    expect(created).toBe(true);
    expect(instance).toMatchObject({
      playbook_version: "1.0.0-dev",
      status: "running",
      external_key: "<msg-1@example.com>",
      hatchet_run_id: null,
    });
    expect(instance.effective_config.sla_sev1).toBe("4h");
    const audit = await listAuditForInstance(pool, tenant, instance.id);
    expect(audit.map((a) => [a.event, a.actor_type, a.actor_id])).toEqual([["instance.started", "worker", "w1"]]);
  });

  it("dedupes on the external key", async () => {
    const first = await start();
    const second = await start({ ...mail(), subject: "Re: Checkout down" });
    expect(second.created).toBe(false);
    expect(second.instance.id).toBe(first.instance.id);
    expect((await start(mail("<msg-2@example.com>"))).created).toBe(true);
  });

  it("rejects invalid input with actionable problems", async () => {
    const err = (await start({ from: "x", subject: "y", received_at: "yesterday" }).catch((e) => e)) as ZykError;
    expect(err).toBeInstanceOf(ZykError);
    expect(err.message).toContain("field `message_id` is missing");
    expect(err.message).toContain("field `received_at` must be a valid date-time");
  });

  it("rejects unknown playbooks and lists the known ones", async () => {
    const err = (await startInstance(pool, catalog, {
      tenantId: tenant, playbookId: "nope", input: {}, actor: { type: "admin" },
    }).catch((e) => e)) as ZykError;
    expect(err.hint).toContain("incident-triage");
  });
});

describe("run bookkeeping", () => {
  it("lets exactly one Hatchet run claim an instance", async () => {
    const { instance } = await start();
    expect(await claimRun(pool, instance.id, "run-a")).toBe(true);
    expect(await claimRun(pool, instance.id, "run-a")).toBe(true); // replay of the same run
    expect(await claimRun(pool, instance.id, "run-b")).toBe(false);
  });

  it("records steps monotonically and dedupes replayed entries", async () => {
    const { instance } = await start();
    await recordStep(pool, instance, 1, "triage", "instance.step_started");
    await recordStep(pool, instance, 2, "confirm", "instance.step_started");
    // Replay re-enters step 1 and 2.
    await recordStep(pool, instance, 1, "triage", "instance.step_started");
    await recordStep(pool, instance, 2, "confirm", "instance.step_started");
    const row = await loadInstance(pool, instance.id);
    expect(row.current_step).toBe("confirm");
    expect(row.step_seq).toBe(2);
    const events = (await listAuditForInstance(pool, tenant, instance.id)).map((a) => `${a.event}:${a.data.step_key ?? ""}`);
    expect(events).toEqual(["instance.started:", "instance.step_started:triage", "instance.step_started:confirm"]);
  });

  it("finishes once with an outcome", async () => {
    const { instance } = await start();
    await finishInstance(pool, instance, "end_resolved", "resolved");
    await finishInstance(pool, instance, "end_resolved", "resolved");
    const row = await loadInstance(pool, instance.id);
    expect(row).toMatchObject({ status: "completed", outcome: "resolved", current_step: "end_resolved" });
    expect(row.ended_at).toBeInstanceOf(Date);
    const completed = (await listAuditForInstance(pool, tenant, instance.id)).filter((a) => a.event === "instance.completed");
    expect(completed).toHaveLength(1);
  });

  it("fails an instance and cancels its open tasks", async () => {
    const { instance } = await start();
    const { task } = await createTask(pool, {
      tenantId: tenant, instanceId: instance.id, stepKey: "triage", kind: "system",
      topic: "github", instructions: "x", resultSchema: { type: "object" },
    });
    await fetchAndLock(pool, { tenantId: tenant, workerId: "w1", maxTasks: 1, lockSeconds: 60 });
    await failInstance(pool, instance.id, { message: "Step create_issue failed", step_key: "create_issue" });
    await failInstance(pool, instance.id, { message: "again" }); // no-op
    const details = await getInstanceDetails(pool, tenant, instance.id);
    expect(details.instance).toMatchObject({ status: "failed", outcome: "failed", error: { message: "Step create_issue failed" } });
    expect(details.tasks[0]).toMatchObject({ id: task.id, status: "cancelled", lock_token: null });
    expect(details.history.map((h) => h.event)).toEqual([
      "instance.started", "task.created", "task.locked", "instance.failed", "task.cancelled",
    ]);
  });

  it("finds instances whose run was never triggered", async () => {
    const { instance } = await start();
    expect(await untriggeredInstances(pool, 0)).toHaveLength(1);
    await claimRun(pool, instance.id, "run-a");
    expect(await untriggeredInstances(pool, 0)).toHaveLength(0);
  });

  it("scopes instance details to the tenant", async () => {
    const { instance } = await start();
    const other = await insertTenant(pool, "other");
    await expect(getInstanceDetails(pool, other, instance.id)).rejects.toBeInstanceOf(ZykError);
  });
});

describe("outbox", () => {
  async function resolvedTask() {
    const { instance } = await start();
    await createTask(pool, {
      tenantId: tenant, instanceId: instance.id, stepKey: "triage", kind: "system",
      topic: "github", instructions: "x", resultSchema: { type: "object" },
    });
    const [locked] = await fetchAndLock(pool, { tenantId: tenant, workerId: "w1", maxTasks: 1, lockSeconds: 60 });
    await completeTask(pool, { tenantId: tenant, taskId: locked.id, lockToken: locked.lock_token!, result: {}, workerId: "w1" });
    return { instance, taskId: locked.id };
  }

  it("re-publishes resolved, unconsumed tasks until consumed", async () => {
    const { taskId } = await resolvedTask();
    const published: string[] = [];
    const publish = async (id: string) => void published.push(id);

    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 60 })).toEqual([]); // still in grace
    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 0 })).toEqual([taskId]);
    expect((await getTask(pool, tenant, taskId)).event_published_at).toBeInstanceOf(Date);
    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 0, republishAfterSeconds: 60 })).toEqual([]);
    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 0, republishAfterSeconds: 0 })).toEqual([taskId]);

    await markConsumed(pool, taskId);
    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 0, republishAfterSeconds: 0 })).toEqual([]);
  });

  it("ignores tasks of ended instances and keeps going after publish errors", async () => {
    const { instance } = await resolvedTask();
    const failing = async () => {
      throw new Error("Hatchet down");
    };
    expect(await republishPending(pool, failing, { unpublishedGraceSeconds: 0 })).toEqual([]);
    await finishInstance(pool, instance, "end_resolved", "resolved");
    const publish = async () => {};
    expect(await republishPending(pool, publish, { unpublishedGraceSeconds: 0 })).toEqual([]);
  });
});

describe("untrusted input", () => {
  it("returns only the manifest's untrusted fields", async () => {
    const { instance } = await start();
    expect(await untrustedInputOf(pool, instance.id)).toEqual({ subject: "Checkout down", body: "Nobody can pay" });
  });

  it("is purged from instance inputs after the retention period", async () => {
    const { instance } = await start();
    expect((await purgeExpiredUntrustedContent(pool)).instances).toBe(0);
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect((await purgeExpiredUntrustedContent(pool, { now: later })).instances).toBe(1);
    const row = await loadInstance(pool, instance.id);
    expect(row.input).toEqual({ message_id: "<msg-1@example.com>", from: "Ada <ada@example.com>", received_at: "2026-10-16T09:00:00Z" });
    expect(await untrustedInputOf(pool, instance.id)).toBeUndefined();
    expect((await purgeExpiredUntrustedContent(pool, { now: later })).instances).toBe(0);
  });
});
