import { z } from "zod";
import { consumePendingQuestion, hasPendingQuestion } from "../server/interactions.js";

// pendingInteractions lives in webhook.ts — we need to store the answer there
// so the workflow's /slack/pending/:id polling picks it up.
// We expose a setter function for this.
let _storeAnswer: (correlationId: string, action: string) => void = () => {};

export function setAnswerStore(fn: (correlationId: string, action: string) => void) {
  _storeAnswer = fn;
}

export const respondTaskSchema = z.object({
  correlation_id: z.string().describe("The correlation_id from get_tasks"),
  answer: z.string().describe("Your answer — must match one of the options if options were given"),
});

export async function respondTaskTool(input: z.infer<typeof respondTaskSchema>) {
  const { correlation_id, answer } = input;

  if (!hasPendingQuestion(correlation_id)) {
    return {
      success: false,
      error: "Task not found. It may have already been answered or expired. Call get_tasks to see current pending tasks.",
    };
  }

  const question = consumePendingQuestion(correlation_id);
  _storeAnswer(correlation_id, answer);

  return {
    success: true,
    message: `Answer "${answer}" submitted for: "${question?.message}"`,
    workflow: question?.workflowName ?? "unknown",
  };
}
