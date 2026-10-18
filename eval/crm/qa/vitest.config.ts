import { defineConfig } from "vitest/config";

// Host fixture QA for the synthetic CRM contract fixtures (the root config only includes tests/**).
export default defineConfig({
  test: {
    include: ["eval/crm/qa/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
