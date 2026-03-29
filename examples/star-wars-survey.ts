/**
 * Star Wars Survey — looping human-in-the-loop demo
 *
 * Fetches all Star Wars films directed by George Lucas from SWAPI.
 * For each film, asks the user if they like it and waits up to 1 minute.
 * If no answer arrives, defaults to "no". Logs a summary at the end.
 *
 * No secrets required. Demonstrates: external API call, loop over tasks,
 * per-item timeout, parent output chaining.
 *
 * Prompt:
 *   "Fetch all Star Wars films directed by George Lucas from the SWAPI API.
 *    For each film ask me if I like it, wait up to 1 minute for my answer,
 *    if I don't answer assume no, log the decision. At the end summarize."
 */

import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

interface Film {
  title: string;
  episode_id: number;
  director: string;
  release_date: string;
}

const workflow = hatchet.workflow({ name: "star-wars-george-lucas-survey" });

const fetchFilms = workflow.task({
  name: "fetch-george-lucas-films",
  retries: 3,
  fn: async (_input, ctx) => {
    await ctx.log("Fetching Star Wars films from SWAPI...");
    const res = await fetch("https://swapi.dev/api/films/");
    if (!res.ok) throw new Error(`SWAPI error: ${res.status}`);
    const data = await res.json() as { results: Film[] };
    const lucasFilms = data.results
      .filter(f => f.director === "George Lucas")
      .sort((a, b) => a.episode_id - b.episode_id);
    await ctx.log(`Found ${lucasFilms.length} George Lucas films`);
    return { films: lucasFilms };
  },
});

const surveyFilms = workflow.durableTask({
  name: "survey-films",
  parents: [fetchFilms],
  executionTimeout: "10m",
  fn: async (_input, ctx) => {
    const { films } = await ctx.parentOutput(fetchFilms);
    const base = process.env.ZYK_WEBHOOK_BASE ?? `http://localhost:${process.env.PORT ?? "3100"}`;
    const decisions: Array<{ title: string; episode: number; liked: boolean; answer: string }> = [];

    for (const film of films) {
      const correlationId = `film-${film.episode_id}-${ctx.workflowRunId()}`;
      await ctx.log(`Asking about: ${film.title} (Episode ${film.episode_id})`);

      await fetch(`${base}/interact/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          correlationId,
          workflowName: "star-wars-george-lucas-survey",
          message: `Do you like "${film.title}" (Episode ${film.episode_id}, ${film.release_date.slice(0, 4)})?`,
          options: ["yes", "no"],
          timeoutSeconds: 60,
          defaultAnswer: "no",
        }),
      });

      await ctx.log(`Waiting for answer (id=${correlationId})`);
      await ctx.waitForEvent(correlationId);

      const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
      const { action } = await answerRes.json() as { action: string };
      const answer = action ?? "no";

      const liked = answer.toLowerCase() === "yes";
      await ctx.log(`"${film.title}": ${answer}`);
      decisions.push({ title: film.title, episode: film.episode_id, liked, answer });
    }

    return { decisions };
  },
});

workflow.task({
  name: "summarize-decisions",
  parents: [surveyFilms],
  retries: 3,
  fn: async (_input, ctx) => {
    const { decisions } = await ctx.parentOutput(surveyFilms);
    const liked = decisions.filter(d => d.liked).map(d => d.title);
    const disliked = decisions.filter(d => !d.liked).map(d => d.title);

    const lines = [
      "=== Star Wars Survey Summary ===",
      `Liked (${liked.length}): ${liked.length > 0 ? liked.join(", ") : "none"}`,
      `Disliked / No answer (${disliked.length}): ${disliked.length > 0 ? disliked.join(", ") : "none"}`,
      `Total films reviewed: ${decisions.length}`,
    ];

    for (const line of lines) await ctx.log(line);
    return { summary: lines.join("\n"), decisions };
  },
});

const worker = await hatchet.worker("star-wars-george-lucas-survey-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };
