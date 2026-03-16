/**
 * Human-in-the-loop interaction store.
 *
 * Workflow calls POST /interact/ask  → question stored here, SSE emitted to browser.
 * User responds via POST /interact/respond/:correlationId → answer stored here.
 * Workflow polls GET /slack/pending/:correlationId → picks up answer (same contract as mcp-server).
 */

import { emitSSE } from "./sse";

export interface PendingQuestion {
  correlationId: string;
  sessionId: string;
  message: string;
  options?: string[];
  askedAt: string;
}

export interface ResolvedAnswer {
  action: string;
  userId: string;
  timestamp: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;

if (!g._pendingQuestions) g._pendingQuestions = new Map<string, PendingQuestion>();
if (!g._resolvedAnswers) g._resolvedAnswers = new Map<string, ResolvedAnswer>();

export const pendingQuestions: Map<string, PendingQuestion> = g._pendingQuestions;
export const resolvedAnswers: Map<string, ResolvedAnswer> = g._resolvedAnswers;

// Evict entries older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of resolvedAnswers) {
    if (new Date(val.timestamp).getTime() < cutoff) resolvedAnswers.delete(key);
  }
  for (const [key, val] of pendingQuestions) {
    if (new Date(val.askedAt).getTime() < cutoff) pendingQuestions.delete(key);
  }
}, 30 * 60 * 1000);

export function askQuestion(params: {
  correlationId: string;
  sessionId: string;
  message: string;
  options?: string[];
}): void {
  const question: PendingQuestion = {
    ...params,
    askedAt: new Date().toISOString(),
  };
  pendingQuestions.set(params.correlationId, question);
  emitSSE(params.sessionId, "interaction_request", {
    correlationId: params.correlationId,
    message: params.message,
    options: params.options,
  });
}

export function respondToQuestion(correlationId: string, action: string): boolean {
  const question = pendingQuestions.get(correlationId);
  if (!question) return false;
  pendingQuestions.delete(correlationId);
  resolvedAnswers.set(correlationId, {
    action,
    userId: "playground-user",
    timestamp: new Date().toISOString(),
  });
  return true;
}

export function pollAnswer(
  correlationId: string
): { pending: true } | { pending: false; action: string; userId: string } {
  const answer = resolvedAnswers.get(correlationId);
  if (answer) {
    resolvedAnswers.delete(correlationId);
    return { pending: false, action: answer.action, userId: answer.userId };
  }
  return { pending: true };
}
