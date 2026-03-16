const ZYK_API_BASE = "https://api.zyk.dev";

export function isProTier(): boolean {
  return process.env.ZYK_API_KEY !== undefined;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  description: string;
  trigger: "on-demand" | "schedule";
  tags: string[];
}

export interface TemplateDetail extends Template {
  code: string;
  diagram?: string;
}

export interface ReviewResult {
  available: boolean;
  message?: string;
  suggestions?: string[];
}

// ── Stub data ─────────────────────────────────────────────────────────────────

const STUB_TEMPLATES: Template[] = [
  {
    id: "daily-report",
    name: "Daily Revenue Report",
    description: "Fetch Stripe revenue each morning and post a summary to Slack.",
    trigger: "schedule",
    tags: ["stripe", "slack"],
  },
  {
    id: "new-user-onboarding",
    name: "New User Onboarding",
    description: "Send a welcome email sequence when a new user signs up via webhook.",
    trigger: "on-demand",
    tags: ["email"],
  },
  {
    id: "api-error-monitor",
    name: "API Error Monitor",
    description: "Poll your API health endpoint and page on-call via PagerDuty on failures.",
    trigger: "schedule",
    tags: ["pagerduty"],
  },
];

const STUB_TEMPLATE_CODE: Record<string, string> = {
  "daily-report": `import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const fetchRevenue = hatchet.task({
  name: "fetch-revenue",
  fn: async (_input: Record<string, never>) => {
    const response = await fetch("https://api.stripe.com/v1/balance_transactions?limit=100", {
      headers: { Authorization: \`Bearer \${process.env.STRIPE_SECRET_KEY}\` },
    });
    const data = await response.json() as { data: Array<{ amount: number; currency: string }> };
    const total = data.data.reduce((sum, tx) => sum + tx.amount, 0);
    return { total, currency: "usd" };
  },
});

const postSlack = hatchet.task({
  name: "post-slack",
  fn: async (input: { total: number; currency: string }) => {
    const amount = (input.total / 100).toFixed(2);
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.SLACK_TOKEN}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL ?? "#revenue",
        text: \`Daily revenue: $\${amount} \${input.currency.toUpperCase()}\`,
      }),
    });
    return { sent: true };
  },
});

const dailyReportWorkflow = hatchet.workflow({
  name: "daily-revenue-report",
  steps: [fetchRevenue, postSlack],
  on: { crons: ["0 8 * * *"] },
});

export default dailyReportWorkflow;`,

  "new-user-onboarding": `import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const sendWelcomeEmail = hatchet.task({
  name: "send-welcome-email",
  fn: async (input: { email: string; name?: string }) => {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.SENDGRID_API_KEY}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [{ email: input.email }],
        from: { email: process.env.FROM_EMAIL ?? "hello@example.com" },
        subject: "Welcome!",
        content: [{ type: "text/plain", value: \`Hi \${input.name ?? "there"}, welcome aboard!\` }],
      }),
    });
    return { status: response.status };
  },
});

const onboardingWorkflow = hatchet.workflow({
  name: "new-user-onboarding",
  steps: [sendWelcomeEmail],
});

export default onboardingWorkflow;`,

  "api-error-monitor": `import Hatchet from "@hatchet-dev/typescript-sdk";

const hatchet = Hatchet.init();

const checkHealth = hatchet.task({
  name: "check-health",
  fn: async (_input: Record<string, never>) => {
    try {
      const response = await fetch(process.env.HEALTH_URL ?? "https://example.com/health");
      return { healthy: response.ok, status: response.status };
    } catch (err) {
      return { healthy: false, status: 0, error: String(err) };
    }
  },
});

const alertPagerDuty = hatchet.task({
  name: "alert-pagerduty",
  fn: async (input: { healthy: boolean; status: number; error?: string }) => {
    if (input.healthy) return { alerted: false };
    await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: process.env.PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        payload: {
          summary: \`API health check failed (status \${input.status})\`,
          severity: "error",
          source: "zyk-monitor",
        },
      }),
    });
    return { alerted: true };
  },
});

const errorMonitorWorkflow = hatchet.workflow({
  name: "api-error-monitor",
  steps: [checkHealth, alertPagerDuty],
  on: { crons: ["*/5 * * * *"] },
});

export default errorMonitorWorkflow;`,
};

// ── API calls ─────────────────────────────────────────────────────────────────

export function track(event: string, props?: Record<string, unknown>): void {
  const key = process.env.ZYK_API_KEY;
  if (!key) return;

  fetch(`${ZYK_API_BASE}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zyk-api-key": key,
    },
    body: JSON.stringify({ event, ...props }),
  }).catch(() => {
    // fire-and-forget — never surface errors
  });
}

export async function fetchTemplates(): Promise<Template[]> {
  const key = process.env.ZYK_API_KEY;
  if (!key) return STUB_TEMPLATES;

  try {
    const res = await fetch(`${ZYK_API_BASE}/templates`, {
      headers: { "x-zyk-api-key": key },
    });
    if (!res.ok) return STUB_TEMPLATES;
    return (await res.json()) as Template[];
  } catch {
    return STUB_TEMPLATES;
  }
}

export async function fetchTemplate(id: string): Promise<TemplateDetail | null> {
  const key = process.env.ZYK_API_KEY;
  if (!key) return null;

  // Return stub data if the API isn't available yet
  const stub = STUB_TEMPLATES.find((t) => t.id === id);
  if (!stub) return null;

  try {
    const res = await fetch(`${ZYK_API_BASE}/templates/${encodeURIComponent(id)}`, {
      headers: { "x-zyk-api-key": key },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TemplateDetail;
  } catch {
    // Fall back to stub data so the feature works before the API exists
    const code = STUB_TEMPLATE_CODE[id];
    if (!code) return null;
    return { ...stub, code };
  }
}

export function recordRun(workflowId: string, runId: string, trigger: string): void {
  const key = process.env.ZYK_API_KEY;
  if (!key) return;

  fetch(`${ZYK_API_BASE}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zyk-api-key": key,
    },
    body: JSON.stringify({ workflowId, runId, trigger }),
  }).catch(() => {
    // fire-and-forget
  });
}

export async function reviewWorkflow(_code: string): Promise<ReviewResult> {
  // Stub: AI review coming soon
  return {
    available: false,
    message: "AI review coming soon — watch for updates at zyk.dev",
  };
}
