# Zyk — CLAUDE.md

## What is Zyk?

Zyk is a conversational workflow automation platform. Users describe automations in plain English to Claude, Claude generates real TypeScript workflow code, and Zyk executes it durably via Hatchet. Users watch the workflow appear as a live diagram in real time.

**One-line pitch:** Describe it. Watch it build. Deploy it.

**Positioning:** Workflow automation for AI-native startups and small teams. No connectors to configure. No UI builder to learn. Just conversation.

---

## The Core Insight

Most workflow tools (n8n, Zapier, Make) require users to build workflows upfront in a visual editor with pre-built connectors. If a connector doesn't exist, you're blocked.

Zyk is different:
- Claude **generates real TypeScript code** on the fly — it knows thousands of APIs from training
- No connector library to maintain — if Claude knows the API, it works
- Workflows are **durable** — they survive failures, retries, long waits (not fragile one-shot LLM calls)
- The interface is **conversation** — no UI builder, no drag and drop

---

## Tech Stack

```
Claude (conversation + code generation)
    ↓
Zyk MCP Server (this repo — the core product)
    ↓
Hatchet (durable workflow execution engine)
    ↓
PostgreSQL (Hatchet's only dependency)
    ↓
Docker Compose (self-hosted, one command setup)
```

### Why Hatchet over Temporal?
- Single Docker image ("Hatchet Lite") — no Kubernetes needed
- Postgres only — no Elasticsearch, Kafka, or Cassandra
- Beautiful built-in monitoring UI out of the box
- MIT licensed — no pricing surprises for self-hosters
- Low resource footprint — perfect for small teams
- Clean TypeScript SDK — easy to wrap in MCP

### Why not a custom DSL (old Zyk YAML)?
The previous Zyk approach used a custom YAML DSL. This is abandoned because:
- A DSL limits users to what the DSL supports
- Claude generates better, more flexible code directly
- No connector library maintenance burden
- Real TypeScript is inspectable, testable, version-controllable

---

## Repo Structure

```
zyk/
├── CLAUDE.md                  # This file
├── docker-compose.yml         # Hatchet + Postgres, one command
├── mcp-server/                # Core product — the MCP server
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts           # MCP server entry point
│   │   ├── tools/
│   │   │   ├── create-workflow.ts
│   │   │   ├── run-workflow.ts
│   │   │   ├── get-status.ts
│   │   │   ├── list-workflows.ts
│   │   │   └── delete-workflow.ts
│   │   ├── hatchet/
│   │   │   ├── client.ts      # Hatchet client wrapper
│   │   │   ├── register.ts    # Dynamic workflow registration
│   │   │   └── worker.ts      # Worker process management
│   │   └── utils/
│   │       ├── code-runner.ts # Safe TypeScript execution
│   │       └── diagram.ts     # Mermaid diagram generation
├── examples/                  # Example workflows Claude can generate
│   ├── daily-revenue-report.ts
│   ├── new-user-onboarding.ts
│   └── api-error-monitor.ts
└── README.md
```

---

## MCP Tools (What Claude Can Do)

These are the MCP tools the server exposes to Claude. Keep them minimal and clean.

### `create_workflow`
```typescript
{
  name: "create_workflow",
  description: "Create and register a new durable workflow in Hatchet",
  input: {
    name: string,          // human-readable name
    description: string,   // what it does
    code: string,          // TypeScript workflow code (Claude generates this)
    schedule?: string,     // cron expression for recurring workflows
    trigger?: "on-demand" | "schedule"
  }
}
```

### `run_workflow`
```typescript
{
  name: "run_workflow",
  description: "Trigger a workflow execution (one-off or immediate run)",
  input: {
    workflow_id: string,
    params?: Record<string, any>  // runtime parameters
  }
}
```

### `get_status`
```typescript
{
  name: "get_status",
  description: "Get the current status and progress of a workflow or run",
  input: {
    workflow_id: string,
    run_id?: string  // optional — get specific run status
  }
}
```

### `list_workflows`
```typescript
{
  name: "list_workflows",
  description: "List all registered workflows and their status",
  input: {}
}
```

