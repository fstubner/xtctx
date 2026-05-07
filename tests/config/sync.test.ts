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
        "  opencode:",
        "    enabled: true",
        "    scope: project",
        "    categories:",
        "      skills: true",
        "      slash_commands: false",
        "  copilot-cli:",
        "    enabled: true",
        "    scope: project",
        "    categories:",
        "      slash_commands: false",
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
      join(homeDir, ".cursor", "rules", "xtctx-managed.mdc"),
      "utf-8",
    );

    // .mdc rules require YAML frontmatter with `alwaysApply: true` or Cursor's
    // Agent mode silently ignores them. The legacy `.cursorrules` path was
    // dropped in favor of this new format.
    expect(globalCursor.startsWith("---\n")).toBe(true);
    expect(globalCursor).toContain("alwaysApply: true");
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

  it("does not duplicate xtctx when it is already registered in mcp-servers inventory", async () => {
    // Regression: an xtctx.md file in the mcp-servers inventory previously
    // produced two "- xtctx" lines in the rendered MCP servers section —
    // once from the inventory and once from the hardcoded footnote.
    await writeFile(
      join(projectDir, ".xtctx", "tool-config", "mcp-servers", "xtctx.md"),
      "",
      "utf-8",
    );

    await syncToolConfigs(projectDir);

    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    const mcpSection = claudeMd
      .split(/\n## /)
      .find((section) => section.startsWith("MCP servers")) ?? "";

    // Count distinct "- xtctx" (with or without annotation) occurrences
    const xtctxLineCount = (mcpSection.match(/^- xtctx(\s|$|\b)/gm) ?? []).length;
    expect(xtctxLineCount).toBe(1);

    // The annotated footnote MUST NOT appear when xtctx is in the inventory
    expect(mcpSection).not.toContain("- xtctx (required for recall/writeback continuity)");
    // Plain `- xtctx` SHOULD appear from the inventory
    expect(mcpSection).toMatch(/^- xtctx$/m);
  });

  it("appends xtctx footnote when not in mcp-servers inventory", async () => {
    // Default case: no xtctx.md in inventory — the footnote line must be added.
    await syncToolConfigs(projectDir);

    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("- xtctx (required for recall/writeback continuity)");
  });

  describe("handoff brief injection", () => {
    // Use a recent timestamp so the brief generator's default 7-day staleness
    // threshold is comfortably satisfied at test runtime.
    const recentIso = () => new Date(Date.now() - 5 * 60_000).toISOString();

    it("renders the handoff brief in CLAUDE.md when a recent session in another tool is supplied", async () => {
      const sessions = [
        {
          session_ref: "cursor:abc-123",
          tool: "cursor",
          started_at: recentIso(),
          last_activity_at: recentIso(),
          summary: "Picked jose over jsonwebtoken for auth.",
          message_count: 14,
        },
      ];

      await syncToolConfigs(projectDir, sessions);

      const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("## Last session in another tool");
      expect(claudeMd).toContain("**Tool:** Cursor");
      // The session-ref appears inside the brief, helping the agent find the
      // source transcript via xtctx_session_detail if it wants to.
      expect(claudeMd).toContain("`cursor:abc-123`");
      expect(claudeMd).toContain("Picked jose over jsonwebtoken for auth.");
    });

    it("omits the brief section when only sessions in the destination tool exist", async () => {
      // The brief should never tell tool A about its own session; it's
      // a *handoff* — only useful when sourced from a different tool.
      const claudeOnly = [
        {
          session_ref: "claude-code:xyz",
          tool: "claude-code",
          started_at: recentIso(),
          last_activity_at: recentIso(),
          summary: "Worked on auth refactor.",
          message_count: 8,
        },
      ];

      await syncToolConfigs(projectDir, claudeOnly);

      const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).not.toContain("## Last session in another tool");
    });

    it("omits the brief section when no sessions are passed at all", async () => {
      // Standalone `xtctx sync` (no running ingest daemon) calls without
      // session data; the brief degrades to empty so the section is skipped
      // rather than rendering an empty header.
      await syncToolConfigs(projectDir);

      const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).not.toContain("## Last session in another tool");
    });

    it("targets only the destination tool's brief; other tools see briefs from their own non-self sessions", async () => {
      // Two recent sessions, one in cursor and one in codex. Each
      // destination tool's managed block should contain a brief from the
      // *other* tool's session, never its own.
      const sessions = [
        {
          session_ref: "cursor:1",
          tool: "cursor",
          started_at: recentIso(),
          last_activity_at: recentIso(),
          summary: "From cursor.",
          message_count: 3,
        },
      ];

      await syncToolConfigs(projectDir, sessions);

      // CLAUDE.md (claude-code's memory file) sees the cursor brief.
      const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("**Tool:** Cursor");
      expect(claudeMd).toContain("From cursor.");

      // Cursor's own managed block (the .mdc file under .cursor/rules/)
      // should NOT contain a Cursor brief — that would be self-referential.
      const cursorMdc = await readFile(
        join(homeDir, ".cursor", "rules", "xtctx-managed.mdc"),
        "utf-8",
      );
      expect(cursorMdc).not.toContain("## Last session in another tool");
    });
  });
});
