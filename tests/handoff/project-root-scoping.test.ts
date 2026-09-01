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
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
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

/**
 * Deterministic vectors, so the `vector` search mode is genuinely exercised.
 * The real provider is disabled across the suite (a 100MB ONNX model per
 * worker exhausts memory), and without a stand-in the vector query — one of
 * the two that were unscoped — would go untested.
 */
const stubEmbeddings = {
  model: "stub",
  isReady: () => true,
  async embed(): Promise<Float32Array> {
    return new Float32Array([1, 0, 0]);
  },
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0]));
  },
};

describe("reads are scoped to the project the index belongs to", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-rootscope-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function indexFor(projectRoot: string): Promise<SqliteHandoffIndex> {
    return new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      projectRoot,
      [{ tool: "codex", scraper: new OneMessageScraper("belongs to the first project") }],
      { embeddingProvider: stubEmbeddings },
    );
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

  it("does not serve another project's rows through search", async () => {
    // The read paths are six, not four. `listRecentSessions`,
    // `listIndexedSessions`, `getSessionByRef` and `getSessionDetail` were
    // scoped; `semanticSearch` and `queryKeywordUnits` were not, and both
    // already join `sessions`, so the column was in hand and unused. Search
    // returns message text and previews, so this is the read path that leaks
    // the most per call.
    const first = await indexFor("H:/projects/first");
    expect(await first.listRecentSessions(10)).toHaveLength(1);
    await first.close();

    const second = new SqliteHandoffIndex(join(dir, "xtctx.db"), "H:/projects/second", [], {
      embeddingProvider: stubEmbeddings,
    });
    try {
      for (const mode of ["keyword", "hybrid", "vector"] as const) {
        expect(await second.searchSessions("belongs", 10, undefined, mode), mode).toEqual([]);
      }
    } finally {
      await second.close();
    }
  });

  it("still finds its own rows through search", async () => {
    const first = await indexFor("H:/projects/first");
    try {
      const hits = await first.searchSessions("belongs", 10, undefined, "keyword");
      expect(hits).toHaveLength(1);
    } finally {
      await first.close();
    }
  });

  it("re-adopts its own history after the project directory is renamed", async () => {
    // The case the symlink test below does NOT reach. There both spellings
    // resolve to one directory, so the stored root already matches. A rename
    // genuinely changes the root: the rows are pinned to a path that no
    // longer exists, every read filters them out, and the scraper cursors are
    // still honoured so nothing re-adds them.
    //
    // The direction matters. This is not another project leaking in — it is
    // the user's own history going dark, reported as zero sessions with the
    // rows sitting intact in the table, recoverable only by deleting the
    // index by hand.
    const before = join(dir, "before");
    const after = join(dir, "after");
    await mkdir(before, { recursive: true });

    const first = new SqliteHandoffIndex(join(dir, "xtctx.db"), before, [
      { tool: "codex", scraper: new OneMessageScraper("history worth keeping") },
    ]);
    expect(await first.listRecentSessions(10)).toHaveLength(1);
    await first.close();

    await rename(before, after);

    const moved = new SqliteHandoffIndex(join(dir, "xtctx.db"), after, [
      { tool: "codex", scraper: new OneMessageScraper("history worth keeping") },
    ]);
    try {
      expect(await moved.listRecentSessions(10)).toHaveLength(1);
      const status = await moved.getStatus();
      expect(status.sessions).toBe(1);
      expect(status.messages).toBeGreaterThan(0);
    } finally {
      await moved.close();
    }
  });

  it("does not resurrect a renamed project's rows for an unrelated project", async () => {
    // Re-adoption must be tied to the scraper attributing the session here
    // now, not to the row simply being present. Otherwise the fix for a
    // rename becomes a way to inherit any database you are handed.
    const before = join(dir, "before2");
    await mkdir(before, { recursive: true });

    const first = new SqliteHandoffIndex(join(dir, "xtctx.db"), before, [
      { tool: "codex", scraper: new OneMessageScraper("theirs") },
    ]);
    expect(await first.listRecentSessions(10)).toHaveLength(1);
    await first.close();

    // A different project, no scrapers, so nothing re-attributes anything.
    const other = new SqliteHandoffIndex(join(dir, "xtctx.db"), join(dir, "unrelated"), []);
    try {
      expect(await other.listRecentSessions(10)).toEqual([]);
    } finally {
      await other.close();
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
