/**
 * Hatchet client singleton — survives HMR restarts by living on global.
 */

import { Hatchet } from "@hatchet-dev/typescript-sdk";

type HatchetInstance = ReturnType<typeof Hatchet.init>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;

export function getHatchetClient(): HatchetInstance {
  if (!g._hatchetClient) {
    if (!process.env.HATCHET_CLIENT_TOKEN) {
      throw new Error("HATCHET_CLIENT_TOKEN is not set.");
    }
    g._hatchetClient = Hatchet.init();
  }
  return g._hatchetClient as HatchetInstance;
}
