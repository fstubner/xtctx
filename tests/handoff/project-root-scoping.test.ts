/**
 * `sessions.project_root` is written on every insert and declared in the
 * schema, and until now appeared in no `WHERE` clause. Every read returned
 * whatever the table held.
 *
 * The index lives at `<project>/.xtctx/state/xtctx.db`, so normally it only
 * ever holds one project's rows — which is why nothing noticed. But the file
 * outlives the assumption: a directory gets renamed or moved, `.xtctx/` is
 * copied into a sibling as a starting point, a worktree is created from a
 * checkout that already has one. In each case the rows describe conversations
 * belonging to a path this project is not, and they were served as its
 * context.
 *
 * This is defence in depth, not the primary boundary — the scrapers decide
 * attribution, and a row that was mis-attributed on the way in carries this
 * project's root and is not caught here. It is the cheap second check for the
 * case where the *database* is the thing that moved.
 */
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/** A scraper that yields one message, whatever project it is asked about. */
class OneMessageScraper implements ConversationScraper {
  readonly tool = "codex";

  constructor(private readonly text: string) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }

  private async *emit(): AsyncIterable<ConversationChunk> {
    yield {
      tool: "codex",
      sessionId: "scoped",
      timestamp: new Date("2026-02-24T10:00:00Z"),
      role: "user",
      content: this.text,
      metadata: { messageIndex: 0 },
    };
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(): Promise<void> {}
}

describe("reads are scoped to the project the index belongs to", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-rootscope-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function indexFor(projectRoot: string): Promise<SqliteHandoffIndex> {
    return new SqliteHandoffIndex(join(dir, "xtctx.db"), projectRoot, [
      { tool: "codex", scraper: new OneMessageScraper("belongs to the first project") },
    ]);
  }

  it("does not serve rows recorded against a different project root", async () => {
    // Fill the index as one project…
    const first = await indexFor("H:/projects/first");
    expect(await first.listRecentSessions(10)).toHaveLength(1);
    await first.close();

    // …then open the same database file as another. This is what a rename or
    // a copied `.xtctx/` looks like from here.
    const second = new SqliteHandoffIndex(join(dir, "xtctx.db"), "H:/projects/second", []);
    try {
      expect(await second.listRecentSessions(10)).toEqual([]);
      expect(await second.listIndexedSessions(10)).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("does not serve a foreign session by direct reference either", async () => {
    // The list is not the only way out of the index: `xtctx_session_detail`
    // takes a ref, and a ref is guessable from any earlier answer.
    const first = await indexFor("H:/projects/first");
    const [session] = await first.listRecentSessions(10);
    await first.close();

    const second = new SqliteHandoffIndex(join(dir, "xtctx.db"), "H:/projects/second", []);
    try {
      expect(await second.getSessionByRef(session.session_ref)).toBeNull();
      expect(await second.getSessionDetail(session.session_ref, 0, 10)).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("still serves rows written under another spelling of the same directory", async () => {
    // The dangerous direction. One directory has several legitimate
    // spellings — a symlinked path and its target, separators and case — and
    // rows written under one were read under another the moment the writer
    // canonicalised and the reader did not. Exact string equality made those
    // rows silently disappear, which looks like an empty project rather than
    // like a bug. macOS reaches this every run: its temp directory is a
    // symlink, so `/var/...` is written and `/private/var/...` is read.
    const link = join(dir, "link-to-project");
    try {
      await symlink(dir, link, "dir");
    } catch {
      await symlink(dir, link, "junction");
    }

    const viaLink = new SqliteHandoffIndex(join(dir, "xtctx.db"), link, [
      { tool: "codex", scraper: new OneMessageScraper("written through a symlink") },
    ]);
    expect(await viaLink.listRecentSessions(10)).toHaveLength(1);
    await viaLink.close();

    const viaReal = new SqliteHandoffIndex(join(dir, "xtctx.db"), await realpath(link), []);
    try {
      expect(await viaReal.listRecentSessions(10)).toHaveLength(1);
    } finally {
      await viaReal.close();
    }
  });

  it("still serves its own rows", async () => {
    // The check has to be a boundary, not an off switch.
    const first = await indexFor("H:/projects/first");
    try {
      const sessions = await first.listRecentSessions(10);
      expect(sessions).toHaveLength(1);
      const detail = await first.getSessionDetail(sessions[0].session_ref, 0, 10);
      expect(detail[0]?.content).toBe("belongs to the first project");
    } finally {
      await first.close();
    }
  });
});