### `delete_workflow`
```typescript
{
  name: "delete_workflow",
  description: "Remove a workflow from the registry",
  input: {
    workflow_id: string
  }
}
```

---

## How Claude Should Generate Workflow Code

### Clarification rules

**Ask about functional unknowns — never about technical choices.**

Before writing code, ask in ONE short message only if a **business-level** input is genuinely missing and cannot be defaulted:
- Who to notify and under what conditions (if not stated)
- Severity levels or escalation paths (if not stated)
- Schedule/cron expression (for scheduled workflows only)
- Trigger type — on-demand or schedule (if not stated)

Then wait for the user's answers before writing code.

**Never ask about — use these defaults silently:**
- Which Slack channel — use `process.env.SLACK_CHANNEL`
- Which GitHub repo — use `process.env.GITHUB_REPO`
- Who to page / on-call user — use `process.env.ONCALL_USER`
- Engineering / leadership / support channels — use `process.env.ENGINEERING_CHANNEL`, `LEADERSHIP_CHANNEL`, `SUPPORT_CHANNEL`
- Error handling strategy — always throw on non-OK HTTP responses (Hatchet retries automatically)
- Retry counts — always use `retries: 3`
- Which HTTP library — always use `fetch()`
- How to pass secrets — always use `process.env.VAR`
- Whether to add logging — always use `ctx.log()` for key steps
- Code structure, parallelism, or step ordering — decide yourself based on the workflow logic
- How to wait for human input — always use `workflow.durableTask()` + `ctx.waitForEvent(correlationId)`. Never use polling loops.
- Where to persist files — always use `/data` (Railway persistent volume mount). No S3 or external storage needed.

Once functional requirements are clear, **generate the code and call `create_workflow` immediately.** Do not ask for approval, do not call `list_workflows` or read files first, do not explain what you're about to do — just build and deploy.

**CRITICAL: Call `create_workflow` exactly ONCE per user request.** Never call it twice. Never create a "draft" and then a "real" version. One prompt → one workflow.

**CRITICAL: NEVER call `run_workflow` automatically after `create_workflow`.** The user always decides when to run. After creating, tell the user the workflow is ready and ask if they'd like you to run it. Wait for explicit confirmation. Never say "head to the dashboard to run it" — the workflow can only be started by asking Claude to run it.

**CRITICAL: NEVER call `update_workflow` unless the user explicitly asks you to change something.** Do not call it to "fix name mismatches" or "align names" — name differences between the human-readable display name (e.g. "Star Wars Films Survey") and the Hatchet technical name (e.g. "star-wars-films-survey") are expected and handled automatically by the server. Run names in Hatchet include a timestamp suffix — this is also normal, not a bug.

---

### Mandatory file structure

Every workflow file must follow this exact structure or the worker will fail to start:

```typescript
import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const workflow = hatchet.workflow({
  name: "workflow-name",          // kebab-case; must match the `name` passed to create_workflow
  description: "What it does",
});

// Store the return value — needed to express parent dependencies
const firstTask = workflow.task({
  name: "first-task",             // kebab-case
  retries: 3,
  fn: async (_input, ctx) => {
    await ctx.log("Starting first-task");
    // ... logic ...
    return { someValue: "result" };
  },
});

workflow.task({
  name: "second-task",
  parents: [firstTask],           // pass the task ref, NOT a string
  retries: 3,
  fn: async (_input, ctx) => {
    const { someValue } = await ctx.parentOutput(firstTask) as { someValue: string };
    await ctx.log(`Got: ${someValue}`);
    return { done: true };
  },
});

// ⚠️ REQUIRED — the worker process calls workflow.start(), so this export is mandatory
const worker = await hatchet.worker("workflow-name-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };
```

