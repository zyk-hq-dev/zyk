/**
 * POST /interact/respond/:correlationId
 * User submits their answer to a workflow question.
 * Body: { action: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { respondToQuestion } from "@/lib/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ correlationId: string }> }
) {
  const { correlationId } = await params;
  const decoded = decodeURIComponent(correlationId);

  let body: { action: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;
  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  const ok = respondToQuestion(decoded, action);
  if (!ok) {
    return NextResponse.json(
      { error: "Question not found or already answered" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
