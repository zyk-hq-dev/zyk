import { z } from "zod";
import { getWorkflow, updateWorkflow } from "../hatchet/register.js";
import { validateWorkflowCode } from "../utils/code-runner.js";
import { track } from "../lib/zyk-api.js";
import { patchInteractAskCalls } from "./create-workflow.js";

export const updateWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID to update"),
  code: z
    .string()
    .optional()
    .describe("New TypeScript workflow code (replaces existing)"),
  description: z.string().optional().describe("Updated description"),
  trigger: z
    .enum(["on-demand", "schedule"])
    .optional()
    .describe("Updated trigger type"),
  schedule: z
    .string()
    .optional()
    .describe("Updated cron expression (for scheduled workflows)"),
  diagram: z
    .string()
    .optional()
    .describe("Updated Mermaid diagram"),
});

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

export async function updateWorkflowTool(input: UpdateWorkflowInput) {
  const { workflow_id, description, trigger, schedule, diagram } = input;
  let { code } = input;

  const existing = getWorkflow(workflow_id);
  if (!existing) {
    return {
      success: false,
      error: `Workflow "${workflow_id}" not found. Use list_workflows to see available workflows.`,
    };
  }

  if (!code && !description && !trigger && !schedule && !diagram) {
    return {
      success: false,
      error: "At least one field (code, description, trigger, schedule, diagram) must be provided.",
    };
  }

  // Patch /interact/ask calls in updated code: inject workflowName + timeoutSeconds if missing
  if (code) {
    const nameMatch = code.match(
      /hatchet\.workflow\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/
    ) ?? (existing.name ? [null, existing.name] : null);
    if (nameMatch) code = patchInteractAskCalls(code, nameMatch[1]);
  }

  // Validate new code if provided
  if (code) {
    const validation = validateWorkflowCode(code);
    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid workflow code:\n${validation.errors.join("\n")}`,
        warnings: validation.warnings,
      };
    }
  }

  try {
    const updated = await updateWorkflow({
      id: workflow_id,
      code,
      description,
      trigger,
      schedule,
      diagram,
    });

    const result: Record<string, unknown> = {
      success: true,
      workflow_id: updated.id,
      name: updated.name,
      description: updated.description,
      trigger: updated.trigger,
      schedule: updated.schedule,
      message: `Workflow "${updated.name}" updated and worker restarted successfully.`,
    };

    track("workflow_updated");

    return result;
  } catch (err) {
    return {
      success: false,
      error: `Failed to update workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
