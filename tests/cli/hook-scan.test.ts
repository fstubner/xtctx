/**
 * The session-start hook reads the index without scanning, so the first agent
 * session after another tool's work sees nothing: measured live, Codex left a
 * decision in its transcript, Claude Code opened next, and the hook printed
 * "Last scan: never" and nothing else. One MCP call later the same hook named
 * the Codex session and the agent read it unprompted.
 *
 * Waiting for a scan inside the hook would put the whole machine's history in
 * front of every startup. Launching one in the background costs the current
 * session nothing and makes the next one warm. These pin the gate around that
 * launch — the launch itself is injected, so nothing here forks a process.
 */
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_SCAN_MIN_INTERVAL_MS, runHook } from "@xtctx/cli/hook";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";

describe("session-start hook background scan", () => {
  let projectRoot = "";
  let launched: string[] = [];
  let restore: (() => void) | null = null;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-hookscan-"));
    launched = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    restore = () => {
      process.stdout.write = original;
    };
  });

  afterEach(async () => {
    restore?.();
    await rm(projectRoot, { recursive: true, force: true });
  });

  /** Opt the directory in, with every scraper switched off so nothing is read. */
  async function configure(): Promise<void> {
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    const tools = ["claude-code", "cursor", "codex", "copilot", "antigravity", "opencode", "copilot-cli"];
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      ["tools:", ...tools.flatMap((tool) => [`  ${tool}:`, "    enabled: false"]), ""].join("\n"),
      "utf-8",
    );
  }

  async function stampLastScan(at: Date): Promise<void> {
    const dbPath = join(projectRoot, ".xtctx", "state", "xtctx.db");
    const index = new SqliteHandoffIndex(dbPath, projectRoot, []);
    await index.getStatus();
    await index.close();
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO settings(key, value) VALUES ('last_scan_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(at.toISOString());
    db.close();
  }

  const hook = () =>
    runHook({
      projectPath: projectRoot,
      tool: "claude-code",
      event: "session-start",
      launchScan: (root) => {
        launched.push(root);
      },
    });

  it("launches a scan when the index has never been scanned", async () => {
    await configure();

    await hook();

    expect(launched).toHaveLength(1);
  });

  it("launches a scan when the last one is older than the interval", async () => {
    await configure();
    await stampLastScan(new Date(Date.now() - HOOK_SCAN_MIN_INTERVAL_MS - 60_000));

    await hook();

    expect(launched).toHaveLength(1);
  });

  it("does not launch when a scan finished recently", async () => {
    // Every session start would otherwise fork a scan of every store on the
    // machine; one that just finished has nothing new to find.
    await configure();
    await stampLastScan(new Date(Date.now() - 30_000));

    await hook();

    expect(launched).toEqual([]);
  });

  it("does not launch in a project nobody opted in", async () => {
    // Two clients wire xtctx machine-globally, so the hook can run anywhere.
    // Scanning would write an index into a directory that never asked for one.
    await hook();

    expect(launched).toEqual([]);
  });

  it("does not launch when the config cannot be read", async () => {
    // The config is the only place a user switches a transcript store off.
    // A scan on defaults would read stores they may have disabled.
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await writeFile(join(projectRoot, ".xtctx", "config.yaml"), "tools:\n\t- broken\n", "utf-8");

    await hook();

    expect(launched).toEqual([]);
  });
});
