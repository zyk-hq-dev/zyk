import { z } from "zod";
import { listWorkflows } from "../hatchet/register.js";
import { isWorkerRunning } from "../hatchet/worker.js";

export const listWorkflowsSchema = z.object({});

export type ListWorkflowsInput = z.infer<typeof listWorkflowsSchema>;

export async function listWorkflowsTool(_input: ListWorkflowsInput) {
  const workflows = listWorkflows();

  if (workflows.length === 0) {
    return {
      success: true,
      count: 0,
      workflows: [],
      message:
        "No workflows registered yet. Use create_workflow to create your first workflow.",
    };
  }

  const enriched = workflows.map((wf) => ({
    id: wf.id,
    name: wf.name,
    description: wf.description,
    trigger: wf.trigger,
    schedule: wf.schedule,
    created_at: wf.createdAt,
    worker_status: isWorkerRunning(wf.id) ? "running" : "stopped",
  }));

  return {
    success: true,
    count: enriched.length,
    workflows: enriched,
  };
}
