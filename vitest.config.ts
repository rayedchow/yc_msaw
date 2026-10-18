import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "walter/tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Live/cloud checks are scripts (npm run modal:smoke, eval:live), never default tests.
    env: { PROCMEM_OFFLINE_TESTS: "1" },
  },
});
