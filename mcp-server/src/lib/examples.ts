export interface Example {
  id: string;
  name: string;
  description: string;
  trigger: "on-demand" | "schedule";
  tags: string[];
  required_env_vars: string[];
  code: string;
}

const EXAMPLES: Example[] = [
  {
    id: "favourite-colour",
    name: "Favourite Colour",
    description: "Asks the user their favourite colour and logs the answer. No secrets required. Good first workflow to test the full human-in-the-loop loop.",
    trigger: "on-demand",
    tags: ["human-in-the-loop", "demo"],
    required_env_vars: [],
    code: `import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const workflow = hatchet.workflow({ name: "favourite-colour" });

const askColour = workflow.durableTask({
  name: "ask-favourite-colour",
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const correlationId = \`colour-\${ctx.workflowRunId()}\`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? \`http://localhost:\${process.env.PORT ?? "3100"}\`;

    await fetch(\`\${base}/interact/ask\`, {
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

    await ctx.log(\`Waiting for user to answer (id=\${correlationId})\`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(\`\${base}/interact/answer/\${correlationId}\`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(\`User's favourite colour: \${action}\`);
    return { colour: action };
  },
});

workflow.task({
  name: "log-answer",
  parents: [askColour],
  retries: 3,
  fn: async (_input, ctx) => {
    const { colour } = await ctx.parentOutput(askColour);
    await ctx.log(\`Favourite colour logged: \${colour}\`);
    return { done: true, colour };
  },
});

const worker = await hatchet.worker("favourite-colour-worker", { workflows: [workflow] });
export default { start: () => worker.start() };`,
  },
  {
    id: "star-wars-survey",
    name: "Star Wars Survey",
    description: "Fetches all George Lucas Star Wars films from SWAPI and asks you one by one if you like each. Waits up to 1 minute per film, defaults to 'no' on timeout. Summarizes at the end. No secrets required.",
    trigger: "on-demand",
    tags: ["human-in-the-loop", "demo", "loop", "external-api"],
    required_env_vars: [],
    code: `import { Hatchet } from "@hatchet-dev/typescript-sdk";

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
    if (!res.ok) throw new Error(\`SWAPI error: \${res.status}\`);
    const data = await res.json() as { results: Film[] };
    const lucasFilms = data.results
      .filter(f => f.director === "George Lucas")
      .sort((a, b) => a.episode_id - b.episode_id);
    await ctx.log(\`Found \${lucasFilms.length} George Lucas films\`);
    return { films: lucasFilms };
  },
});

const surveyFilms = workflow.durableTask({
  name: "survey-films",
  parents: [fetchFilms],
  executionTimeout: "10m",
  fn: async (_input, ctx) => {
    const { films } = await ctx.parentOutput(fetchFilms);
    const base = process.env.ZYK_WEBHOOK_BASE ?? \`http://localhost:\${process.env.PORT ?? "3100"}\`;
    const decisions: Array<{ title: string; episode: number; liked: boolean; answer: string }> = [];

    for (const film of films) {
      const correlationId = \`film-\${film.episode_id}-\${ctx.workflowRunId()}\`;
      await ctx.log(\`Asking about: \${film.title} (Episode \${film.episode_id})\`);

      await fetch(\`\${base}/interact/ask\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          correlationId,
          workflowName: "star-wars-george-lucas-survey",
          message: \`Do you like "\${film.title}" (Episode \${film.episode_id}, \${film.release_date.slice(0, 4)})? You have 1 minute to respond — no answer assumes "no".\`,
          options: ["yes", "no"],
          timeoutSeconds: 60,
        }),
      });

      await ctx.log(\`Waiting for answer (id=\${correlationId})\`);
      await ctx.waitForEvent(correlationId);

      const answerRes = await fetch(\`\${base}/interact/answer/\${correlationId}\`);
      const { action } = await answerRes.json() as { action: string };
      const answer = action ?? "no";

      const liked = answer.toLowerCase() === "yes";
      await ctx.log(\`"\${film.title}": \${answer}\`);
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
      \`Liked (\${liked.length}): \${liked.length > 0 ? liked.join(", ") : "none"}\`,
      \`Disliked / No answer (\${disliked.length}): \${disliked.length > 0 ? disliked.join(", ") : "none"}\`,
      \`Total films reviewed: \${decisions.length}\`,
    ];

    for (const line of lines) await ctx.log(line);

    return { summary: lines.join("\\n"), decisions };
  },
});

const worker = await hatchet.worker("star-wars-george-lucas-survey-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };`,
  },
  {
    id: "github-incident-triage",
    name: "GitHub Incident Triage",
    description: "Triggered by a GitHub webhook when an issue is opened with a critical or production label. Uses Claude to assess severity, drafts a Slack message, and requires human approval before posting if severity is CRITICAL.",
    trigger: "on-demand",
    tags: ["github", "slack", "human-in-the-loop", "claude"],
    required_env_vars: ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "SLACK_CHANNEL"],
    code: `import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();
const workflow = hatchet.workflow({ name: "github-incident-triage" });

interface GitHubIssueWebhook {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string;
    html_url: string;
    labels: Array<{ name: string }>;
    user: { login: string };
  };
}

const assessSeverity = workflow.task({
  name: "assess-severity",
  retries: 3,
  fn: async (input: GitHubIssueWebhook, ctx) => {
    if (input.action !== "opened") {
      await ctx.log("Skipping — action is not 'opened'");
      return { skipped: true, severity: "", slackMessage: "", issueUrl: "" };
    }

    const labels = input.issue.labels.map((l) => l.name.toLowerCase());
    const isRelevant = labels.includes("critical") || labels.includes("production");

    if (!isRelevant) {
      await ctx.log("Skipping — no critical or production label");
      return { skipped: true, severity: "", slackMessage: "", issueUrl: "" };
    }

    const { number, title, body, html_url: url, user } = input.issue;
    const author = user.login;
    const labelsDisplay = input.issue.labels.map((l) => l.name).join(", ");

    await ctx.log(\`Assessing issue #\${number}: \${title}\`);

    const prompt = \`You are an on-call incident responder. A GitHub issue has been opened with a critical or production label.

Issue details:
- Number: #\${number}
- Title: \${title}
- Author: @\${author}
- Labels: \${labelsDisplay}
- URL: \${url}
- Body:
\${body ?? "(no description provided)"}

Your tasks:
1. Assess the severity. Choose exactly one: CRITICAL, HIGH, or MEDIUM.
2. Write a one-sentence plain-English summary of the problem.
3. Write a Slack message for #incidents with severity, issue title, number, URL, summary, and severity reasoning.

Respond ONLY with valid JSON:
{
  "severity": "CRITICAL" | "HIGH" | "MEDIUM",
  "summary": "<one sentence>",
  "slackMessage": "<full Slack message text>"
}\`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(\`Anthropic API error \${res.status}: \${await res.text()}\`);

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const rawText = data.content.find((b) => b.type === "text")?.text ?? "";
    const clean = rawText.replace(/^\`\`\`(?:json)?\\s*/m, "").replace(/\\s*\`\`\`$/m, "").trim();
    const assessment = JSON.parse(clean) as { severity: string; summary: string; slackMessage: string };

    await ctx.log(\`Severity: \${assessment.severity} — \${assessment.summary}\`);
    return { skipped: false, severity: assessment.severity, summary: assessment.summary, slackMessage: assessment.slackMessage, issueUrl: url, issueNumber: number, issueTitle: title };
  },
});

const askForApproval = workflow.durableTask({
  name: "ask-for-approval",
  parents: [assessSeverity],
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const { skipped, severity, slackMessage, issueNumber, issueTitle } = await ctx.parentOutput(assessSeverity);

    if (skipped || severity !== "CRITICAL") {
      await ctx.log(\`Severity is \${severity || "N/A"} — no approval needed, auto-posting\`);
      return { approved: true, skipped: true };
    }

    const correlationId = \`approval-\${ctx.workflowRunId()}\`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? \`http://localhost:\${process.env.PORT ?? "3100"}\`;

    await fetch(\`\${base}/interact/ask\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "github-incident-triage",
        message: \`CRITICAL — issue #\${issueNumber}: \${issueTitle}\\n\\nReady to post to #incidents:\\n\\n\${slackMessage}\\n\\nApprove posting?\`,
        options: ["approve", "reject"],
        timeoutSeconds: 86400,
      }),
    });

    await ctx.log(\`Paused — waiting for approval (id=\${correlationId})\`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(\`\${base}/interact/answer/\${correlationId}\`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(\`Decision: \${action}\`);
    return { approved: action === "approve", skipped: false };
  },
});

workflow.task({
  name: "post-to-slack",
  parents: [askForApproval],
  retries: 3,
  fn: async (_input, ctx) => {
    const { approved } = await ctx.parentOutput(askForApproval);
    const { skipped, slackMessage, severity } = await ctx.parentOutput(assessSeverity);

    if (skipped) { await ctx.log("Issue skipped — nothing to post"); return { posted: false, reason: "skipped" }; }
    if (!approved) { await ctx.log("Rejected by approver — aborting"); return { posted: false, reason: "rejected" }; }

    await ctx.log(\`Posting \${severity} alert to Slack\`);

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: \`Bearer \${process.env.SLACK_BOT_TOKEN}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: process.env.SLACK_CHANNEL ?? "#incidents", text: slackMessage }),
    });

    if (!res.ok) throw new Error(\`Slack API error \${res.status}: \${await res.text()}\`);
    const slackData = await res.json() as { ok: boolean; error?: string };
    if (!slackData.ok) throw new Error(\`Slack returned error: \${slackData.error}\`);

    await ctx.log("Posted successfully");
    return { posted: true, severity };
  },
});

const worker = await hatchet.worker("github-incident-triage-worker", { workflows: [workflow] });
export default { start: () => worker.start() };`,
  },
];

export function listExamples(): Omit<Example, "code">[] {
  return EXAMPLES.map(({ code: _code, ...rest }) => rest);
}

export function getExample(id: string): Example | null {
  return EXAMPLES.find(e => e.id === id) ?? null;
}
