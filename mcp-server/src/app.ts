import type { Pool } from "./db/pool.js";
import type { Engine } from "./engine/hatchet.js";
import type { PlaybookCatalog } from "./playbooks/loader.js";

/** Shared services for request handlers. */
export interface App {
  pool: Pool;
  catalog: PlaybookCatalog;
  /** Null until the Hatchet worker is up (or when it cannot start). */
  engine: () => Engine | null;
}
