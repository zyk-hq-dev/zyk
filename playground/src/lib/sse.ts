/**
 * SSE controller registry — survives HMR restarts by living on global.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;

if (!g._sseControllers) {
  g._sseControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
}

export const sseControllers: Map<string, ReadableStreamDefaultController<Uint8Array>> =
  g._sseControllers;

export function registerSSE(
  sessionId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
) {
  const existing = sseControllers.get(sessionId);
  if (existing) {
    try {
      existing.close();
    } catch {
      // ignore
    }
  }
  sseControllers.set(sessionId, controller);
}

export function unregisterSSE(sessionId: string) {
  sseControllers.delete(sessionId);
}

export function emitSSE(sessionId: string, event: string, data: unknown) {
  const controller = sseControllers.get(sessionId);
  if (!controller) {
    console.log(`[SSE] no controller for session=${sessionId} event=${event} (registered: ${[...sseControllers.keys()].join(", ")})`);
    return false;
  }

  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(new TextEncoder().encode(payload));
    return true;
  } catch {
    sseControllers.delete(sessionId);
    return false;
  }
}
