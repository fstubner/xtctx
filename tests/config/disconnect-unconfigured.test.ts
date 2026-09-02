/**
 * `disconnect` is a project-scoped command with one machine-wide side effect:
 * Antigravity keeps its MCP config at app level, so removing xtctx from it
 * removes it for every project on the machine. That is documented and
 * warned about, and it is correct when the project was actually configured.
 *
 * It is not correct when the project was never set up. A `cd` into the wrong
 * directory followed by `disconnect --all --yes` reached into the user's
 * global Antigravity config and emptied it, for a project that had nothing to
 * disconnect. The output also announced leaving `.xtctx` in place for a
 * directory that has no `.xtctx`.
 *
 * Nothing about the global config can tell you which project configured it —
 * it holds no per-project entry — so the project's own footprint is the only
 * available signal, and checking it is what makes the destructive path
 * conditional on there being something to destroy.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectProject } from "@xtctx/config/disconnect";
import { setupProject } from "@xtctx/config/setup";

const ANTIGRAVITY_REL = [".gemini", "antigravity", "mcp_config.json"];

async function readAntigravity(homeDir: string): Promise<string> {
  return readFile(join(homeDir, ...ANTIGRAVITY_REL), "utf-8").catch(() => "");
}

describe("disconnect on a project that was never configured", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-disc-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-disc-home-"));
    // A pre-existing global Antigravity config with xtctx in it, as a machine
    // that has xtctx set up in some *other* project would have.
    await mkdir(join(homeDir, ".gemini", "antigravity"), { recursive: true });
    await writeFile(
      join(homeDir, ...ANTIGRAVITY_REL),
      JSON.stringify({ mcpServers: { xtctx: { command: "npx", args: ["-y", "xtctx"] } } }, null, 2),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("leaves the global Antigravity config alone", async () => {
    await disconnectProject({ projectPath: projectRoot, all: true, homeDir });

    const after = await readAntigravity(homeDir);
    expect(after).toContain("xtctx");
  });

  it("reports that there was nothing to disconnect", async () => {
    const result = await disconnectProject({ projectPath: projectRoot, all: true, homeDir });

    // Nothing changed, and the caller is told why rather than being shown a
    // list of removals that did not happen.
    expect(result.writes.every((w) => !w.changed)).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/not configured|nothing to disconnect/i);
  });

  it("flags the project as unconfigured so the CLI can suppress its report", async () => {
    // The CLI prints "left in place <root>/.xtctx" unconditionally, which is
    // a lie for a directory that has no .xtctx. The printer needs a signal
    // from the result rather than guessing.
    const result = await disconnectProject({ projectPath: projectRoot, all: true, homeDir });

    expect(result.configured).toBe(false);
    expect(result.writes).toHaveLength(0);
  });

  it("still disconnects a project that WAS configured", async () => {
    // The guard must not break the real path — this is the case the global
    // Antigravity removal is legitimately for. That removal now also needs
    // --global-mcp, which is a separate decision (disconnect-global.test.ts).
    await setupProject({ projectPath: projectRoot, homeDir });
    expect(await readAntigravity(homeDir)).toContain("xtctx");

    const result = await disconnectProject({ projectPath: projectRoot, all: true, globalMcp: true, homeDir });

    expect(result.writes.some((w) => w.changed)).toBe(true);
    const after = JSON.parse((await readAntigravity(homeDir)) || "{}") as {
      mcpServers?: Record<string, unknown>;
    };
    expect(after.mcpServers?.xtctx).toBeUndefined();
  });
});
