// Replaced by use-example.ts — kept as a stub to avoid dead import errors.
import { z } from "zod";

export const useTemplateSchema = z.object({
  template_id: z.string().describe("The template ID from list_templates"),
});

export type UseTemplateInput = z.infer<typeof useTemplateSchema>;

export async function useTemplateTool(_input: UseTemplateInput) {
  return { error: "use_template is no longer available. Use use_example instead." };
}
