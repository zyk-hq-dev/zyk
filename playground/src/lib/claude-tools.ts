/**
 * Anthropic Tool definitions for the playground chat API.
 * Mirrors the MCP tool schemas but uses Anthropic's input_schema format.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

type Tool = Anthropic.Messages.Tool;
import {
  registerWorkflow,
  updateWorkflowEntry,
  listWorkflowsBySession,
  getWorkflowEntry,
  deleteWorkflowEntry,
  createWorkflowId,
  validateWorkflowCode,
  hatchetWorkflowName,
} from "./registry";
import { validateCronExpression } from "./code-runner";
import { getHatchetClient } from "./hatchet-client";
import { MAX_WORKFLOWS_PER_SESSION } from "./limits";

// ── Tool schemas ──────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "create_workflow",
    description:
      "Create and register a new durable workflow in Hatchet. Generate TypeScript workflow code and deploy it.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable workflow name" },
        description: { type: "string", description: "What this workflow does" },
        code: {
          type: "string",
          description: "TypeScript Hatchet workflow code",
        },
        schedule: {
          type: "string",
          description: "Cron expression for scheduled workflows (e.g. '0 8 * * *')",
        },
        trigger: {
          type: "string",
          enum: ["on-demand", "schedule"],
          description: "How the workflow is triggered",
        },
        diagram: {
          type: "string",
          description: "Mermaid flowchart diagram representing the workflow",
        },
      },
      required: ["name", "description", "code"],
    },
  },
  {
    name: "update_workflow",
    description:
      "Update an existing workflow's code, description, trigger, or schedule. The worker is restarted automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to update",
        },
        code: {
          type: "string",
          description: "New TypeScript workflow code (replaces existing)",
        },
        description: { type: "string", description: "Updated description" },
        trigger: {
          type: "string",
          enum: ["on-demand", "schedule"],
          description: "Updated trigger type",
        },
        schedule: {
          type: "string",
          description: "Updated cron expression",
        },
        diagram: {
          type: "string",
          description: "Updated Mermaid diagram",
        },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "run_workflow",
    description: "Trigger an execution of a registered workflow.",
    input_schema: {
      type: "object" as const,
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID returned by create_workflow",
        },
        params: {
          type: "object",
          description: "Runtime parameters to pass to the workflow",
          additionalProperties: true,
        },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "get_status",
    description:
      "Get the current status of a workflow or a specific workflow run.",
    input_schema: {
      type: "object" as const,
      properties: {
        workflow_id: { type: "string", description: "The workflow ID" },
        run_id: {
          type: "string",
          description: "Optional specific run ID to get status for",
        },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "list_workflows",
    description:
      "List all registered workflows and their current worker status (running/stopped).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_runs",
    description: "List recent workflow run executions. Optionally filter by status.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max runs to return (default 20)" },
        status: { type: "string", description: "Filter by status: COMPLETED, FAILED, RUNNING, QUEUED" },
        since_hours: { type: "number", description: "How many hours back to look (default 24)" },
      },
      required: [],
    },
  },
  {
    name: "delete_workflow",
    description: "Remove a workflow from the registry and stop its worker process.",
    input_schema: {
      type: "object" as const,
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to delete",
        },
      },
      required: ["workflow_id"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  sessionId: string
): Promise<unknown> {
  switch (toolName) {
    case "create_workflow": {
      const { name, description, code, trigger = "on-demand", schedule, diagram } = input;

      // Enforce max workflows per session
      const existingWorkflows = listWorkflowsBySession(sessionId);
      if (existingWorkflows.length >= MAX_WORKFLOWS_PER_SESSION) {
        return {
          success: false,
          error: `Workflow limit reached. This session already has ${existingWorkflows.length} workflows (max ${MAX_WORKFLOWS_PER_SESSION}). Please delete one before creating another.`,
          code: "MAX_WORKFLOWS_REACHED",
        };
      }

      // Validate code
      const validation = validateWorkflowCode(code);
      if (!validation.valid) {
        return {
          success: false,
          error: `Invalid workflow code:\n${validation.errors.join("\n")}`,
          warnings: validation.warnings,
        };
      }

      // Validate cron if scheduled
      if (trigger === "schedule" && schedule) {
        const cronCheck = validateCronExpression(schedule);
        if (!cronCheck.valid) {
          return { success: false, error: cronCheck.error };
        }
      }

      const id = createWorkflowId(sessionId);

      try {
        const entry = await registerWorkflow({
          id,
          sessionId,
          name,
          description,
          code,
          trigger,
          schedule,
          diagram,
        });

        return {
          success: true,
          workflow_id: entry.id,
          name: entry.name,
          description: entry.description,
          trigger: entry.trigger,
          schedule: entry.schedule,
          created_at: entry.createdAt,
          message: `Workflow "${name}" registered and worker started successfully.`,
          ...(validation.warnings.length > 0
            ? { warnings: validation.warnings }
            : {}),
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to register workflow: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case "update_workflow": {
      const { workflow_id, code, description, trigger, schedule, diagram } = input;

      const existing = getWorkflowEntry(workflow_id);
      if (!existing || existing.sessionId !== sessionId) {
        return {
          success: false,
          error: `Workflow "${workflow_id}" not found.`,
        };
      }

      if (!code && !description && !trigger && !schedule && !diagram) {
        return {
          success: false,
          error: "At least one field must be provided.",
        };
      }

      if (code) {
        const validation = validateWorkflowCode(code);
        if (!validation.valid) {
          return {
            success: false,
            error: `Invalid workflow code:\n${validation.errors.join("\n")}`,
          };
        }
      }

      if (trigger === "schedule" && schedule) {
        const cronCheck = validateCronExpression(schedule);
        if (!cronCheck.valid) {
          return { success: false, error: cronCheck.error };
        }
      }

      try {
        const updated = await updateWorkflowEntry({
          id: workflow_id,
          code,
          description,
          trigger,
          schedule,
          diagram,
        });
        return {
          success: true,
          workflow_id: updated.id,
          name: updated.name,
          message: `Workflow "${updated.name}" updated and worker restarted.`,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to update workflow: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case "run_workflow": {
      const { workflow_id, params = {} } = input;

      const entry = getWorkflowEntry(workflow_id);
      if (!entry || entry.sessionId !== sessionId) {
        return { success: false, error: `Workflow "${workflow_id}" not found.` };
      }

      try {
        const hatchet = getHatchetClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const runRef = await hatchet.runNoWait(hatchetWorkflowName(entry.name, entry.sessionId), params as any, {});
        const runId = await runRef.workflowRunId;
        return {
          success: true,
          run_id: runId,
          workflow_id,
          workflow_name: entry.name,
          message: `Workflow "${entry.name}" triggered.`,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to run workflow: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case "get_status": {
      const { workflow_id, run_id } = input;

      const entry = getWorkflowEntry(workflow_id);
      if (!entry || entry.sessionId !== sessionId) {
        return { success: false, error: `Workflow "${workflow_id}" not found.` };
      }

      if (run_id) {
        try {
          const hatchet = getHatchetClient();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const run = await (hatchet.api as any).workflowRunGet(
            hatchet.tenantId,
            run_id
          );
          return {
            workflow_id,
            run_id,
            status: run.data?.status ?? "UNKNOWN",
            started_at: run.data?.metadata?.createdAt,
            finished_at: run.data?.finishedAt,
          };
        } catch (err) {
          return {
            success: false,
            error: `Failed to get run status: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      return {
        workflow_id,
        name: entry.name,
        trigger: entry.trigger,
        schedule: entry.schedule,
        created_at: entry.createdAt,
      };
    }

    case "list_workflows": {
      const workflows = listWorkflowsBySession(sessionId);
      return {
        workflows: workflows.map((w) => ({
          workflow_id: w.id,
          name: w.name,
          description: w.description,
          trigger: w.trigger,
          schedule: w.schedule,
          created_at: w.createdAt,
        })),
        count: workflows.length,
      };
    }

    case "list_runs": {
      const { limit = 20, status, since_hours = 24 } = input;
      const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
      const params = new URLSearchParams({ sessionId, limit: String(limit), since_hours: String(since_hours) });
      if (status) params.set("status", status);
      const res = await fetch(`${base}/api/runs?${params}`);
      const data = await res.json() as { runs?: unknown[]; error?: string };
      if (!res.ok) return { error: data.error ?? "Failed to fetch runs" };
      return data;
    }

    case "delete_workflow": {
      const { workflow_id } = input;
      const entry = getWorkflowEntry(workflow_id);
      if (!entry || entry.sessionId !== sessionId) {
        return { success: false, error: `Workflow "${workflow_id}" not found.` };
      }
      await deleteWorkflowEntry(workflow_id);
      return {
        success: true,
        message: `Workflow "${entry.name}" deleted.`,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

export function getSystemPrompt(sessionId: string): string {
  return `You are Zyk, an AI workflow automation assistant. You help users create and run durable workflows using Hatchet (a workflow execution engine).

## Your capabilities
You can create, run, update, list, and delete workflows using the provided tools.

## Session context
Current session ID: ${sessionId}
All workflows you create are scoped to this session.

## Workflow code rules (CRITICAL — follow exactly)

Every workflow MUST use this exact structure:

\`\`\`typescript
import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const workflow = hatchet.workflow({
  name: "workflow-name",  // kebab-case
});

const step1 = workflow.task({
  name: "step-1",
  retries: 3,
  fn: async (_input, ctx) => {
    await ctx.log("Starting step-1");
    return { value: "result" };
  },
});

workflow.task({
  name: "step-2",
  parents: [step1],
  retries: 3,
  fn: async (_input, ctx) => {
    const { value } = await ctx.parentOutput(step1) as { value: string };
    await ctx.log(\`Got: \${value}\`);
    return { done: true };
  },
});

const worker = await hatchet.worker("workflow-name-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };
\`\`\`

Rules:
- Import must be named: \`import { Hatchet } from "@hatchet-dev/typescript-sdk"\`
- Task function key is \`fn:\`, NOT \`run:\`. Signature is \`(input, ctx)\` — ctx is SECOND param
- Store task return values: \`const taskRef = workflow.task({...})\`
- Pass task refs to \`parents:\`, NOT strings
- Await \`ctx.parentOutput(taskRef)\` — it is async
- Always \`export default { start: () => worker.start() }\`
- Each task gets \`retries: 3\`
- For scheduled workflows: include \`on: { cron: "<expression>" }\` in \`hatchet.workflow({...})\`

## Available APIs (playground environment)
These API keys are pre-configured — use them directly:

- **Tavily Search**: \`process.env.TAVILY_API_KEY\` — POST https://api.tavily.com/search
- **OpenWeatherMap**: \`process.env.OPENWEATHERMAP_API_KEY\` — GET https://api.openweathermap.org/data/2.5/weather?q=CITY&appid=KEY&units=metric
  Response shape: \`{ name, sys: { country, sunrise, sunset }, weather: [{ description }], main: { temp, feels_like, temp_min, temp_max, humidity, pressure }, wind: { speed, deg }, visibility, clouds: { all } }\`
  Access as: \`data.main.temp\`, \`data.weather[0].description\`, \`data.wind.speed\`, \`data.sys.country\`, etc.
- **NewsAPI**: ~~not available~~ — free tier blocks non-localhost servers; use Tavily Search for news instead
- Any public **JSON API** endpoint (e.g. SWAPI, Open Meteo, REST Countries) — must return JSON, not HTML

**Do NOT**:
- Fetch arbitrary websites or scrape HTML pages (e.g. news sites, blogs, any URL returning text/html)
- Attempt to use Slack, Stripe, AWS, email APIs, or any API not listed above

If the user asks you to fetch a website or scrape HTML, explain that the playground only supports JSON APIs and suggest using the NewsAPI or Tavily Search instead.

## Human-in-the-loop interactions
Instead of Slack buttons, ask the user directly using HTTP:

\`\`\`typescript
// Ask a question and wait for the user's response
const askTask = workflow.task({
  name: "ask-user",
  retries: 3,
  fn: async (_input, ctx) => {
    const correlationId = \`question-\${Date.now()}\`;
    const base = process.env.ZYK_WEBHOOK_BASE;
    if (!base) throw new Error("ZYK_WEBHOOK_BASE is not set");

    // Post question to the UI
    const res = await fetch(\`\${base}/api/interact/ask\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        sessionId: process.env.ZYK_SESSION_ID ?? "unknown",
        message: "What city should I check the weather for?",
        options: ["London", "New York", "Tokyo"],  // optional
      }),
    });
    if (!res.ok) throw new Error(\`Failed to send question: \${res.status}\`);
    await ctx.log(\`Question sent (id=\${correlationId})\`);
    return { correlationId };
  },
});

workflow.task({
  name: "wait-for-answer",
  parents: [askTask],
  retries: 0,   // never retry a polling loop
  fn: async (_input, ctx) => {
    const { correlationId } = await ctx.parentOutput(askTask) as { correlationId: string };
    const base = process.env.ZYK_WEBHOOK_BASE;
    if (!base) throw new Error("ZYK_WEBHOOK_BASE is not set");
    const deadline = Date.now() + 30 * 60 * 1000;  // 30 min

    while (Date.now() < deadline) {
      const r = await fetch(\`\${base}/api/slack/pending/\${encodeURIComponent(correlationId)}\`);
      const d = await r.json() as { pending: boolean; action?: string };
      if (!d.pending && d.action) {
        await ctx.log(\`User chose: \${d.action}\`);
        return { answer: d.action };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error("Timed out waiting for user response");
  },
});
\`\`\`

**IMPORTANT**: Pass the session ID to /api/interact/ask so the question appears in the right browser tab:
- Add \`sessionId: process.env.ZYK_SESSION_ID ?? "unknown"\` to the ask request

## Diagram generation
Every \`create_workflow\` call MUST include a \`diagram\` field — a Mermaid \`flowchart TD\` string.

Rules:
- Use \`([text])\` for start/end nodes
- Use \`[text]\` for task/action nodes (one per Hatchet task)
- Use \`{text}\` for decision/conditional nodes (whenever a task contains an if-check, branch, or loop with conditional output)
- Use \`-->|label|\` for conditional edges
- Tasks without parents run in parallel — show them side by side
- Keep node labels short (2–5 words)

Example with conditional:
\`\`\`
flowchart TD
    A([Start]) --> B[Fetch Data]
    B --> C{Check result}
    C -->|success| D[Send report]
    C -->|error| E[Send alert]
    D --> F([Done])
    E --> F
\`\`\`

Example with parallel tasks:
\`\`\`
flowchart TD
    A([Start]) --> B[Fetch Revenue]
    A --> C[Fetch Users]
    B --> D[Send Report]
    C --> D
    D --> E([Done])
\`\`\`

## Logs
Workflow logs stream automatically into the chat UI in real time. **Every task MUST call \`ctx.log()\` at least once** — at the start and at key results — so the user can follow progress. Examples:
- \`await ctx.log("Fetching weather for London...")\` at the start of a fetch task
- \`await ctx.log("Temperature: 18°C, humidity: 72%")\` after parsing the response
- \`await ctx.log("Question sent, waiting for user response...")\` in an ask-user task
- \`await ctx.log("User chose: Tokyo")\` after receiving an answer

Never generate a task body without at least one \`ctx.log()\` call. You do NOT need to fetch logs yourself; they appear automatically to the user.

## Workflow creation flow
When a user asks for a workflow:
1. Generate the TypeScript code following the rules above
2. Call \`create_workflow\` immediately with the \`diagram\` field filled in — no approval needed
3. After the workflow is created, briefly explain what it does

If \`create_workflow\` returns \`code: "MAX_WORKFLOWS_REACHED"\`, tell the user clearly: they have reached the 5-workflow limit for this session and need to delete an existing workflow first. Offer to delete one for them.

## Clarification rules
Ask in ONE message only when a **business-level** detail is genuinely unknown and cannot be defaulted:
- Schedule frequency (for scheduled workflows only)

Never ask about: error handling, retries, which HTTP library, code structure, or implementation details.

**CRITICAL**: If the user says "ask me X" or "ask me for X" — that means the **workflow itself** should ask via the interaction system at runtime. Do NOT ask X yourself in chat. Just create and run the workflow; it will prompt the user automatically when it reaches that step.

Example: "Ask me which city to check the weather for" → create a workflow with an ask-user task that calls \`/api/interact/ask\` at runtime. Do not ask "which city?" in chat.

## Cron expressions
Minimum interval: 1 minute (cron limitation — seconds are not supported). Common examples:
- \`"* * * * *"\` — every minute
- \`"*/5 * * * *"\` — every 5 minutes
- \`"0 8 * * 1-5"\` — weekdays at 8 AM
- \`"0 0 * * *"\` — daily at midnight

## Response style
- Be concise and direct
- After creating a workflow, briefly explain what it does and mention the diagram
- If a workflow fails to start, explain the error clearly and offer to fix it
- Workflow names must NOT contain emojis or icons — plain text only (e.g. "Berlin Weather Logger", not "🌦 Berlin Weather Logger")`;
}