**Rules:**
- `workflow.name` must be kebab-case and match what you pass to `create_workflow`
- For scheduled workflows, `on: { cron: "<expression>" }` MUST be in `hatchet.workflow({...})` — without it Hatchet never fires the workflow
- Import must be named: `import { Hatchet } from "@hatchet-dev/typescript-sdk"` — NOT a default import
- Task function key is `fn:`, NOT `run:`. Signature is `(input, ctx)` — ctx is the **second** param
- Store `workflow.task()` return values as `const taskRef = workflow.task({...})`
- Pass task refs to `parents:`, NOT strings: `parents: [taskRef]`
- Await `ctx.parentOutput(taskRef)` — it is async
- Always `export default { start: () => worker.start() }` — never export the workflow object directly
- Each task gets `retries: 3` unless there's a reason not to
- Tasks without `parents` run in parallel automatically
- Use `await ctx.log(message)` for step-level logs visible in the Hatchet UI
- Use `process.env.VAR_NAME` for all secrets — never hardcode values

---

### Passing data between tasks

```typescript
// Upstream task returns data
const fetchUser = workflow.task({
  name: "fetch-user",
  fn: async (_input) => {
    const user = await fetchUserFromDB();
    return { userId: user.id, email: user.email };  // return a plain object
  },
});

// Downstream task reads it
workflow.task({
  name: "send-email",
  parents: [fetchUser],           // task ref, not a string
  fn: async (_input, ctx) => {
    const { userId, email } = await ctx.parentOutput(fetchUser) as { userId: string; email: string };
    // use userId, email...
  },
});
```

---

### REST / HTTP calls

```typescript
workflow.task({
  name: "call-api",
  retries: 3,
  fn: async (_input, ctx) => {
    await ctx.log("Calling external API");

    const res = await fetch("https://api.example.com/endpoint", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "value" }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);  // triggers retry
    }

    const data = await res.json() as { result: string };
    await ctx.log(`API responded: ${data.result}`);
    return { result: data.result };
  },
});
```

**Always throw on non-OK responses** — Hatchet will retry the task automatically.

---

### Anthropic / Claude API integration

When a workflow needs AI-based classification, summarisation, or any LLM call, call the Anthropic API directly. **Always include the `x-api-key` header with `process.env.ANTHROPIC_API_KEY`.**

```typescript
workflow.task({
  name: "assess-with-claude",
  retries: 3,
  fn: async (input: { text: string }, ctx) => {
    await ctx.log("Calling Claude API");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: input.text }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as { content: { text: string }[] };
    // Strip markdown code fences — Claude sometimes wraps JSON in ```json ... ``` despite instructions
    const rawText = data.content[0].text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const result = rawText;
    await ctx.log(`Claude responded: ${result.slice(0, 100)}`);
    return { result };
  },
});
```

**Rules:**
- Always use `"x-api-key": process.env.ANTHROPIC_API_KEY ?? ""` — never omit the auth header
- Always include `"anthropic-version": "2023-06-01"`
- Default model: `claude-sonnet-4-20250514`
- Always ask Claude to respond in JSON when you need structured output — include the schema in the prompt

---

### Slack integration

```typescript
// Send a message
const notifySlack = workflow.task({
  name: "notify-slack",
  retries: 3,
  fn: async (_input, ctx) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#general",
        text: "Hello from Zyk!",
        // For rich messages, use blocks:
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*Hello* from Zyk!" },
          },
        ],
      }),
    });
    const data = await res.json() as { ok: boolean; ts: string; error?: string };
    if (!data.ok) throw new Error(`Slack error: ${data.error}`);
    await ctx.log(`Message sent, ts=${data.ts}`);
    return { messageTs: data.ts };
  },
});

// Update an existing message (pass messageTs from earlier task)
workflow.task({
  name: "update-slack-message",
  parents: [notifySlack],
  fn: async (_input, ctx) => {
    const { messageTs } = await ctx.parentOutput(notifySlack) as { messageTs: string };
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#general",
        ts: messageTs,
        text: "Updated by Zyk",
      }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack update error: ${data.error}`);
  },
});
```

---

### GitHub integration

```typescript
workflow.task({
  name: "create-github-issue",
  retries: 3,
  fn: async (_input, ctx) => {
    const repo = process.env.GITHUB_REPO;           // e.g. "owner/repo"
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
      },
      body: JSON.stringify({
        title: "Issue title",
        body: "Issue body",
        labels: ["bug"],
      }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const issue = await res.json() as { number: number; html_url: string };
    await ctx.log(`Created issue #${issue.number}`);
    return { issueNumber: issue.number, url: issue.html_url };
  },
});
```

---

### Parallel tasks (no `parents`)

Tasks without `parents` run concurrently. Use this for independent notifications, fan-out fetches, etc.:

```typescript
// These two run at the same time
const notifySlack = workflow.task({
  name: "notify-slack",
  fn: async (_input, ctx) => { /* ... */ return { messageTs: "..." }; },
});

