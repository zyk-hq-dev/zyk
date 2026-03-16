/**
 * Worker process entry point — plain CommonJS, NOT compiled by Next.js.
 * Forked as a child process to run a single workflow's Hatchet worker.
 *
 * Usage: node bin/worker-process.js <filePath> <workflowId>
 */

"use strict";

const { pathToFileURL } = require("url");

const [, , filePath, workflowId] = process.argv;

if (!filePath || !workflowId) {
  process.stderr.write("Usage: worker-process.js <filePath> <workflowId>\n");
  process.exit(1);
}

async function main() {
  try {
    // Dynamically import the compiled workflow ESM module.
    const mod = await import(pathToFileURL(filePath).href);
    const workflow = mod.default;

    if (!workflow) {
      throw new Error(`Workflow module at ${filePath} has no default export`);
    }

    if (typeof workflow.start !== "function") {
      throw new Error(
        `Workflow default export does not have a start() method. Make sure to export a Hatchet worker.`
      );
    }

    // Signal ready BEFORE calling start(), because start() blocks forever
    // (it's the Hatchet gRPC poll loop). Sending after would mean the parent
    // never receives the message and startWorker() hangs indefinitely.
    if (process.send) {
      process.send({ type: "ready", workflowId });
    }

    await workflow.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Worker error: ${message}\n`);
    if (process.send) {
      process.send({ type: "error", error: message });
    }
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on("SIGTERM", () => {
  process.exit(0);
});
