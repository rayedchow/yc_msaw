import { defineConfig } from "vitest/config";

// Donor config (askshepherd/aqueduct@b26d3f46 vitest.config.ts) plus the source-lane suites.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
  },
});