const createIssue = workflow.task({
  name: "create-github-issue",
  fn: async (_input, ctx) => { /* ... */ return { issueNumber: 42 }; },
});

// This runs after both finish
workflow.task({
  name: "summarise",
  parents: [notifySlack, createIssue],
  fn: async (_input, ctx) => {
    const slack = await ctx.parentOutput(notifySlack) as { messageTs: string };
    const gh = await ctx.parentOutput(createIssue) as { issueNumber: number };
    await ctx.log(`Slack ts=${slack.messageTs}, GH issue #${gh.issueNumber}`);
  },
});
```

---

### Waiting for a Slack button click

Use `workflow.durableTask()` — Hatchet suspends the step durably in its DB and resumes it when the button is clicked. No polling loop, survives server restarts.

```typescript
// Step 1: post a message with buttons (regular task)
const requestApproval = workflow.task({
  name: "request-approval",
  retries: 3,
  fn: async (_input, ctx) => {
    const correlationId = `approval-${Date.now()}`;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#approvals",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Approve this deployment?" } },
          {
            type: "actions",
            block_id: correlationId,   // ← must match the correlationId used in waitForEvent
            elements: [
              { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve", style: "primary" },
              { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "reject", style: "danger" },
            ],
          },
        ],
      }),
    });
    const data = await res.json() as { ok: boolean; ts: string; error?: string };
    if (!data.ok) throw new Error(`Slack error: ${data.error}`);
    await ctx.log(`Approval request sent (correlationId=${correlationId})`);
    return { correlationId, messageTs: data.ts };
  },
});

// Step 2: wait for the button click — durable, no polling
const waitForApproval = workflow.durableTask({
  name: "wait-for-approval",
  parents: [requestApproval],
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const { correlationId } = await ctx.parentOutput(requestApproval) as { correlationId: string };
    await ctx.log(`Waiting for approval (id=${correlationId})`);
    // ctx.waitForEvent signals the user responded — it carries NO payload (always returns {})
    await ctx.waitForEvent(correlationId);
    // Fetch the actual answer from the MCP server
    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = await answerRes.json() as { action: string };
    await ctx.log(`Decision: ${action}`);
    return { approved: action === "approve", action };
  },
});
```

**Rules:**
- Always set `block_id` on the `actions` block — that's the correlationId Zyk uses to match the click
- Each button needs a unique `action_id` — that's what comes back in `eventData.action`
- Use `workflow.durableTask()` — never `workflow.task()` — for the waiting step
- `executionTimeout` sets the maximum wait (e.g. `"24h"`)
- Slack requires a public HTTPS URL to deliver button clicks. For local development use [ngrok](https://ngrok.com): run `ngrok http 3100` and set the Slack app's **Interactivity Request URL** to `https://<your-ngrok-url>/slack/interactions`

---

### Asking the user a question (interactive workflows)

Use `workflow.durableTask()` — Hatchet suspends the step durably and resumes it when the user answers. The question appears in the Zyk dashboard Tasks tab.

