import { ChildProcess, fork } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Track active worker processes by workflow ID
const workers = new Map<string, ChildProcess>();

// Workflows stopped intentionally via stopWorker() — do NOT auto-restart these
const stoppedIntentionally = new Set<string>();

// Retry state for auto-restart backoff
const retryState = new Map<string, { count: number }>();
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const WORKER_STARTUP_TIMEOUT_MS = 30_000;

// Directory where workflow code files are persisted.
// Override with WORKFLOWS_DIR env var (e.g. a Railway persistent volume mount).
// The default resolves to <app-root>/workflows, which is the Docker volume mount point.
export const WORKFLOWS_DIR =
  process.env.WORKFLOWS_DIR ?? join(__dirname, "../../workflows");

export function ensureWorkflowsDir() {
  if (!existsSync(WORKFLOWS_DIR)) {
    mkdirSync(WORKFLOWS_DIR, { recursive: true });
  }
}

export function saveWorkflowCode(workflowId: string, code: string): string {
  ensureWorkflowsDir();
  const filePath = join(WORKFLOWS_DIR, `${workflowId}.ts`);
  writeFileSync(filePath, code, "utf-8");
  return filePath;
}

export function getWorkflowFilePath(workflowId: string): string {
  return join(WORKFLOWS_DIR, `${workflowId}.ts`);
}

/**
 * Compile a workflow TypeScript file to ESM JavaScript using esbuild.
 * Returns the path to the compiled .js file.
 *
 * We compile rather than using tsx/esm at runtime because tsx 4.x on Windows
 * cannot import TypeScript files via file:// URLs from a dynamic import().
 */
