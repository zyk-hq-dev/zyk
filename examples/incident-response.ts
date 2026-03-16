import { Hatchet } from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const workflow = hatchet.workflow({
  name: "production-incident-response",
  description: "Handle production incidents from alert to resolution with automatic tracking, escalation, and post-mortems",
});

// ── Helper: poll for a Slack button click ─────────────────────────────────────
async function waitForSlackAction(
  correlationId: string,
  timeoutMs: number,
  log: (msg: string) => Promise<void>
): Promise<{ action: string; userId: string }> {
  const base = process.env.ZYK_WEBHOOK_BASE ?? "http://localhost:3100";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/slack/pending/${encodeURIComponent(correlationId)}`);
    const data = await res.json() as { pending: boolean; action?: string; userId?: string };
    if (!data.pending && data.action) {
      await log(`Slack response: ${data.action} from ${data.userId}`);
      return { action: data.action, userId: data.userId ?? "unknown" };
    }
    await new Promise(r => setTimeout(r, 3_000));
  }
  await log(`Timeout waiting for ${correlationId}`);
  return { action: "timeout", userId: "system" };
}

// ── Step 1 & 2: Create GitHub issue + Slack channel (run in parallel) ─────────

const createGithubIssue = workflow.task({
  name: "create-github-issue",
  retries: 3,
  fn: async (input: { title: string; severity: string; description: string; source: string }, ctx) => {
    await ctx.log(`Creating GitHub issue for ${input.severity.toUpperCase()}: ${input.title}`);

    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
      },
      body: JSON.stringify({
        title: `[${input.severity.toUpperCase()}] ${input.title}`,
        body: [
          "## Incident Details",
          "",
          `- **Severity:** ${input.severity.toUpperCase()}`,
          `- **Source:** ${input.source}`,
          `- **Description:** ${input.description}`,
          "",
          "**Status:** Open  ",
          "**Assigned:** On-call engineer",
        ].join("\n"),
        labels: ["incident", input.severity],
      }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const issue = await res.json() as { number: number; html_url: string };
    await ctx.log(`Created GitHub issue #${issue.number}: ${issue.html_url}`);
    return { issueNumber: issue.number, issueUrl: issue.html_url };
  },
});

const createIncidentChannel = workflow.task({
  name: "create-incident-channel",
  retries: 3,
  fn: async (input: { severity: string; title: string }, ctx) => {
    // Channel names must be lowercase, no spaces, max 80 chars
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    const channelName = `inc-${input.severity}-${slug}`;
    await ctx.log(`Creating Slack channel #${channelName}`);

    const res = await fetch("https://slack.com/api/conversations.create", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: channelName }),
    });
    const data = await res.json() as { ok: boolean; channel?: { id: string; name: string }; error?: string };
    if (!data.ok) throw new Error(`Slack create channel error: ${data.error}`);
    await ctx.log(`Created #${data.channel!.name} (${data.channel!.id})`);
    return { channelId: data.channel!.id, channelName: data.channel!.name };
  },
});

// ── Step 3: Invite on-call + post the alert (after both above finish) ─────────

