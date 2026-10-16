/**
 * JSON Schema for playbook manifests (structure only). Cross-references — edges, config
 * references, approvals, defaults — are checked in validate.ts.
 */

const id = { type: "string", pattern: "^[a-z][a-z0-9_]*$" };
const duration = { type: "string", pattern: "^(\\d+d)?(\\d+h)?(\\d+m)?(\\d+s)?$", minLength: 2 };
const nonEmpty = { type: "string", minLength: 1 };

const extBase = {
  label: nonEmpty,
  description: nonEmpty,
};

const extensionPoint = {
  type: "object",
  required: ["type", "label", "description", "default"],
  discriminator: { propertyName: "type" },
  oneOf: [
    {
      properties: {
        type: { const: "duration" }, ...extBase,
        default: duration, min: duration, max: duration,
      },
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: "integer" }, ...extBase,
        default: { type: "integer" }, min: { type: "integer" }, max: { type: "integer" },
      },
      additionalProperties: false,
    },
    {
      properties: { type: { const: "boolean" }, ...extBase, default: { type: "boolean" } },
      additionalProperties: false,
    },
    {
      required: ["values"],
      properties: {
        type: { const: "enum" }, ...extBase,
        values: { type: "array", items: nonEmpty, minItems: 2, uniqueItems: true },
        default: { type: "string" },
      },
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: "string_list" }, ...extBase,
        allowed: { type: "array", items: nonEmpty, minItems: 1, uniqueItems: true },
        max_items: { type: "integer", minimum: 1 },
        default: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: "text" }, ...extBase,
        max_length: { type: "integer", minimum: 1 },
        default: { type: "string" },
      },
      additionalProperties: false,
    },
    {
      required: ["variables"],
      properties: {
        type: { const: "template" }, ...extBase,
        variables: { type: "array", items: id, uniqueItems: true },
        max_length: { type: "integer", minimum: 1 },
        default: nonEmpty,
      },
      additionalProperties: false,
    },
  ],
};

const edges = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["to"],
    properties: { to: id, label: nonEmpty },
    additionalProperties: false,
  },
};

const taskStepProps = {
  title: nonEmpty,
  next: edges,
  topic: id,
  instructions: nonEmpty,
  result_schema: { type: "object" },
  allowed_tools: { type: "array", items: nonEmpty, uniqueItems: true },
  idempotency_key: nonEmpty,
  max_attempts: { type: "integer", minimum: 1, maximum: 10 },
  timeout: duration,
  irreversible: { type: "boolean" },
  requires_approval: id,
};

const step = {
  type: "object",
  required: ["kind", "title"],
  discriminator: { propertyName: "kind" },
  oneOf: [
    {
      required: ["topic", "instructions", "result_schema", "timeout", "next"],
      properties: { kind: { const: "system" }, ...taskStepProps },
      additionalProperties: false,
    },
    {
      required: ["topic", "instructions", "result_schema", "timeout", "next"],
      properties: { kind: { const: "user" }, ...taskStepProps },
      additionalProperties: false,
    },
    {
      required: ["durations", "next"],
      properties: {
        kind: { const: "wait" },
        title: nonEmpty,
        next: edges,
        durations: { type: "array", items: id, minItems: 1, uniqueItems: true },
      },
      additionalProperties: false,
    },
    {
      required: ["outcome"],
      properties: { kind: { const: "end" }, title: nonEmpty, outcome: id },
      additionalProperties: false,
    },
  ],
};

export const manifestMetaSchema = {
  type: "object",
  required: ["id", "version", "title", "description", "input_schema", "extension_points", "start", "steps"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    version: {
      type: "string",
      pattern: "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$",
    },
    title: nonEmpty,
    description: nonEmpty,
    input_schema: { type: "object" },
    untrusted_input: { type: "array", items: nonEmpty, uniqueItems: true },
    external_key: nonEmpty,
    extension_points: { type: "object", propertyNames: id, additionalProperties: extensionPoint },
    start: id,
    steps: { type: "object", propertyNames: id, minProperties: 1, additionalProperties: step },
  },
  additionalProperties: false,
} as const;
