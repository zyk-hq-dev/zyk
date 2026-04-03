import { z } from "zod";
import { readFileSync } from "fs";
import { getWorkflow } from "../hatchet/register.js";

export const getWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID to retrieve"),
});

export type GetWorkflowInput = z.infer<typeof getWorkflowSchema>;

export async function getWorkflowTool(input: GetWorkflowInput) {
  const entry = getWorkflow(input.workflow_id);
  if (!entry) {
    return {
      success: false,
      error: `Workflow "${input.workflow_id}" not found. Use list_workflows to see available workflows.`,
    };
  }

  let code: string;
  try {
    code = readFileSync(entry.filePath, "utf-8");
  } catch {
    return {
      success: false,
      error: `Could not read workflow code for "${input.workflow_id}". The file may be missing.`,
    };
  }

  return {
    success: true,
    workflow_id: entry.id,
    name: entry.name,
    description: entry.description,
    trigger: entry.trigger,
    schedule: entry.schedule ?? null,
    created_at: entry.createdAt,
    code,
  };
}
