import { z } from "zod";
import { randomUUID } from "crypto";
import { registerWorkflow } from "../hatchet/register.js";
import { validateWorkflowCode } from "../utils/code-runner.js";
import { track } from "../lib/zyk-api.js";

export const createWorkflowSchema = z.object({
  name: z.string().describe("Human-readable workflow name"),
  description: z.string().describe("What this workflow does"),
  code: z.string().describe("TypeScript Hatchet workflow code"),
  schedule: z
    .string()
    .optional()
    .describe("Cron expression for scheduled workflows (e.g. '0 8 * * *')"),
  trigger: z
    .enum(["on-demand", "schedule"])
    .default("on-demand")
    .describe("How the workflow is triggered"),
  diagram: z
    .string()
    .optional()
    .describe("Mermaid flowchart diagram representing the workflow"),
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

/** Sanitize a name so it passes Hatchet's ^[a-zA-Z0-9\.\-_]+$ validation */
function toHatchetName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9.\-_]/g, "")
    || "workflow";
}

/**
 * Patch /interact/ask calls in generated workflow code to ensure workflowName
 * and timeoutSeconds are always present, regardless of what Claude generated.
 *
 * Without workflowName tasks show as "unknown workflow" in the dashboard.
 * Without timeoutSeconds tasks never auto-expire and accumulate in the UI.
 */
export function patchInteractAskCalls(code: string, workflowName: string): string {
  if (!code.includes("/interact/ask")) return code;

  // Infer timeout in seconds from any deadline pattern near the polling loop.
  // Handles: Date.now() + 60 * 1000  /  Date.now() + 60_000  /  Date.now() + 60000
  function parseDeadlineMs(expr: string): number | null {
    // N * 1000  (seconds expressed as multiplication)
    const mulMatch = expr.match(/(\d[\d_]*)\s*\*\s*1000\b/);
    if (mulMatch) return parseInt(mulMatch[1].replace(/_/g, ""));
    // plain ms literal: 60_000 or 60000
    const msMatch = expr.match(/\b(\d[\d_]{2,})\b/);
    if (msMatch) {
      const ms = parseInt(msMatch[1].replace(/_/g, ""));
      if (ms >= 1000) return Math.round(ms / 1000);
    }
    return null;
  }
  const deadlineMatch = code.match(/Date\.now\(\)\s*\+\s*([\d_]+(?:\s*\*\s*[\d_]+)*)/);
  const inferredTimeout = deadlineMatch ? parseDeadlineMs(deadlineMatch[1]) : null;

  // Pass 1: inject workflowName after standalone `correlationId,` in /interact/ask bodies
  const pass1Lines = code.split("\n");
  const pass1Result: string[] = [];
  let inAskFetch = false;

  for (const line of pass1Lines) {
    if (line.includes("/interact/ask")) inAskFetch = true;

    if (inAskFetch && /^\s*correlationId\s*,?\s*$/.test(line)) {
      // Standalone shorthand property — inject workflowName right after
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      pass1Result.push(`${indent}correlationId,`);
      pass1Result.push(`${indent}workflowName: "${workflowName}",`);
      inAskFetch = false;
      continue;
    }

    if (inAskFetch && line.includes("workflowName:")) inAskFetch = false;

    pass1Result.push(line);
  }

  if (inferredTimeout === null) return pass1Result.join("\n");

  // Pass 2: inject timeoutSeconds before the closing `})` of each patched body
  const pass2Lines = pass1Result.join("\n").split("\n");
  const pass2Result: string[] = [];
  let afterWorkflowName = false;
  let seenTimeout = false;

  for (const line of pass2Lines) {
    if (line.includes("workflowName:")) {
      afterWorkflowName = true;
      seenTimeout = false;
    }

    if (afterWorkflowName && line.includes("timeoutSeconds")) seenTimeout = true;

    // Detect the closing `})` of JSON.stringify — inject timeoutSeconds before it
    if (afterWorkflowName && /^\s*\}\s*\)\s*[,;]?\s*$/.test(line)) {
      if (!seenTimeout) {
        const indent = line.match(/^(\s*)/)?.[1] ?? "";
        pass2Result.push(`${indent}timeoutSeconds: ${inferredTimeout},`);
      }
      afterWorkflowName = false;
    }

    pass2Result.push(line);
  }

  return pass2Result.join("\n");
}

/** Extract all process.env.VAR_NAME references from workflow code */
export function extractEnvVars(code: string): string[] {
  const matches = code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
  const vars = new Set<string>();
  for (const match of matches) vars.add(match[1]);
  // Filter out Hatchet internals that Zyk manages automatically
  const internal = new Set(["HATCHET_CLIENT_TOKEN", "HATCHET_CLIENT_TLS_STRATEGY", "PORT", "WEBHOOK_PORT", "WORKFLOWS_DIR"]);
  return [...vars].filter(v => !internal.has(v)).sort();
}

export async function createWorkflow(input: CreateWorkflowInput) {
  const { name, description, schedule, trigger, diagram } = input;
  let { code } = input;

  // Sanitize any workflow name embedded in the code so Hatchet accepts it.
  // Matches: hatchet.workflow({ name: "..." }) or hatchet.workflow({ name: '...' })
  code = code.replace(
    /hatchet\.workflow\s*\(\s*\{([^}]*?)name\s*:\s*(['"])(.*?)\2/g,
    (_match, prefix, quote, wfName) =>
      `hatchet.workflow({${prefix}name: ${quote}${toHatchetName(wfName)}${quote}`
  );

  // Patch /interact/ask calls: inject workflowName + timeoutSeconds if missing.
  // Extract the sanitized workflow name from the code itself (post-sanitization).
  const sanitizedNameMatch = code.match(
    /hatchet\.workflow\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/
  );
  if (sanitizedNameMatch) {
    code = patchInteractAskCalls(code, sanitizedNameMatch[1]);
  }

  // Validate the code before registering
  const validation = validateWorkflowCode(code);

  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid workflow code:\n${validation.errors.join("\n")}`,
      warnings: validation.warnings,
    };
  }

  const id = `wf-${randomUUID().slice(0, 8)}`;

  try {
    const entry = await registerWorkflow({
      id,
      name,
      hatchetName: sanitizedNameMatch?.[1],
      description,
      code,
      trigger,
      schedule,
      diagram,
    });

    const envVars = extractEnvVars(code);

    const result: Record<string, unknown> = {
      success: true,
      workflow_id: entry.id,
      name: entry.name,
      description: entry.description,
      trigger: entry.trigger,
      schedule: entry.schedule,
      created_at: entry.createdAt,
      required_env_vars: envVars,
      message: `Workflow "${name}" registered and worker started successfully. Ask the user if they want to run it — do NOT call run_workflow automatically.`
        + (envVars.length > 0
          ? ` IMPORTANT: tell the user this workflow requires these environment variables to be set in their Railway service: ${envVars.join(", ")}. For each one, briefly explain what it is (e.g. SLACK_BOT_TOKEN = Slack bot token starting with xoxb-).`
          : ""),
    };

    if (validation.warnings.length > 0) {
      result.warnings = validation.warnings;
    }

    track("workflow_created", { trigger });

    return result;
  } catch (err) {
    return {
      success: false,
      error: `Failed to register workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