```typescript
const askUser = workflow.durableTask({
  name: "ask-user",
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const correlationId = `question-${Date.now()}`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? "http://localhost:3100";

    // Register the question so it appears in the Zyk dashboard
    await fetch(`${base}/interact/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "my-workflow-name",   // ← REQUIRED — must match hatchet.workflow({ name: "..." }) exactly
        message: "Do you want to proceed?",
        options: ["yes", "no"],             // optional — omit for free-text answers
        timeoutSeconds: 86400,              // ← REQUIRED — must match executionTimeout in seconds
      }),
    });

    await ctx.log(`Question posted (id=${correlationId})`);

    // Suspend durably — resumes automatically when user answers
    // ctx.waitForEvent signals the user responded — it carries NO payload (always returns {})
    await ctx.waitForEvent(correlationId);
    // Fetch the actual answer from the MCP server
    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = await answerRes.json() as { action: string };
    const answer = action.toLowerCase(); // normalize — always compare lowercase

    await ctx.log(`User answered: ${answer}`);
    return { answer };
  },
});
```

**Rules:**
- **Always use `workflow.durableTask()`** — never `workflow.task()` for interactive steps
- **ALWAYS set `workflowName`** in the `/interact/ask` body — required for the task to appear in the dashboard and be cleaned up on workflow delete
- `options` is optional; omit it for free-text answers, include it for button choices
- Always pass `timeoutSeconds` matching `executionTimeout` so the dashboard auto-removes expired tasks
- **NEVER call `/interact/ask` to display results or summaries** — use `ctx.log()` for output-only content. `/interact/ask` is ONLY for questions requiring a user response.
- **No icons or emoji anywhere in workflow code** — not in `message`, not in `options`, not in `ctx.log()` strings. Plain text only.

---

### Scheduled workflows (cron)

Pass `trigger: "schedule"` and a `schedule` cron string to `create_workflow`.

**CRITICAL: you MUST include `on: { cron: "<expression>" }` in `hatchet.workflow({...})`.** Without this, the worker registers but Hatchet never triggers any runs. This is the most common mistake.

```typescript
// ✅ CORRECT — cron is in the workflow definition
const workflow = hatchet.workflow({
  name: "my-scheduled-workflow",
  on: { cron: "0 8 * * 1-5" },   // ← REQUIRED for scheduled workflows
});

// ❌ WRONG — cron omitted, workflow never fires
const workflow = hatchet.workflow({
  name: "my-scheduled-workflow",  // no 'on' field → never runs automatically
});
```

Common cron expressions:
```
"0 8 * * 1-5"    every weekday at 8 AM
"*/15 * * * *"   every 15 minutes
"* * * * *"      every minute
"0 0 * * *"      daily at midnight
```

---

### Error handling patterns

```typescript
// Conditional branching based on upstream result
const fetchData = workflow.task({
  name: "fetch-data",
  fn: async (_input) => { /* ... */ return { status: "ok" }; },
});

workflow.task({
  name: "handle-result",
  parents: [fetchData],
  fn: async (_input, ctx) => {
    const { status } = await ctx.parentOutput(fetchData) as { status: string };

    if (status === "error") {
      // notify and stop
      await sendSlackAlert("Fetch failed");
      throw new Error("Upstream fetch failed — aborting workflow");
    }

    // happy path...
  },
});

// Fallback with try/catch inside a task
workflow.task({
  name: "resilient-call",
  retries: 3,
  fn: async (_input, ctx) => {
    try {
      return await callPrimaryAPI();
    } catch (err) {
      await ctx.log(`Primary failed: ${err}, trying fallback`);
      return await callFallbackAPI();
    }
  },
});
```

---

### Persistent storage

Zyk runs on Railway with a persistent volume mounted at `/data`. Use this for any state that must survive across workflow runs — cached responses, reports, counters, etc.

Always use the Node.js built-in `fs` module. No extra dependencies needed.

```typescript
import fs from "fs";

// Read state (with safe default if file doesn't exist yet)
workflow.task({
  name: "load-state",
  fn: async (_input, ctx) => {
    const path = "/data/state.json";
    const raw = fs.existsSync(path) ? fs.readFileSync(path, "utf-8") : "{}";
    const state = JSON.parse(raw) as { lastRun?: string; count?: number };
    await ctx.log(`Loaded state: lastRun=${state.lastRun ?? "never"}`);
    return { state };
  },
});

// Write state
workflow.task({
  name: "save-state",
  fn: async (_input, ctx) => {
    const state = { lastRun: new Date().toISOString(), count: 42 };
    fs.mkdirSync("/data", { recursive: true });   // safe no-op if already exists
    fs.writeFileSync("/data/state.json", JSON.stringify(state, null, 2));
    await ctx.log("State saved");
  },
});

