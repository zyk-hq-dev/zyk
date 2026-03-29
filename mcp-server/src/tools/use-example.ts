import { z } from "zod";
import { getExample } from "../lib/examples.js";

export const useExampleSchema = z.object({
  example_id: z.string().describe("The example ID from list_examples"),
});

export async function useExampleTool(input: z.infer<typeof useExampleSchema>) {
  const example = getExample(input.example_id);
  if (!example) {
    return {
      success: false,
      error: `Example "${input.example_id}" not found. Use list_examples to see available examples.`,
    };
  }

  return {
    success: true,
    id: example.id,
    name: example.name,
    description: example.description,
    trigger: example.trigger,
    tags: example.tags,
    required_env_vars: example.required_env_vars,
    code: example.code,
    hint: "You can now call create_workflow with this code to deploy it.",
  };
}
