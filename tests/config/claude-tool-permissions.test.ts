/**
 * Setup wires the MCP server and the SessionStart hook, and then Claude Code
 * refuses to call the tools.
 *
 * Found by running the product rather than testing it: a real Codex session
 * left a decision in its transcript, and a real Claude Code session in the
 * same repo was asked to recover it. Every xtctx tool call came back
 * "permission not granted". The agent fell back to grepping
 * `~/.codex/sessions` by hand — it got the right answer, and xtctx
 * contributed nothing to it.
 *
 * Interactively this is a prompt the user clicks through. Non-interactively —
 * CI, a subagent, any automation — it is a silent refusal, which is exactly
 * the case cross-tool handoff is for.
 *
 * There is a second gate that xtctx must NOT close: Claude Code ignores
 * `permissions.allow` entirely in a workspace the user has not trusted.
 * Trusting a workspace is the user's security decision and setup has no
 * business making it, so the tests below pin the allowlist and the docs
 * explain the trust step.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupProject } from "@xtctx/config/setup";
import { disconnectProject } from "@xtctx/config/disconnect";

/**
 * The tools an agent can call, namespaced as Claude Code addresses them —
 * under both names the same server can carry: the project `.mcp.json` entry
 * and the plugin. Seen live: with the plugin installed the agent used the
 * plugin's copy after setup, which an allowlist naming only `mcp__xtctx__`
 * would not have covered.
 */
const EXPECTED = [
  "xtctx_recent_sessions",
  "xtctx_session_detail",
  "xtctx_search_sessions",
  "xtctx_continuity_status",
  "xtctx_handoff_manifest",
].flatMap((tool) => [`mcp__xtctx__${tool}`, `mcp__plugin_xtctx_xtctx__${tool}`]);

interface ClaudeSettings {
  hooks?: { SessionStart?: unknown[] };
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown;
}

describe("claude code tool permissions", () => {
  let root = "";
  let home = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-perms-"));
    home = await mkdtemp(join(tmpdir(), "xtctx-perms-home-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function settings(): Promise<ClaudeSettings> {
    return JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf-8"),
    ) as ClaudeSettings;
  }

  it("allows every tool it registers", async () => {
    await setupProject({ projectPath: root, homeDir: home, yes: true });

    const allow = (await settings()).permissions?.allow ?? [];
    for (const tool of EXPECTED) {
      expect(allow, tool).toContain(tool);
    }
  });

  it("does not duplicate the entries on a second run", async () => {
    await setupProject({ projectPath: root, homeDir: home, yes: true });
    await setupProject({ projectPath: root, homeDir: home, yes: true });

    const allow = (await settings()).permissions?.allow ?? [];
    for (const tool of EXPECTED) {
      expect(allow.filter((entry) => entry === tool), tool).toHaveLength(1);
    }
  });

  it("adds them to a project whose hook is already installed", async () => {
    // The upgrade path, and the one an early return would miss: every project
    // set up before this change already has the hook, so a check that stops
    // once the hook is present would never grant the permissions.
    await setupProject({ projectPath: root, homeDir: home, yes: true });
    const path = join(root, ".claude", "settings.json");
    const withoutPermissions = (await settings()) as ClaudeSettings;
    delete withoutPermissions.permissions;
    await writeFile(path, `${JSON.stringify(withoutPermissions, null, 2)}\n`, "utf-8");

    await setupProject({ projectPath: root, homeDir: home, yes: true });

    expect((await settings()).permissions?.allow ?? []).toEqual(
      expect.arrayContaining(EXPECTED),
    );
  });

  it("leaves the user's own permissions alone", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf /)"] },
          model: "opus",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await setupProject({ projectPath: root, homeDir: home, yes: true });

    const after = await settings();
    expect(after.permissions?.allow).toContain("Bash(npm test)");
    expect(after.permissions?.deny).toEqual(["Bash(rm -rf /)"]);
    expect(after.model).toBe("opus");
  });

  it("removes its own entries on disconnect and keeps the user's", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2)}\n`,
      "utf-8",
    );
    await setupProject({ projectPath: root, homeDir: home, yes: true });

    await disconnectProject({ projectPath: root, homeDir: home, all: true });

    const after = await settings().catch(() => ({}) as ClaudeSettings);
    const allow = after.permissions?.allow ?? [];
    for (const tool of EXPECTED) {
      expect(allow, tool).not.toContain(tool);
    }
    // Removing xtctx must not take the user's rules with it.
    if (after.permissions) {
      expect(allow).toContain("Bash(npm test)");
    }
  });

  /**
   * Disconnect filters by xtctx's own list, not by the `mcp__` prefix the
   * entries happen to share.
   *
   * The distinction is invisible in a project whose only other rule is a Bash
   * one — the test above passes either way. Prefix removal is the plausible
   * "simplification", and it silently deletes every grant the user holds for
   * every *other* MCP server: GitHub, Playwright, whatever else they wired up.
   * Those are not xtctx's to touch, and nothing tells the user they went.
   */
  it("leaves other MCP servers' permissions alone on disconnect", async () => {
    const foreign = [
      "mcp__github__create_issue",
      "mcp__plugin_playwright_playwright__browser_click",
    ];
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { allow: [...foreign, "Bash(npm test)"] } }, null, 2)}\n`,
      "utf-8",
    );
    await setupProject({ projectPath: root, homeDir: home, yes: true });

    await disconnectProject({ projectPath: root, homeDir: home, all: true });

    const allow = (await settings().catch(() => ({}) as ClaudeSettings)).permissions?.allow ?? [];
    for (const tool of EXPECTED) {
      expect(allow, tool).not.toContain(tool);
    }
    for (const entry of foreign) {
      expect(allow, entry).toContain(entry);
    }
  });
});
