/**
 * Extension-point values: durations, value validation, effective config resolution, and
 * template rendering. Overlays (milestone 2) are maps of extension-point id → value; anything
 * else — in particular backbone changes — is not expressible.
 */

import type { Config, ConfigValue, ExtensionPoint, PlaybookManifest } from "./types.js";

// ── Durations ─────────────────────────────────────────────────────────────────

const DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** "1d12h" → 129600. Returns null for anything that is not a positive compact duration. */
export function parseDuration(value: string): number | null {
  const m = DURATION_RE.exec(value);
  if (!m || value.length === 0) return null;
  const [d, h, min, s] = m.slice(1).map((v) => (v ? parseInt(v, 10) : 0));
  const seconds = d * 86_400 + h * 3_600 + min * 60 + s;
  return seconds > 0 ? seconds : null;
}

/** 129600 → "1d12h" */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  const units: [string, number][] = [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]];
  let rest = seconds;
  for (const [unit, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join("") || "0s";
}

// ── Templates ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Placeholder names used in a template, e.g. ["reporter_name", "issue_url"]. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/** Replaces {{name}} placeholders. Throws if a placeholder has no value. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER_RE, (_, name: string) => {
    if (!(name in vars)) throw new Error(`Template variable {{${name}}} has no value`);
    return String(vars[name]);
  });
}

/** Renders step instructions; only {{config.<id>}} placeholders are allowed. */
export function renderInstructions(instructions: string, config: Config): string {
  return instructions.replace(PLACEHOLDER_RE, (_, name: string) => {
    const id = name.startsWith("config.") ? name.slice("config.".length) : null;
    if (id === null || !(id in config)) throw new Error(`Unknown instruction placeholder {{${name}}}`);
    const value = config[id];
    return Array.isArray(value) ? (value.length ? value.join(", ") : "(none)") : String(value);
  });
}

// ── Values ────────────────────────────────────────────────────────────────────

/** Problems with `value` for extension point `id`; empty when valid. */
export function validateConfigValue(id: string, ext: ExtensionPoint, value: unknown): string[] {
  const where = `\`${id}\``;
  switch (ext.type) {
    case "duration": {
      if (typeof value !== "string" || parseDuration(value) === null) {
        return [`${where} must be a duration like "30m", "4h", "2d", or "1d12h"`];
      }
      const secs = parseDuration(value)!;
      const problems: string[] = [];
      if (ext.min && secs < parseDuration(ext.min)!) problems.push(`${where} must be at least ${ext.min}`);
      if (ext.max && secs > parseDuration(ext.max)!) problems.push(`${where} must be at most ${ext.max}`);
      return problems;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return [`${where} must be a whole number`];
      const problems: string[] = [];
      if (ext.min !== undefined && value < ext.min) problems.push(`${where} must be at least ${ext.min}`);
      if (ext.max !== undefined && value > ext.max) problems.push(`${where} must be at most ${ext.max}`);
      return problems;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${where} must be true or false`];
    case "enum":
      return typeof value === "string" && ext.values.includes(value)
        ? []
        : [`${where} must be one of: ${ext.values.join(", ")}`];
    case "string_list": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return [`${where} must be a list of strings`];
      }
      const problems: string[] = [];
      if (new Set(value).size !== value.length) problems.push(`${where} must not contain duplicates`);
      if (ext.max_items !== undefined && value.length > ext.max_items) {
        problems.push(`${where} may have at most ${ext.max_items} items`);
      }
      if (ext.allowed) {
        const bad = value.filter((v) => !ext.allowed!.includes(v));
        if (bad.length) problems.push(`${where} contains ${bad.join(", ")}; allowed: ${ext.allowed.join(", ")}`);
      }
      return problems;
    }
    case "text":
      if (typeof value !== "string" || value.trim() === "") return [`${where} must be non-empty text`];
      return ext.max_length !== undefined && value.length > ext.max_length
        ? [`${where} must be at most ${ext.max_length} characters`]
        : [];
    case "template": {
      if (typeof value !== "string" || value.trim() === "") return [`${where} must be a non-empty template`];
      const problems: string[] = [];
      const unknown = templatePlaceholders(value).filter((p) => !ext.variables.includes(p));
      if (unknown.length) {
        problems.push(
          `${where} uses unknown placeholders ${unknown.map((u) => `{{${u}}}`).join(", ")}; ` +
            `available: ${ext.variables.map((v) => `{{${v}}}`).join(", ")}`
        );
      }
      if (ext.max_length !== undefined && value.length > ext.max_length) {
        problems.push(`${where} must be at most ${ext.max_length} characters`);
      }
      return problems;
    }
  }
}

export interface ResolvedConfig {
  config: Config;
  problems: string[];
}

/**
 * Effective config = extension-point defaults + overlay. Unknown keys and invalid values are
 * reported as problems (the config then holds defaults for those keys).
 */
export function resolveConfig(manifest: PlaybookManifest, overlay: Record<string, unknown> = {}): ResolvedConfig {
  const config: Config = {};
  const problems: string[] = [];
  for (const [id, ext] of Object.entries(manifest.extension_points)) {
    config[id] = ext.default as ConfigValue;
  }
  const known = Object.keys(manifest.extension_points);
  for (const [id, value] of Object.entries(overlay)) {
    const ext = manifest.extension_points[id];
    if (!ext) {
      problems.push(
        `\`${id}\` is not an extension point of ${manifest.id}; customizable fields are: ${known.join(", ")}`
      );
      continue;
    }
    const valueProblems = validateConfigValue(id, ext, value);
    if (valueProblems.length) problems.push(...valueProblems);
    else config[id] = value as ConfigValue;
  }
  return { config, problems };
}
