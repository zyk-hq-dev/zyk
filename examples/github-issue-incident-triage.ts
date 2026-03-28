import { Hatchet } from "@hatchet-dev/typescript-sdk";

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

// ── Step 1: Read issue and assess severity with Claude ───────────────────────
const assessSeverity = workflow.task({
  name: "assess-severity",
  retries: 3,
  fn: async (input: GitHubIssueWebhook, ctx) => {
    if (input.action !== "opened") {
      await ctx.log("Skipping — action is not 'opened'");
      return { skipped: true, severity: "", slackMessage: "", issueUrl: "" };
    }

    const labels = input.issue.labels.map((l) => l.name.toLowerCase());
    const isRelevant =
      labels.includes("critical") || labels.includes("production");

    if (!isRelevant) {
      await ctx.log("Skipping — no critical or production label");
      return { skipped: true, severity: "", slackMessage: "", issueUrl: "" };
    }

    const { number, title, body, html_url: url, user } = input.issue;
    const author = user.login;
    const labelsDisplay = input.issue.labels.map((l) => l.name).join(", ");

    await ctx.log(`Assessing issue #${number}: ${title}`);

    const prompt = `You are an on-call incident responder. A GitHub issue has been opened with a critical or production label.

Issue details:
- Number: #${number}
- Title: ${title}
- Author: @${author}
- Labels: ${labelsDisplay}
- URL: ${url}
- Body:
${body ?? "(no description provided)"}

Your tasks:
1. Assess the severity. Choose exactly one:
   - CRITICAL: immediate action required — service down, data loss risk, or full outage
   - HIGH: significant impact — major feature broken, no workaround
   - MEDIUM: limited impact — partial degradation, workaround available

2. Write a one-sentence plain-English summary of the problem.

3. Write a Slack message for #incidents. Include:
   - A severity emoji: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM
   - Issue title, number, and URL
   - The one-sentence summary
   - Severity level clearly labeled

Respond ONLY with valid JSON — no markdown, no preamble:
{
  "severity": "CRITICAL" | "HIGH" | "MEDIUM",
  "summary": "<one sentence>",
  "slackMessage": "<full Slack message text>"
}`;

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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const rawText = data.content.find((b) => b.type === "text")?.text ?? "";
    const clean = rawText
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();

    const assessment = JSON.parse(clean) as {
      severity: string;
      summary: string;
      slackMessage: string;
    };

    await ctx.log(`Severity: ${assessment.severity} — ${assessment.summary}`);

    return {
      skipped: false,
      severity: assessment.severity,
      summary: assessment.summary,
      slackMessage: assessment.slackMessage,
      issueUrl: url,
      issueNumber: number,
      issueTitle: title,
    };
  },
});

// ── Step 2 (conditional): Human approval gate for CRITICAL ───────────────────
const askForApproval = workflow.durableTask({
  name: "ask-for-approval",
  parents: [assessSeverity],
  executionTimeout: "24h",
  fn: async (_input, ctx) => {
    const { skipped, severity, slackMessage, issueNumber, issueTitle } =
      await ctx.parentOutput(assessSeverity);

    if (skipped || severity !== "CRITICAL") {
      await ctx.log(
        `Severity is ${severity || "N/A"} — no approval needed, auto-posting`
      );
      return { approved: true, skipped: true };
    }

    const correlationId = `approval-${ctx.workflowRunId()}`;
    const base =
      process.env.ZYK_WEBHOOK_BASE ??
      `http://localhost:${process.env.PORT ?? "3100"}`;

    await fetch(`${base}/interact/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "github-incident-triage",
        message:
          `CRITICAL — issue #${issueNumber}: ${issueTitle}\n\n` +
          `Ready to post to #incidents:\n\n${slackMessage}\n\n` +
          `Approve posting?`,
        options: ["approve", "reject"],
        timeoutSeconds: 86400,
      }),
    });

    await ctx.log(`Paused — waiting for approval (id=${correlationId})`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = (await answerRes.json()) as { action: string };

    await ctx.log(`Decision: ${action}`);
    return { approved: action === "approve", skipped: false };
  },
});

// ── Step 3: Post to Slack ────────────────────────────────────────────────────
workflow.task({
  name: "post-to-slack",
  parents: [askForApproval],
  retries: 3,
  fn: async (_input, ctx) => {
    const { approved } = await ctx.parentOutput(askForApproval);
    const { skipped, slackMessage, severity } =
      await ctx.parentOutput(assessSeverity);

    if (skipped) {
      await ctx.log("Issue skipped — nothing to post");
      return { posted: false, reason: "skipped" };
    }
    if (!approved) {
      await ctx.log("Rejected by approver — aborting");
      return { posted: false, reason: "rejected" };
    }

    await ctx.log(`Posting ${severity} alert to Slack`);

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#incidents",
        text: slackMessage,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Slack API error ${res.status}: ${err}`);
    }

    const slackData = (await res.json()) as { ok: boolean; error?: string };
    if (!slackData.ok) {
      throw new Error(`Slack returned error: ${slackData.error}`);
    }

    await ctx.log("Posted successfully");
    return { posted: true, severity };
  },
});

const worker = await hatchet.worker("github-incident-triage-worker", {
  workflows: [workflow],
});

export default { start: () => worker.start() };
