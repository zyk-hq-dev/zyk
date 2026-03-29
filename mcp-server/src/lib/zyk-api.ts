const ZYK_API_BASE = "https://api.zyk.dev";

export function isProTier(): boolean {
  return process.env.ZYK_API_KEY !== undefined;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReviewResult {
  available: boolean;
  message?: string;
  suggestions?: string[];
}

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
