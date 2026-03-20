#!/usr/bin/env node

// Load .env from the repo root for local development.
// In Docker/Railway env vars come from the container environment — this is a no-op there.
// We do this manually (no dotenv) to guarantee nothing is written to stdout,
// which would corrupt the MCP stdio JSON-RPC stream.
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
{
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
      }
    }
  }
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { IncomingMessage, ServerResponse } from "http";
import { fstatSync } from "fs";

import { createWorkflow, createWorkflowSchema } from "./tools/create-workflow.js";
import { runWorkflow, runWorkflowSchema } from "./tools/run-workflow.js";
import { getStatus, getStatusSchema } from "./tools/get-status.js";
import { listWorkflowsTool, listWorkflowsSchema } from "./tools/list-workflows.js";
import { listRuns, listRunsSchema } from "./tools/list-runs.js";
import { deleteWorkflowTool, deleteWorkflowSchema } from "./tools/delete-workflow.js";
import { updateWorkflowTool, updateWorkflowSchema } from "./tools/update-workflow.js";
import { listTemplatesTool, listTemplatesSchema } from "./tools/list-templates.js";
import { useTemplateTool, useTemplateSchema } from "./tools/use-template.js";
import { reviewWorkflowTool, reviewWorkflowSchema } from "./tools/review-workflow.js";
import { restoreWorkersOnStartup } from "./hatchet/register.js";
import { stopAllWorkers } from "./hatchet/worker.js";
import { startWebhookServer, storeInteractionAnswer } from "./server/webhook.js";
import { getTasksTool, getTasksSchema } from "./tools/get-tasks.js";
import { respondTaskTool, respondTaskSchema, setAnswerStore } from "./tools/respond-task.js";
import { ensureHatchetToken } from "./hatchet/bootstrap.js";
import { runProxy } from "./proxy.js";

// ── Server factory ────────────────────────────────────────────────────────────
// Each HTTP session gets its own Server instance (SDK allows one connect per server).

