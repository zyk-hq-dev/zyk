/**
 * POST /interact/ask
 * Workflow registers a question to show to the user.
 * Body: { correlationId, sessionId, message, options? }
 */

import { NextRequest, NextResponse } from "next/server";
import { askQuestion } from "@/lib/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: {
    correlationId: string;
    sessionId: string;
    message: string;
    options?: string[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { correlationId, sessionId, message, options } = body;
  if (!correlationId || !sessionId || !message) {
    return NextResponse.json(
      { error: "correlationId, sessionId, and message are required" },
      { status: 400 }
    );
  }

  console.log(`[interact/ask] correlationId=${correlationId} sessionId=${sessionId} message="${message}"`);
  askQuestion({ correlationId, sessionId, message, options });

  return NextResponse.json({ ok: true });
}
