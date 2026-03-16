/**
 * Example: API Error Monitor
 *
 * Polls your API's health endpoint every 5 minutes. If errors are detected
 * (high error rate or health check failure), pages the on-call engineer
 * via PagerDuty and posts an alert to Slack.
 *
 * Trigger: schedule (every 5 minutes)
 *
 * Required env vars:
 *   API_HEALTH_URL       - Your API's health check URL
 *   PAGERDUTY_ROUTING_KEY - PagerDuty Events API v2 routing key
 *   SLACK_TOKEN          - Slack bot OAuth token
 *   SLACK_ALERT_CHANNEL  - Channel for alerts (e.g. "#oncall")
 */

import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

interface HealthCheckResult {
  healthy: boolean;
  statusCode: number;
  errorRate?: number;
  responseTimeMs: number;
  details?: string;
}

// --- Tasks ---

const checkApiHealth = hatchet.task({
  name: "check-api-health",
  fn: async (_input: Record<string, never>): Promise<HealthCheckResult> => {
    const url = process.env.API_HEALTH_URL;
    if (!url) throw new Error("API_HEALTH_URL is not set");

    const start = Date.now();

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000), // 10 second timeout
      });

      const responseTimeMs = Date.now() - start;
      const body = await response.json().catch(() => ({})) as {
        error_rate?: number;
        details?: string;
      };

      const errorRate = body.error_rate ?? 0;
      const healthy = response.ok && errorRate < 0.05; // >5% error rate = unhealthy

      return {
        healthy,
        statusCode: response.status,
        errorRate,
        responseTimeMs,
        details: !healthy
          ? `Status ${response.status}, error rate ${(errorRate * 100).toFixed(1)}%`
          : undefined,
      };
    } catch (err) {
      return {
        healthy: false,
        statusCode: 0,
        responseTimeMs: Date.now() - start,
        details: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

const triggerPagerDuty = hatchet.task({
  name: "trigger-pagerduty-alert",
  fn: async (input: HealthCheckResult) => {
    const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
    if (!routingKey) throw new Error("PAGERDUTY_ROUTING_KEY is not set");

    // Skip if healthy
    if (input.healthy) return { skipped: true };

    const response = await fetch(
      "https://events.pagerduty.com/v2/enqueue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: "trigger",
          payload: {
            summary: `API Health Check Failed: ${input.details}`,
            severity: "critical",
            source: process.env.API_HEALTH_URL,
            custom_details: {
              status_code: input.statusCode,
              error_rate: input.errorRate,
              response_time_ms: input.responseTimeMs,
            },
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`PagerDuty API error: ${response.status}`);
    }

    const result = (await response.json()) as { dedup_key: string };
    return { paged: true, dedupKey: result.dedup_key };
  },
});

const postSlackAlert = hatchet.task({
  name: "post-slack-alert",
  fn: async (input: HealthCheckResult) => {
    // Skip if healthy
    if (input.healthy) return { skipped: true };

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_ALERT_CHANNEL ?? "#oncall",
        text: `🚨 *API Health Alert*\n> ${input.details ?? "Health check failed"}\n> Response time: ${input.responseTimeMs}ms`,
        mrkdwn: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    return { alerted: true };
  },
});

// --- Workflow ---

const apiMonitorWorkflow = hatchet.workflow({
  name: "api-error-monitor",
  on: {
    // Check every 5 minutes
    crons: ["*/5 * * * *"],
  },
  steps: [checkApiHealth, triggerPagerDuty, postSlackAlert],
});

// --- Worker ---

const worker = await hatchet.worker("monitor-worker", {
  workflows: [apiMonitorWorkflow],
});

export default {
  start: () => worker.start(),
};
