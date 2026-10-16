/**
 * Manifest validation: structure (meta-schema) plus cross-reference and safety checks.
 * Returns every problem at once so a playbook author can fix them in one pass.
 */

import { Ajv } from "ajv";
import { assertValidSchema, describeAjvErrors } from "../tasks/validate.js";
import { parseDuration, templatePlaceholders, validateConfigValue } from "./config.js";
import { manifestMetaSchema } from "./meta-schema.js";
import type { PlaybookManifest, Step, TaskStep } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
const validateStructure = ajv.compile(manifestMetaSchema);

/** Placeholders allowed in idempotency key patterns. */
export const IDEMPOTENCY_PLACEHOLDERS = ["external_key", "instance_id", "iteration"];

export function validateManifest(raw: unknown): { manifest?: PlaybookManifest; problems: string[] } {
  if (!validateStructure(raw)) {
    return { problems: describeAjvErrors(validateStructure.errors ?? [], "manifest") };
  }
  const manifest = raw as unknown as PlaybookManifest;
  const problems = [
    ...checkInput(manifest),
    ...checkExtensionPoints(manifest),
    ...checkSteps(manifest),
    ...checkGraph(manifest),
    ...checkApprovals(manifest),
  ];
  return problems.length ? { problems } : { manifest, problems };
}

function checkInput(m: PlaybookManifest): string[] {
  const problems: string[] = [];
  try {
    assertValidSchema(m.input_schema);
  } catch (err) {
    problems.push(`input_schema is not a valid JSON Schema: ${(err as Error).message}`);
  }
  const props = (m.input_schema.properties ?? {}) as Record<string, unknown>;
  if (m.external_key && !(m.external_key in props)) {
    problems.push(`external_key \`${m.external_key}\` is not a property of input_schema`);
  }
  for (const field of m.untrusted_input ?? []) {
    if (!(field in props)) problems.push(`untrusted_input \`${field}\` is not a property of input_schema`);
  }
  return problems;
}

function checkExtensionPoints(m: PlaybookManifest): string[] {
  const problems: string[] = [];
  for (const [id, ext] of Object.entries(m.extension_points)) {
    for (const p of validateConfigValue(id, ext, ext.default)) problems.push(`default of ${p}`);
    if (ext.type === "duration" && ext.min && ext.max && parseDuration(ext.min)! > parseDuration(ext.max)!) {
      problems.push(`\`${id}\`: min ${ext.min} is greater than max ${ext.max}`);
    }
    if (ext.type === "integer" && ext.min !== undefined && ext.max !== undefined && ext.min > ext.max) {
      problems.push(`\`${id}\`: min ${ext.min} is greater than max ${ext.max}`);
    }
  }
  return problems;
}

function isTask(step: Step): step is TaskStep {
  return step.kind === "system" || step.kind === "user";
}

