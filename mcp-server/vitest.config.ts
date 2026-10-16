import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // DB-backed test files share one database; run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
