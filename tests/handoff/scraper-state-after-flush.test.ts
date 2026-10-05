/**
 * A scraper's saved state must not reach disk before the rows it vouches for.
 *
 * Scrapers save at the end of their read: per-file cursors, and the version
 * marker that says the one-off re-read after an upgrade is done. That is
 * before the scan prunes the rows the re-read replaces and before `durable`
 * flushes the write-ahead log, and commits do not flush on their own
 * (`synchronous = NORMAL`). A power cut in between could keep the marker and
 * lose the re-read, and the old rows then sit at the very positions the
 * cursors' index probe checks, so no later scan repairs them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTool } from "@xtctx/handoff/scan";
import { openDatabase, prepareStatements } from "@xtctx/handoff/schema";
import { CLAUDE_CODE_SCRAPER_VERSION, ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { COPILOT_SCRAPER_VERSION, CopilotScraper } from "@xtctx/scrapers/copilot";
import type { ConversationScraper } from "@xtctx/types/scraper";

let root = "";
let state = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xtctx-state-after-flush-"));
  state = join(root, "state");
  await mkdir(state, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storedVersion(tool: string): Promise<number | undefined> {
  try {
    const saved = JSON.parse(await readFile(join(state, `${tool}-state.json`), "utf-8")) as {
      scraperVersion?: number;
    };
    return saved.scraperVersion;
  } catch {
    return undefined;
  }
}

/** Scans once, recording the version on disk at the moment the scan flushes. */
async function versionAtFlush(scraper: ConversationScraper): Promise<number | undefined> {
  const db = openDatabase(join(root, "xtctx.db"));
  const atFlush: Array<number | undefined> = [];
  try {
    await scanTool(scraper, {
      db,
      stmts: prepareStatements(db),
      scopedRoot: root,
      durable: async () => {
        atFlush.push(await storedVersion(scraper.tool));
      },
    });
  } finally {
    db.close();
  }
  expect(atFlush).toHaveLength(1);
  return atFlush[0];
}

describe("a scraper's saved state waits for the scan's flush", () => {
  it("claude-code: version marker and cursors", async () => {
    const projects = join(root, "projects");
    await mkdir(join(projects, "proj"), { recursive: true });
    await writeFile(
      join(projects, "proj", "sess.jsonl"),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "fix the build" },
        timestamp: "2026-02-24T10:00:00Z",
      }) + "\n",
    );

    expect(await versionAtFlush(new ClaudeCodeScraper(projects, state))).toBeUndefined();
    expect(await storedVersion("claude-code")).toBe(CLAUDE_CODE_SCRAPER_VERSION);
  });

  it("copilot: version marker, with nothing read", async () => {
    const workspaceStorage = join(root, "workspaceStorage");
    await mkdir(workspaceStorage, { recursive: true });

    expect(await versionAtFlush(new CopilotScraper(workspaceStorage, state))).toBeUndefined();
    expect(await storedVersion("copilot")).toBe(COPILOT_SCRAPER_VERSION);
  });
});
