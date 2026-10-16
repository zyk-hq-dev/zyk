import { describe, expect, it } from "vitest";
import {
  formatDuration,
  parseDuration,
  renderInstructions,
  renderTemplate,
  resolveConfig,
  templatePlaceholders,
  validateConfigValue,
} from "../../src/playbooks/config.js";
import type { ExtensionPoint } from "../../src/playbooks/types.js";
import { minimalManifest } from "./fixtures.js";

describe("durations", () => {
  it("parses compact durations", () => {
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("4h")).toBe(14_400);
    expect(parseDuration("1d12h")).toBe(129_600);
    expect(parseDuration("1d2h3m4s")).toBe(93_784);
  });

  it("rejects malformed or empty durations", () => {
    for (const bad of ["", "0m", "4", "h4", "4 h", "1h1d", "P1D", "-1h"]) expect(parseDuration(bad)).toBeNull();
  });

  it("formats seconds back", () => {
    expect(formatDuration(129_600)).toBe("1d12h");
    expect(formatDuration(90)).toBe("1m30s");
  });
});

describe("templates", () => {
  it("lists and renders placeholders", () => {
    const t = "Hi {{ name }}, see {{url}} ({{name}})";
    expect(templatePlaceholders(t)).toEqual(["name", "url"]);
    expect(renderTemplate(t, { name: "Ada", url: "https://x" })).toBe("Hi Ada, see https://x (Ada)");
  });

  it("refuses to render with a missing variable", () => {
    expect(() => renderTemplate("Hi {{name}}", {})).toThrow("{{name}}");
  });

  it("renders instructions from config only", () => {
    const config = { rules: "be kind", sevs: ["sev1", "sev2"], none: [] as string[] };
    expect(renderInstructions("Rules: {{config.rules}}; {{config.sevs}}; {{config.none}}", config)).toBe(
      "Rules: be kind; sev1, sev2; (none)"
    );
    expect(() => renderInstructions("{{input.body}}", config)).toThrow("{{input.body}}");
    expect(() => renderInstructions("{{config.missing}}", config)).toThrow();
  });
});

describe("validateConfigValue", () => {
  const cases: [ExtensionPoint, unknown, string[]][] = [
    [{ type: "duration", label: "l", description: "d", default: "1h", min: "15m", max: "1d" }, "2h", []],
    [{ type: "duration", label: "l", description: "d", default: "1h", min: "15m", max: "1d" }, "5m", ["`x` must be at least 15m"]],
    [{ type: "duration", label: "l", description: "d", default: "1h", max: "1d" }, "2d", ["`x` must be at most 1d"]],
    [{ type: "duration", label: "l", description: "d", default: "1h" }, "3 days", ['`x` must be a duration like "30m", "4h", "2d", or "1d12h"']],
    [{ type: "integer", label: "l", description: "d", default: 3, min: 0, max: 10 }, 11, ["`x` must be at most 10"]],
    [{ type: "integer", label: "l", description: "d", default: 3 }, 2.5, ["`x` must be a whole number"]],
    [{ type: "boolean", label: "l", description: "d", default: true }, "yes", ["`x` must be true or false"]],
    [{ type: "enum", label: "l", description: "d", values: ["a", "b"], default: "a" }, "c", ["`x` must be one of: a, b"]],
    [{ type: "string_list", label: "l", description: "d", allowed: ["sev1", "sev2"], default: [] }, ["sev1", "sev9"], ["`x` contains sev9; allowed: sev1, sev2"]],
    [{ type: "string_list", label: "l", description: "d", max_items: 1, default: [] }, ["a", "a"], ["`x` must not contain duplicates", "`x` may have at most 1 items"]],
    [{ type: "text", label: "l", description: "d", default: "t", max_length: 3 }, "long", ["`x` must be at most 3 characters"]],
    [{ type: "text", label: "l", description: "d", default: "t" }, "  ", ["`x` must be non-empty text"]],
    [
      { type: "template", label: "l", description: "d", variables: ["name"], default: "Hi {{name}}" },
      "Hi {{name}}, your {{password}}",
      ["`x` uses unknown placeholders {{password}}; available: {{name}}"],
    ],
  ];

  it.each(cases)("checks %j with %j", (ext, value, expected) => {
    expect(validateConfigValue("x", ext, value)).toEqual(expected);
  });
});

describe("resolveConfig", () => {
  it("uses defaults without an overlay", () => {
    const { config, problems } = resolveConfig(minimalManifest());
    expect(problems).toEqual([]);
    expect(config).toEqual({ wait_time: "1d", rounds: 2 });
  });

  it("applies valid overlay values", () => {
    const { config, problems } = resolveConfig(minimalManifest(), { wait_time: "5d" });
    expect(problems).toEqual([]);
    expect(config.wait_time).toBe("5d");
  });

  it("rejects anything that is not an extension point, including backbone edits", () => {
    const { config, problems } = resolveConfig(minimalManifest(), {
      steps: { work: { kind: "end" } },
      rounds: 99,
    });
    expect(problems).toEqual([
      "`steps` is not an extension point of test-playbook; customizable fields are: wait_time, rounds",
      "`rounds` must be at most 5",
    ]);
    expect(config).toEqual({ wait_time: "1d", rounds: 2 });
  });
});
