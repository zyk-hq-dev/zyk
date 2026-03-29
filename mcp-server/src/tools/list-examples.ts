import { z } from "zod";
import { listExamples } from "../lib/examples.js";

export const listExamplesSchema = z.object({});

export async function listExamplesTool(_input: z.infer<typeof listExamplesSchema>) {
  const examples = listExamples();
  return {
    examples,
    count: examples.length,
    hint: 'Use use_example with an example id to get the full code ready to deploy (e.g. use_example { "example_id": "favourite-colour" }).',
  };
}
