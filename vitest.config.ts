import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
