import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncToolHooks } from "@xtctx/config/hooks";

describe("syncToolHooks", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-hooks-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("generates a Claude hooks.json with the xtctx context command", async () => {
    const results = await syncToolHooks(projectDir);

    const claude = results.find((r) => r.tool === "claude");
    expect(claude).toBeDefined();
    expect(claude?.created || claude?.updated).toBe(true);

    const hooksPath = join(projectDir, ".claude", "hooks.json");
    const raw = await readFile(hooksPath, "utf-8");
    const parsed = JSON.parse(raw) as { hooks?: { SessionStart?: unknown[] } };
    const sessionStart = parsed.hooks?.SessionStart ?? [];
    expect(sessionStart.length).toBeGreaterThan(0);
  });

  it("includes the project path in the generated command", async () => {
    await syncToolHooks(projectDir);

    const hooksPath = join(projectDir, ".claude", "hooks.json");
    const raw = await readFile(hooksPath, "utf-8");
    const parsed = JSON.parse(raw) as { hooks?: { SessionStart?: Array<{ command?: string }> } };
    const entry = (parsed.hooks?.SessionStart ?? [])[0];
    expect(entry?.command).toContain("xtctx context --project");
  });

  it("quotes paths that contain spaces (C4 — shell injection fix)", async () => {
    // Create a temp dir whose name contains a space to simulate a real-world
    // project path like "My Projects/myapp".
    const spacedDir = await mkdtemp(join(tmpdir(), "xtctx hooks spacey "));
    try {
      const results = await syncToolHooks(spacedDir);
      const claude = results.find((r) => r.tool === "claude");
      expect(claude?.warning).toBeUndefined();

      const hooksPath = join(spacedDir, ".claude", "hooks.json");
      const raw = await readFile(hooksPath, "utf-8");
      const parsed = JSON.parse(raw) as { hooks?: { SessionStart?: Array<{ command?: string }> } };
      const command = (parsed.hooks?.SessionStart ?? [])[0]?.command ?? "";

      // The path must be wrapped in double quotes so shells don't split on spaces.
      expect(command).toMatch(/--project ".*"/);
    } finally {
      await rm(spacedDir, { recursive: true, force: true });
    }
  });

  it("is idempotent — does not duplicate hooks on re-run", async () => {
    await syncToolHooks(projectDir);
    const second = await syncToolHooks(projectDir);

    const claude = second.find((r) => r.tool === "claude");
    expect(claude?.skipped).toBe(true);

    const hooksPath = join(projectDir, ".claude", "hooks.json");
    const raw = await readFile(hooksPath, "utf-8");
    const parsed = JSON.parse(raw) as { hooks?: { SessionStart?: unknown[] } };
    const sessionStart = parsed.hooks?.SessionStart ?? [];
    // Only one xtctx entry should exist after two runs.
    const xtctxEntries = (sessionStart as Array<{ command?: string }>).filter(
      (e) => e.command?.includes("xtctx context"),
    );
    expect(xtctxEntries.length).toBe(1);
  });
});
