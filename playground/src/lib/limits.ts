/**
 * Playground safety limits — session-scoped, all in-memory on globalThis.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RateWindow {
  count: number;
  windowStart: number; // ms timestamp
}

if (!g._rateLimitWindows) g._rateLimitWindows = new Map<string, RateWindow>();
const rateLimitWindows: Map<string, RateWindow> = g._rateLimitWindows;

const RATE_LIMIT_MAX = 20;       // messages per session
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMinutes: number;
}

export function checkRateLimit(sessionId: string): RateLimitResult {
  const now = Date.now();
  const window = rateLimitWindows.get(sessionId);

  if (!window || now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Fresh window
    rateLimitWindows.set(sessionId, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetInMinutes: 60 };
  }

  if (window.count >= RATE_LIMIT_MAX) {
    const resetInMs = RATE_LIMIT_WINDOW_MS - (now - window.windowStart);
    const resetInMinutes = Math.ceil(resetInMs / 60_000);
    return { allowed: false, remaining: 0, resetInMinutes };
  }

  window.count++;
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX - window.count,
    resetInMinutes: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - window.windowStart)) / 60_000),
  };
}

// ── Prompt length ─────────────────────────────────────────────────────────────

export const MAX_PROMPT_CHARS = 2000;

export function checkPromptLength(text: string): { ok: boolean; length: number } {
  return { ok: text.length <= MAX_PROMPT_CHARS, length: text.length };
}

// ── Max workflows per session ─────────────────────────────────────────────────

export const MAX_WORKFLOWS_PER_SESSION = 5;
