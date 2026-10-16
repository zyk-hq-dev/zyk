import { describe, expect, it } from "vitest";
import { assertValidSchema, validateAgainstSchema } from "../../src/tasks/validate.js";

const schema = {
  type: "object",
  required: ["issue_number", "severity"],
  additionalProperties: false,
  properties: {
    issue_number: { type: "integer" },
    severity: { enum: ["sev1", "sev2", "sev3"] },
    url: { type: "string", format: "uri" },
    labels: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  },
};

describe("validateAgainstSchema", () => {
  it("accepts a valid result", () => {
    expect(validateAgainstSchema(schema, { issue_number: 42, severity: "sev2" })).toEqual([]);
  });

  it("names missing fields", () => {
    expect(validateAgainstSchema(schema, { severity: "sev1" })).toEqual(["field `issue_number` is missing"]);
  });

  it("reports every problem at once with readable paths", () => {
    const problems = validateAgainstSchema(schema, {
      issue_number: "42",
      severity: "urgent",
      url: "not a url",
      labels: [{}],
      extra: true,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "field `issue_number` must be of type integer",
        'field `severity` must be one of: "sev1", "sev2", "sev3"',
        "field `url` must be a valid uri",
        "field `labels[0].name` is missing",
        "field `extra` is not allowed — remove it",
      ])
    );
    expect(problems).toHaveLength(5);
  });

  it("refers to the root as `result`", () => {
    expect(validateAgainstSchema(schema, "nope")).toEqual(["field `result` must be of type object"]);
  });
});

describe("assertValidSchema", () => {
  it("rejects invalid JSON Schemas", () => {
    expect(() => assertValidSchema({ type: "banana" })).toThrow();
    expect(() => assertValidSchema(schema)).not.toThrow();
  });
});
