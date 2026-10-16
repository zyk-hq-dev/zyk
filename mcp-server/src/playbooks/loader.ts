/**
 * Loads playbook manifests from `mcp-server/playbooks/<id>/<version>.yaml` and registers them in
 * the playbook_versions table. Several versions of one playbook can live side by side so that
 * running instances stay pinned to the version they started with.
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";
import type { Pool } from "../db/pool.js";
import type { LoadedPlaybook, PlaybookManifest } from "./types.js";
import { validateManifest } from "./validate.js";

/** `mcp-server/playbooks` — same relative path from src/playbooks (tsx) and dist/playbooks. */
export const PLAYBOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../playbooks");

/** JSON with sorted keys, so the hash ignores key order and YAML formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashManifest(manifest: PlaybookManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function loadPlaybookFile(path: string): LoadedPlaybook {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Playbook ${path}: invalid YAML: ${(err as Error).message}`);
  }
  const { manifest, problems } = validateManifest(raw);
  if (!manifest) {
    throw new Error(`Playbook ${path} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return { manifest, contentHash: hashManifest(manifest), sourcePath: path };
}

export function loadPlaybooks(dir: string = PLAYBOOKS_DIR): LoadedPlaybook[] {
  if (!existsSync(dir)) return [];
  const loaded: LoadedPlaybook[] = [];
  for (const id of readdirSync(dir).sort()) {
    const playbookDir = join(dir, id);
    if (!statSync(playbookDir).isDirectory()) continue;
    for (const file of readdirSync(playbookDir).filter((f) => f.endsWith(".yaml")).sort()) {
      const playbook = loadPlaybookFile(join(playbookDir, file));
      const { manifest } = playbook;
      if (manifest.id !== id || `${manifest.version}.yaml` !== file) {
        throw new Error(
          `Playbook ${playbook.sourcePath} declares ${manifest.id}@${manifest.version}; ` +
            `it must live at ${manifest.id}/${manifest.version}.yaml`
        );
      }
      loaded.push(playbook);
    }
  }
  return loaded;
}

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/** Semver comparison; a prerelease sorts before its release (1.0.0-dev < 1.0.0). */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split(/-(.*)/s);
  const [coreB, preB] = b.split(/-(.*)/s);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

/**
 * Stores each version in playbook_versions. A released version whose content changed is an
 * error (bump the version instead); prerelease versions are updated in place.
 */
export async function registerPlaybooks(pool: Pool, playbooks: LoadedPlaybook[]): Promise<void> {
  for (const { manifest, contentHash } of playbooks) {
    const { rows } = await pool.query<{ content_hash: string }>(
      `INSERT INTO playbook_versions (playbook_id, version, manifest, content_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (playbook_id, version) DO UPDATE SET playbook_id = EXCLUDED.playbook_id
       RETURNING content_hash`,
      [manifest.id, manifest.version, manifest, contentHash]
    );
    if (rows[0].content_hash === contentHash) continue;
    if (!isPrerelease(manifest.version)) {
      throw new Error(
        `Playbook ${manifest.id}@${manifest.version} was already released with different content. ` +
          "Released versions are immutable — bump the version instead."
      );
    }
    await pool.query(
      "UPDATE playbook_versions SET manifest = $3, content_hash = $4 WHERE playbook_id = $1 AND version = $2",
      [manifest.id, manifest.version, manifest, contentHash]
    );
  }
}

/** In-memory catalog of loaded playbooks. */
export class PlaybookCatalog {
  private readonly byId = new Map<string, LoadedPlaybook[]>();

  constructor(playbooks: LoadedPlaybook[]) {
    for (const p of playbooks) {
      const list = this.byId.get(p.manifest.id) ?? [];
      list.push(p);
      list.sort((a, b) => compareVersions(a.manifest.version, b.manifest.version));
      this.byId.set(p.manifest.id, list);
    }
  }

  /** Latest versions of every playbook. */
  list(): PlaybookManifest[] {
    return [...this.byId.values()].map((versions) => versions[versions.length - 1].manifest);
  }

  /** A specific version, or the latest when `version` is omitted. */
  get(id: string, version?: string): PlaybookManifest | undefined {
    const versions = this.byId.get(id);
    if (!versions) return undefined;
    if (!version) return versions[versions.length - 1].manifest;
    return versions.find((v) => v.manifest.version === version)?.manifest;
  }

  versions(id: string): string[] {
    return (this.byId.get(id) ?? []).map((v) => v.manifest.version);
  }
}