// Write a file (e.g. a CSV report)
workflow.task({
  name: "save-report",
  fn: async (_input, ctx) => {
    const csv = "date,revenue\n2024-01-01,1000\n2024-01-02,1200";
    fs.mkdirSync("/data/reports", { recursive: true });
    fs.writeFileSync(`/data/reports/report-${Date.now()}.csv`, csv);
    await ctx.log("Report saved to /data/reports/");
  },
});
```

**Rules:**
- Always use `/data` as the root — it is the Railway volume mount path
- Always call `fs.mkdirSync(dir, { recursive: true })` before writing to a subdirectory
- For JSON state, default to `{}` if the file doesn't exist yet
- Use `Date.now()` or an ISO timestamp in filenames to avoid overwrites
- Do not use `/tmp` for anything that must persist — it is ephemeral

---

## Diagram Generation

After creating a workflow, always generate a Mermaid flowchart diagram. This is a core UX feature — render it in the chat response as a fenced `mermaid` code block so it appears in the Claude side panel.

### Mandatory rules (apply to every diagram)

**Node shapes — use consistently:**
- `([...])` rounded stadium — trigger/start and terminal Done node only
- `[...]` rectangle — normal task step
- `{...}` diamond — any conditional branch or decision
- `[/.../]` parallelogram — concurrent/parallel steps
- `subgraph` — any loop or repeated section

**Always include:**
1. A trigger node: `A(["▶ On-demand"])` or `A(["⏰ Schedule: <expr>"])`
2. A terminal node: `Z(["✓ Done"])`
3. Every distinct task in the workflow as its own node — do not collapse multiple steps into one box
4. A `{Decision}` diamond for every `if/else` branch in the code, with labelled edges (`|Yes|`, `|No|`, `|approved|`, `|rejected|`, etc.)
5. A `subgraph` for every loop or iteration — never flatten a loop into a linear sequence
6. Parallel tasks rendered as separate nodes that fan out from a common predecessor and rejoin at a common successor
7. A waiting/polling step shown as its own node (e.g. `[Poll for approval]`) whenever the workflow polls or waits for user input
8. Edge labels on every branch leaving a decision diamond

**Never do:**
- Do not merge two or more distinct tasks into a single node to save space
- Do not omit decision diamonds because the branching "seems obvious"
- Do not show a loop as a fixed linear sequence of steps (A → B → C) — always use `subgraph` with a back-edge
- Do not omit the trigger or Done node

### Examples

Sequential with branching:
```
flowchart TD
    A(["⏰ Schedule: 8AM Daily"]) --> B[Fetch Stripe Revenue]
    B --> C[Fetch Last Week Revenue]
    C --> D{Revenue changed?}
    D -->|"Up"| E[Post green summary to Slack]
    D -->|"Down"| F[Post red alert to Slack]
    D -->|"Flat"| G[Post neutral update to Slack]
    E --> Z(["✓ Done"])
    F --> Z
    G --> Z
```

Parallel fan-out:
```
flowchart TD
    A(["▶ On-demand"]) --> B[Fetch GitHub issues]
    B --> C[/Notify Slack/]
    B --> D[/Create Jira ticket/]
    B --> E[/Send email/]
    C --> Z(["✓ Done"])
    D --> Z
    E --> Z
```

Loop with decision:
```
flowchart TD
    A(["▶ On-demand"]) --> B[Fetch items]
    B --> C{More items?}
    subgraph loop [" For each item "]
      C -->|"Yes"| D[Process item]
      D --> E[Ask user question]
      E --> F[Poll for answer]
      F --> G{Answer}
      G -->|"approve"| H[Mark approved]
      G -->|"reject"| I[Mark rejected]
      H --> C
      I --> C
    end
    C -->|"No"| J[Summarize results]
    J --> Z(["✓ Done"])
```

Approval / human-in-the-loop:
```
flowchart TD
    A(["▶ On-demand"]) --> B[Fetch deployment info]
    B --> C[Post approval request to Slack]
    C --> D[Poll for button click]
    D --> E{Decision}
    E -->|"Approve"| F[Run deployment]
    E -->|"Reject"| G[Post rejection notice]
    F --> H[Post success to Slack]
    H --> Z(["✓ Done"])
    G --> Z