function checkSteps(m: PlaybookManifest): string[] {
  const problems: string[] = [];
  for (const [key, step] of Object.entries(m.steps)) {
    const where = `steps.${key}`;
    if (step.kind !== "end") {
      for (const edge of step.next ?? []) {
        if (!(edge.to in m.steps)) problems.push(`${where}.next references unknown step \`${edge.to}\``);
      }
    }
    if (step.kind === "wait") {
      for (const id of step.durations) {
        if (m.extension_points[id]?.type !== "duration") {
          problems.push(`${where}.durations: \`${id}\` is not a duration extension point`);
        }
      }
    }
    if (!isTask(step)) continue;

    for (const ph of templatePlaceholders(step.instructions)) {
      const id = ph.startsWith("config.") ? ph.slice("config.".length) : null;
      if (id === null) {
        problems.push(
          `${where}.instructions: {{${ph}}} is not allowed — instructions may only reference ` +
            `{{config.<extension point>}}; runtime data belongs in the task input`
        );
      } else if (!(id in m.extension_points)) {
        problems.push(`${where}.instructions: {{${ph}}} references unknown extension point \`${id}\``);
      }
    }
    if (step.idempotency_key) {
      for (const ph of templatePlaceholders(step.idempotency_key)) {
        if (!IDEMPOTENCY_PLACEHOLDERS.includes(ph)) {
          problems.push(
            `${where}.idempotency_key: {{${ph}}} is not allowed; use ${IDEMPOTENCY_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}`
          );
        }
      }
    }
    try {
      assertValidSchema(step.result_schema);
    } catch (err) {
      problems.push(`${where}.result_schema is not a valid JSON Schema: ${(err as Error).message}`);
    }
    if (step.kind === "user") {
      const required = (step.result_schema.required ?? []) as string[];
      const decision = ((step.result_schema.properties ?? {}) as Record<string, { enum?: unknown[] }>).decision;
      if (!required.includes("decision") || !Array.isArray(decision?.enum) || decision.enum.length === 0) {
        problems.push(`${where}.result_schema must require \`decision\` with an enum of allowed decisions`);
      }
    }
    if (parseDuration(step.timeout) === null) problems.push(`${where}.timeout must be a positive duration`);
    if (step.irreversible && !step.idempotency_key) {
      problems.push(`${where} is irreversible and needs an idempotency_key`);
    }
    if (step.irreversible && !step.requires_approval) {
      problems.push(`${where} is irreversible and needs requires_approval (a user step)`);
    }
    const approval = step.requires_approval ? m.steps[step.requires_approval] : undefined;
    if (step.requires_approval && approval?.kind !== "user") {
      problems.push(`${where}.requires_approval: \`${step.requires_approval}\` is not a user step`);
    }
    if (step.requires_approval && !step.approval_decisions) {
      problems.push(
        `${where} needs approval_decisions (which decisions of \`${step.requires_approval}\` allow it)`
      );
    }
    if (step.approval_decisions && !step.requires_approval) {
      problems.push(`${where}.approval_decisions requires requires_approval`);
    }
    if (approval && isTask(approval) && approval.kind === "user" && step.approval_decisions) {
      const props = (approval.result_schema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
      const allowed = props.decision?.enum ?? [];
      for (const d of step.approval_decisions) {
        if (!allowed.includes(d)) {
          problems.push(`${where}.approval_decisions: \`${d}\` is not a decision of \`${step.requires_approval}\``);
        }
      }
    }
  }
  return problems;
}

function successors(m: PlaybookManifest, key: string): string[] {
  const step = m.steps[key];
  return step && step.kind !== "end" ? (step.next ?? []).map((e) => e.to).filter((to) => to in m.steps) : [];
}

/** Steps reachable from `from`, never entering `blocked`. */
function reachable(m: PlaybookManifest, from: string, blocked?: string): Set<string> {
  const seen = new Set<string>();
  const queue = from === blocked ? [] : [from];
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key) || !(key in m.steps)) continue;
    seen.add(key);
    for (const next of successors(m, key)) if (next !== blocked) queue.push(next);
  }
  return seen;
}

function checkGraph(m: PlaybookManifest): string[] {
  const problems: string[] = [];
  const start = m.steps[m.start];
  if (!start) return [`start references unknown step \`${m.start}\``];
  if (start.kind === "end") problems.push("start must not be an end step");

  const fromStart = reachable(m, m.start);
  for (const key of Object.keys(m.steps)) {
    if (!fromStart.has(key)) problems.push(`steps.${key} is unreachable from start \`${m.start}\``);
  }
  for (const key of fromStart) {
    const canEnd = [...reachable(m, key)].some((k) => m.steps[k].kind === "end");
    if (!canEnd) problems.push(`steps.${key} cannot reach an end step`);
  }
  return problems;
}

/** Every path from start to an approval-gated step must pass through its approval step. */
function checkApprovals(m: PlaybookManifest): string[] {
  const problems: string[] = [];
  for (const [key, step] of Object.entries(m.steps)) {
    if (!isTask(step) || !step.requires_approval || !(step.requires_approval in m.steps)) continue;
    if (reachable(m, m.start, step.requires_approval).has(key)) {
      problems.push(`steps.${key} can be reached without passing its approval step \`${step.requires_approval}\``);
    }
  }
  return problems;
}