const inviteAndPage = workflow.task({
  name: "invite-and-page",
  parents: [createGithubIssue, createIncidentChannel],
  retries: 3,
  fn: async (input: { title: string; severity: string; description: string; source: string }, ctx) => {
    const { channelId } = await ctx.parentOutput(createIncidentChannel) as { channelId: string; channelName: string };
    const { issueNumber, issueUrl } = await ctx.parentOutput(createGithubIssue) as { issueNumber: number; issueUrl: string };
    const oncallUser = process.env.ONCALL_USER ?? "";

    // Invite on-call to channel
    const inviteRes = await fetch("https://slack.com/api/conversations.invite", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, users: oncallUser }),
    });
    const inviteData = await inviteRes.json() as { ok: boolean; error?: string };
    if (!inviteData.ok && inviteData.error !== "already_in_channel") {
      await ctx.log(`Warning: could not invite on-call: ${inviteData.error}`);
    }

    // Post alert with buttons
    const correlationId = `oncall-${Date.now()}`;
    const msgRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: channelId,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                "🚨 *Production Incident Alert*",
                "",
                `*Title:* ${input.title}`,
                `*Severity:* ${input.severity.toUpperCase()}`,
                `*Source:* ${input.source}`,
                `*Description:* ${input.description}`,
                "",
                `*GitHub Issue:* <${issueUrl}|#${issueNumber}>`,
                "",
                `<@${oncallUser}> Please respond:`,
              ].join("\n"),
            },
          },
          {
            type: "actions",
            block_id: correlationId,
            elements: [
              { type: "button", text: { type: "plain_text", text: "✅ Acknowledge" }, action_id: "acknowledge", style: "primary" },
              { type: "button", text: { type: "plain_text", text: "⬆️ Escalate" }, action_id: "escalate", style: "danger" },
              { type: "button", text: { type: "plain_text", text: "🔕 False Alarm" }, action_id: "false_alarm" },
            ],
          },
        ],
      }),
    });
    const msgData = await msgRes.json() as { ok: boolean; ts: string; error?: string };
    if (!msgData.ok) throw new Error(`Slack error: ${msgData.error}`);
    await ctx.log(`Paged on-call (correlationId=${correlationId})`);
    return { correlationId, messageTs: msgData.ts };
  },
});

// ── Step 4: Wait for on-call response (polls every 3s, 15-min timeout) ────────

const waitForOncallResponse = workflow.task({
  name: "wait-for-oncall-response",
  parents: [inviteAndPage],
  retries: 0,
  fn: async (_input, ctx) => {
    const { correlationId } = await ctx.parentOutput(inviteAndPage) as { correlationId: string; messageTs: string };
    await ctx.log(`Waiting for on-call to respond (id=${correlationId})`);
    const { action, userId } = await waitForSlackAction(
      correlationId,
      15 * 60 * 1000,
      (msg) => ctx.log(msg)
    );
    return { action, userId };
  },
});

// ── Step 5: Drive the full incident lifecycle ──────────────────────────────────
// This single task handles: false alarm, severity confirmation, SEV1 broadcasts,
// status update loop, and resolution. It can run for hours — Hatchet supports it.

