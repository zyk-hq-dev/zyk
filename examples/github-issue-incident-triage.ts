/**
 * GitHub Issue Incident Triage — webhook-triggered, AI-assisted, human-in-the-loop
 *
 * Triggered by a GitHub webhook when an issue is opened with a critical or
 * production label. Uses Claude to assess severity, drafts a Slack message,
 * and pauses for human approval before posting if severity is CRITICAL.
 *
 * Required secrets: ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL
 *
 * Prompt:
 *   "Create a workflow called "github-issue-incident-triage" with these steps:
 *    1. Trigger: a GitHub issue is opened with a critical or production label
 *    2. Call the Anthropic API to assess severity (critical / high / medium / low)
 *       and produce a short summary and impact statement
 *    3. Draft a Slack message for #incidents with clearly labeled fields:
 *       severity level, issue link and number, labels, author,
 *       AI-generated summary, potential impact, and severity reasoning
 *    4. If severity is critical, pause and ask me for approval before posting
 *    5. On approval, post the message to the Slack channel in SLACK_CHANNEL"
 */

import { Hatchet } from "@hatchet-dev/typescript-sdk";

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
      await ctx.log(`Skipping — action is '${input.action}', not 'opened'`);
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

    await ctx.log(`Triaging issue #${number}: ${title}`);

    const prompt = `You are an incident triage assistant. Analyze this GitHub issue and respond ONLY with a valid JSON object — no markdown, no code fences, no extra text.

Issue #${number}: ${title}
Author: ${user.login}
Labels: ${labelNames.join(", ")}
Body:
${body ?? "(no description provided)"}

Respond with this exact JSON structure:
{
  "severity": "critical" | "high" | "medium" | "low",
  "summary": "2-3 sentence summary of the issue",
  "impact": "1-2 sentence potential impact statement",
  "reasoning": "1-2 sentence explanation of the severity assessment"
}`;

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

    if (!aiRes.ok) throw new Error(`Anthropic API error: ${aiRes.status}`);

    const aiData = await aiRes.json() as { content: Array<{ type: string; text: string }> };
    const rawText = aiData.content.find(b => b.type === "text")?.text ?? "{}";
    const cleaned = rawText.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const { severity, summary, impact, reasoning } = JSON.parse(cleaned) as {
      severity: "critical" | "high" | "medium" | "low";
      summary: string;
      impact: string;
      reasoning: string;
    };

    await ctx.log(`Severity assessed: ${severity}`);

    const severityEmoji: Record<string, string> = {
      critical: "🔴", high: "🟠", medium: "🟡", low: "🟢",
    };

    const slackMessage = [
      `${severityEmoji[severity] ?? "⚪"} *Incident Alert — ${severity.toUpperCase()}*`,
      "",
      `*Issue:* <${html_url}|#${number} — ${title}>`,
      `*Labels:* ${labelNames.join(", ")}`,
      `*Author:* ${user.login}`,
      "",
      `*Summary:* ${summary}`,
      `*Potential Impact:* ${impact}`,
      `*Severity Reasoning:* ${reasoning}`,
    ].join("\n");

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

    const correlationId = `approval-${ctx.workflowRunId()}`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? `http://localhost:${process.env.PORT ?? "3100"}`;

    await ctx.log("Critical severity — requesting approval before posting to Slack");

    await fetch(`${base}/interact/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "github-issue-incident-triage",
        message: `Critical incident detected for issue #${triage.issue!.number}: "${triage.issue!.title}"\n\nApprove posting to ${process.env.SLACK_CHANNEL ?? "#incidents"}?`,
        options: ["approve", "reject"],
        timeoutSeconds: 86400,
        defaultAnswer: "reject",
      }),
    });

    await ctx.log(`Waiting for approval (id=${correlationId})`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(`Approval decision: ${action}`);
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
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#incidents",
        text: triage.slackMessage,
      }),
    });

    if (!slackRes.ok) throw new Error(`Slack API error: ${slackRes.status}`);
    const slackData = await slackRes.json() as { ok: boolean; error?: string };
    if (!slackData.ok) throw new Error(`Slack error: ${slackData.error}`);

    await ctx.log(`Posted to ${process.env.SLACK_CHANNEL ?? "#incidents"} successfully`);
    return { posted: true };
  },
});

const worker = await hatchet.worker("github-issue-incident-triage-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };
