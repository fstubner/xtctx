import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeSetupPlan, setupProject } from "@xtctx/config/setup";

describe("setupProject", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-setup-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-setup-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("writes the greenfield setup surfaces with npx -y xtctx MCP config", async () => {
    const result = await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    expect(result.configPath).toBe(join(projectRoot, ".xtctx", "config.yaml"));
    const mcpConfig = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8")) as {
      mcpServers: { xtctx: { command: string; args: string[] } };
    };
    expect(mcpConfig.mcpServers.xtctx).toMatchObject({
      command: "npx",
      args: ["-y", "xtctx"],
    });
    await expect(readFile(join(projectRoot, ".codex", "config.toml"), "utf-8")).resolves.toContain(
      'args = [ "-y", "xtctx" ]',
    );
    await expect(
      readFile(join(homeDir, ".gemini", "antigravity", "mcp_config.json"), "utf-8"),
    ).resolves.toContain('"xtctx"');

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf-8");
    expect(agents).toContain("xtctx Handoff");
    expect(agents).toContain("xtctx_recent_sessions");
    expect(agents).toContain("chronological transcript windows");
    expect(agents).toContain("Synced Skills");
    expect(agents).toContain("xtctx-handoff");
    expect(agents).not.toContain("xtctx_last_session_brief");
    expect(agents).not.toContain("xtctx serve");
    expect(agents).not.toContain("real startup hooks");

    await expect(readFile(join(projectRoot, ".xtctx", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"))
      .resolves.toContain("name: xtctx-handoff");
    await expect(readFile(join(projectRoot, ".claude", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"))
      .resolves.toContain("xtctx_recent_sessions");
    await expect(readFile(join(projectRoot, ".cursor", "rules", "xtctx-skills", "xtctx-handoff.mdc"), "utf-8"))
      .resolves.toContain("xtctx:skill-hash");
    await expect(
      readFile(join(projectRoot, ".github", "instructions", "xtctx-xtctx-handoff.instructions.md"), "utf-8"),
    ).resolves.toContain("xtctx:skill-hash");
    await expect(readFile(join(projectRoot, "GEMINI.md"), "utf-8")).resolves.toContain("Tool: antigravity");
    await expect(
      readFile(join(projectRoot, ".gemini", "extensions", "xtctx-xtctx-handoff", "GEMINI.md"), "utf-8"),
    ).rejects.toThrow();

    const config = parseYaml(await readFile(join(projectRoot, ".xtctx", "config.yaml"), "utf-8")) as {
      skills: { selected: Record<string, { hash: string }>; targets: Record<string, { mode: string }> };
      tools: Record<string, unknown>;
    };
    expect(config.skills.selected["xtctx-handoff"].hash).toMatch(/^sha256:/);
    expect(config.skills.targets["claude-code"].mode).toBe("native-skill");
    expect(config.skills.targets.antigravity.mode).toBe("managed-block");
    expect(config.tools.gemini).toBeUndefined();
  });

  it("describes planned writes before setup applies them", () => {
    const plan = describeSetupPlan(projectRoot);

    expect(plan.projectRoot).toBe(projectRoot);
    expect(plan.writes.map((write) => write.kind)).toEqual(
      expect.arrayContaining([
        "config",
        "mcp:codex",
        "memory:codex/opencode",
        "hook:claude-code",
        "skill-source:xtctx-handoff",
        "skill:claude-code:xtctx-handoff",
      ]),
    );
  });

  it("writes Copilot CLI global MCP only when explicitly requested", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await expect(readFile(join(homeDir, ".copilot", "mcp-config.json"), "utf-8")).rejects.toThrow();

    await setupProject({ projectPath: projectRoot, homeDir, yes: true, includeGlobalMcp: true });

    const copilotCliConfig = JSON.parse(
      await readFile(join(homeDir, ".copilot", "mcp-config.json"), "utf-8"),
    ) as { mcpServers: { xtctx: { command: string; args: string[] } } };
    expect(copilotCliConfig.mcpServers.xtctx).toMatchObject({
      command: "npx",
      args: ["-y", "xtctx"],
    });

    const plan = describeSetupPlan(projectRoot, undefined, true);
    expect(plan.writes.map((write) => write.kind)).toContain("mcp:copilot-cli");
  });

  it("imports only selected discovered skills during setup", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "review-notes"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "review-notes", "SKILL.md"),
      [
        "---",
        "name: review-notes",
        "description: Preserve review notes across coding tools.",
        "---",
        "",
        "# Review Notes",
        "",
        "Read recent reviewer feedback before making changes.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await mkdir(join(homeDir, ".claude", "skills", "unselected"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "unselected", "SKILL.md"),
      [
        "---",
        "name: unselected",
        "description: This skill should not be imported unless selected.",
        "---",
        "",
        "# Unselected",
        "",
      ].join("\n"),
      "utf-8",
    );

    await setupProject({
      projectPath: projectRoot,
      homeDir,
      yes: true,
      selectedSkillIds: ["review-notes"],
    });

    await expect(readFile(join(projectRoot, ".xtctx", "skills", "review-notes", "SKILL.md"), "utf-8"))
      .resolves.toContain("Review Notes");
    await expect(readFile(join(projectRoot, ".xtctx", "skills", "unselected", "SKILL.md"), "utf-8"))
      .rejects.toThrow();
  });

  it("keeps --yes conservative when external skills are present", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "external-skill"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "external-skill", "SKILL.md"),
      [
        "---",
        "name: external-skill",
        "description: This skill should not be imported by non-interactive setup.",
        "---",
        "",
        "# External Skill",
        "",
      ].join("\n"),
      "utf-8",
    );

    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    await expect(readFile(join(projectRoot, ".xtctx", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"))
      .resolves.toContain("xtctx Handoff");
    await expect(readFile(join(projectRoot, ".xtctx", "skills", "external-skill", "SKILL.md"), "utf-8"))
      .rejects.toThrow();
  });

  it("repairs duplicated stale managed blocks idempotently", async () => {
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await mkdir(join(projectRoot, ".xtctx", ".store", "lancedb"), { recursive: true });
    await writeFile(join(projectRoot, ".xtctx", "state", "xtctx.db"), "legacy", "utf-8");
    await writeFile(
      join(projectRoot, ".xtctx", ".store", "lancedb", "legacy"),
      "legacy",
      "utf-8",
    );
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      [
        "# User Notes",
        "",
        "<!-- xtctx:begin -->",
        "xtctx_search xtctx_project_knowledge xtctx_save_decision",
        "<!-- xtctx:end -->",
        "",
        "<!-- xtctx:begin -->",
        "xtctx serve",
        "<!-- xtctx:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await setupProject({ projectPath: projectRoot, homeDir, yes: true, repair: true });
    await setupProject({ projectPath: projectRoot, homeDir, yes: true, repair: true });

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf-8");
    expect(agents).toContain("# User Notes");
    expect(agents.match(/<!-- xtctx:begin -->/g)).toHaveLength(1);
    expect(agents).not.toMatch(/\bxtctx_search\b/);
    expect(agents).not.toContain("xtctx_project_knowledge");
    expect(agents).not.toContain("xtctx_save_decision");
    expect(agents).not.toContain("xtctx serve");
    await expect(readFile(join(projectRoot, ".xtctx", "state", "xtctx.db"), "utf-8")).rejects.toThrow();
    await expect(
      readFile(join(projectRoot, ".xtctx", ".store", "lancedb", "legacy"), "utf-8"),
    ).rejects.toThrow();
  });
});
