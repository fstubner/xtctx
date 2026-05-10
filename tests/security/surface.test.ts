import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CURRENT_SURFACE_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  join(".github", "copilot-instructions.md"),
  join(".github", "release.yml"),
  join("docs", "architecture.md"),
  join("docs", "drift-canary.md"),
  join("docs", "security", "owasp-asvs-lite.md"),
  join("landing", "src", "data", "site.ts"),
];

const REMOVED_SURFACES = [
  /\bxtctx\s+serve\b/,
  /\bxtctx_project_knowledge\b/,
  /\bxtctx_save_decision\b/,
  /\bxtctx_save_error_solution\b/,
  /\bxtctx_save_faq\b/,
  /\bxtctx_save_insight\b/,
  /\bxtctx_last_session_brief\b/,
  /\bxtctx_search\b/,
];

describe("current product surface", () => {
  it("does not advertise removed serve, brief, durable knowledge, or writeback tools", async () => {
    for (const file of CURRENT_SURFACE_FILES) {
      const content = await readFile(join(process.cwd(), file), "utf-8");
      for (const pattern of REMOVED_SURFACES) {
        expect(content, `${file} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
