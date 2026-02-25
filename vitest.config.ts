import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
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
