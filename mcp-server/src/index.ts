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
import { randomUUID } from "crypto";
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
        "\n\nNATIVE INTERACTIONS — default pattern for asking the user questions. Works in the Zyk dashboard (localhost:3100) without Slack setup:\n" +
        "1. Generate a correlationId: `const correlationId = \\`question-\\${Date.now()}\\``\n" +
        "2. POST to ZYK_WEBHOOK_BASE/interact/ask with { correlationId, message, options? }\n" +
        "3. Poll GET ZYK_WEBHOOK_BASE/slack/pending/<correlationId> every 3s (same endpoint as Slack)\n" +
        "4. User answers in the Zyk dashboard — response arrives via the polling endpoint\n" +
        "Example (retries: 0, timeout: '4h' required on polling task):\n" +
        "```typescript\n" +
        "const correlationId = `question-${Date.now()}`;\n" +
        "const base = process.env.ZYK_WEBHOOK_BASE ?? 'http://localhost:3100';\n" +
        "await fetch(`${base}/interact/ask`, {\n" +
        "  method: 'POST', headers: { 'Content-Type': 'application/json' },\n" +
        "  body: JSON.stringify({ correlationId, message: 'Do you approve?', options: ['yes', 'no'] }),\n" +
        "});\n" +
        "const deadline = Date.now() + 4 * 60 * 60 * 1000;\n" +
        "while (Date.now() < deadline) {\n" +
        "  const r = await fetch(`${base}/slack/pending/${encodeURIComponent(correlationId)}`);\n" +
        "  const d = await r.json() as { pending: boolean; action?: string };\n" +
        "  if (!d.pending && d.action) return { answer: d.action };\n" +
        "  await new Promise(r => setTimeout(r, 3000));\n" +
        "}\n" +
        "throw new Error('Timed out');\n" +
        "```\n" +
        "\n\nSLACK BUTTON INTERACTIONS — mandatory pattern (NEVER use waitForEvent or Hatchet events for Slack):\n" +
        "1. Post a Slack message with an actions block. Set block_id to a unique correlationId (e.g. `approval-${Date.now()}`).\n" +
        "2. Poll GET http://localhost:3100/slack/pending/<correlationId> every 3s.\n" +
        "3. Response is { pending: true } while waiting, or { pending: false, action: 'button_action_id', userId: '...' } once clicked.\n" +
        "Example poll loop (retries: 0 AND timeout: '4h' on polling tasks — REQUIRED to prevent Hatchet from killing the task):\n" +
        "```typescript\n" +
        "// task must have retries: 0, timeout: '4h'\n" +
        "const base = process.env.ZYK_WEBHOOK_BASE ?? 'http://localhost:3100';\n" +
        "const deadline = Date.now() + 60 * 60 * 1000;\n" +
        "while (Date.now() < deadline) {\n" +
        "  const r = await fetch(`${base}/slack/pending/${encodeURIComponent(correlationId)}`);\n" +
        "  const d = await r.json() as { pending: boolean; action?: string };\n" +
        "  if (!d.pending && d.action) return { action: d.action };\n" +
        "  await new Promise(r => setTimeout(r, 3000));\n" +
        "}\n" +
        "```\n" +
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
        "\n\nDIAGRAM: The diagram is stored internally and rendered automatically in the Zyk browser dashboard (localhost:3100). " +
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
              "Mermaid flowchart diagram. Use flowchart TD, plain node labels, no %%{init}%% block. " +
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
          diagram: { type: "string", description: "Updated Mermaid diagram" },
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

// ── HTTP session management ───────────────────────────────────────────────────

const sessions = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const method = req.method ?? "GET";

  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (method === "POST") {
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, body);
      return;
    }
    // New session
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => { sessions.set(id, transport); },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const sessionServer = createMcpServer();
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (method === "GET") {
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No active session" }));
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
    return;
  }

  if (method === "DELETE") {
    if (sessionId) {
      await sessions.get(sessionId)?.close();
      sessions.delete(sessionId);
    }
    res.writeHead(200); res.end();
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

// Global error handlers — log before crashing so Railway captures the cause
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
  process.exit(1);
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
