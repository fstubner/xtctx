import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf-8");
    expect(agents).toContain("xtctx Handoff");
    expect(agents).toContain("xtctx_recent_sessions");
    expect(agents).toContain("chronological transcript windows");
    expect(agents).not.toContain("xtctx_last_session_brief");
    expect(agents).not.toContain("xtctx serve");
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
      ]),
    );
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
