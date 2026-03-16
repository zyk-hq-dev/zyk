/**
 * In-memory workflow registry — session-scoped, survives HMR on global.
 * Persisted to .workflows/registry.json so workers can be restored after server restarts.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { startWorker, stopWorker } from "./worker";
import { validateWorkflowCode, injectWorkflowName, hatchetWorkflowName } from "./code-runner";
import { emitSSE } from "./sse";

export interface WorkflowEntry {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  code: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;
if (!g._workflowRegistry) g._workflowRegistry = new Map<string, WorkflowEntry>();
export const workflowRegistry: Map<string, WorkflowEntry> = g._workflowRegistry;

const REGISTRY_PATH = join(process.cwd(), ".workflows", "registry.json");

function persistRegistry() {
  try {
    mkdirSync(join(process.cwd(), ".workflows"), { recursive: true });
    const entries = Array.from(workflowRegistry.values());
    writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

// Load from disk once per process (survives HMR via globalThis guard)
if (!g._registryLoaded) {
  g._registryLoaded = true;
  if (existsSync(REGISTRY_PATH)) {
    try {
      const entries = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as WorkflowEntry[];
      for (const entry of entries) {
        workflowRegistry.set(entry.id, entry);
      }
    } catch {
      // corrupt file — ignore
    }
  }
}

export async function registerWorkflow(params: {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  code: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
}): Promise<WorkflowEntry> {
  const { id, sessionId, name, description, code, trigger, schedule, diagram } = params;

  const finalCode = injectWorkflowName(code, name, sessionId);
  await startWorker(id, sessionId, finalCode);

  const entry: WorkflowEntry = {
    id,
    sessionId,
    name,
    description,
    code: finalCode,
    trigger,
    schedule,
    diagram,
    createdAt: new Date().toISOString(),
  };

  workflowRegistry.set(id, entry);
  persistRegistry();
  emitSSE(sessionId, "workflow_registered", { workflow: entry });

  return entry;
}

export async function updateWorkflowEntry(params: {
  id: string;
  code?: string;
  description?: string;
  trigger?: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
}): Promise<WorkflowEntry> {
  const existing = workflowRegistry.get(params.id);
  if (!existing) throw new Error(`Workflow "${params.id}" not found`);

  const updated: WorkflowEntry = {
    ...existing,
    description: params.description ?? existing.description,
    trigger: params.trigger ?? existing.trigger,
    schedule: params.schedule ?? existing.schedule,
    diagram: params.diagram ?? existing.diagram,
  };

  if (params.code !== undefined) {
    const finalCode = injectWorkflowName(params.code, existing.name, existing.sessionId);
    updated.code = finalCode;
    await startWorker(params.id, existing.sessionId, finalCode);
  }

  workflowRegistry.set(params.id, updated);
  persistRegistry();
  emitSSE(existing.sessionId, "workflow_updated", { workflow: updated });

  return updated;
}

export function listWorkflowsBySession(sessionId: string): WorkflowEntry[] {
  return Array.from(workflowRegistry.values())
    .filter((w) => w.sessionId === sessionId)
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

export function getWorkflowEntry(id: string): WorkflowEntry | undefined {
  return workflowRegistry.get(id);
}

export async function deleteWorkflowEntry(id: string): Promise<boolean> {
  const entry = workflowRegistry.get(id);
  if (!entry) return false;
  await stopWorker(id);
  workflowRegistry.delete(id);
  persistRegistry();
  emitSSE(entry.sessionId, "workflow_deleted", { workflowId: id });
  return true;
}

export function createWorkflowId(sessionId: string): string {
  const prefix = sessionId.slice(0, 8);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}

export { validateWorkflowCode, hatchetWorkflowName };
