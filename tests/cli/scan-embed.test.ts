/**
 * `scan --embed` exists because nothing works the embedding backlog down
 * between commands, and searches only chip at it a few seconds per call —
 * measured on a live 9,232-window project, covering the corpus that way
 * needed on the order of 570 searches.
 *
 * The default matters more than the flag. The session-start hook launches
 * `scan` detached, so a scan that drained unconditionally would start hours
 * of embedding every time an agent opened a large project. That is the
 * assertion below: without the flag, nothing calls the drain at all.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScan } from "@xtctx/cli/scan";
import { setupProject } from "@xtctx/config/setup";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";

describe("xtctx scan and the embedding backlog", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-scan-embed-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-scan-embed-home-"));
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    // Every reader switched off: this asserts what the command does about
    // embedding, and left on it would read every transcript store on the
    // machine.
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      [
        "tools:",
        ...["claude-code", "cursor", "codex", "copilot", "antigravity", "opencode", "copilot-cli"].flatMap(
          (tool) => [`  ${tool}:`, "    enabled: false"],
        ),
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("does not touch the backlog without --embed", async () => {
    const drain = vi.spyOn(SqliteHandoffIndex.prototype, "embedBacklog");

    await runScan({ projectPath: projectRoot });

    expect(drain).not.toHaveBeenCalled();
  }, 60_000);

  it("drains it with --embed", async () => {
    const drain = vi.spyOn(SqliteHandoffIndex.prototype, "embedBacklog");

    await runScan({ projectPath: projectRoot, embed: true });

    expect(drain).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("refuses an unconfigured project rather than embedding into one", async () => {
    // The same refusal the plain scan makes. A flag must not become a way to
    // create an index somewhere nobody opted in.
    const bare = await mkdtemp(join(tmpdir(), "xtctx-scan-embed-bare-"));
    const drain = vi.spyOn(SqliteHandoffIndex.prototype, "embedBacklog");
    try {
      await runScan({ projectPath: bare, embed: true });

      expect(drain).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(bare, { recursive: true, force: true });
    }
  }, 60_000);
});
