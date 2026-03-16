import { z } from "zod";
import { deleteWorkflow, getWorkflow } from "../hatchet/register.js";
import { clearPendingQuestionsForWorkflow } from "../server/interactions.js";
import { track } from "../lib/zyk-api.js";

export const deleteWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID to delete"),
});

export type DeleteWorkflowInput = z.infer<typeof deleteWorkflowSchema>;

export async function deleteWorkflowTool(input: DeleteWorkflowInput) {
  const { workflow_id } = input;

  const entry = getWorkflow(workflow_id);
  if (!entry) {
    return {
      success: false,
      error: `Workflow "${workflow_id}" not found.`,
    };
  }

  try {
    await deleteWorkflow(workflow_id);
    clearPendingQuestionsForWorkflow(entry.name);
    track("workflow_deleted");
    return {
      success: true,
      message: `Workflow "${entry.name}" (${workflow_id}) has been deleted and its worker stopped.`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to delete workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
