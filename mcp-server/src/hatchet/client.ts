import { HatchetClient as Hatchet } from "@hatchet-dev/typescript-sdk/v1/index.js";

type HatchetClientInstance = ReturnType<typeof Hatchet.init>;

let _client: HatchetClientInstance | null = null;

export function getHatchetClient(): HatchetClientInstance {
  if (!_client) {
    if (!process.env.HATCHET_CLIENT_TOKEN) {
      throw new Error(
        "HATCHET_CLIENT_TOKEN is not set. Get your token from the Hatchet dashboard."
      );
    }
    _client = Hatchet.init();
  }
  return _client;
}
