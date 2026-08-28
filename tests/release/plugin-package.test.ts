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

    // Run `node scripts/sync-plugin-skill.mjs` when this fails.
    expect(shipped).toBe(builtInHandoffSkill());
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
