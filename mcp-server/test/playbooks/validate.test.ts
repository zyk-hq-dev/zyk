import { describe, expect, it } from "vitest";
import { validateManifest } from "../../src/playbooks/validate.js";
import { minimalManifest } from "./fixtures.js";

/** Applies `mutate` to a fresh valid manifest and returns the problems. */
function problemsAfter(mutate: (m: any) => void): string[] {
  const m = minimalManifest();
  mutate(m);
  return validateManifest(JSON.parse(JSON.stringify(m))).problems;
}

describe("validateManifest", () => {
  it("accepts the minimal manifest", () => {
    const { manifest, problems } = validateManifest(minimalManifest());
    expect(problems).toEqual([]);
    expect(manifest?.id).toBe("test-playbook");
  });

  describe("structure", () => {
    it("reports missing fields readably", () => {
      expect(problemsAfter((m) => delete m.start)).toContain("field `start` is missing");
    });

    it("rejects unknown step kinds and fields", () => {
      expect(problemsAfter((m) => (m.steps.work.kind = "script"))).not.toEqual([]);
      expect(problemsAfter((m) => (m.steps.work.code = "rm -rf /"))).toContain(
        "field `steps.work.code` is not allowed — remove it"
      );
    });

    it("rejects malformed versions, ids, and durations", () => {
      expect(problemsAfter((m) => (m.version = "v1"))).not.toEqual([]);
      expect(problemsAfter((m) => (m.steps.work.timeout = "1 day"))).not.toEqual([]);
      expect(problemsAfter((m) => (m.extension_points["Bad-Id"] = m.extension_points.rounds))).not.toEqual([]);
    });
  });

  describe("references", () => {
    it("rejects edges to unknown steps", () => {
      expect(problemsAfter((m) => m.steps.work.next.push({ to: "nowhere" }))).toContain(
        "steps.work.next references unknown step `nowhere`"
      );
    });

    it("rejects an unknown start step", () => {
      expect(problemsAfter((m) => (m.start = "nope"))).toContain("start references unknown step `nope`");
    });

    it("only allows {{config.*}} placeholders in instructions", () => {
      expect(problemsAfter((m) => (m.steps.work.instructions = "Body: {{input.body}}"))).toContain(
        "steps.work.instructions: {{input.body}} is not allowed — instructions may only reference " +
          "{{config.<extension point>}}; runtime data belongs in the task input"
      );
      expect(problemsAfter((m) => (m.steps.work.instructions = "{{config.nope}}"))).toContain(
        "steps.work.instructions: {{config.nope}} references unknown extension point `nope`"
      );
    });

    it("restricts idempotency key placeholders", () => {
      expect(problemsAfter((m) => (m.steps.send.idempotency_key = "x:{{input.key}}"))).toContain(
        "steps.send.idempotency_key: {{input.key}} is not allowed; use {{external_key}}, {{instance_id}}, {{iteration}}"
      );
    });

    it("checks wait durations, external key, and untrusted fields", () => {
      expect(problemsAfter((m) => (m.steps.wait.durations = ["rounds"]))).toContain(
        "steps.wait.durations: `rounds` is not a duration extension point"
      );
      expect(problemsAfter((m) => (m.external_key = "missing"))).toContain(
        "external_key `missing` is not a property of input_schema"
      );
      expect(problemsAfter((m) => (m.untrusted_input = ["missing"]))).toContain(
        "untrusted_input `missing` is not a property of input_schema"
      );
    });

    it("checks extension point defaults and ranges", () => {
      expect(problemsAfter((m) => (m.extension_points.rounds.default = 9))).toContain(
        "default of `rounds` must be at most 5"
      );
      expect(problemsAfter((m) => (m.extension_points.wait_time.default = "30m"))).toContain(
        "default of `wait_time` must be at least 1h"
      );
      expect(problemsAfter((m) => (m.extension_points.rounds.min = 6))).toContain(
        "`rounds`: min 6 is greater than max 5"
      );
    });

    it("rejects invalid result schemas", () => {
      expect(problemsAfter((m) => (m.steps.work.result_schema = { type: "banana" }))[0]).toMatch(
        /^steps.work.result_schema is not a valid JSON Schema/
      );
    });

    it("requires user steps to declare their decisions", () => {
      expect(problemsAfter((m) => (m.steps.approve.result_schema = { type: "object" }))).toContain(
        "steps.approve.result_schema must require `decision` with an enum of allowed decisions"
      );
    });
  });

  describe("graph", () => {
    it("rejects unreachable steps", () => {
      expect(
        problemsAfter((m) => (m.steps.orphan = { kind: "end", title: "Orphan", outcome: "orphan" }))
      ).toContain("steps.orphan is unreachable from start `work`");
    });

    it("rejects loops that can never end", () => {
      expect(
        problemsAfter((m) => {
          m.steps.work.next = [{ to: "loop" }];
          m.steps.loop = { kind: "wait", title: "Loop", durations: ["wait_time"], next: [{ to: "work" }] };
        })
      ).toContain("steps.work cannot reach an end step");
    });
  });

  describe("approvals", () => {
    it("requires approval and an idempotency key for irreversible steps", () => {
      const problems = problemsAfter((m) => {
        delete m.steps.send.requires_approval;
        delete m.steps.send.idempotency_key;
      });
      expect(problems).toContain("steps.send is irreversible and needs requires_approval (a user step)");
      expect(problems).toContain("steps.send is irreversible and needs an idempotency_key");
    });

    it("rejects a path that bypasses the approval", () => {
      expect(problemsAfter((m) => m.steps.work.next.push({ to: "send", label: "shortcut" }))).toContain(
        "steps.send can be reached without passing its approval step `approve`"
      );
    });

    it("requires approval decisions that the approval step can produce", () => {
      expect(problemsAfter((m) => delete m.steps.send.approval_decisions)).toContain(
        "steps.send needs approval_decisions (which decisions of `approve` allow it)"
      );
      expect(problemsAfter((m) => (m.steps.send.approval_decisions = ["yes"]))).toContain(
        "steps.send.approval_decisions: `yes` is not a decision of `approve`"
      );
    });

    it("requires the approval step to be a user step", () => {
      expect(problemsAfter((m) => (m.steps.send.requires_approval = "work"))).toContain(
        "steps.send.requires_approval: `work` is not a user step"
      );
    });
  });
});
