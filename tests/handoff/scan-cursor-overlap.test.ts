/**
 * A scan saves its resume cursor slightly BEHIND the newest message it read,
 * so the next scan re-reads the boundary instead of starting after it.
 *
 * Without the rewind, a message written in the same second as the newest one
 * already scanned falls in the gap: the cursor is at or past its timestamp,
 * so the next scan skips it and nothing ever comes back for it. Tools write
 * several messages a second, so this is the ordinary case, not a rare race.
 * Re-reading is free — message ids are deterministic hashes, so the overlap
 * upserts rather than duplicating.
 *
 * Nothing tested it. Found by a mutation sweep: setting the overlap to zero
 * left the unit, drift, eval and smoke suites all green, so a change that
 * silently loses messages would have shipped with a green board.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * Records the cursor it is told to save and resumes strictly after it.
 *
 * Strictly is the point. A cursor is a position already consumed, so reading
 * "everything after" it is the natural implementation — and it is what makes
 * the rewind load-bearing: without one, a message sharing a timestamp with
 * the newest message already scanned sits exactly on the cursor and is never
 * yielded again. Tools write several messages a second, so shared timestamps
 * are ordinary.
 */
class ResumingScraper implements ConversationScraper {
  readonly tool = "codex";
  saved: ScraperState = { lastTimestamp: new Date(0) };
  scrapes = 0;

  constructor(private chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    this.scrapes += 1;
    const cursor = this.saved.lastTimestamp.getTime();
    for (const chunk of this.chunks) {
      if (chunk.timestamp.getTime() > cursor) yield chunk;
    }
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

  /** A later write landing in the same second as the last one scanned. */
  append(chunk: ConversationChunk): void {
    this.chunks = [...this.chunks, chunk];
  }
}

function chunk(index: number, content: string, at: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "resume-session",
    timestamp: new Date(at),
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

describe("the resume cursor overlap", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-cursor-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("rewinds behind the newest message it read", async () => {
    const scraper = new ResumingScraper([
      chunk(0, "first", "2026-05-10T10:00:00.000Z"),
      chunk(1, "second", "2026-05-10T10:00:05.000Z"),
    ]);
    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 30_000,
    });

    await index.listRecentSessions(5);
    await index.whenScanSettled();

    // Strictly behind the newest, or a same-second write is unreachable.
    expect(scraper.saved.lastTimestamp.getTime()).toBeLessThan(
      Date.parse("2026-05-10T10:00:05.000Z"),
    );
  });

  it("still finds a message that shares a timestamp with the last one scanned", async () => {
    // The failure the overlap exists for, end to end.
    const scraper = new ResumingScraper([
      chunk(0, "first", "2026-05-10T10:00:00.000Z"),
      chunk(1, "second", "2026-05-10T10:00:05.000Z"),
    ]);
    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 30_000,
    });

    await index.listRecentSessions(5);
    await index.whenScanSettled();
    await index.close();

    // Written after the scan, stamped the same second as the newest message
    // it saw — which is where the cursor would otherwise sit.
    scraper.append(chunk(2, "the message written moments later", "2026-05-10T10:00:05.000Z"));

    index = new SqliteHandoffIndex(join(dir, "xtctx.db"), dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 30_000,
    });
    await index.listRecentSessions(5);
    await index.whenScanSettled();

    const detail = await index.getSessionDetail("codex:resume-session", 0, 20);
    expect(detail.map((message) => message.content)).toContain(
      "the message written moments later",
    );
    // And re-reading the boundary did not duplicate anything.
    expect(detail).toHaveLength(3);
  });
});
