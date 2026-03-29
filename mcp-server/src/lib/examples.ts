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
          message: \`Do you like "\${film.title}" (Episode \${film.episode_id}, \${film.release_date.slice(0, 4)})?\`,
          options: ["yes", "no"],
          timeoutSeconds: 60,
          defaultAnswer: "no",
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

interface TriageResult {
  skipped?: boolean;
  severity?: "critical" | "high" | "medium" | "low";
  summary?: string;
  impact?: string;
  reasoning?: string;
  slackMessage?: string;
  issue?: {
    number: number;
    title: string;
    url: string;
    labels: string[];
    author: string;
  };
}

const workflow = hatchet.workflow({ name: "github-issue-incident-triage" });

const triageIssue = workflow.task({
  name: "triage-issue",
  retries: 3,
  fn: async (input: GitHubIssueWebhook, ctx) => {
    if (input.action !== "opened") {
      await ctx.log(\`Skipping — action is '\${input.action}', not 'opened'\`);
      return { skipped: true } as TriageResult;
    }

    const { number, title, body, html_url, labels, user } = input.issue;
    const labelNames = labels.map(l => l.name);
    const hasIncidentLabel = labelNames.some(l =>
      ["critical", "production"].includes(l.toLowerCase())
    );

    if (!hasIncidentLabel) {
      await ctx.log("Skipping — no critical/production label found");
      return { skipped: true } as TriageResult;
    }

    await ctx.log(\`Triaging issue #\${number}: \${title}\`);

    const prompt = \`You are an incident triage assistant. Analyze this GitHub issue and respond ONLY with a valid JSON object — no markdown, no code fences, no extra text.

Issue #\${number}: \${title}
Author: \${user.login}
Labels: \${labelNames.join(", ")}
Body:
\${body ?? "(no description provided)"}

Respond with this exact JSON structure:
{
  "severity": "critical" | "high" | "medium" | "low",
  "summary": "2-3 sentence summary of the issue",
  "impact": "1-2 sentence potential impact statement",
  "reasoning": "1-2 sentence explanation of the severity assessment"
}\`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!aiRes.ok) throw new Error(\`Anthropic API error: \${aiRes.status}\`);

    const aiData = await aiRes.json() as { content: Array<{ type: string; text: string }> };
    const rawText = aiData.content.find(b => b.type === "text")?.text ?? "{}";
    const cleaned = rawText.replace(/^\`\`\`(?:json)?\\s*/m, "").replace(/\\s*\`\`\`$/m, "").trim();
    const { severity, summary, impact, reasoning } = JSON.parse(cleaned) as {
      severity: "critical" | "high" | "medium" | "low";
      summary: string;
      impact: string;
      reasoning: string;
    };

    await ctx.log(\`Severity assessed: \${severity}\`);

    const severityEmoji: Record<string, string> = {
      critical: "🔴", high: "🟠", medium: "🟡", low: "🟢",
    };

    const slackMessage = [
      \`\${severityEmoji[severity] ?? "⚪"} *Incident Alert — \${severity.toUpperCase()}*\`,
      "",
      \`*Issue:* <\${html_url}|#\${number} — \${title}>\`,
      \`*Labels:* \${labelNames.join(", ")}\`,
      \`*Author:* \${user.login}\`,
      "",
      \`*Summary:* \${summary}\`,
      \`*Potential Impact:* \${impact}\`,
      \`*Severity Reasoning:* \${reasoning}\`,
    ].join("\\n");

    return {
      severity, summary, impact, reasoning, slackMessage,
      issue: { number, title, url: html_url, labels: labelNames, author: user.login },
    } as TriageResult;
  },
});

const maybeRequestApproval = workflow.durableTask({
  name: "maybe-request-approval",
  parents: [triageIssue],
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const triage = await ctx.parentOutput(triageIssue);

    if (triage.skipped) return { skipped: true, approved: false };

    if (triage.severity !== "critical") {
      await ctx.log("Non-critical severity — skipping approval step");
      return { approved: true, skipped: false };
    }

    const correlationId = \`approval-\${ctx.workflowRunId()}\`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? \`http://localhost:\${process.env.PORT ?? "3100"}\`;

    await ctx.log("Critical severity — requesting approval before posting to Slack");

    await fetch(\`\${base}/interact/ask\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "github-issue-incident-triage",
        message: \`Critical incident detected for issue #\${triage.issue!.number}: "\${triage.issue!.title}"\\n\\nApprove posting to \${process.env.SLACK_CHANNEL ?? "#incidents"}?\`,
        options: ["approve", "reject"],
        timeoutSeconds: 86400,
        defaultAnswer: "reject",
      }),
    });

    await ctx.log(\`Waiting for approval (id=\${correlationId})\`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(\`\${base}/interact/answer/\${correlationId}\`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(\`Approval decision: \${action}\`);
    return { approved: action === "approve", skipped: false };
  },
});

workflow.task({
  name: "post-to-slack",
  parents: [maybeRequestApproval],
  retries: 3,
  fn: async (_input, ctx) => {
    const approval = await ctx.parentOutput(maybeRequestApproval);

    if (approval.skipped || !approval.approved) {
      await ctx.log("Skipping Slack post — not approved or issue was skipped");
      return { posted: false };
    }

    const triage = await ctx.parentOutput(triageIssue);

    await ctx.log("Posting to Slack...");

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.SLACK_BOT_TOKEN ?? ""}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#incidents",
        text: triage.slackMessage,
      }),
    });

    if (!slackRes.ok) throw new Error(\`Slack API error: \${slackRes.status}\`);
    const slackData = await slackRes.json() as { ok: boolean; error?: string };
    if (!slackData.ok) throw new Error(\`Slack error: \${slackData.error}\`);

    await ctx.log(\`Posted to \${process.env.SLACK_CHANNEL ?? "#incidents"} successfully\`);
    return { posted: true };
  },
});

const worker = await hatchet.worker("github-issue-incident-triage-worker", { workflows: [workflow] });
export default { start: () => worker.start() };`,
  },
];

export function listExamples(): Omit<Example, "code">[] {
  return EXAMPLES.map(({ code: _code, ...rest }) => rest);
}

export function getExample(id: string): Example | null {
  return EXAMPLES.find(e => e.id === id) ?? null;
}
