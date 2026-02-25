import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { syncToolConfigs } from "@xtctx/config/sync";

describe("syncToolConfigs", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-config-sync-"));
    await mkdir(join(projectDir, ".xtctx", "tool-config"), { recursive: true });
    await writeFile(
      join(projectDir, ".xtctx", "tool-config", "shared.yaml"),
      [
        "shared:",
        "  skills:",
        "    - xtctx-search",
        "    - debugging-playbook",
        "  commands:",
        "    - npm test",
        "    - npm run build",
        "  agents:",
        "    - reviewer",
        "toolPreferences:",
        "  claude-code:",
        "    alwaysCallRecentSessions: true",
        "  codex:",
        "    enforceTests: true",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("generates tool-native config files", async () => {
    const result = await syncToolConfigs(projectDir);
    expect(result.updated).toBeGreaterThanOrEqual(4);

    const cursorRules = await readFile(join(projectDir, ".cursorrules"), "utf-8");
    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    const agentsMd = await readFile(join(projectDir, "AGENTS.md"), "utf-8");
    const copilot = await readFile(
      join(projectDir, ".github", "copilot-instructions.md"),
      "utf-8",
    );

    expect(cursorRules).toContain("xtctx-search");
    expect(claudeMd).toContain("xtctx-search");
    expect(agentsMd).toContain("reviewer");
    expect(copilot).toContain("npm test");
  });

  it("updates managed sections idempotently", async () => {
    await syncToolConfigs(projectDir);
    await syncToolConfigs(projectDir);

    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    const beginMarkerCount = (claudeMd.match(/xtctx:begin/g) ?? []).length;
    expect(beginMarkerCount).toBe(1);
  });
});
