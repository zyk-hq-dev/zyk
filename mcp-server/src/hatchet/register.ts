import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import {
  saveWorkflowCode,
  startWorker,
  stopWorker,
  getWorkflowFilePath,
  WORKFLOWS_DIR,
} from "./worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(WORKFLOWS_DIR, "registry.json");

export interface WorkflowRegistryEntry {
  id: string;
  name: string;
  /** Kebab-case name used by Hatchet internally (matches workflow name in run displayName) */
  hatchetName?: string;
  description: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
  createdAt: string;
  /** Absolute path — resolved at load time, not stored literally in JSON */
  filePath: string;
}

/** Shape stored on disk — uses fileName (basename) instead of absolute filePath */
interface PersistedEntry {
  id: string;
  name: string;
  hatchetName?: string;
  description: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
  createdAt: string;
  fileName: string;
}

function loadRegistry(): Record<string, WorkflowRegistryEntry> {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    const raw = JSON.parse(
      readFileSync(REGISTRY_PATH, "utf-8")
    ) as Record<string, PersistedEntry>;

    // Resolve fileName → absolute filePath at load time
    const result: Record<string, WorkflowRegistryEntry> = {};
    for (const [id, entry] of Object.entries(raw)) {
      result[id] = {
        ...entry,
        filePath: join(WORKFLOWS_DIR, entry.fileName),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function persistRegistry(registry: Record<string, WorkflowRegistryEntry>) {
  mkdirSync(WORKFLOWS_DIR, { recursive: true });

  // Convert absolute filePath → portable fileName (basename only)
  const data: Record<string, PersistedEntry> = {};
  for (const [id, entry] of Object.entries(registry)) {
    const { filePath: _filePath, ...rest } = entry;
    data[id] = {
      ...rest,
      fileName: basename(entry.filePath),
    };
  }

  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function registerWorkflow(params: {
  id: string;
  name: string;
  hatchetName?: string;
  description: string;
  code: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
}): Promise<WorkflowRegistryEntry> {
  const { id, name, hatchetName, description, code, trigger, schedule, diagram } = params;

  // Save the workflow code to disk
  const filePath = saveWorkflowCode(id, code);

  const entry: WorkflowRegistryEntry = {
    id,
    name,
    hatchetName,
    description,
    trigger,
    schedule,
    diagram,
    createdAt: new Date().toISOString(),
    filePath,
  };

  // Persist to registry
  const registry = loadRegistry();
  registry[id] = entry;
  persistRegistry(registry);

  // Start the Hatchet worker for this workflow
  await startWorker(id, filePath);

  return entry;
}

export async function updateWorkflow(params: {
  id: string;
  code?: string;
  description?: string;
  trigger?: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
}): Promise<WorkflowRegistryEntry> {
  const registry = loadRegistry();
  const existing = registry[params.id];
  if (!existing) {
    throw new Error(`Workflow "${params.id}" not found`);
  }

  // Overwrite code file if new code was provided
  if (params.code !== undefined) {
    saveWorkflowCode(params.id, params.code);
  }

  const updated: WorkflowRegistryEntry = {
    ...existing,
    description: params.description ?? existing.description,
    trigger: params.trigger ?? existing.trigger,
    schedule: params.schedule ?? existing.schedule,
    diagram: params.diagram ?? existing.diagram,
  };

  registry[params.id] = updated;
  persistRegistry(registry);

  // Restart the worker to pick up the new code
  await startWorker(params.id, updated.filePath);

  return updated;
}

export function listWorkflows(): WorkflowRegistryEntry[] {
  return Object.values(loadRegistry()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getWorkflow(id: string): WorkflowRegistryEntry | undefined {
  return loadRegistry()[id];
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const registry = loadRegistry();
  if (!registry[id]) return false;

  // Stop the worker
  await stopWorker(id);

  // Remove .ts source and compiled .js files
  const filePath = getWorkflowFilePath(id);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  const jsFilePath = filePath.replace(/\.ts$/, ".js");
  if (existsSync(jsFilePath)) {
    unlinkSync(jsFilePath);
  }

  delete registry[id];
  persistRegistry(registry);
  return true;
}

export async function restoreWorkersOnStartup(): Promise<void> {
  const registry = loadRegistry();
  const entries = Object.values(registry);

  if (entries.length === 0) return;

  console.error(`Restoring ${entries.length} workflow worker(s)...`);

  for (const entry of entries) {
    if (existsSync(entry.filePath)) {
      try {
        await startWorker(entry.id, entry.filePath);
        console.error(`  ✓ Restored worker for: ${entry.name}`);
      } catch (err) {
        console.error(
          `  ✗ Failed to restore worker for ${entry.name}:`,
          err instanceof Error ? err.message : err
        );
      }
    } else {
      console.error(
        `  ✗ Skipping ${entry.name}: code file not found at ${entry.filePath}`
      );
    }
  }
}
