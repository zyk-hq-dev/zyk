import type { PlaybookDefinition } from "../engine/run.js";
import { incidentTriage } from "./incident-triage/workflow.js";
import type { PlaybookCatalog } from "./loader.js";

/** Playbook code, one entry per playbook id and major version. */
export const PLAYBOOK_DEFINITIONS: PlaybookDefinition[] = [incidentTriage];

export function majorOf(version: string): number {
  return parseInt(version.split(".")[0], 10);
}

/** Hatchet workflow name for a playbook major version, e.g. incident-triage-v1. */
export function workflowName(playbookId: string, major: number): string {
  return `${playbookId}-v${major}`;
}

export function findDefinition(playbookId: string, version: string): PlaybookDefinition | undefined {
  return PLAYBOOK_DEFINITIONS.find((d) => d.id === playbookId && d.major === majorOf(version));
}

/** Every loaded manifest version needs code for its major version. */
export function assertDefinitionsFor(catalog: PlaybookCatalog): void {
  for (const manifest of catalog.list()) {
    for (const version of catalog.versions(manifest.id)) {
      if (!findDefinition(manifest.id, version)) {
        throw new Error(`No workflow code for playbook ${manifest.id}@${version} (major ${majorOf(version)})`);
      }
    }
  }
}
