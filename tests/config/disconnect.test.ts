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

    // GEMINI.md held nothing but the managed block, so disconnect removes the
    // file rather than leaving an empty one behind.
    await expect(readFile(join(projectRoot, "GEMINI.md"), "utf-8")).rejects.toThrow();

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

    // The project MCP file existed only to hold the xtctx entry.
    await expect(
      readFile(join(projectRoot, ".cursor", "mcp.json"), "utf-8"),
    ).rejects.toThrow();

    const cursorRules = await readFile(join(projectRoot, ".cursor", "rules", "xtctx.mdc"), "utf-8");
    expect(cursorRules).toContain("User note");
    expect(cursorRules).not.toContain("<!-- xtctx:begin -->");
    expect(cursorRules).not.toContain("Generated block");
    await expect(readFile(join(projectRoot, ".cursor", "rules", "xtctx-skills", "xtctx-handoff.mdc"), "utf-8"))
      .rejects.toThrow();
  });

  it("does not leave behind files that hold nothing but xtctx scaffolding", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    await disconnectProject({ projectPath: projectRoot, homeDir, all: true, yes: true });

    // A managed file whose only content was the xtctx block, and configs that
    // now hold an empty xtctx container, are litter created by setup.
    await expect(readFile(join(projectRoot, "GEMINI.md"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(projectRoot, "opencode.json"), "utf-8")).rejects.toThrow();
    await expect(
      readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"),
    ).rejects.toThrow();
    // A rules file reduced to xtctx's own frontmatter is still an xtctx rule
    // Cursor would keep loading.
    await expect(
      readFile(join(projectRoot, ".cursor", "rules", "xtctx.mdc"), "utf-8"),
    ).rejects.toThrow();
    // --all removes the synced-skill source too, as the walkthrough claims.
    await expect(
      readFile(join(projectRoot, ".xtctx", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("labels a rewritten config as updated, not removed", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    const result = await disconnectProject({
      projectPath: projectRoot,
      homeDir,
      tool: "claude-code",
    });

    const configWrite = result.writes.find((write) => write.kind === "config");
    // config.yaml survives with tools flipped to disabled; reporting it as
    // "removed" while it is still on disk is a false statement to the user.
    expect(configWrite?.action).toBe("updated");
    await expect(
      readFile(join(projectRoot, ".xtctx", "config.yaml"), "utf-8"),
    ).resolves.toContain("enabled: false");
  });

  it("preserves CRLF user content when removing managed blocks", async () => {
    // Setup preserves the file's line endings; removal rewrote the whole file
    // as LF, so a round trip through setup + disconnect silently reformatted
    // a CRLF-authored file — against both PRODUCT.md's "byte-for-byte" claim
    // and ARCHITECTURE.md's "preserve the file's line endings".
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    const target = join(projectRoot, "CLAUDE.md");
    const existing = await readFile(target, "utf-8");
    // Two lines, so line endings are still observable once the block and the
    // separator that preceded it are gone. With a single line there is nothing
    // left to carry a line ending and the assertion below proves nothing.
    await writeFile(
      target,
      `My CRLF notes\r\nsecond line\r\n\r\n${existing.replace(/\r?\n/g, "\r\n")}`,
      "utf-8",
    );

    await disconnectProject({ projectPath: projectRoot, homeDir, tool: "claude-code" });

    const final = await readFile(target, "utf-8");
    expect(final).toContain("My CRLF notes");
    expect(final).not.toContain("<!-- xtctx:begin -->");
    expect(final.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(final)).toBe(false);
  });

  it("removes Claude Code startup hooks without touching unrelated hooks", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    // Seed a user hook group in settings.json alongside the xtctx one, plus a
    // legacy hooks.json with a foreign entry and a stale xtctx entry.
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const settingsBefore = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: { SessionStart: unknown[] };
    };
    settingsBefore.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "echo keep-user" }],
    });
    await writeFile(settingsPath, JSON.stringify(settingsBefore, null, 2), "utf-8");
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

    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = settings.hooks.SessionStart.flatMap((group) =>
      Array.isArray(group.hooks) ? group.hooks.map((hook) => hook.command) : [],
    );
    expect(commands).toContain("echo keep-user");
    expect(commands.some((command) => command.includes("xtctx --hook session-start"))).toBe(false);

    const hooks = JSON.parse(await readFile(join(projectRoot, ".claude", "hooks.json"), "utf-8")) as {
      hooks: { SessionStart: Array<{ command: string }> };
    };
    expect(hooks.hooks.SessionStart).toEqual([{ type: "command", command: "echo keep" }]);
    await expect(readFile(join(projectRoot, ".claude", "skills", "xtctx-handoff", "SKILL.md"), "utf-8"))
      .rejects.toThrow();
  });
});

/**
 * PRODUCT.md promises user content survives setup+disconnect byte for byte
 * outside the managed block. Trailing bytes were the exception: blank lines at
 * EOF were dropped, and a markdown hard break (two trailing spaces) on the
 * last line was destroyed — a silent edit to the user's own file.
 */
describe("disconnect leaves user content byte-identical", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-bytes-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-bytes-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("preserves trailing blank lines and a hard break on the last line", async () => {
    const original = "# Notes\nline one\nline two  \n\n\n";
    await writeFile(join(projectRoot, "CLAUDE.md"), original, "utf-8");

    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await disconnectProject({ projectPath: projectRoot, homeDir, all: true });

    expect(await readFile(join(projectRoot, "CLAUDE.md"), "utf-8")).toBe(original);
  });

  it("preserves a file that ends without a trailing newline", async () => {
    const original = "# Notes\nno newline at eof";
    await writeFile(join(projectRoot, "CLAUDE.md"), original, "utf-8");

    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await disconnectProject({ projectPath: projectRoot, homeDir, all: true });

    expect(await readFile(join(projectRoot, "CLAUDE.md"), "utf-8")).toBe(original);
  });
});