async function compileWorkflow(tsFilePath: string): Promise<string> {
  // esbuild on Windows requires forward-slash paths; path.join() produces backslashes
  const tsNorm = tsFilePath.replace(/\\/g, "/");
  const jsNorm = tsNorm.replace(/\.ts$/, ".js");
  await build({
    entryPoints: [tsNorm],
    outfile: jsNorm,
    bundle: false,        // keep @hatchet-dev/typescript-sdk as an external reference
    format: "esm",        // ESM required for top-level await in workflow files
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  // On Windows use backslashes; on Linux (e.g. Docker) keep forward slashes
  return process.platform === "win32" ? jsNorm.replace(/\//g, "\\") : jsNorm;
}

export function isWorkerRunning(workflowId: string): boolean {
  const worker = workers.get(workflowId);
  return worker !== undefined && !worker.killed;
}

/**
 * Forks a new worker subprocess for the given workflow file.
 * Resolves once the child sends { type: "ready" }.
 * Attaches an exit handler for auto-restart on unexpected crashes.
 */
function forkWorker(workflowId: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(
      join(__dirname, "./worker-process.js"),
      [filePath, workflowId],
      {
        cwd: join(__dirname, "../.."),
        env: {
          ...process.env,
          // Default to insecure gRPC for local Hatchet (no TLS cert).
          // Can be overridden by setting HATCHET_CLIENT_TLS_STRATEGY explicitly.
          HATCHET_CLIENT_TLS_STRATEGY:
            process.env.HATCHET_CLIENT_TLS_STRATEGY ?? "none",
          // Ensure workflow code can always reach the webhook server.
          // On Railway, PORT is set to 8080 — generated code may hardcode 3100 as fallback.
          // Setting ZYK_WEBHOOK_BASE here ensures the subprocess always uses the right port.
          ZYK_WEBHOOK_BASE:
            process.env.ZYK_WEBHOOK_BASE ??
            `http://localhost:${process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3100"}`,
          // Strip server-internal secrets so workflow code cannot exfiltrate them.
          // Workflows only need Hatchet SDK vars + user-supplied integration secrets.
          ZYK_API_KEY: undefined,
        },
        // No execArgv — workflow files are pre-compiled to .js by esbuild,
        // so no TypeScript loader is needed at worker runtime.
        // Pipe stdout+stderr so workers never write to the MCP server's stdout
        // (which would corrupt the stdio-based JSON-RPC transport).
        // Both streams are redirected to the parent's stderr for visibility.
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );

    child.stdout?.on("data", (d: Buffer) => process.stderr.write(d));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

    // Startup phase: resolve/reject based on the first IPC message
    let startupDone = false;

    const startupTimeout = setTimeout(() => {
      if (startupDone) return;
      startupDone = true;
      child.kill("SIGTERM");
      reject(new Error(`Worker for ${workflowId} did not start within ${WORKER_STARTUP_TIMEOUT_MS / 1000}s — Hatchet may be unreachable`));
    }, WORKER_STARTUP_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (startupDone) return;
      startupDone = true;
      clearTimeout(startupTimeout);
      fn();
    };

    child.once("message", (msg: { type: string; error?: string }) => {
      finish(() => {
        if (msg.type === "ready") {
          workers.set(workflowId, child);

          // Only attach the restart handler once the worker has successfully started.
          // Workers that never reach "ready" should not trigger the restart loop.
          child.on("exit", (code, signal) => {
            workers.delete(workflowId);
            if (stoppedIntentionally.has(workflowId)) return;
            console.error(
              `Worker for ${workflowId} exited unexpectedly ` +
                `(code=${code ?? "null"}, signal=${signal ?? "none"})`
            );
            scheduleRestart(workflowId, filePath);
          });

          resolve();
        } else if (msg.type === "error") {
          reject(new Error(msg.error ?? "Worker failed to start"));
        }
      });
    });

    child.once("error", (err) => {
      finish(() => reject(err));
    });

    // Startup-phase exit: worker died before sending "ready" — don't restart
    child.once("exit", () => {
      finish(() => {
        workers.delete(workflowId);
        reject(new Error(`Worker for ${workflowId} exited during startup`));
      });
    });
  });
}

function scheduleRestart(workflowId: string, filePath: string): void {
  const state = retryState.get(workflowId) ?? { count: 0 };

  if (state.count >= MAX_RETRIES) {
    console.error(
      `Worker for ${workflowId} has crashed ${MAX_RETRIES} times — giving up. ` +
        `Recreate the workflow to try again.`
    );
    retryState.delete(workflowId);
    return;
  }

  const delay = Math.min(BASE_DELAY_MS * 2 ** state.count, MAX_DELAY_MS);
  retryState.set(workflowId, { count: state.count + 1 });

  console.error(
    `Restarting worker for ${workflowId} in ${delay}ms ` +
      `(attempt ${state.count + 1}/${MAX_RETRIES})`
  );

  setTimeout(async () => {
    if (stoppedIntentionally.has(workflowId)) return;

    try {
      await forkWorker(workflowId, filePath);
      retryState.delete(workflowId); // reset on successful restart
      console.error(`Worker for ${workflowId} restarted successfully.`);
    } catch (err) {
      console.error(
        `Failed to restart worker for ${workflowId}:`,
        err instanceof Error ? err.message : err
      );
      scheduleRestart(workflowId, filePath);
    }
  }, delay);
}

export async function startWorker(
  workflowId: string,
  tsFilePath: string
): Promise<void> {
  // Stop any existing worker first
  await stopWorker(workflowId);

  // Clear intentional-stop flag and retry state so auto-restart is allowed
  stoppedIntentionally.delete(workflowId);
  retryState.delete(workflowId);

  // Compile TypeScript → ESM JavaScript before forking.
  // tsx/esm cannot dynamically import .ts files via file:// URLs on Windows,
  // so we pre-compile with esbuild and run the resulting plain .js file.
  const jsFilePath = await compileWorkflow(tsFilePath);

  await forkWorker(workflowId, jsFilePath);
}

export async function stopWorker(workflowId: string): Promise<void> {
  // Mark as intentional before killing so the exit handler doesn't restart it
  stoppedIntentionally.add(workflowId);

  const worker = workers.get(workflowId);
  if (worker && !worker.killed) {
    worker.kill("SIGTERM");
    workers.delete(workflowId);
  }
}

export async function stopAllWorkers(): Promise<void> {
  for (const [id] of workers) {
    await stopWorker(id);
  }
}

export function getRunningWorkers(): string[] {
  return Array.from(workers.keys()).filter((id) => {
    const w = workers.get(id);
    return w && !w.killed;
  });
}
