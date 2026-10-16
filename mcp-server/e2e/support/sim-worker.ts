/**
 * A simulated assistant that works zyk tasks through the MCP tools, the way the server
 * instructions describe: fetch, do the work in the (fake) world following the idempotency
 * markers, complete or decide, repeat. Decisions for user tasks come from a script.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FakeWorld } from "./fake-world.js";

export interface LockedTask {
  task_id: string;
  lock_token: string;
  kind: "system" | "user";
  step: string;
  instance_id: string;
  input: Record<string, any>;
  untrusted_content?: { note: string; content: Record<string, any> };
  decisions?: string[];
}

export interface ToolResult {
  isError: boolean;
  body: Record<string, any>;
}

/** Per-instance script: how triage classifies, and how the user decides. */
export interface Script {
  triage: { severity: "sev1" | "sev2" | "sev3"; duplicate_of?: number };
  decisions: Record<string, { decision: string; comment?: string }[]>;
}

export interface WorkerEvent {
  worker: string;
  action: "fetched" | "completed" | "decided" | "failed" | "released" | "crashed";
  task_id: string;
  step: string;
  instance_id: string;
}

export class SimWorker {
  readonly events: WorkerEvent[] = [];
  private client?: Client;

  constructor(
    readonly name: string,
    private readonly url: URL,
    private readonly key: string,
    private readonly world: FakeWorld,
    private readonly scripts: Map<string, Script>,
    private readonly opts: { kinds?: ("system" | "user")[] } = {}
  ) {}

  async connect(): Promise<this> {
    this.client = new Client({ name: this.name, version: "0" });
    await this.client.connect(
      new StreamableHTTPClientTransport(this.url, { requestInit: { headers: { Authorization: `Bearer ${this.key}` } } })
    );
    return this;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = await this.client!.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    return { isError: Boolean(res.isError), body: JSON.parse(text) };
  }

  async fetch(maxTasks = 2): Promise<LockedTask[]> {
    const res = await this.call("fetch_and_lock", { worker: this.name, kinds: this.opts.kinds, max_tasks: maxTasks });
    if (res.isError) throw new Error(`fetch_and_lock failed: ${JSON.stringify(res.body)}`);
    const tasks = res.body.tasks as LockedTask[];
    for (const t of tasks) this.record("fetched", t);
    return tasks;
  }

  /** Works until `done()` is true. */
  async runUntil(done: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`${this.name}: timed out`);
      for (const task of await this.fetch()) await this.handle(task);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Performs the task's effect and reports the result, as an assistant would. */
  async handle(task: LockedTask): Promise<ToolResult> {
    if (task.kind === "user") return this.decide(task);
    const result = this.perform(task);
    const res = await this.call("complete_task", { task_id: task.task_id, lock_token: task.lock_token, result });
    if (res.isError) throw new Error(`${this.name}: complete_task ${task.step} failed: ${JSON.stringify(res.body)}`);
    this.record("completed", task);
    return res;
  }

  /** Does the work in the fake world without reporting back — then "crashes". */
  performAndCrash(task: LockedTask): void {
    this.perform(task);
    this.record("crashed", task);
  }

  perform(task: LockedTask): Record<string, unknown> {
    const { input, step } = task;
    const world = this.world;
    switch (step) {
      case "triage": {
        const script = this.script(task);
        const mail = task.untrusted_content!.content;
        return {
          severity: script.triage.severity,
          title: String(mail.subject).slice(0, 120),
          summary: `Reported by ${input.from}: ${mail.subject}.`,
          reporter_name: String(input.from).replace(/\s*<.*>$/, ""),
          ...(script.triage.duplicate_of ? { duplicate_of: script.triage.duplicate_of } : {}),
        };
      }
      case "comment_duplicate":
        return { comment_url: world.comment(input.duplicate_of, `Another report: ${input.summary}`, input.marker) };
      case "create_issue": {
        const issue =
          world.findIssueWithMarker(input.marker) ??
          world.createIssue(input.title, `${input.summary}\nSeverity: ${input.severity}\n<!-- ${input.marker} -->`, "grace");
        return { issue_number: issue.number, issue_url: issue.url, assignee: issue.assignee };
      }
      case "draft_ack":
      case "draft_resolution": {
        const text = input.revision_notes ? `${input.text}\n[revised: ${input.revision_notes}]` : input.text;
        return { draft_id: world.createDraft(input.to, text), text };
      }
      case "send_ack":
      case "send_resolution":
        return { sent_message_id: world.send(input.draft_id, input.approved_text) };
      case "check_status": {
        const issue = world.issue(input.issue_number);
        const active = world.activity.delete(issue.number);
        return {
          state: issue.state,
          has_activity: active || issue.state === "closed",
          ...(issue.assignee ? { assignee: issue.assignee } : {}),
          ...(issue.resolution ? { resolution_summary: issue.resolution } : {}),
        };
      }
      case "escalate":
        return { comment_url: world.comment(input.issue_number, input.text, input.marker) };
      default:
        throw new Error(`SimWorker cannot do ${step}`);
    }
  }

  private async decide(task: LockedTask): Promise<ToolResult> {
    const answer = this.script(task).decisions[task.step]?.shift();
    if (!answer) throw new Error(`${this.name}: no scripted decision for ${task.step}`);
    const res = await this.call("complete_user_task", {
      task_id: task.task_id, lock_token: task.lock_token, decision: answer.decision, comment: answer.comment,
    });
    if (res.isError) throw new Error(`${this.name}: complete_user_task ${task.step} failed: ${JSON.stringify(res.body)}`);
    this.record("decided", task);
    return res;
  }

  private script(task: LockedTask): Script {
    const script = this.scripts.get(task.instance_id);
    if (!script) throw new Error(`No script for instance ${task.instance_id}`);
    return script;
  }

  private record(action: WorkerEvent["action"], task: LockedTask) {
    this.events.push({ worker: this.name, action, task_id: task.task_id, step: task.step, instance_id: task.instance_id });
  }
}
