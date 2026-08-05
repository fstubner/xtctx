import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("v9 landing content", () => {
  it("keeps onboarding, skill sync, and runtime claims aligned with the product", async () => {
    const page = await readFile(join(process.cwd(), "landing", "src", "pages", "v9.astro"), "utf-8");

    expect(page).toContain("npx -y xtctx setup");
    expect(page).toContain("Move between coding agents without starting over");
    expect(page).toContain("Skill sync");
    expect(page).toContain("Does xtctx sync skills?");
    expect(page).toContain("What are the limits?");
    expect(page).toContain("npm run demo:public");
    expect(page).toContain("Setup writes config. Tools call MCP.");
    expect(page).toContain("What setup writes");
    expect(page).toContain("Selected skills stay under .xtctx/skills");
    expect(page).toContain("The next tool gets the same project instructions");
    expect(page).toContain("xtctx_recent_sessions");
    expect(page).toContain("xtctx_session_detail");
    expect(page).toContain("xtctx_search_sessions");
    expect(page).toContain("xtctx_continuity_status");
    expect(page).toContain("xtctx_handoff_manifest");
    expect(page).toContain("Antigravity</span><span>MCP + GEMINI.md");
    expect(page).not.toContain("Raw transcripts</li>");
    expect(page).not.toContain("Semantic windows</li>");
    expect(page).not.toContain("Tool disconnect</li>");
    expect(page).not.toContain("supported startup hooks update");
    expect(page).not.toContain("startup hooks update");
    expect(page).not.toContain("—");
    expect(page).not.toContain("–");
  });
});
