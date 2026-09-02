/**
 * Disconnecting one project emptied the machine-global Antigravity and Copilot
 * CLI configs, taking xtctx away from every other project on the machine.
 *
 * Observed live: `xtctx disconnect --all` in a throwaway trial repo, and both
 * global files went to `{"mcpServers": {}}`. It warned about Antigravity and
 * said nothing about Copilot CLI. Neither file holds a per-project entry, so
 * there is nothing project-scoped to remove there — only the whole wiring.
 *
 * So a project disconnect leaves those files alone and says so, and removing
 * xtctx from those two clients is its own explicit step: `--global-mcp`,
 * mirroring the flag `setup` uses to write them.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeDisconnectPlan, disconnectProject } from "@xtctx/config/disconnect";
import { setupProject } from "@xtctx/config/setup";

const GLOBAL_FILES = [
  join(".gemini", "antigravity", "mcp_config.json"),
  join(".copilot", "mcp-config.json"),
];

describe("disconnect and machine-global MCP configs", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-disc-global-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-disc-global-home-"));
    await setupProject({ projectPath: projectRoot, homeDir, yes: true, includeGlobalMcp: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  async function globalHasXtctx(relative: string): Promise<boolean> {
    const config = JSON.parse(await readFile(join(homeDir, relative), "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return config.mcpServers?.xtctx !== undefined;
  }

  it("leaves both global configs alone on a project disconnect", async () => {
    const result = await disconnectProject({ projectPath: projectRoot, homeDir, all: true });

    for (const relative of GLOBAL_FILES) {
      expect(await globalHasXtctx(relative), relative).toBe(true);
    }
    // And says so, naming the way to do it on purpose.
    expect(result.warnings.join("\n")).toMatch(/--global-mcp/);
    expect(result.warnings.join("\n")).not.toMatch(/was removed from the Antigravity config/);
  });

  it("leaves them alone even when the global tool is named directly", async () => {
    await disconnectProject({ projectPath: projectRoot, homeDir, tool: "antigravity" });

    expect(await globalHasXtctx(GLOBAL_FILES[0])).toBe(true);
  });

  it("removes them under --global-mcp", async () => {
    const result = await disconnectProject({
      projectPath: projectRoot,
      homeDir,
      all: true,
      globalMcp: true,
    });

    for (const relative of GLOBAL_FILES) {
      expect(await globalHasXtctx(relative), relative).toBe(false);
    }
    expect(result.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mcp:antigravity", changed: true }),
        expect.objectContaining({ kind: "mcp:copilot-cli", changed: true }),
      ]),
    );
  });

  it("does not list the global files in the plan it shows before confirming", async () => {
    // The plan is what the user reads before typing y. Listing a file the
    // disconnect will not touch is as misleading as touching one it did not list.
    const plan = describeDisconnectPlan({ projectPath: projectRoot, homeDir, all: true });
    const paths = plan.writes.map((write) => write.path);
    for (const relative of GLOBAL_FILES) {
      expect(paths).not.toContain(join(homeDir, relative));
    }
    expect(plan.warnings.join("\n")).toMatch(/--global-mcp/);

    const explicit = describeDisconnectPlan({
      projectPath: projectRoot,
      homeDir,
      all: true,
      globalMcp: true,
    });
    for (const relative of GLOBAL_FILES) {
      expect(explicit.writes.map((write) => write.path)).toContain(join(homeDir, relative));
    }
  });
});
