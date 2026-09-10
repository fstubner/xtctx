/**
 * Re-reading a session from the top must replace its messages, not merge into
 * whatever a previous read left behind.
 *
 * Message ids hash the message index, so a message that moves position between
 * two reads is a different id and inserts alongside its old row instead of
 * upserting over it. Nothing deletes the old one, so the session ends up
 * holding the same turn twice, at two positions.
 *
 * Observed on a real index: a full re-read of one Codex session left `"do it
 * again"` at both message index 147 and 154, and `"try now"` at both 153 and
 * 160 — 13 surplus rows across the session, every one a copy of content
 * already there. Positions shifted because the re-read was done by a newer
 * scraper that reads records the previous one skipped, which is the ordinary
 * reason for a forced re-read in the first place.
 *
 * Ordinary incremental scanning is not exposed to this. Every scraper keeps
 * positions stable across a cutoff — cursor and opencode filter by timestamp
 * but still count the messages they skip, and the byte-cursor scrapers carry
 * `messageIndex` through a resume — so a message keeps its position and its
 * id from one scan to the next. What shifts positions is a read that sees a
 * different set of records than the read before it: a scraper that learned to
 * read something it used to skip, or a transcript rewritten underneath.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * Re-reads its whole conversation every scrape, ignoring the saved cursor.
 *
 * That is not a simplification for the test: `cursor` and `opencode` both work
 * exactly this way, and a forced re-read of any tool does too.
 */
class RereadingScraper implements ConversationScraper {
  readonly tool = "codex";
  saved: ScraperState = { lastTimestamp: new Date(0) };

  constructor(private chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.saved;
  }
  async saveScrapedPosition(state: ScraperState): Promise<void> {
    this.saved = state;
  }

  /** What the next scrape will yield, standing in for a re-read that sees more. */
  replaceWith(chunks: ConversationChunk[]): void {
    this.chunks = chunks;
  }
}

function chunk(index: number, content: string, at: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "rescan-session",
    timestamp: new Date(at),
    role: content.startsWith("assistant") ? "assistant" : "user",
    content,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

describe("a session re-read from the top", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-rescan-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function scanWith(scraper: ConversationScraper): Promise<void> {
    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 30_000,
    });
    await index.listRecentSessions(5);
    await index.whenScanSettled();
    await index.close();
    index = undefined;
  }

  it("does not keep a copy of a turn that moved position", async () => {
    // Positions start at 3, not 0. Every scraper advances `messageIndex` over
    // records it skips, so a real session's first *emitted* position is never
    // 0 — the nine Codex sessions on the machine that exposed this bug start
    // at 2, 3 or 5. A fixture starting at 0 passes against a prune that never
    // fires on real data, which is exactly what happened to the first version
    // of this fix.
    const scraper = new RereadingScraper([
      chunk(3, "do it again", "2026-06-18T20:15:24.000Z"),
      chunk(4, "assistant reply", "2026-06-18T20:15:34.000Z"),
    ]);

    await scanWith(scraper);

    // The re-read sees a turn the first read skipped, so everything after it
    // shifts down one. This is the ordinary reason to force a re-read.
    scraper.replaceWith([
      chunk(3, "an earlier turn the first read missed", "2026-06-18T20:15:20.000Z"),
      chunk(4, "do it again", "2026-06-18T20:15:24.000Z"),
      chunk(5, "assistant reply", "2026-06-18T20:15:34.000Z"),
    ]);

    await scanWith(scraper);

    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    const detail = await index.getSessionDetail("codex:rescan-session", 0, 50);
    const contents = detail.map((message) => message.content);

    expect(contents.filter((text) => text === "do it again")).toHaveLength(1);
    expect(contents.filter((text) => text === "assistant reply")).toHaveLength(1);
    expect(detail).toHaveLength(3);
  });

  it("still keeps everything a resumed read never saw", async () => {
    // The prune must key off "this read started at the top", not "this session
    // was touched" — a resumed read only ever sees the tail, and pruning on
    // one would delete the entire history before its resume point.
    const scraper = new RereadingScraper([
      chunk(3, "first", "2026-06-18T20:15:20.000Z"),
      chunk(4, "assistant second", "2026-06-18T20:15:24.000Z"),
    ]);

    await scanWith(scraper);

    // Yields only the tail, as a cursor-resuming scraper does.
    scraper.replaceWith([chunk(5, "third", "2026-06-18T20:15:30.000Z")]);

    await scanWith(scraper);

    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    const detail = await index.getSessionDetail("codex:rescan-session", 0, 50);

    expect(detail.map((message) => message.content)).toEqual([
      "first",
      "assistant second",
      "third",
    ]);
  });
});
