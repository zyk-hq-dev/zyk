import { z } from "zod";
import { readFileSync } from "fs";
import { isProTier, reviewWorkflow } from "../lib/zyk-api.js";
import { getWorkflow } from "../hatchet/register.js";

export const reviewWorkflowSchema = z.object({
  workflow_id: z.string().describe("The workflow ID to review"),
});

export type ReviewWorkflowInput = z.infer<typeof reviewWorkflowSchema>;

export async function reviewWorkflowTool(input: ReviewWorkflowInput) {
  if (!isProTier()) {
    return {
      pro_required: true,
      message:
        "AI workflow review requires a ZYK_API_KEY. " +
        "Set ZYK_API_KEY in your MCP server environment to unlock templates, AI review, and usage analytics. " +
        "Learn more at zyk.dev.",
    };
  }

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
      error: `Could not read workflow code for "${input.workflow_id}".`,
    };
  }

  const result = await reviewWorkflow(code);
  return {
    success: true,
    workflow_id: entry.id,
    workflow_name: entry.name,
    ...result,
  };
}
