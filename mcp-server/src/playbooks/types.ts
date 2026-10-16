/**
 * Playbook manifest types. A manifest describes a playbook version: its extension points
 * (the customizable 20%) and its step graph (the fixed backbone, used for task templates,
 * diagrams, and safety checks). Control flow itself lives in the playbook's Hatchet workflow
 * code. See docs/v2-architecture.md §9.
 */

export type JsonSchema = Record<string, unknown>;

// ── Extension points ──────────────────────────────────────────────────────────

interface ExtensionPointBase {
  label: string;
  description: string;
}

/** Durations use compact units, e.g. "30m", "4h", "1d", "1d12h". */
export interface DurationExtensionPoint extends ExtensionPointBase {
  type: "duration";
  default: string;
  min?: string;
  max?: string;
}

export interface IntegerExtensionPoint extends ExtensionPointBase {
  type: "integer";
  default: number;
  min?: number;
  max?: number;
}

export interface BooleanExtensionPoint extends ExtensionPointBase {
  type: "boolean";
  default: boolean;
}

export interface EnumExtensionPoint extends ExtensionPointBase {
  type: "enum";
  values: string[];
  default: string;
}

export interface StringListExtensionPoint extends ExtensionPointBase {
  type: "string_list";
  /** When set, every item must be one of these. */
  allowed?: string[];
  max_items?: number;
  default: string[];
}

/** Plain-language text, e.g. rules the assistant follows. */
export interface TextExtensionPoint extends ExtensionPointBase {
  type: "text";
  max_length?: number;
  default: string;
}

/** Message template with {{variable}} placeholders; only `variables` may be used. */
export interface TemplateExtensionPoint extends ExtensionPointBase {
  type: "template";
  variables: string[];
  max_length?: number;
  default: string;
}

export type ExtensionPoint =
  | DurationExtensionPoint
  | IntegerExtensionPoint
  | BooleanExtensionPoint
  | EnumExtensionPoint
  | StringListExtensionPoint
  | TextExtensionPoint
  | TemplateExtensionPoint;

export type ConfigValue = string | number | boolean | string[];
export type Config = Record<string, ConfigValue>;

// ── Steps ─────────────────────────────────────────────────────────────────────

export interface Edge {
  to: string;
  /** Short label for diagrams, e.g. "duplicate" or "approved". */
  label?: string;
}

interface StepBase {
  title: string;
  next?: Edge[];
}

/** A step the assistant performs: with tools (`system`) or by asking the human (`user`). */
export interface TaskStep extends StepBase {
  kind: "system" | "user";
  topic: string;
  /** May reference extension points as {{config.<id>}}. Never runtime data. */
  instructions: string;
  result_schema: JsonSchema;
  allowed_tools?: string[];
  /** Pattern for the idempotency key, e.g. "incident:{{external_key}}:create_issue". */
  idempotency_key?: string;
  max_attempts?: number;
  /** How long zyk waits for the task to be resolved before failing the instance. */
  timeout: string;
  /** Causes an effect outside the user's control (e.g. sends mail). Requires `requires_approval`. */
  irreversible?: boolean;
  /** User step that every path from the start to this step must pass through. */
  requires_approval?: string;
}

export interface WaitStep extends StepBase {
  kind: "wait";
  /** Duration extension points that can determine this wait. */
  durations: string[];
}

export interface EndStep {
  kind: "end";
  title: string;
  /** Recorded as the instance outcome, e.g. "resolved". */
  outcome: string;
}

export type Step = TaskStep | WaitStep | EndStep;

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface PlaybookManifest {
  id: string;
  /** Semver. Prerelease versions (e.g. 1.0.0-dev) may change; released versions may not. */
  version: string;
  title: string;
  description: string;
  /** JSON Schema for the input that starts an instance. */
  input_schema: JsonSchema;
  /** Input fields holding external text; passed to tasks only as untrusted content. */
  untrusted_input?: string[];
  /** Input field used to dedupe starts (e.g. a mail Message-ID). */
  external_key?: string;
  extension_points: Record<string, ExtensionPoint>;
  start: string;
  steps: Record<string, Step>;
}

export interface LoadedPlaybook {
  manifest: PlaybookManifest;
  /** sha256 of the canonical JSON manifest. */
  contentHash: string;
  sourcePath: string;
}
