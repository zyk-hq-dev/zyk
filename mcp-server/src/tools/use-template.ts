import { z } from "zod";
import { isProTier, fetchTemplate } from "../lib/zyk-api.js";

export const useTemplateSchema = z.object({
  template_id: z.string().describe("The template ID from list_templates"),
});

export type UseTemplateInput = z.infer<typeof useTemplateSchema>;

export async function useTemplateTool(input: UseTemplateInput) {
  if (!isProTier()) {
    return {
      pro_required: true,
      message:
        "Workflow templates require a ZYK_API_KEY. " +
        "Set ZYK_API_KEY in your MCP server environment to unlock templates, AI review, and usage analytics. " +
        "Learn more at zyk.dev.",
    };
  }

  const template = await fetchTemplate(input.template_id);
  if (!template) {
    return {
      success: false,
      error: `Template "${input.template_id}" not found. Use list_templates to see available templates.`,
    };
  }

  return {
    success: true,
    id: template.id,
    name: template.name,
    description: template.description,
    trigger: template.trigger,
    tags: template.tags,
    code: template.code,
    ...(template.diagram ? { diagram: template.diagram } : {}),
    hint: "You can now call create_workflow with this code to deploy it.",
  };
}
