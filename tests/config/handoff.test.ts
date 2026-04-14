import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncToolConfigs } from "@xtctx/config/sync";
import { syncToolHooks } from "@xtctx/config/hooks";
import { loadSkillDefinitions, syncToolSkills } from "@xtctx/config/skills";
import { loadMcpServerDefinitions, syncToolMcpConfigs } from "@xtctx/config/mcp-config";

/**
 * Integration tests that simulate a full handoff scenario:
 * skills + MCP servers defined in .xtctx/, then synced into all tool formats.
 */
describe("cross-tool handoff integration", () => {
  let projectDir = "";
  let homeDir = "";
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-handoff-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-handoff-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    // Set up the xtctx tool-config directories
    const configRoot = join(projectDir, ".xtctx", "tool-config");
    await mkdir(join(configRoot, "skills"), { recursive: true });
    await mkdir(join(configRoot, "commands"), { recursive: true });
    await mkdir(join(configRoot, "agents"), { recursive: true });
    await mkdir(join(configRoot, "mcp-servers"), { recursive: true });
    await mkdir(join(configRoot, "slash-commands"), { recursive: true });

    // Create a skill
    await writeFile(
      join(configRoot, "skills", "foo.md"),
      "# Foo Skill\n\nDo foo things.\n\n## Steps\n1. First step\n2. Second step",
      "utf-8",
    );

    // Create an MCP server definition
    await writeFile(
      join(configRoot, "mcp-servers", "bar.json"),
      JSON.stringify({
        name: "bar",
        command: "npx",
        args: ["bar-server", "--stdio"],
        transport: "stdio",
      }),
      "utf-8",
    );

    // Write the shared policy
    await writeFile(
      join(configRoot, "shared.yaml"),
      [
        "defaults:",
        "  sync_enabled: true",
        "  categories_enabled:",
        "    - context_feed",
        "    - skills",
        "    - mcp_servers",
        "    - whitelist_policy",
        "  scope: project",
        "tools: {}",
        "policy:",
        "  whitelist:",
        "    allowed_patterns: []",
        "    denied_patterns: []",
        "    advisory_level: warn",
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

  it("sync produces correct native files for each tool", async () => {
    // Phase 1: Sync managed blocks
    const syncResult = await syncToolConfigs(projectDir);
    expect(syncResult.updated).toBeGreaterThanOrEqual(5);

    // Phase 2: Sync hooks
    const hookResults = await syncToolHooks(projectDir);
    expect(hookResults.length).toBe(5); // claude, cursor, codex, copilot, gemini

    // Phase 3: Sync skill files
    const configRoot = join(projectDir, ".xtctx", "tool-config");
    const skills = await loadSkillDefinitions(configRoot);
    const enabledTools = syncResult.tools.filter((t) => t.enabled).map((t) => t.tool);
    const skillResults = await syncToolSkills(projectDir, skills, enabledTools);

    // Phase 4: Sync MCP configs
    const mcpServers = await loadMcpServerDefinitions(configRoot);
    const mcpResults = await syncToolMcpConfigs(projectDir, mcpServers, enabledTools);

    // Verify Claude Code gets native skill file
    const claudeSkill = await readFile(
      join(projectDir, ".claude", "skills", "foo", "SKILL.md"),
      "utf-8",
    );
    expect(claudeSkill).toContain("name: foo");
    expect(claudeSkill).toContain("Do foo things.");

    // Verify Cursor gets native skill file
    const cursorSkill = await readFile(
      join(projectDir, ".cursor", "rules", "xtctx-skill-foo.mdc"),
      "utf-8",
    );
    expect(cursorSkill).toContain("alwaysApply: true");
    expect(cursorSkill).toContain("Do foo things.");

    // Verify Codex gets skill content embedded in AGENTS.md managed block
    const agentsMd = await readFile(join(projectDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("### Skill: foo");
    expect(agentsMd).toContain("Do foo things.");

    // Verify Copilot gets skill content embedded
    const copilotMd = await readFile(
      join(projectDir, ".github", "copilot-instructions.md"),
      "utf-8",
    );
    expect(copilotMd).toContain("### Skill: foo");

    // Verify Gemini gets skill content embedded
    const geminiMd = await readFile(join(projectDir, "GEMINI.md"), "utf-8");
    expect(geminiMd).toContain("### Skill: foo");

    // Verify Claude Code gets native MCP config
    const mcpJson = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpJson.mcpServers.bar).toBeDefined();

    // Verify Cursor gets native MCP config
    const cursorMcp = JSON.parse(
      await readFile(join(projectDir, ".cursor", "mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursorMcp.mcpServers.bar).toBeDefined();

    // Verify Codex/Copilot/Gemini get MCP connection details embedded
    expect(agentsMd).toContain("## MCP server connection details");
    expect(agentsMd).toContain("### bar");
  });

  it("is idempotent — double sync produces no second changes", async () => {
    const configRoot = join(projectDir, ".xtctx", "tool-config");
    const skills = await loadSkillDefinitions(configRoot);
    const mcpServers = await loadMcpServerDefinitions(configRoot);
    const enabledTools = ["claude", "cursor", "codex", "copilot", "gemini"];

    // First full sync (all four phases)
    await syncToolConfigs(projectDir);
    await syncToolHooks(projectDir);
    await syncToolSkills(projectDir, skills, enabledTools);
    await syncToolMcpConfigs(projectDir, mcpServers, enabledTools);

    // Stabilization pass — hooks append to files that sync created,
    // so a second sync reorders content. This pass settles the order.
    await syncToolConfigs(projectDir);
    await syncToolHooks(projectDir);
    await syncToolSkills(projectDir, skills, enabledTools);
    await syncToolMcpConfigs(projectDir, mcpServers, enabledTools);

    // Third pass — everything is stable now
    const syncResult3 = await syncToolConfigs(projectDir);
    expect(syncResult3.updated).toBe(0);

    const hookResults3 = await syncToolHooks(projectDir);
    for (const hook of hookResults3) {
      expect(hook.skipped).toBe(true);
    }

    const skillResults3 = await syncToolSkills(projectDir, skills, enabledTools);
    for (const skill of skillResults3.results) {
      expect(skill.skipped).toBe(true);
    }

    const mcpResults3 = await syncToolMcpConfigs(projectDir, mcpServers, enabledTools);
    for (const mcp of mcpResults3.results) {
      expect(mcp.skipped).toBe(true);
    }

    // Verify no duplicate managed blocks
    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    const beginCount = (claudeMd.match(/xtctx:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it("handoff: Claude Code and Cursor receive the same skills and MCP servers", async () => {
    await syncToolConfigs(projectDir);

    const configRoot = join(projectDir, ".xtctx", "tool-config");
    const skills = await loadSkillDefinitions(configRoot);
    const mcpServers = await loadMcpServerDefinitions(configRoot);

    await syncToolSkills(projectDir, skills, ["claude", "cursor"]);
    await syncToolMcpConfigs(projectDir, mcpServers, ["claude", "cursor"]);

    // Both should have the foo skill content
    const claudeSkill = await readFile(
      join(projectDir, ".claude", "skills", "foo", "SKILL.md"),
      "utf-8",
    );
    const cursorSkill = await readFile(
      join(projectDir, ".cursor", "rules", "xtctx-skill-foo.mdc"),
      "utf-8",
    );
    expect(claudeSkill).toContain("Do foo things.");
    expect(cursorSkill).toContain("Do foo things.");

    // Both should have the bar MCP server
    const claudeMcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, { command?: string }>;
    };
    const cursorMcp = JSON.parse(
      await readFile(join(projectDir, ".cursor", "mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, { command?: string }> };

    expect(claudeMcp.mcpServers.bar.command).toBe("npx");
    expect(cursorMcp.mcpServers.bar.command).toBe("npx");
  });

  it("hooks are generated for all five tools", async () => {
    const results = await syncToolHooks(projectDir);

    expect(results).toHaveLength(5);

    const tools = results.map((r) => r.tool).sort();
    expect(tools).toEqual(["claude", "codex", "copilot", "cursor", "gemini"]);

    // Claude gets a real hook
    const hooksJson = JSON.parse(
      await readFile(join(projectDir, ".claude", "hooks.json"), "utf-8"),
    ) as { hooks?: { SessionStart?: unknown[] } };
    expect(hooksJson.hooks?.SessionStart?.length).toBeGreaterThan(0);

    // Cursor gets a .mdc rule
    const cursorRule = await readFile(
      join(projectDir, ".cursor", "rules", "xtctx-context.mdc"),
      "utf-8",
    );
    expect(cursorRule).toContain("xtctx");

    // Codex gets a soft hook in AGENTS.md
    const agentsMd = await readFile(join(projectDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("xtctx:hooks:begin");
    expect(agentsMd).toContain("xtctx_recent_sessions");

    // Copilot gets a soft hook
    const copilotMd = await readFile(
      join(projectDir, ".github", "copilot-instructions.md"),
      "utf-8",
    );
    expect(copilotMd).toContain("xtctx:hooks:begin");

    // Gemini gets a soft hook
    const geminiMd = await readFile(join(projectDir, "GEMINI.md"), "utf-8");
    expect(geminiMd).toContain("xtctx:hooks:begin");
  });
});
