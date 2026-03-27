import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

interface IssueInput {
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  issueNumber: number;
  labels: string[];
  author: string;
}

const workflow = hatchet.workflow({ name: "github-issue-incident-triage" });

const assessSeverity = workflow.task({
  name: "assess-severity",
  retries: 3,
  fn: async (input: IssueInput, ctx) => {
    await ctx.log(`Assessing severity for issue #${input.issueNumber}: ${input.issueTitle}`);

    const prompt = `You are an on-call incident triage assistant. A GitHub issue was opened with the following details:

Title: ${input.issueTitle}
Labels: ${input.labels.join(", ")}
Author: ${input.author}
URL: ${input.issueUrl}

Body:
${input.issueBody}

Analyze this issue and respond ONLY with a JSON object (no markdown fences) with these fields:
- severity: one of "critical", "high", "medium", "low"
- reasoning: 1-2 sentence explanation of your severity assessment
- summary: a concise 2-3 sentence summary of what the issue is about
- impact: brief description of potential user/system impact`;

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

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const raw = data.content.find(b => b.type === "text")?.text ?? "{}";
    const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const assessment = JSON.parse(cleaned) as {
      severity: string;
      reasoning: string;
      summary: string;
      impact: string;
    };

    await ctx.log(`Severity assessed: ${assessment.severity}`);
    return { assessment, issue: input };
  },
});

const draftSlackMessage = workflow.task({
  name: "draft-slack-message",
  parents: [assessSeverity],
  retries: 3,
  fn: async (_input: IssueInput, ctx) => {
    const { assessment, issue } = await ctx.parentOutput(assessSeverity);

    const severityEmoji: Record<string, string> = {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "🟢",
    };

    const emoji = severityEmoji[assessment.severity] ?? "⚪";

    const message = `${emoji} *Incident Alert — ${assessment.severity.toUpperCase()}*

*Issue:* <${issue.issueUrl}|#${issue.issueNumber} ${issue.issueTitle}>
*Labels:* ${issue.labels.join(", ")}
*Opened by:* ${issue.author}

*Summary:* ${assessment.summary}

*Impact:* ${assessment.impact}

*Severity Reasoning:* ${assessment.reasoning}`;

    await ctx.log("Slack message drafted");
    return { message, severity: assessment.severity, issue };
  },
});

const requestApproval = workflow.durableTask({
  name: "request-approval",
  parents: [draftSlackMessage],
  executionTimeout: "24h",
  fn: async (_input: IssueInput, ctx) => {
    const { message, severity, issue } = await ctx.parentOutput(draftSlackMessage);

    if (severity !== "critical") {
      await ctx.log(`Severity is ${severity} — skipping approval gate`);
      return { approved: true, message, severity, issue };
    }

    await ctx.log("Critical severity detected — requesting human approval");

    const correlationId = `incident-approval-${ctx.workflowRunId()}`;
    const base = process.env.ZYK_WEBHOOK_BASE ?? `http://localhost:${process.env.PORT ?? "3100"}`;

    await fetch(`${base}/interact/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correlationId,
        workflowName: "github-issue-incident-triage",
        message: `Critical issue #${issue.issueNumber} detected: "${issue.issueTitle}". Ready to post to ${process.env.SLACK_CHANNEL ?? "#incidents"}. Do you approve?`,
        options: ["approve", "reject"],
        timeoutSeconds: 86400,
      }),
    });

    await ctx.log(`Approval request sent (correlationId=${correlationId}) — waiting...`);
    await ctx.waitForEvent(correlationId);

    const answerRes = await fetch(`${base}/interact/answer/${correlationId}`);
    const { action } = await answerRes.json() as { action: string };

    await ctx.log(`Approval decision: ${action}`);
    return { approved: action === "approve", message, severity, issue };
  },
});

workflow.task({
  name: "post-to-slack",
  parents: [requestApproval],
  retries: 3,
  fn: async (_input: IssueInput, ctx) => {
    const { approved, message, severity, issue } = await ctx.parentOutput(requestApproval);

    if (!approved) {
      await ctx.log(`Posting rejected — not sending Slack message for issue #${issue.issueNumber}`);
      return { posted: false, reason: "rejected by user" };
    }

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL,
        text: message,
        mrkdwn: true,
      }),
    });

    const slackData = await slackRes.json() as { ok: boolean; error?: string };
    if (!slackData.ok) throw new Error(`Slack API error: ${slackData.error}`);

    await ctx.log(`Message posted to Slack for issue #${issue.issueNumber} (severity: ${severity})`);
    return { posted: true, severity, issueNumber: issue.issueNumber };
  },
});

const worker = await hatchet.worker("github-issue-triage-worker", { workflows: [workflow] });
export default { start: () => worker.start() };
