import type { PlaybookManifest } from "../../src/playbooks/types.js";

/**
 * Smallest valid manifest with a user approval gating an irreversible step:
 *   work → approve → send → wait → done
 *            └─ reject → done
 */
export function minimalManifest(): PlaybookManifest {
  return {
    id: "test-playbook",
    version: "1.0.0",
    title: "Test playbook",
    description: "Used by tests.",
    input_schema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" }, body: { type: "string" } },
    },
    untrusted_input: ["body"],
    external_key: "key",
    extension_points: {
      wait_time: { type: "duration", label: "Wait", description: "How long to wait", default: "1d", min: "1h" },
      rounds: { type: "integer", label: "Rounds", description: "Rounds", default: 2, min: 0, max: 5 },
    },
    start: "work",
    steps: {
      work: {
        kind: "system",
        title: "Do work",
        topic: "github",
        timeout: "1d",
        instructions: "Work for {{config.rounds}} rounds.",
        result_schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
        next: [{ to: "approve" }],
      },
      approve: {
        kind: "user",
        title: "Approve?",
        topic: "inbox",
        timeout: "7d",
        instructions: "Ask the user.",
        result_schema: {
          type: "object",
          required: ["decision"],
          properties: { decision: { enum: ["send", "reject"] } },
        },
        next: [
          { to: "send", label: "send" },
          { to: "done", label: "reject" },
        ],
      },
      send: {
        kind: "system",
        title: "Send",
        topic: "gmail",
        timeout: "1d",
        irreversible: true,
        requires_approval: "approve",
        idempotency_key: "test:{{external_key}}:send",
        instructions: "Send it.",
        result_schema: { type: "object" },
        next: [{ to: "wait" }],
      },
      wait: { kind: "wait", title: "Wait", durations: ["wait_time"], next: [{ to: "done" }] },
      done: { kind: "end", title: "Done", outcome: "done" },
    },
  };
}
