import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInHandoffSkill } from "@xtctx/config/skills";

/**
 * The `plugin/` directory is installed by cloning this repo — `agy plugin
 * install <git-url>`, `copilot plugin install`, a Cursor marketplace entry.
 * Nothing builds it on the way, so every file has to be committed, and
 * committed copies of generated content go stale silently.
 *
 * Two things go stale here, and both are invisible until a user installs the
 * plugin and gets something different from what `setup` would have given
 * them: the skill text, and the version stamped into three manifests.
 */
const PLUGIN_DIR = join(process.cwd(), "plugin");

/** Every manifest a supported client looks for, and the client that reads it. */
const MANIFESTS = [
  ["plugin.json", "Agent Plugins 1.0 — Cursor, VS Code, Copilot CLI, Antigravity"],
  [join(".claude-plugin", "plugin.json"), "Claude Code"],
  [join(".codex-plugin", "plugin.json"), "Codex"],
] as const;

/**
 * The same server entry under the three filenames the clients discover it
 * from. Claude Code and Copilot CLI read `.mcp.json` at the plugin root,
 * Cursor and VS Code read `mcp.json`, Antigravity reads `mcp_config.json`.
 */
const MCP_FILES = [".mcp.json", "mcp.json", "mcp_config.json"] as const;

describe("plugin package", () => {
  it("ships the same skill setup writes", async () => {
    const shipped = await readFile(
      join(PLUGIN_DIR, "skills", "xtctx-handoff", "SKILL.md"),
      "utf-8",
    );

    // Line endings are git's business, not this test's: a Windows checkout
    // converts the committed file to CRLF while the generator emits LF, so a
    // byte comparison fails for a difference no reader can see. Drift in the
    // text is what matters.
    const normalize = (text: string) => text.replace(/\r\n/g, "\n");

    // Run `node scripts/sync-plugin-skill.mjs` when this fails.
    expect(normalize(shipped)).toBe(normalize(builtInHandoffSkill()));
  });

  it("stamps the package version into every manifest", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };

    for (const [path] of MANIFESTS) {
      const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, path), "utf-8")) as {
        name: string;
        version: string;
      };
      expect(manifest.name, path).toBe("xtctx");
      expect(manifest.version, path).toBe(pkg.version);
    }

    // Claude Code's `plugin tag` refuses to cut a release when a plugin and
    // its enclosing marketplace entry disagree, so the marketplace has to
    // track the package too. Codex and Copilot both read this same file.
    const marketplace = JSON.parse(
      await readFile(join(process.cwd(), ".claude-plugin", "marketplace.json"), "utf-8"),
    ) as { plugins: Array<{ name: string; version: string }> };
    expect(marketplace.plugins[0].name).toBe("xtctx");
    expect(marketplace.plugins[0].version).toBe(pkg.version);
  });

  it("declares the same MCP server in every shape clients discover", async () => {
    const expected = { command: "npx", args: ["-y", "xtctx"] };

    for (const file of MCP_FILES) {
      const config = JSON.parse(await readFile(join(PLUGIN_DIR, file), "utf-8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(config.mcpServers.xtctx, file).toEqual(expected);
    }
  });
});

/**
 * The skill is instructions to an agent, so a claim in it that the server
 * refuses is worse than a wrong sentence in a README — it tells the agent to
 * keep calling tools that will not answer.
 *
 * It told them retrieval needed no setup and that a missing config affected
 * only instruction blocks, while `createToolHandlers` points every tool at
 * `notConfigured()` when no `.xtctx/config.yaml` exists. The landing page
 * carried the same wrong belief in four places.
 */
describe("the published skill's claims", () => {
  it("does not tell an agent retrieval works without setup", () => {
    const skill = builtInHandoffSkill().toLowerCase();

    expect(skill).not.toContain("no xtctx setup is required");
    expect(skill).not.toContain("retrieval tools are unaffected");
  });

  it("names the command the tools name", () => {
    expect(builtInHandoffSkill()).toContain("xtctx setup");
  });
});
