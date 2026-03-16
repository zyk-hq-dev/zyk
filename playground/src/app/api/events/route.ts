/**
 * GET /api/events?sessionId=...
 * Server-Sent Events stream for real-time updates per session.
 */

import { NextRequest } from "next/server";
import { registerSSE, unregisterSSE, emitSSE } from "@/lib/sse";
import { listWorkflowsBySession } from "@/lib/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return new Response("Missing sessionId", { status: 400 });
  }

  let closeController: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      registerSSE(sessionId, controller);

      // Send a keepalive comment every 25s to prevent proxy timeouts
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, 25_000);

      closeController = () => {
        clearInterval(keepalive);
        unregisterSSE(sessionId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Send connected event
      const connected = `event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`;
      controller.enqueue(new TextEncoder().encode(connected));

      // Replay existing workflows for this session so page refresh restores cards
      const existing = listWorkflowsBySession(sessionId);
      for (const workflow of existing) {
        emitSSE(sessionId, "workflow_registered", { workflow });
      }
    },
    cancel() {
      closeController?.();
    },
  });

  // Clean up when the client disconnects
  req.signal.addEventListener("abort", () => {
    closeController?.();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
