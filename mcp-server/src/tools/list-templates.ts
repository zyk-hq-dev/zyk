// Replaced by list-examples.ts — kept as a stub to avoid dead import errors.
import { z } from "zod";

export const listTemplatesSchema = z.object({});

export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

export async function listTemplatesTool(_input: ListTemplatesInput) {
  return { error: "list_templates is no longer available. Use list_examples instead." };
}