```

**Level of detail:** match the diagram to the actual tasks in the generated code. If the code has 6 tasks, the diagram should have 6 task nodes plus trigger, decisions, and Done. Never produce a diagram with fewer nodes than the workflow has tasks.

---

## Docker Compose Setup

The `docker-compose.yml` should run Hatchet + Postgres locally:

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: hatchet
      POSTGRES_PASSWORD: hatchet
      POSTGRES_DB: hatchet
    volumes:
      - postgres_data:/var/lib/postgresql/data

  hatchet-engine:
    image: ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
    ports:
      - "8080:8080"   # Hatchet UI
      - "7077:7077"   # gRPC
    environment:
      DATABASE_URL: postgresql://hatchet:hatchet@postgres:5432/hatchet
    depends_on:
      - postgres

  zyk-mcp:
    build: ./mcp-server
    ports:
      - "3100:3100"
    environment:
      HATCHET_CLIENT_TOKEN: ${HATCHET_CLIENT_TOKEN}
      DATABASE_URL: postgresql://hatchet:hatchet@postgres:5432/hatchet
    depends_on:
      - hatchet-engine

volumes:
  postgres_data:
```

---

## Claude Configuration

Users add Zyk to their Claude by adding this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "command": "node",
      "args": ["/path/to/zyk/mcp-server/dist/index.js"],
      "env": {
        "HATCHET_CLIENT_TOKEN": "your-token-here"
      }
    }
  }
}
```

---

## What Makes This Different from Competitors

| | Zapier/Make | n8n | Temporal | **Zyk** |
|---|---|---|---|---|
| Interface | Visual UI | Visual UI | Code | **Conversation** |
| Connectors | Pre-built only | Pre-built only | DIY | **Any API Claude knows** |
| Durability | Basic | Basic | Yes | **Yes (Hatchet)** |
| Self-host | No/Limited | Yes | Complex | **One command** |
| Target user | Non-technical | Semi-technical | Engineers | **AI-native teams** |

---

## MVP Scope (Build This First)

1. **MCP server** with the 5 core tools above
2. **Hatchet integration** — register and run dynamically generated workflows
3. **Docker Compose** — one command to get running
4. **3 example workflows** that demonstrate the concept
5. **README** with clear setup instructions

Do NOT build in MVP:
- Authentication/multi-user
- Workflow versioning UI
- Custom connector library
- Web dashboard (Hatchet's UI covers this for now)
- Billing/usage tracking

---

## Environment Variables

```bash
# Hatchet
HATCHET_CLIENT_TOKEN=        # From Hatchet dashboard
HATCHET_HOST_PORT=localhost:7077

# Optional user secrets (passed through to generated workflows)
SLACK_TOKEN=
STRIPE_SECRET_KEY=
GITHUB_TOKEN=
# etc — users add their own as needed
```

---

## Key Constraints and Decisions

- **No DSL** — Claude generates real TypeScript, not a custom format
- **No connector library** — Claude writes API calls directly
- **Hatchet not Temporal** — simpler self-hosting is a core feature
- **MCP not REST API** — Claude is the primary interface
- **Self-hosted first** — cloud hosted version comes later
- **TypeScript only** — for MVP, keep it simple

---

## Competitive Positioning

**Zyk is not:**
- A no-code tool (it's AI-code)
- An iPaaS (no connector marketplace)
- A BPM platform (no BPMN, no enterprise process modeling)

**Zyk is:**
- The workflow engine for teams that live in Claude
- "Temporal for people who don't want to think about infrastructure"
- The automation layer that emerges naturally from AI-native workflows

---

## First Steps for Claude Code

1. Initialize the `mcp-server` Node.js/TypeScript project
2. Install dependencies: `@modelcontextprotocol/sdk`, `@hatchet-dev/typescript-sdk`, `typescript`, `tsx`
3. Build the MCP server with the 5 tools defined above
4. Create the Hatchet client wrapper
5. Write a working `docker-compose.yml`
6. Build 2-3 example workflows
7. Write the README

Start with `create_workflow` and `run_workflow` — those two tools alone are enough for a first demo.
