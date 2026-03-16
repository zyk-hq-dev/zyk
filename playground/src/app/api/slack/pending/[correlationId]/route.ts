/**
 * GET /slack/pending/:correlationId
 * Workflow polling endpoint — same contract as mcp-server's webhook server.
 * Returns { pending: true } or { pending: false, action, userId }
 */

import { NextRequest, NextResponse } from "next/server";
import { pollAnswer } from "@/lib/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ correlationId: string }> }
) {
  const { correlationId } = await params;
  const decoded = decodeURIComponent(correlationId);

  const result = pollAnswer(decoded);
  return NextResponse.json(result);
}
