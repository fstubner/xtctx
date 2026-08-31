import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
    // The scraper and drift suites build real SQLite databases and JSONL
    // stores on disk per case. Vitest's 5s default is comfortable locally but
    // marginal on CI runners — the opencode mutation battery came in at
    // 5392ms on windows-latest — and a timeout there reads as a product
    // failure rather than a slow machine.
    testTimeout: 30_000,
    // Turns down budgets that describe production latency rather than
    // correctness; see the file for why a fanned-out suite cannot pay them.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/**/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@xtctx": resolve(__dirname, "src"),
    },
  },
});
