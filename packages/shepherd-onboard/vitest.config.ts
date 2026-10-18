import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each end-to-end file starts its own runtime and child uploaders; keep them from competing for CPU.
    fileParallelism: false,
  },
});
