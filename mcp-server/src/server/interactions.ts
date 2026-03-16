/**
 * Shared pending questions store.
 * Workflows post questions via POST /interact/ask.
 * Users answer via the respond_task MCP tool (in Claude) or POST /interact/respond/:id.
 * Answers land in pendingInteractions (webhook.ts) via the same /slack/pending/:id polling contract.
 */

export interface PendingQuestion {
  correlationId: string;
  message: string;
  options?: string[];
  workflowName?: string;
  askedAt: string;
  expiresAt?: string;
}

const pendingQuestions = new Map<string, PendingQuestion>();

// Evict entries older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, val] of pendingQuestions) {
    if (new Date(val.askedAt).getTime() < cutoff) pendingQuestions.delete(key);
  }
}, 30 * 60 * 1000).unref();

export function storePendingQuestion(q: PendingQuestion): void {
  pendingQuestions.set(q.correlationId, q);
}

export function getPendingQuestions(): PendingQuestion[] {
  const now = Date.now();
  // Evict expired questions on read
  for (const [key, val] of pendingQuestions) {
    if (val.expiresAt && new Date(val.expiresAt).getTime() < now) {
      pendingQuestions.delete(key);
    }
  }
  return Array.from(pendingQuestions.values()).sort(
    (a, b) => new Date(a.askedAt).getTime() - new Date(b.askedAt).getTime()
  );
}

export function consumePendingQuestion(correlationId: string): PendingQuestion | undefined {
  const q = pendingQuestions.get(correlationId);
  if (q) pendingQuestions.delete(correlationId);
  return q;
}

export function hasPendingQuestion(correlationId: string): boolean {
  return pendingQuestions.has(correlationId);
}

export function clearPendingQuestionsForWorkflow(workflowName: string): number {
  let count = 0;
  for (const [key, val] of pendingQuestions) {
    if (val.workflowName === workflowName) {
      pendingQuestions.delete(key);
      count++;
    }
  }
  return count;
}

export function clearAllPendingQuestions(): number {
  const count = pendingQuestions.size;
  pendingQuestions.clear();
  return count;
}
