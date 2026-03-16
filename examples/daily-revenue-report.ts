/**
 * Example: Daily Revenue Report
 *
 * Fetches yesterday's revenue from Stripe and posts a summary to Slack.
 * Triggered on a schedule: every day at 8 AM.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY  - Your Stripe secret key
 *   SLACK_TOKEN        - Slack bot OAuth token
 *   SLACK_CHANNEL      - Channel to post to (e.g. "#revenue")
 */

import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

// --- Tasks (each retried independently by Hatchet) ---

const fetchStripeRevenue = hatchet.task({
  name: "fetch-stripe-revenue",
  fn: async (_input: Record<string, never>) => {
    const now = new Date();
    const startOfYesterday = new Date(now);
    startOfYesterday.setDate(now.getDate() - 1);
    startOfYesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(startOfYesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    const params = new URLSearchParams({
      "created[gte]": String(Math.floor(startOfYesterday.getTime() / 1000)),
      "created[lte]": String(Math.floor(endOfYesterday.getTime() / 1000)),
      limit: "100",
    });

    const response = await fetch(
      `https://api.stripe.com/v1/charges?${params}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Stripe API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ amount: number; currency: string; status: string }>;
    };

    const successfulCharges = data.data.filter((c) => c.status === "succeeded");
    const totalCents = successfulCharges.reduce((sum, c) => sum + c.amount, 0);
    const totalDollars = totalCents / 100;

    return {
      date: startOfYesterday.toISOString().split("T")[0],
      revenue: totalDollars,
      transactionCount: successfulCharges.length,
      currency: "usd",
    };
  },
});

const postToSlack = hatchet.task({
  name: "post-slack-summary",
  fn: async (input: {
    date: string;
    revenue: number;
    transactionCount: number;
    currency: string;
  }) => {
    const { date, revenue, transactionCount } = input;
    const formattedRevenue = revenue.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });

    const emoji = revenue > 1000 ? "🚀" : revenue > 500 ? "📈" : "📊";
    const message = `${emoji} *Daily Revenue Report — ${date}*\n> Revenue: *${formattedRevenue}*\n> Transactions: *${transactionCount}*`;

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#general",
        text: message,
        mrkdwn: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      throw new Error(`Slack error: ${result.error}`);
    }

    return { posted: true, message };
  },
});

// --- Workflow (orchestrates tasks in sequence) ---

const dailyRevenueWorkflow = hatchet.workflow({
  name: "daily-revenue-report",
  on: {
    // Runs every day at 8 AM UTC
    crons: ["0 8 * * *"],
  },
  steps: [fetchStripeRevenue, postToSlack],
});

// --- Worker ---

const worker = await hatchet.worker("revenue-worker", {
  workflows: [dailyRevenueWorkflow],
});

export default {
  start: () => worker.start(),
};
