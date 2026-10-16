import { defineConfig } from "vitest/config";

// End-to-end tests against a real Hatchet engine. Needs `docker compose up -d postgres
// hatchet-engine` and HATCHET_CLIENT_TOKEN in the environment. Durations are scaled down and
// workflows are namespaced so a running dev server on the same Hatchet tenant is not affected.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: {
      ZYK_TIME_SCALE: "0.001",
      HATCHET_CLIENT_NAMESPACE: "zyk_e2e",
      HATCHET_CLIENT_TLS_STRATEGY: "none",
      HATCHET_CLIENT_HOST_PORT: process.env.HATCHET_CLIENT_HOST_PORT ?? "localhost:7077",
    },
  },
});
