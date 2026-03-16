import { z } from "zod";
import { getWorkflow } from "../hatchet/register.js";
import { getHatchetClient } from "../hatchet/client.js";
import { track, recordRun } from "../lib/zyk-api.js";

export const runWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID returned by create_workflow"),
  params: z
    .record(z.unknown())
    .optional()
    .describe("Runtime parameters to pass to the workflow"),
});

export type RunWorkflowInput = z.infer<typeof runWorkflowSchema>;

// Guard against double-triggering the same workflow within 10 seconds
const recentTriggers = new Map<string, number>();
const DEBOUNCE_MS = 10_000;

export async function runWorkflow(input: RunWorkflowInput) {
  const { workflow_id, params = {} } = input;

  const lastTriggered = recentTriggers.get(workflow_id);
  if (lastTriggered && Date.now() - lastTriggered < DEBOUNCE_MS) {
    return {
      success: false,
      error: `Workflow "${workflow_id}" was already triggered ${Math.round((Date.now() - lastTriggered) / 1000)}s ago and may still be starting. Wait a moment before running again.`,
    };
  }
  recentTriggers.set(workflow_id, Date.now());

  const entry = getWorkflow(workflow_id);
  if (!entry) {
    return {
      success: false,
      error: `Workflow "${workflow_id}" not found. Use list_workflows to see available workflows.`,
    };
  }

  try {
    const hatchet = getHatchetClient();

    // Trigger the workflow by name without waiting for it to complete.
    // Hatchet normalizes workflow names to lowercase internally, so we must match.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runRef = await hatchet.runNoWait(entry.name.toLowerCase().replace(/\s+/g, "-"), params as any, {});

    const runId = await runRef.workflowRunId;

    const runIdStr = typeof runId === "string" ? runId : runId.workflowRunId;
    track("workflow_run", { trigger: entry.trigger });
    recordRun(entry.id, runIdStr, entry.trigger);

    return {
      success: true,
      workflow_id: entry.id,
      workflow_name: entry.name,
      run_id: runId,
      message: `Workflow "${entry.name}" triggered successfully.`,
      hint: `Use get_status with workflow_id="${workflow_id}" to check progress.`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to run workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
