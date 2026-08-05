import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectProject } from "@xtctx/config/disconnect";
import { setupProject } from "@xtctx/config/setup";

describe("disconnectProject", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-disconnect-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-disconnect-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("disconnects Antigravity by removing MCP, managed GEMINI.md, and disabling the tool", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    const result = await disconnectProject({
      projectPath: projectRoot,
      homeDir,
      tool: "antigravity",
    });

    expect(result.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "config", changed: true }),
        expect.objectContaining({ kind: "mcp:antigravity", changed: true }),
        expect.objectContaining({ kind: "memory", changed: true }),
      ]),
    );

    const antigravityConfig = JSON.parse(
      await readFile(join(homeDir, ".gemini", "antigravity", "mcp_config.json"), "utf-8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(antigravityConfig.mcpServers.xtctx).toBeUndefined();

    const geminiMd = await readFile(join(projectRoot, "GEMINI.md"), "utf-8");
    expect(geminiMd).not.toContain("<!-- xtctx:begin -->");

    const config = parseYaml(await readFile(join(projectRoot, ".xtctx", "config.yaml"), "utf-8")) as {
      tools: Record<string, { enabled?: boolean }>;
    };
    expect(config.tools.antigravity.enabled).toBe(false);
  });

  it("disconnects Cursor by removing project MCP and managed instruction blocks", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await writeFile(
      join(projectRoot, ".cursor", "rules", "xtctx.mdc"),
      [
        "---",
        'description: user cursor rule',
        "---",
        "",
        "<!-- xtctx:begin -->",
        "Generated block",
        "<!-- xtctx:end -->",
        "",
        "User note",
        "",
      ].join("\n"),
      "utf-8",
    );

    await disconnectProject({ projectPath: projectRoot, homeDir, tool: "cursor" });

    const mcpConfig = JSON.parse(
      await readFile(join(projectRoot, ".cursor", "mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers.xtctx).toBeUndefined();

    const cursorRules = await readFile(join(projectRoot, ".cursor", "rules", "xtctx.mdc"), "utf-8");
    expect(cursorRules).toContain("User note");
    expect(cursorRules).not.toContain("<!-- xtctx:begin -->");
    expect(cursorRules).not.toContain("Generated block");
    await expect(readFile(join(projectRoot, ".cursor", "rules", "xtctx-skills", "xtctx-handoff.mdc"), "utf-8"))
      .rejects.toThrow();
  });

  it("removes Claude Code startup hooks without touching unrelated hooks", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(
      join(projectRoot, ".claude", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { type: "command", command: "echo keep" },
              { type: "command", command: 'npx -y xtctx --hook session-start --tool claude-code --project "x"' },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await disconnectProject({ projectPath: projectRoot, homeDir, tool: "claude-code" });

    const hooks = JSON.parse(await readFile(join(projectRoot, ".claude", "hooks.json"), "utf-8")) as {
      hooks: { SessionStart: Array<{ command: string }> };
    };
    expect(hooks.hooks.SessionStart).toEqual([{ type: "command", command: "echo keep" }]);
    await expect(readFile(join(projectRoot, ".claude", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"))
      .rejects.toThrow();
  });
});
