/**
 * GET /api/runs?sessionId=...&limit=50&status=COMPLETED
 * Proxies Hatchet REST API for run history.
 */

import { NextRequest, NextResponse } from "next/server";
import { getHatchetClient } from "@/lib/hatchet-client";
import { listWorkflowsBySession } from "@/lib/registry";
import { hatchetWorkflowName } from "@/lib/code-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Extract server_url and tenantId from the Hatchet JWT without verifying it. */
function decodeJWT(token: string): { server_url?: string; sub?: string } {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const sessionId = searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 100);
  const status = searchParams.get("status") ?? undefined;
  const sinceHours = parseInt(searchParams.get("since_hours") ?? "24", 10);
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  // Build a name→id map for this session's workflows
  const nameMap: Record<string, string> = {};
  for (const wf of listWorkflowsBySession(sessionId)) {
    nameMap[hatchetWorkflowName(wf.name, wf.sessionId)] = wf.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[] = [];

  try {
    const hatchet = getHatchetClient();
    const tenantId = hatchet.tenantId;

    // Primary path: use Hatchet SDK REST client
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (hatchet.api as any).v1WorkflowRunList(tenantId, {
        since,
        limit,
        only_tasks: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(status ? { statuses: [status as any] } : {}),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (resp.data as any)?.rows ?? [];
    } catch (sdkErr) {
      // Fallback: construct the URL directly from the JWT or env var
      const token = process.env.HATCHET_CLIENT_TOKEN ?? "";
      const apiBase =
        process.env.HATCHET_CLIENT_API_URL ??
        decodeJWT(token).server_url ??
        "";

      if (!apiBase) {
        console.error("[runs] SDK failed and no fallback API URL:", sdkErr);
        return NextResponse.json({ runs: [], since, warning: "Run history unavailable" });
      }

      const qs = new URLSearchParams({ since, limit: String(limit), only_tasks: "false" });
      if (status) qs.set("statuses", status);
      const url = `${apiBase}/api/v1/stable/tenants/${tenantId}/workflow-runs?${qs}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) {
        return NextResponse.json({ runs: [], since, warning: "Run history unavailable" });
      }
      const data = await res.json() as { rows?: unknown[] };
      rows = data.rows ?? [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runs = rows.map((r: any) => {
      const workflowName: string =
        r.displayName?.split("/")?.[0] ?? r.workflowName ?? "unknown";
      return {
        run_id: r.metadata?.id ?? r.id,
        workflow_name: workflowName,
        workflow_id: nameMap[workflowName] ?? null,
        status: r.status,
        started_at: r.metadata?.createdAt ?? r.createdAt,
        finished_at: r.finishedAt ?? null,
        duration_ms: r.duration ?? null,
      };
    });
    return NextResponse.json({ runs, since });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to fetch runs: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }
}
