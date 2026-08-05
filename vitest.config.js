import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        // Runnable demos, exercised by hand rather than by the suite.
        "src/examples/**",
        // Test-only helper.
        "src/testHarness.ts",
        "**/*.d.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text-summary", "html"],
    },
    poolOptions: {
      forks: { execArgv: ["--experimental-eventsource"] },
    },
  },
});
