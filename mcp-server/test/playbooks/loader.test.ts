import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  canonicalJson,
  compareVersions,
  hashManifest,
  loadPlaybooks,
  PlaybookCatalog,
  registerPlaybooks,
} from "../../src/playbooks/loader.js";
import type { PlaybookManifest } from "../../src/playbooks/types.js";
import { resetData, testPool } from "../helpers/db.js";
import { minimalManifest } from "./fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zyk-playbooks-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlaybook(m: PlaybookManifest, file = `${m.version}.yaml`, id = m.id): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, file), stringify(m));
}

describe("loadPlaybooks", () => {
  it("loads every version from <id>/<version>.yaml", () => {
    writePlaybook(minimalManifest());
    writePlaybook({ ...minimalManifest(), version: "1.1.0" });
    const loaded = loadPlaybooks(dir);
    expect(loaded.map((p) => p.manifest.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(loaded[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a file whose location does not match its id and version", () => {
    writePlaybook(minimalManifest(), "2.0.0.yaml");
    expect(() => loadPlaybooks(dir)).toThrow("it must live at test-playbook/1.0.0.yaml");
  });

  it("lists every problem of an invalid manifest", () => {
    const m = minimalManifest() as any; // deliberately corrupted
    m.steps.work.next = [{ to: "nowhere" }];
    m.steps.work.instructions = "{{input.body}}";
    writePlaybook(m);
    expect(() => loadPlaybooks(dir)).toThrow(/unknown step `nowhere`[\s\S]*\{\{input\.body\}\} is not allowed/);
  });

  it("reports invalid YAML", () => {
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "1.0.0.yaml"), "id: [unclosed");
    expect(() => loadPlaybooks(dir)).toThrow("invalid YAML");
  });

  it("returns nothing for a missing directory", () => {
    expect(loadPlaybooks(join(dir, "missing"))).toEqual([]);
  });
});

describe("hashing", () => {
  it("ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    const m = minimalManifest();
    const reordered = Object.fromEntries(Object.entries(m).reverse()) as unknown as PlaybookManifest;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(m)[0]);
    expect(hashManifest(reordered)).toBe(hashManifest(m));
  });
});

describe("versions", () => {
  it("orders semver with prereleases first", () => {
    const sorted = ["1.0.0", "0.9.0", "1.0.0-dev", "1.10.0", "1.2.0"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.0", "1.0.0-dev", "1.0.0", "1.2.0", "1.10.0"]);
  });

  it("catalog returns the latest or a specific version", () => {
    writePlaybook(minimalManifest());
    writePlaybook({ ...minimalManifest(), version: "1.1.0-dev" });
    const catalog = new PlaybookCatalog(loadPlaybooks(dir));
    expect(catalog.get("test-playbook")?.version).toBe("1.1.0-dev");
    expect(catalog.get("test-playbook", "1.0.0")?.version).toBe("1.0.0");
    expect(catalog.get("test-playbook", "9.9.9")).toBeUndefined();
    expect(catalog.versions("test-playbook")).toEqual(["1.0.0", "1.1.0-dev"]);
    expect(catalog.list().map((m) => m.version)).toEqual(["1.1.0-dev"]);
  });
});

describe("registerPlaybooks", () => {
  const pool = testPool();

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetData(pool);
  });

  async function storedHash(version: string): Promise<string> {
    const { rows } = await pool.query(
      "SELECT content_hash FROM playbook_versions WHERE playbook_id = 'test-playbook' AND version = $1",
      [version]
    );
    return rows[0].content_hash;
  }

  it("registers once and is idempotent", async () => {
    writePlaybook(minimalManifest());
    const loaded = loadPlaybooks(dir);
    await registerPlaybooks(pool, loaded);
    await registerPlaybooks(pool, loaded);
    expect(await storedHash("1.0.0")).toBe(loaded[0].contentHash);
  });

  it("refuses to change a released version", async () => {
    writePlaybook(minimalManifest());
    await registerPlaybooks(pool, loadPlaybooks(dir));
    const changed = minimalManifest();
    changed.title = "Changed";
    writePlaybook(changed);
    await expect(registerPlaybooks(pool, loadPlaybooks(dir))).rejects.toThrow(
      "test-playbook@1.0.0 was already released with different content"
    );
  });

  it("updates a prerelease version in place", async () => {
    writePlaybook({ ...minimalManifest(), version: "1.0.0-dev" });
    await registerPlaybooks(pool, loadPlaybooks(dir));
    writePlaybook({ ...minimalManifest(), version: "1.0.0-dev", title: "Changed" });
    const loaded = loadPlaybooks(dir);
    await registerPlaybooks(pool, loaded);
    expect(await storedHash("1.0.0-dev")).toBe(loaded[0].contentHash);
  });
});
