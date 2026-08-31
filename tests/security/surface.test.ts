import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CURRENT_SURFACE_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  join(".github", "copilot-instructions.md"),
  join("docs", "architecture.md"),
  join("docs", "demo.md"),
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
  /**
   * A file this list names but cannot read used to `continue`, so the check
   * passed by not running. Renaming or deleting any surface file silently
   * removed it from coverage while the gate stayed green — the failure mode a
   * gate exists to prevent. Unreadable is now a failure: the list is a claim
   * about which files describe the product, and a claim that no longer
   * resolves is wrong whichever way it broke.
   */
  it("names only files that exist", async () => {
    const missing: string[] = [];
    for (const file of CURRENT_SURFACE_FILES) {
      if ((await readOptionalFile(join(process.cwd(), file))) === null) {
        missing.push(file);
      }
    }

    expect(missing, "surface files listed but unreadable").toEqual([]);
  });

  it("does not advertise removed serve, brief, durable knowledge, or writeback tools", async () => {
    for (const file of CURRENT_SURFACE_FILES) {
      const content = await readOptionalFile(join(process.cwd(), file));
      if (content === null) {
        // Reported by the test above; skip here so one missing file does not
        // also mask which patterns the readable files still carry.
        continue;
      }

      for (const pattern of REMOVED_SURFACES) {
        expect(content, `${file} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
