/**
 * Favourite Colour — human-in-the-loop demo
 *
 * The simplest workflow that tests the full Zyk loop:
 *   create → run → task appears in dashboard → answer → completes in Hatchet
 *
 * No secrets required. Good first workflow to run after setup.
 *
 * Prompt:
 *   "Create a workflow that asks me what my favourite colour is and logs my answer"
 */

import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const workflow = hatchet.workflow({ name: "favourite-colour" });

const askColour = workflow.durableTask({
  name: "ask-favourite-colour",
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const correlationId = `colour-${ctx.workflowRunId()}`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? `http://localhost:${process.env.PORT ?? "3100"}`;

    await fetch(`${base}/interact/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "favourite-colour",
        message: "What's your favourite colour?",
        options: ["Red", "Blue", "Green", "Yellow", "Purple", "Orange", "Other"],
        timeoutSeconds: 86400,
      }),
    });

    await ctx.log(`Waiting for user to answer (id=${correlationId})`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(`User's favourite colour: ${action}`);
    return { colour: action };
  },
});

workflow.task({
  name: "log-answer",
  parents: [askColour],
  retries: 3,
  fn: async (_input, ctx) => {
    const { colour } = await ctx.parentOutput(askColour);
    await ctx.log(`Favourite colour logged: ${colour}`);
    return { done: true, colour };
  },
});

const worker = await hatchet.worker("favourite-colour-worker", { workflows: [workflow] });
export default { start: () => worker.start() };