function createMcpServer(): Server {
  const server = new Server(
    { name: "zyk-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_workflow",
      description:
        "Create and register a new durable workflow in Hatchet. " +
        "\n\nCLARIFICATION RULES — follow exactly:\n" +
        "Only ask if a business-level detail is genuinely ambiguous and has no reasonable default. " +
        "Ask all questions in ONE short message, then wait for answers. " +
        "NEVER ask about: which Slack channel (use process.env.SLACK_CHANNEL), which GitHub repo (use process.env.GITHUB_REPO), " +
        "who is on-call (use process.env.ONCALL_USER), which engineering/leadership/support channel (use process.env.ENGINEERING_CHANNEL / LEADERSHIP_CHANNEL / SUPPORT_CHANNEL), " +
        "Slack auth token (ALWAYS use process.env.SLACK_BOT_TOKEN — NEVER process.env.SLACK_TOKEN), " +
        "error handling (always throw on non-OK), retries (always 3), HTTP library (always fetch()), secrets (always process.env.VAR), " +
        "how to ask the user a question — use the NATIVE INTERACTIONS pattern by default (POST /interact/ask). Only use Slack buttons if the user explicitly mentions Slack.\n" +
        "Once functional requirements are clear, generate code and call this tool immediately — no approval needed.\n" +
        "\n\nHUMAN INTERACTION PATTERN — use workflow.durableTask() for ANY step that waits for user input (dashboard or Slack). " +
        "This is the ONLY correct pattern — never use polling loops or retries: 0 hacks.\n" +
        "The step is suspended durably in Hatchet's DB and resumed automatically when the user responds. Worker thread is freed while waiting.\n" +
        "\nNATIVE INTERACTIONS (dashboard) — example:\n" +
        "```typescript\n" +
        "const askUser = workflow.durableTask({\n" +
        "  name: 'ask-user',\n" +
        "  executionTimeout: '24h',\n" +
        "  fn: async (_input, ctx) => {\n" +
        "    const correlationId = `question-${Date.now()}`;\n" +
        "    const base = process.env.ZYK_WEBHOOK_BASE ?? 'http://localhost:3100';\n" +
        "    await fetch(`${base}/interact/ask`, {\n" +
        "      method: 'POST', headers: { 'Content-Type': 'application/json' },\n" +
        "      body: JSON.stringify({ correlationId, workflowName: 'my-workflow', message: 'Do you approve?', options: ['yes', 'no'] }),\n" +
        "    });\n" +
        "    await ctx.log(`Waiting for user input (id=${correlationId})`);\n" +
        "    const result = await ctx.waitForEvent(correlationId);\n" +
        "    await ctx.log(`User answered: ${result.action}`);\n" +
        "    return { answer: result.action as string };\n" +
        "  },\n" +
        "});\n" +
        "```\n" +
        "\nSLACK BUTTON INTERACTIONS — example:\n" +
        "```typescript\n" +
        "const waitForApproval = workflow.durableTask({\n" +
        "  name: 'wait-for-approval',\n" +
        "  executionTimeout: '24h',\n" +
        "  fn: async (_input, ctx) => {\n" +
        "    const correlationId = `approval-${Date.now()}`;\n" +
        "    // post Slack message with block_id: correlationId on the actions block\n" +
        "    await ctx.log(`Waiting for Slack approval (id=${correlationId})`);\n" +
        "    const result = await ctx.waitForEvent(correlationId);\n" +
        "    await ctx.log(`Decision: ${result.action} by ${result.userId}`);\n" +
        "    return { approved: result.action === 'approve', action: result.action as string };\n" +
        "  },\n" +
        "});\n" +
        "```\n" +
        "RULES: (1) Always use workflow.durableTask() — never workflow.task() — for steps that wait for input. " +
        "(2) ctx.waitForEvent(correlationId) suspends the step durably — no polling, no timeout tricks. " +
        "(3) executionTimeout: '24h' sets the maximum wait time. " +
        "(4) Still call POST /interact/ask for native interactions so the question appears in the Zyk dashboard. " +
        "(5) For Slack: set block_id on the actions block to the correlationId — that's what Zyk uses to match the click.\n" +
        "\n\nMANDATORY CODE TEMPLATE (copy this structure exactly — wrong patterns cause runtime errors):\n" +
        "```typescript\n" +
        'import { Hatchet } from "@hatchet-dev/typescript-sdk"; // named import — NOT default\n' +
        "const hatchet = Hatchet.init();\n" +
        'const workflow = hatchet.workflow({ name: "my-workflow" });\n' +
        "// Store return value of each task — needed for parent refs\n" +
        "const step1 = workflow.task({\n" +
        '  name: "step-1",\n' +
        "  retries: 3,\n" +
        "  fn: async (_input, ctx) => {  // key is 'fn', NOT 'run'; ctx is SECOND param\n" +
        '    await ctx.log("step 1");\n' +
        "    return { value: 42 };\n" +
        "  },\n" +
        "});\n" +
        "workflow.task({\n" +
        '  name: "step-2",\n' +
        "  parents: [step1],             // pass task REF, NOT a string\n" +
        "  fn: async (_input, ctx) => {\n" +
        "    const { value } = await ctx.parentOutput(step1); // must await\n" +
        "    return { done: true };\n" +
        "  },\n" +
        "});\n" +
        'const worker = await hatchet.worker("my-workflow-worker", { workflows: [workflow] });\n' +
        "export default { start: () => worker.start() };\n" +
        "```\n" +
        "RULES: (1) import { Hatchet } named, never default. " +
        "(2) fn: not run:. " +
        "(3) fn signature (input, ctx) — ctx is second. " +
        "(4) parents: [taskRef] not parents: ['string']. " +
        "(5) await ctx.parentOutput(taskRef). " +
        "(6) await hatchet.worker(...). " +
        "(7) Use process.env.VAR for secrets. " +
        "(8) Use fetch() for HTTP — no extra packages. " +
        "(9) SCHEDULED WORKFLOWS: ALWAYS include on: { cron: '<expression>' } inside hatchet.workflow({...}) — e.g. hatchet.workflow({ name: 'my-workflow', on: { cron: '* * * * *' } }). WITHOUT THIS the workflow is never triggered automatically. " +
        "(10) HUMAN INPUT: use workflow.durableTask() not workflow.task() for any step that waits for user input. See HUMAN INTERACTION PATTERN above. " +
        "\n\nDIAGRAM: The diagram is stored internally and rendered automatically in the Zyk dashboard. " +
        "Do NOT output any mermaid diagram in your reply — just confirm the workflow was created.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable workflow name" },
          description: { type: "string", description: "What this workflow does" },
          code: { type: "string", description: "TypeScript Hatchet workflow code" },
          schedule: {
            type: "string",
            description: "Cron expression for scheduled workflows (e.g. '0 8 * * *')",
          },
          trigger: {
            type: "string",
            enum: ["on-demand", "schedule"],
            description: "How the workflow is triggered",
            default: "on-demand",
          },
          diagram: {
            type: "string",
            description:
              "Mermaid flowchart diagram (flowchart TD). Rules:\n" +
              "- Node labels MUST be descriptive human-readable text — NEVER use kebab-case task names from the code (e.g. write 'Fetch films from SWAPI' not 'fetch-film', 'Ask user about favourite film' not 'ask-user')\n" +
              "- Shapes: ([...]) for trigger/done nodes only, [...] for normal steps, {...} for decisions/branches, [/.../] for parallel steps\n" +
              "- Always start with a trigger node: ([\"▶ On-demand\"]) or ([\"⏰ Schedule: <expr>\"])\n" +
              "- Always end with a terminal node: ([\"✓ Done\"])\n" +
              "- One node per task — never collapse multiple tasks into one box\n" +
              "- Add a {...} diamond for every if/else branch with labelled edges (|Yes|, |No|, |approved|, etc.)\n" +
              "- Use subgraph for any loop with a back-edge — never flatten a loop into a linear sequence\n" +
              "- Show parallel tasks as separate nodes fanning out from a common predecessor\n" +
              "- Show polling/waiting steps as their own node (e.g. [Poll for user response])\n" +
              "- No %%{init}%% block, no emoji in node labels\n" +
              "Do NOT output this diagram in your reply — it is rendered automatically in the Zyk dashboard.",
          },
        },
        required: ["name", "description", "code"],
      },
    },
    {
      name: "update_workflow",
      description:
        "Update an existing workflow's code, description, trigger, or schedule. " +
        "The worker is restarted automatically. The workflow ID is preserved. " +
        "Ask clarifying questions about functional changes if needed (same rules as create_workflow), " +
        "but never ask about technical choices. " +
        "Use the same mandatory code pattern as create_workflow: import { Hatchet } named, fn: not run:, parents: [taskRef] not strings.",
      inputSchema: {
        type: "object",
        properties: {
          workflow_id: { type: "string", description: "The workflow ID to update" },
          code: { type: "string", description: "New TypeScript workflow code (replaces existing)" },
          description: { type: "string", description: "Updated description" },
          trigger: {
            type: "string",
            enum: ["on-demand", "schedule"],
            description: "Updated trigger type",
          },
          schedule: { type: "string", description: "Updated cron expression" },
          diagram: { type: "string", description: "Updated Mermaid diagram — follow the same labeling rules as create_workflow: descriptive human-readable node labels, never kebab-case task names." },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "run_workflow",
      description:
        "Trigger an execution of a registered workflow. Returns a run_id you can use with get_status.",
      inputSchema: {
        type: "object",
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
      inputSchema: {
        type: "object",
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
      description: "List all registered workflows and their current worker status (running/stopped). Use list_runs to see actual executions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_runs",
      description:
        "List recent workflow run executions from Hatchet. " +
        "Use this when the user asks about runs, executions, history, or what happened. " +
        "Optionally filter by workflow_id, status, or time window.",
      inputSchema: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "Filter by a specific workflow ID (optional — omit for all workflows)",
          },
          limit: {
            type: "number",
            description: "Max runs to return (default 20, max 100)",
          },
          status: {
            type: "string",
            enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
            description: "Filter by run status (optional)",
          },
          since_hours: {
            type: "number",
            description: "How many hours back to look (default 24)",
          },
        },
      },
    },
    {
      name: "delete_workflow",
      description: "Remove a workflow from the registry and stop its worker process.",
      inputSchema: {
        type: "object",
        properties: {
          workflow_id: { type: "string", description: "The workflow ID to delete" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "get_tasks",
      description:
        "Get all pending workflow tasks that are waiting for your input. " +
        "Call this proactively when the user asks about pending tasks, open questions, workflows waiting for a response, or 'anything waiting for me'. " +
        "Also call this at the start of a conversation if the user seems to be checking in on running workflows.\n\n" +
        "FLOW: When tasks are returned, handle ALL of them sequentially in a single conversation turn — do not wait for the user to re-prompt. " +
        "For each task: (1) state the task number and which workflow it belongs to, (2) show the question, (3) if options are provided present them clearly as a numbered list (e.g. '1. approve  2. reject'), (4) ask the user to reply with their choice, (5) call respond_task with the answer, (6) confirm and immediately move on to the next task without re-prompting. " +
        "After all tasks are done, summarise what was answered. " +
        "If no tasks are pending, say so in one sentence.\n\n" +
        "You can also direct the user to the Tasks tab in the dashboard for a button-based UI (the dashboard_url is returned in the response).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "respond_task",
      description:
        "Submit your answer to a pending workflow task. Use after get_tasks to respond to a question a workflow is waiting on. " +
        "Call this immediately after getting the user's answer — do not wait, do not ask for confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          correlation_id: {
            type: "string",
            description: "The correlation_id from get_tasks",
          },
          answer: {
            type: "string",
            description: "Your answer — must match one of the options if options were provided",
          },
        },
        required: ["correlation_id", "answer"],
      },
    },
    {
      name: "list_templates",
      description:
        "List pre-built workflow templates from the Zyk library. Requires ZYK_API_KEY.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "use_template",
      description:
        "Fetch the full code for a workflow template so you can deploy it with create_workflow. Requires ZYK_API_KEY.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: {
            type: "string",
            description: "The template ID from list_templates",
          },
        },
        required: ["template_id"],
      },
    },
    {
      name: "review_workflow",
      description:
        "Send a workflow's code to Zyk's AI backend for quality suggestions. Requires ZYK_API_KEY.",
      inputSchema: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The workflow ID to review",
          },
        },
        required: ["workflow_id"],
      },
    },
  ],
}));

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "create_workflow": {
        const input = createWorkflowSchema.parse(args);
        result = await createWorkflow(input);
        break;
      }
      case "update_workflow": {
        const input = updateWorkflowSchema.parse(args);
        result = await updateWorkflowTool(input);
        break;
      }
      case "run_workflow": {
        const input = runWorkflowSchema.parse(args);
        result = await runWorkflow(input);
        break;
      }
      case "get_status": {
        const input = getStatusSchema.parse(args);
        result = await getStatus(input);
        break;
      }
      case "list_workflows": {
        const input = listWorkflowsSchema.parse(args);
        result = await listWorkflowsTool(input);
        break;
      }
      case "list_runs": {
        const input = listRunsSchema.parse(args);
        result = await listRuns(input);
        break;
      }
      case "delete_workflow": {
        const input = deleteWorkflowSchema.parse(args);
        result = await deleteWorkflowTool(input);
        break;
      }
      case "get_tasks": {
        const input = getTasksSchema.parse(args);
        result = await getTasksTool(input);
        break;
      }
      case "respond_task": {
        const input = respondTaskSchema.parse(args);
        result = await respondTaskTool(input);
        break;
      }
      case "list_templates": {
        const input = listTemplatesSchema.parse(args);
        result = await listTemplatesTool(input);
        break;
      }
      case "use_template": {
        const input = useTemplateSchema.parse(args);
        result = await useTemplateTool(input);
        break;
      }
      case "review_workflow": {
        const input = reviewWorkflowSchema.parse(args);
        result = await reviewWorkflowTool(input);
        break;
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

  return server;
}

