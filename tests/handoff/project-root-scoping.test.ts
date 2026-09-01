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
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  it("re-adopts rows when the root's spelling changes", async () => {
    // What this covers, precisely: the stored root and the current one differ,
    // and a scraper still attributes the session here — so the row is
    // re-adopted rather than filtered out forever.
    //
    // What it does NOT cover, and what an earlier version of this test was
    // wrongly named for: a literal directory rename. The database half works
    // there too, but nothing re-attributes — the transcripts still record the
    // old path and every scraper keys off that — so a rename does not recover
    // history, and no test here should suggest it does. The stub scraper
    // below attributes unconditionally, which is exactly why it cannot tell
    // the two cases apart.
    //
    // The direction still matters: this is not another project leaking in, it
    // is the user's own rows going dark with the data intact in the table.
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

  it("clears scraper cursors when the index holds nothing for this project", async () => {
    // The other half of the rename fix, and the half nothing covered: the
    // repair that rebuilds is gated on a row count, and that count used to
    // ignore which project it was counting. A database full of another root's
    // rows looked populated, so the cursors were kept and the scan skipped
    // the history that would have re-attributed those sessions.
    //
    // Asserted on the cursor file, because that is the observable effect —
    // the stub scraper in the tests above writes none, which is exactly why
    // this was invisible.
    const before = join(dir, "cursors-before");
    await mkdir(before, { recursive: true });
    const cursorFile = join(dir, "codex-state.json");

    const first = new SqliteHandoffIndex(join(dir, "xtctx.db"), before, [
      { tool: "codex", scraper: new OneMessageScraper("theirs") },
    ]);
    expect(await first.listRecentSessions(10)).toHaveLength(1);
    await first.close();

    // A cursor of the kind a real scraper leaves behind, next to the index.
    await writeFile(cursorFile, JSON.stringify({ lastTimestamp: new Date().toISOString() }), "utf-8");

    // Opened as a project the index holds nothing for.
    const other = new SqliteHandoffIndex(join(dir, "xtctx.db"), join(dir, "cursors-after"), []);
    try {
      await other.listRecentSessions(10);
    } finally {
      await other.close();
    }

    expect(existsSync(cursorFile)).toBe(false);
  });

  it("keeps scraper cursors when the index does hold this project's rows", async () => {
    // The boundary: clearing on every open would make each MCP server start
    // re-read every transcript store on the machine.
    const root = join(dir, "kept");
    await mkdir(root, { recursive: true });
    const cursorFile = join(dir, "codex-state.json");

    const index = new SqliteHandoffIndex(join(dir, "xtctx.db"), root, [
      { tool: "codex", scraper: new OneMessageScraper("ours") },
    ]);
    expect(await index.listRecentSessions(10)).toHaveLength(1);
    await index.close();

    await writeFile(cursorFile, JSON.stringify({ lastTimestamp: new Date().toISOString() }), "utf-8");

    const again = new SqliteHandoffIndex(join(dir, "xtctx.db"), root, [
      { tool: "codex", scraper: new OneMessageScraper("ours") },
    ]);
    try {
      await again.listRecentSessions(10);
    } finally {
      await again.close();
    }

    expect(existsSync(cursorFile)).toBe(true);
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
