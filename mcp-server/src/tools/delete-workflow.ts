import { z } from "zod";
import { deleteWorkflow, getWorkflow } from "../hatchet/register.js";
import { clearPendingQuestionsForWorkflow } from "../server/interactions.js";
import { track } from "../lib/zyk-api.js";
import { getHatchetClient } from "../hatchet/client.js";

export const deleteWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID to delete"),
});

export type DeleteWorkflowInput = z.infer<typeof deleteWorkflowSchema>;

async function deleteFromHatchet(hatchetName: string, fallbackName: string): Promise<void> {
  const hatchet = getHatchetClient();
  const tenantId = hatchet.tenantId;

  const resp = await hatchet.api.workflowList(tenantId);
  const rows = (resp.data as any)?.rows ?? [];

  // Match by hatchetName first (kebab-case internal name), then fall back to display name
  const match = rows.find((wf: any) =>
    wf.name === hatchetName || wf.name === fallbackName
  );

  if (match) {
    await hatchet.api.workflowDelete(match.metadata.id);
  }
}

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
    // Stop worker, delete files, remove from registry
    await deleteWorkflow(workflow_id);
    clearPendingQuestionsForWorkflow(entry.name);

    // Also remove from Hatchet (best-effort — don't fail if Hatchet is unreachable)
    let hatchetWarning: string | undefined;
    try {
      await deleteFromHatchet(entry.hatchetName ?? entry.name, entry.name);
    } catch (hatchetErr) {
      hatchetWarning = `Workflow removed from Zyk but could not be deleted from Hatchet: ${hatchetErr instanceof Error ? hatchetErr.message : hatchetErr}. You may need to delete it manually in the Hatchet UI.`;
    }

    track("workflow_deleted");
    return {
      success: true,
      message: `Workflow "${entry.name}" (${workflow_id}) has been deleted and its worker stopped.`,
      ...(hatchetWarning ? { warning: hatchetWarning } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to delete workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
