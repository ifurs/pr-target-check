import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/bin.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { statements: 90, branches: 82, functions: 90, lines: 90 },
    },
  },
});
