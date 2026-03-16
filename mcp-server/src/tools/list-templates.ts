import { z } from "zod";
import { isProTier, fetchTemplates } from "../lib/zyk-api.js";

export const listTemplatesSchema = z.object({});

export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

export async function listTemplatesTool(_input: ListTemplatesInput) {
  if (!isProTier()) {
    return {
      pro_required: true,
      message:
        "Workflow templates require a ZYK_API_KEY. " +
        "Set ZYK_API_KEY in your MCP server environment to unlock templates, AI review, and usage analytics. " +
        "Learn more at zyk.dev.",
    };
  }

  const templates = await fetchTemplates();
  return {
    templates,
    count: templates.length,
    hint: 'Use use_template with a template id to pull the full code (e.g. use_template { "template_id": "daily-report" }).',
  };
}
