/**
 * POST /api/trigger
 * Trigger a workflow run from the UI.
 * Body: { workflow_id, session_id, params? }
 */

import { NextRequest, NextResponse } from "next/server";
import { getWorkflowEntry } from "@/lib/registry";
import { getHatchetClient } from "@/lib/hatchet-client";
import { hatchetWorkflowName } from "@/lib/code-runner";
import { isWorkerRunning, startWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: {
    workflow_id: string;
    session_id: string;
    params?: Record<string, unknown>;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workflow_id, session_id, params = {} } = body;

  const entry = getWorkflowEntry(workflow_id);
  if (!entry || entry.sessionId !== session_id) {
    return NextResponse.json(
      { error: `Workflow "${workflow_id}" not found.` },
      { status: 404 }
    );
  }

  // Restart worker if it died (e.g. server restart cleared in-memory workers map)
  if (!isWorkerRunning(workflow_id)) {
    await startWorker(workflow_id, entry.sessionId, entry.code);
  }

  try {
    const hatchet = getHatchetClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runRef = await hatchet.runNoWait(hatchetWorkflowName(entry.name, entry.sessionId), params as any, {});
    const runId = await runRef.workflowRunId;
    return NextResponse.json({
      success: true,
      run_id: runId,
      workflow_id,
      workflow_name: entry.name,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to run workflow: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }
}
