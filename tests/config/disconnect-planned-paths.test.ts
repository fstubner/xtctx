/**
 * The plan a disconnect shows before asking for confirmation names the file
 * it will touch for each tool. Those paths used to be restated by hand in a
 * `switch` inside disconnect.ts, separately from the table setup writes
 * from; now they are derived from that table. Deriving is only right if it
 * produces the paths users have already seen, so they are pinned here as
 * literals, not recomputed from the table — a test that consulted the table
 * would pass whatever the table said.
 *
 * Written because a deliberate wrong path for one tool left every existing
 * test green.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDisconnectPlan } from "@xtctx/config/disconnect";

// Absolute on every platform: describeDisconnectPlan resolves the project
// path, so a Windows-shaped literal lands under the runner's cwd on macOS
// and Linux and matches nothing. Nothing is written here; these are names.
const projectRoot = resolve(tmpdir(), "xtctx-planned-paths-app");
const homeDir = resolve(tmpdir(), "xtctx-planned-paths-home");

describe("planned MCP config paths", () => {
  it("names the same file for every tool as before the table took over", () => {
    const plan = describeDisconnectPlan({ projectPath: projectRoot, homeDir, all: true, globalMcp: true });
    const mcp = plan.writes
      .filter((write) => write.kind.startsWith("mcp:"))
      .map((write) => [write.kind, write.path, write.note ?? ""]);

    expect(mcp).toEqual(
      expect.arrayContaining([
        ["mcp:claude-code", join(projectRoot, ".mcp.json"), ""],
        ["mcp:cursor", join(projectRoot, ".cursor", "mcp.json"), ""],
        ["mcp:copilot", join(projectRoot, ".vscode", "mcp.json"), ""],
        ["mcp:codex", join(projectRoot, ".codex", "config.toml"), ""],
        ["mcp:opencode", join(projectRoot, "opencode.json"), ""],
        ["mcp:antigravity", join(homeDir, ".gemini", "antigravity", "mcp_config.json"), "global config"],
        ["mcp:copilot-cli", join(homeDir, ".copilot", "mcp-config.json"), "global config"],
      ]),
    );
    expect(mcp).toHaveLength(7);
  });

  it("plans no global file when there is no home to put it in", () => {
    const plan = describeDisconnectPlan({ projectPath: projectRoot, homeDir: "", all: true, globalMcp: true });
    const kinds = plan.writes.map((write) => write.kind);
    expect(kinds).not.toContain("mcp:antigravity");
    expect(kinds).not.toContain("mcp:copilot-cli");
  });
});
