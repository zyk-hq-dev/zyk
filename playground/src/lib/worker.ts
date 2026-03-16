/**
 * Worker lifecycle manager for the playground.
 * Session-keyed: each workflow gets its own subprocess.
 */

import { ChildProcess, fork } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { build } from "esbuild";
import { emitSSE } from "./sse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;

if (!g._workers) g._workers = new Map<string, ChildProcess>();
if (!g._stoppedIntentionally) g._stoppedIntentionally = new Set<string>();
if (!g._retryState) g._retryState = new Map<string, { count: number }>();

const workers: Map<string, ChildProcess> = g._workers;
const stoppedIntentionally: Set<string> = g._stoppedIntentionally;
const retryState: Map<string, { count: number }> = g._retryState;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const WORKER_STARTUP_TIMEOUT_MS = 30_000;
const WORKER_MAX_LIFETIME_MS = 30 * 60 * 1_000; // 30 minutes

function getWorkflowDir(sessionId: string): string {
  // Must be inside the project tree so ESM import() resolution walks up to node_modules
  return join(process.cwd(), ".workflows", sessionId);
}

function saveWorkflowCode(workflowId: string, sessionId: string, code: string): string {
  const dir = getWorkflowDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${workflowId}.ts`);
  writeFileSync(filePath, code, "utf-8");
  return filePath;
}

async function compileWorkflow(tsFilePath: string): Promise<string> {
  const tsNorm = tsFilePath.replace(/\\/g, "/");
  const jsNorm = tsNorm.replace(/\.ts$/, ".js");
  await build({
    entryPoints: [tsNorm],
    outfile: jsNorm,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  return process.platform === "win32" ? jsNorm.replace(/\//g, "\\") : jsNorm;
}

/**
 * Filter and reformat raw Hatchet worker log lines.
 * Returns null for lines that should be hidden from the user.
 */
function formatWorkerLog(line: string): string | null {
  // Parse Hatchet log format: "... [LEVEL/Category] message"
  const m = line.match(/\[(\w+)\/([^\]]+)\]\s*(.+)$/);
  if (!m) return null; // stack trace lines, module warnings, etc.

  const [, level, category, message] = m;

  // ctx.log() calls from user workflow code — show as-is
  if (category === "ctx") return message.trim();

  // Worker category lines
  if (category.startsWith("Worker/")) {
    // Task started: "Worker X received action workflow:task-name:attempt"
    const actionMatch = message.match(/received action [^:]+:([^:]+):\d+/);
    if (actionMatch) return `[${actionMatch[1]}]`;

    // Task failed: "Task run <id> failed: <error message>"
    if (level === "ERROR") {
      const failedMatch = message.match(/Task run \S+ failed: (.+)/);
      if (failedMatch) return `FAILED: ${failedMatch[1]}`;
    }

    // Skip: "listening for actions", "Task run succeeded", etc.
    return null;
  }

  // Skip everything else: ActionListener, WARN, etc.
  return null;
}

function forkWorker(workflowId: string, sessionId: string, jsFilePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerProcessPath = join(process.cwd(), "bin", "worker-process.js");

    const child = fork(workerProcessPath, [jsFilePath, workflowId], {
      cwd: process.cwd(),
      env: {
        // Explicit allowlist — never inherit the full parent env.
        // ANTHROPIC_API_KEY and other server secrets are intentionally excluded.
        PATH: process.env.PATH,
        NODE_PATH: process.env.NODE_PATH,
        NODE_ENV: process.env.NODE_ENV,
        // Hatchet connection
        HATCHET_CLIENT_TOKEN: process.env.HATCHET_CLIENT_TOKEN,
        HATCHET_CLIENT_HOST_PORT: process.env.HATCHET_CLIENT_HOST_PORT ?? process.env.HATCHET_HOST_PORT,
        HATCHET_CLIENT_TLS_STRATEGY: process.env.HATCHET_CLIENT_TLS_STRATEGY ?? "none",
        // Playground-internal
        // Always use 127.0.0.1 + the actual PORT so this works regardless of
        // what ZYK_WEBHOOK_BASE is set to in the environment. On Railway and
        // other Linux hosts, 'localhost' resolves to ::1 (IPv6) which fails
        // when Next.js only listens on IPv4.
        ZYK_WEBHOOK_BASE: `http://127.0.0.1:${process.env.PORT ?? 3000}`,
        ZYK_SESSION_ID: sessionId,
        // Pre-configured API keys available to playground workflows
        TAVILY_API_KEY: process.env.TAVILY_API_KEY,
        OPENWEATHERMAP_API_KEY: process.env.OPENWEATHERMAP_API_KEY,
        NEWSAPI_API_KEY: process.env.NEWSAPI_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const pipeLog = (d: Buffer) => {
      const text = d.toString();
      process.stderr.write(d);
      for (const line of text.split("\n")) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!clean) continue;
        const formatted = formatWorkerLog(clean);
        if (formatted) emitSSE(sessionId, "worker_log", { workflowId, line: formatted });
      }
    };
    child.stdout?.on("data", pipeLog);
    child.stderr?.on("data", pipeLog);

    let startupDone = false;

    const startupTimeout = setTimeout(() => {
      if (startupDone) return;
      startupDone = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Worker for ${workflowId} did not start within ${WORKER_STARTUP_TIMEOUT_MS / 1000}s`
        )
      );
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

          // Kill worker after max lifetime to prevent runaway processes
          const lifetimeTimer = setTimeout(() => {
            if (stoppedIntentionally.has(workflowId)) return;
            console.error(`Worker for ${workflowId} reached max lifetime (${WORKER_MAX_LIFETIME_MS / 60_000}min) — stopping.`);
            emitSSE(sessionId, "worker_log", {
              workflowId,
              line: `STOPPED: Workflow reached the ${WORKER_MAX_LIFETIME_MS / 60_000}-minute playground time limit and was shut down.`,
            });
            stoppedIntentionally.add(workflowId);
            child.kill("SIGTERM");
          }, WORKER_MAX_LIFETIME_MS);
          // Don't let this timer prevent Node from exiting
          lifetimeTimer.unref();

          child.on("exit", (code, signal) => {
            workers.delete(workflowId);
            clearTimeout(lifetimeTimer);
            if (stoppedIntentionally.has(workflowId)) return;
            console.error(
              `Worker for ${workflowId} exited unexpectedly (code=${code}, signal=${signal})`
            );
            scheduleRestart(workflowId, sessionId, jsFilePath);
          });
          resolve();
        } else if (msg.type === "error") {
          reject(new Error(msg.error ?? "Worker failed to start"));
        }
      });
    });

    child.once("error", (err) => finish(() => reject(err)));
    child.once("exit", () => {
      finish(() => {
        workers.delete(workflowId);
        reject(new Error(`Worker for ${workflowId} exited during startup`));
      });
    });
  });
}

function scheduleRestart(workflowId: string, sessionId: string, jsFilePath: string): void {
  const state = retryState.get(workflowId) ?? { count: 0 };
  if (state.count >= MAX_RETRIES) {
    console.error(`Worker for ${workflowId} crashed ${MAX_RETRIES} times — giving up.`);
    retryState.delete(workflowId);
    return;
  }
  const delay = Math.min(BASE_DELAY_MS * 2 ** state.count, MAX_DELAY_MS);
  retryState.set(workflowId, { count: state.count + 1 });
  setTimeout(async () => {
    if (stoppedIntentionally.has(workflowId)) return;
    try {
      await forkWorker(workflowId, sessionId, jsFilePath);
      retryState.delete(workflowId);
    } catch (err) {
      console.error(`Failed to restart worker for ${workflowId}:`, err);
      scheduleRestart(workflowId, sessionId, jsFilePath);
    }
  }, delay);
}

export async function startWorker(
  workflowId: string,
  sessionId: string,
  code: string
): Promise<void> {
  await stopWorker(workflowId);
  stoppedIntentionally.delete(workflowId);
  retryState.delete(workflowId);
  const tsFilePath = saveWorkflowCode(workflowId, sessionId, code);
  const jsFilePath = await compileWorkflow(tsFilePath);
  await forkWorker(workflowId, sessionId, jsFilePath);
}

export async function stopWorker(workflowId: string): Promise<void> {
  stoppedIntentionally.add(workflowId);
  const worker = workers.get(workflowId);
  if (worker && !worker.killed) {
    worker.kill("SIGTERM");
    workers.delete(workflowId);
  }
}

export function isWorkerRunning(workflowId: string): boolean {
  const w = workers.get(workflowId);
  return w !== undefined && !w.killed;
}
