import { z } from "zod";
import { getHatchetClient } from "../hatchet/client.js";
import { listWorkflows } from "../hatchet/register.js";

export const listRunsSchema = z.object({
  workflow_id: z
    .string()
    .optional()
    .describe("Filter by a specific workflow ID (optional — omit to list runs across all workflows)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of runs to return (default 20, max 100)"),
  status: z
    .enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"])
    .optional()
    .describe("Filter by run status (optional)"),
  since_hours: z
    .number()
    .default(24)
    .describe("How many hours back to look (default 24)"),
});

export type ListRunsInput = z.infer<typeof listRunsSchema>;

// Build a map of Hatchet workflow name → Zyk workflow ID for display.
// Keys: hatchetName (kebab-case internal name) preferred, fallback to human-readable name.
function buildNameMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of listWorkflows()) {
    if (entry.hatchetName) map[entry.hatchetName] = entry.id;
    map[entry.name] = entry.id;
  }
  return map;
}

/** Strip Hatchet's timestamp suffix from run display names (e.g. "my-wf-1773868500167" → "my-wf") */
function stripTimestamp(name: string): string {
  return name.replace(/-\d{10,}$/, "");
}

export async function listRuns(input: ListRunsInput) {
  const { workflow_id, limit, status, since_hours } = input;

  const hatchet = getHatchetClient();
  const tenantId = hatchet.tenantId;

  const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();

  // If a workflow_id was specified, resolve its Hatchet-internal workflow name
  // so we can pass it as a filter. Hatchet's REST API filter uses UUIDs for
  // workflow definitions — but those are Hatchet-internal, not Zyk IDs.
  // We filter client-side by workflow name instead (simpler and reliable).
  let filterByZykId: string | undefined = workflow_id;

  try {
    const resp = await hatchet.api.v1WorkflowRunList(tenantId, {
      since,
      limit,
      only_tasks: false,
      ...(status ? { statuses: [status as any] } : {}),
    });

    const runs = (resp.data as any)?.rows ?? [];

    // Build name → zyk-id map for display
    const nameMap = buildNameMap();

    // Normalize and optionally filter
    const normalized = runs
      .map((run: any) => {
        const rawName: string = run.displayName?.split("/")[0] ?? run.workflowName ?? "unknown";
        const workflowName = stripTimestamp(rawName);
        const zykId = nameMap[workflowName];
        return {
          run_id: run.metadata?.id ?? run.id,
          workflow_name: workflowName,
          workflow_id: zykId ?? null,
          status: run.status,
          started_at: run.metadata?.createdAt ?? run.createdAt,
          finished_at: run.finishedAt ?? null,
          duration_ms: run.duration ?? null,
        };
      })
      .filter((r: any) => {
        if (!filterByZykId) return true;
        return r.workflow_id === filterByZykId;
      });

    return {
      success: true,
      total: normalized.length,
      since,
      runs: normalized,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to list runs: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
