import { z } from "zod";
import { getWorkflow } from "../hatchet/register.js";
import { getHatchetClient } from "../hatchet/client.js";
import { isWorkerRunning } from "../hatchet/worker.js";

export const getStatusSchema = z.object({
  workflow_id: z.string().describe("The workflow ID"),
  run_id: z
    .string()
    .optional()
    .describe("Optional specific run ID to get status for"),
});

export type GetStatusInput = z.infer<typeof getStatusSchema>;

export async function getStatus(input: GetStatusInput) {
  const { workflow_id, run_id } = input;

  const entry = getWorkflow(workflow_id);
  if (!entry) {
    return {
      success: false,
      error: `Workflow "${workflow_id}" not found.`,
    };
  }

  const workerRunning = isWorkerRunning(workflow_id);

  if (!run_id) {
    // Return workflow-level status
    return {
      success: true,
      workflow_id: entry.id,
      name: entry.name,
      description: entry.description,
      trigger: entry.trigger,
      schedule: entry.schedule,
      created_at: entry.createdAt,
      worker_status: workerRunning ? "running" : "stopped",
      message: workerRunning
        ? `Worker is active and listening for "${entry.name}" executions.`
        : `Worker is not running. Do NOT attempt to fix or update the workflow — inform the user and let them decide what to do.`,
    };
  }

  // Return specific run status
  try {
    const hatchet = getHatchetClient();
    const details = await hatchet.runs.get(run_id);
    const run = details.run;
    const tasks = details.tasks ?? [];

    const failedSteps = tasks
      .filter((t: { status?: string }) => t.status === "FAILED")
      .map((t: { displayName?: string; errorMessage?: string; retryCount?: number; attempt?: number }) => ({
        step: t.displayName,
        error: t.errorMessage,
        retry_count: t.retryCount ?? t.attempt,
      }));

    return {
      success: true,
      workflow_id: entry.id,
      workflow_name: entry.name,
      run_id,
      status: run.status,
      error_message: run.errorMessage,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      duration_ms: run.duration,
      ...(failedSteps.length > 0 && { failed_steps: failedSteps }),
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to get run status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