// ── HTTP request handler (stateless mode) ────────────────────────────────────
// Each POST is handled independently — no session state, no SSE GET needed.
// This avoids 409 race conditions and is compatible with Railway's proxy which
// kills long-lived SSE connections anyway.

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown
): Promise<void> {
  const method = req.method ?? "GET";

  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });
    const sessionServer = createMcpServer();
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, body);
    // Clean up after request completes
    await sessionServer.close().catch(() => {});
    return;
  }

  res.writeHead(405); res.end();
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  // Proxy mode: bridge stdio ↔ remote HTTP MCP server (for Claude Desktop + Railway)
  // Usage: node dist/index.js --proxy https://your-app.railway.app/mcp
  const proxyIdx = process.argv.indexOf("--proxy");
  if (proxyIdx !== -1) {
    const remoteUrl = process.argv[proxyIdx + 1];
    if (!remoteUrl) {
      process.stderr.write("Usage: node dist/index.js --proxy <url>\n");
      process.exit(1);
    }
    await runProxy(remoteUrl);
    return; // process stays alive via open stdio/HTTP connections
  }

  const port = parseInt(process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3100", 10);

  setAnswerStore(storeInteractionAnswer);

  // Start the HTTP server immediately so Railway healthchecks pass.
  // Bootstrap and worker restore run in the background.
  startWebhookServer(port, handleMcpRequest);
  console.error(`Zyk MCP server listening on http://0.0.0.0:${port}/mcp`);

  // If stdin is an actual pipe (spawned by Claude Desktop), connect a stdio transport.
  // We check isFIFO() to distinguish real IPC pipes from /dev/null (Docker/Railway).
  const stdinIsPipe = (() => { try { return fstatSync(0).isFIFO(); } catch { return false; } })();
  if (stdinIsPipe) {
    const stdioServer = createMcpServer();
    const stdioTransport = new StdioServerTransport();
    await stdioServer.connect(stdioTransport);
    console.error("Zyk MCP server connected via stdio");
  } else {
    console.error("Zyk MCP server running in HTTP-only mode (stdin is not a pipe)");
  }

  // Bootstrap token and restore workers in the background.
  ensureHatchetToken()
    .then(() => restoreWorkersOnStartup())
    .catch((err) => {
      console.error("Warning: Hatchet bootstrap failed:", err);
    });
}

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

// Log unhandled rejections but do NOT exit.
// The Hatchet SDK starts background gRPC connections that can fail asynchronously
// (e.g. when HATCHET_HOST_PORT is misconfigured). Those failures must not kill the
// HTTP server — Claude must still be able to connect via MCP.
process.on("unhandledRejection", (reason) => {
  console.error("[WARN] Unhandled promise rejection (server continuing):", reason);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await stopAllWorkers();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopAllWorkers();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
