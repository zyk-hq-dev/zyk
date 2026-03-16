import { z } from "zod";
import { getPendingQuestions } from "../server/interactions.js";

export const getTasksSchema = z.object({});

export async function getTasksTool(_input: z.infer<typeof getTasksSchema>) {
  const tasks = getPendingQuestions();

  if (tasks.length === 0) {
    return {
      pending_tasks: 0,
      message: "No pending tasks. All workflows are running without waiting for input.",
    };
  }

  const port = process.env.WEBHOOK_PORT ?? "3100";
  const dashboardUrl = `http://localhost:${port}`;

  return {
    pending_tasks: tasks.length,
    dashboard_url: `${dashboardUrl}/#tasks`,
    tasks: tasks.map((t) => ({
      correlation_id: t.correlationId,
      workflow: t.workflowName ?? "unknown",
      question: t.message,
      options: t.options ?? [],
      asked_at: t.askedAt,
    })),
  };
}
