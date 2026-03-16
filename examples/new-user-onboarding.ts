/**
 * Example: New User Onboarding
 *
 * Triggered when a new user signs up. Sends a welcome email via Resend,
 * creates a Notion page for the customer, and posts to a Slack channel.
 *
 * Trigger: webhook (called from your signup handler)
 *
 * Required env vars:
 *   RESEND_API_KEY     - Resend API key for transactional email
 *   NOTION_TOKEN       - Notion integration token
 *   NOTION_DATABASE_ID - Notion database to add new customer pages to
 *   SLACK_TOKEN        - Slack bot OAuth token
 *   SLACK_CHANNEL      - Channel to notify (e.g. "#new-customers")
 */

import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

interface NewUserInput {
  userId: string;
  email: string;
  name: string;
  plan: "free" | "pro" | "team";
  signedUpAt: string;
}

// --- Tasks ---

const sendWelcomeEmail = hatchet.task({
  name: "send-welcome-email",
  fn: async (input: NewUserInput) => {
    const { email, name, plan } = input;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "onboarding@yourapp.com",
        to: email,
        subject: `Welcome to YourApp, ${name}! 🎉`,
        html: `
          <h1>Welcome, ${name}!</h1>
          <p>Thanks for signing up for the <strong>${plan}</strong> plan.</p>
          <p>Here are your next steps:</p>
          <ol>
            <li><a href="https://yourapp.com/quickstart">Complete the quickstart</a></li>
            <li><a href="https://yourapp.com/docs">Read the docs</a></li>
            <li>Reply to this email if you have questions</li>
          </ol>
          <p>Happy building!<br/>The YourApp Team</p>
        `,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend API error: ${response.status}`);
    }

    const result = (await response.json()) as { id: string };
    return { emailId: result.id, sentTo: email };
  },
});

const createNotionPage = hatchet.task({
  name: "create-notion-customer-page",
  fn: async (input: NewUserInput) => {
    const { userId, name, email, plan, signedUpAt } = input;

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Email: { email },
          Plan: { select: { name: plan } },
          "User ID": { rich_text: [{ text: { content: userId } }] },
          "Signed Up": { date: { start: signedUpAt } },
          Status: { select: { name: "Active" } },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Notion API error: ${response.status}`);
    }

    const result = (await response.json()) as { id: string; url: string };
    return { pageId: result.id, pageUrl: result.url };
  },
});

const notifySlack = hatchet.task({
  name: "notify-slack-new-customer",
  fn: async (input: NewUserInput) => {
    const { name, email, plan } = input;
    const planEmoji = { free: "🆓", pro: "⭐", team: "🚀" }[plan] ?? "👋";

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#general",
        text: `${planEmoji} New ${plan} user: *${name}* (${email})`,
        mrkdwn: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    return { notified: true };
  },
});

// --- Workflow ---

const onboardingWorkflow = hatchet.workflow({
  name: "new-user-onboarding",
  steps: [sendWelcomeEmail, createNotionPage, notifySlack],
});

// --- Worker ---

const worker = await hatchet.worker("onboarding-worker", {
  workflows: [onboardingWorkflow],
});

export default {
  start: () => worker.start(),
};