workflow.task({
  name: "run-incident",
  parents: [waitForOncallResponse, createGithubIssue, createIncidentChannel],
  retries: 0,
  fn: async (input: { title: string; severity: string; description: string; source: string }, ctx) => {
    const { action: oncallAction, userId: oncallUserId } = await ctx.parentOutput(waitForOncallResponse) as { action: string; userId: string };
    const { channelId } = await ctx.parentOutput(createIncidentChannel) as { channelId: string };
    const { issueNumber } = await ctx.parentOutput(createGithubIssue) as { issueNumber: number };

    const slackPost = async (channel: string, text: string) => {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text }),
      });
    };

    const githubComment = async (body: string) => {
      await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json", "Accept": "application/vnd.github+json" },
        body: JSON.stringify({ body }),
      });
    };

    const closeGithubIssue = async () => {
      await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues/${issueNumber}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json", "Accept": "application/vnd.github+json" },
        body: JSON.stringify({ state: "closed" }),
      });
    };

    // ── False alarm ────────────────────────────────────────────────────────────
    if (oncallAction === "false_alarm") {
      await ctx.log("False alarm — closing issue and archiving channel");
      await githubComment(`**False Alarm**\nConfirmed by <@${oncallUserId}> at ${new Date().toISOString()}`);
      await closeGithubIssue();
      await slackPost(channelId, "🔕 *False alarm confirmed.* Issue closed. Channel archived.");
      await fetch("https://slack.com/api/conversations.archive", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: channelId }),
      });
      return { outcome: "false_alarm" };
    }

    await ctx.log(`Incident acknowledged by ${oncallUserId}${oncallAction === "escalate" ? " (escalated)" : ""}`);

    // ── Confirm severity ───────────────────────────────────────────────────────
    const sevCorrelationId = `severity-${Date.now()}`;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: channelId,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `✅ Acknowledged by <@${oncallUserId}>. Please confirm severity:` } },
          {
            type: "actions",
            block_id: sevCorrelationId,
            elements: [
              { type: "button", text: { type: "plain_text", text: "🔴 SEV1 — Critical" }, action_id: "sev1", style: "danger" },
              { type: "button", text: { type: "plain_text", text: "🟠 SEV2 — Major" }, action_id: "sev2" },
              { type: "button", text: { type: "plain_text", text: "🟡 SEV3 — Minor" }, action_id: "sev3" },
            ],
          },
        ],
      }),
    });

    const { action: sevAction } = await waitForSlackAction(sevCorrelationId, 5 * 60 * 1000, (msg) => ctx.log(msg));
    const confirmedSeverity = sevAction === "timeout" ? input.severity : sevAction;
    await ctx.log(`Confirmed severity: ${confirmedSeverity}`);

    // ── SEV1: broadcast in parallel ────────────────────────────────────────────
    if (confirmedSeverity === "sev1") {
      await ctx.log("SEV1 — broadcasting to engineering, leadership, support");
      await Promise.all([
        slackPost(
          process.env.ENGINEERING_CHANNEL ?? channelId,
          `🚨 *SEV1 INCIDENT — DEPLOY FREEZE IN EFFECT*\n\n*${input.title}*\n${input.description}\n\nIncident channel: <#${channelId}>`
        ),
        slackPost(
          process.env.LEADERSHIP_CHANNEL ?? channelId,
          `🚨 *SEV1 INCIDENT ALERT*\n\n*${input.title}*\n${input.description}\n\nIncident channel: <#${channelId}>`
        ),
        slackPost(
          process.env.SUPPORT_CHANNEL ?? channelId,
          `🚨 *SEV1 — CUSTOMER IMPACT EXPECTED*\n\n*${input.title}*\nPlease prepare for customer inquiries. <#${channelId}>`
        ),
      ]);
    }

    // ── Status update loop ─────────────────────────────────────────────────────
    // STATUS_INTERVAL_MS env var lets you shorten this for demos (e.g. 30000 = 30s)
    const statusIntervalMs = parseInt(process.env.STATUS_INTERVAL_MS ?? "120000", 10);
    let resolved = false;

    while (!resolved) {
      await ctx.log(`Waiting ${statusIntervalMs / 1000}s before next status check`);
      await new Promise(r => setTimeout(r, statusIntervalMs));

      const statusId = `status-${Date.now()}`;
      const statusRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: channelId,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "📋 *Status Update* — what's the current state?" } },
            {
              type: "actions",
              block_id: statusId,
              elements: [
                { type: "button", text: { type: "plain_text", text: "🔍 Investigating" }, action_id: "investigating" },
                { type: "button", text: { type: "plain_text", text: "🎯 Identified" }, action_id: "identified" },
                { type: "button", text: { type: "plain_text", text: "🔧 Fixing" }, action_id: "fixing" },
                { type: "button", text: { type: "plain_text", text: "✅ Resolved" }, action_id: "resolved", style: "primary" },
              ],
            },
          ],
        }),
      });
      const statusMsgData = await statusRes.json() as { ok: boolean };
      if (!statusMsgData.ok) { await ctx.log("Warning: failed to send status message"); continue; }

      const { action: statusAction } = await waitForSlackAction(statusId, 30 * 60 * 1000, (msg) => ctx.log(msg));
      await ctx.log(`Status update: ${statusAction}`);

      await githubComment(`**Status Update:** ${statusAction.charAt(0).toUpperCase() + statusAction.slice(1)}\n**Time:** ${new Date().toISOString()}`);

      if (statusAction === "resolved") resolved = true;
    }

    // ── Resolution ─────────────────────────────────────────────────────────────
    await ctx.log("Incident resolved — closing issue and notifying channel");

    await githubComment([
      "## ✅ INCIDENT RESOLVED",
      "",
      `**Severity:** ${confirmedSeverity.toUpperCase()}`,
      `**Resolved by:** <@${oncallUserId}>`,
      `**Resolution time:** ${new Date().toISOString()}`,
    ].join("\n"));

    await closeGithubIssue();

    await slackPost(
      channelId,
      "✅ *INCIDENT RESOLVED*\n\nThe GitHub issue has been closed. This channel will remain for post-incident discussion."
    );

    return { outcome: "resolved", severity: confirmedSeverity };
  },
});

const worker = await hatchet.worker("production-incident-response-worker", {
  workflows: [workflow],
});
export default { start: () => worker.start() };
