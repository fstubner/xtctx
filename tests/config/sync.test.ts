import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncToolConfigs } from "@xtctx/config/sync";

describe("syncToolConfigs", () => {
  let projectDir = "";
  let homeDir = "";
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-config-sync-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-config-sync-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await mkdir(join(projectDir, ".xtctx", "tool-config"), { recursive: true });
    await mkdir(join(projectDir, ".xtctx", "tool-config", "skills"), { recursive: true });
    await mkdir(join(projectDir, ".xtctx", "tool-config", "commands"), { recursive: true });
    await mkdir(join(projectDir, ".xtctx", "tool-config", "agents"), { recursive: true });
    await mkdir(join(projectDir, ".xtctx", "tool-config", "mcp-servers"), { recursive: true });
    await mkdir(join(projectDir, ".xtctx", "tool-config", "slash-commands"), { recursive: true });

    await writeFile(join(projectDir, ".xtctx", "tool-config", "skills", "xtctx-usage.md"), "", "utf-8");
    await writeFile(join(projectDir, ".xtctx", "tool-config", "commands", "session-start.md"), "", "utf-8");
    await writeFile(join(projectDir, ".xtctx", "tool-config", "agents", "reviewer.md"), "", "utf-8");
    await writeFile(join(projectDir, ".xtctx", "tool-config", "mcp-servers", "local.yaml"), "", "utf-8");
    await writeFile(join(projectDir, ".xtctx", "tool-config", "slash-commands", "handoff.md"), "", "utf-8");

    await writeFile(
      join(projectDir, ".xtctx", "tool-config", "shared.yaml"),
      [
        "defaults:",
        "  sync_enabled: true",
        "  categories_enabled:",
        "    - context_feed",
        "    - skills",
        "    - commands",
        "    - agents",
        "    - mcp_servers",
        "    - slash_commands",
        "    - whitelist_policy",
        "  scope: project",
        "tools:",
        "  codex:",
        "    enabled: true",
        "    scope: project",
        "    categories:",
        "      skills: true",
        "      slash_commands: false",
        "    preferences:",
        "      enforceTests: true",
        "  cursor:",
        "    enabled: true",
        "    scope: global",
        "    categories:",
        "      skills: false",
        "policy:",
        "  whitelist:",
        "    allowed_patterns:",
        "      - npm test",
        "      - npm run build",
        "    denied_patterns:",
        "      - rm -rf *",
        "    advisory_level: warn",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it("generates tool-native config files using continuity categories", async () => {
    const result = await syncToolConfigs(projectDir);
    expect(result.updated).toBeGreaterThanOrEqual(5);
    expect(result.tools.length).toBeGreaterThan(0);

    const agentsMd = await readFile(join(projectDir, "AGENTS.md"), "utf-8");
    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");

    expect(agentsMd).toContain("## Skills");
    expect(agentsMd).toContain("xtctx-usage");
    expect(agentsMd).not.toContain("## Slash commands");
    expect(agentsMd).toContain("## Whitelist policy");
    expect(claudeMd).toContain("## MCP servers");
    expect(claudeMd).toContain("local");
  });

  it("respects global scope targets", async () => {
    await syncToolConfigs(projectDir);

    const globalCursor = await readFile(
      join(homeDir, ".cursor", "rules", ".cursorrules"),
      "utf-8",
    );

    expect(globalCursor).toContain("xtctx sync");
    expect(globalCursor).not.toContain("## Skills");
  });

  it("returns per-tool state and enabled categories in sync result", async () => {
    const result = await syncToolConfigs(projectDir);
    const codex = result.tools.find((tool) => tool.tool === "codex");

    expect(codex).toBeDefined();
    expect(codex?.state).toBe("in_sync");
    expect(codex?.categories.skills).toBe(true);
    expect(codex?.categories.slash_commands).toBe(false);
    expect(codex?.categories_synced).not.toContain("slash_commands");
  });

  it("updates managed sections idempotently", async () => {
    await syncToolConfigs(projectDir);
    await syncToolConfigs(projectDir);

    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    const beginMarkerCount = (claudeMd.match(/xtctx:begin/g) ?? []).length;
    expect(beginMarkerCount).toBe(1);
  });
});
