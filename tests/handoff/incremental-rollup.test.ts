/**
 * A session's count and preview land as soon as the scraper moves past it,
 * not only when the whole scan finishes.
 *
 * Seen live: the MCP server starts a scan at startup, a 22-second agent
 * session ends before the scan does, and the next session's hook finds the
 * other tool's session in the index — with "Messages: 0" and no preview,
 * because the roll-up that fills those in ran after every scraper had
 * finished. The agent ignored that bare pointer where it had followed one
 * that said what the session was about.
 *
 * Interrupted scans are the normal case for short sessions, so what a
 * partial scan leaves behind has to be usable.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * One session streaming in slowly — its second message lands over a second
 * after its first — and then a long stall before anything else. That is the
 * shape of the case that matters: the newest session is the last thing a
 * scraper reads, so nothing ever "moves past" it; only time does.
 */
class PausingScraper implements ConversationScraper {
  readonly tool = "codex";
  constructor(private readonly pauseMs: number) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield this.chunk("first", 0, "the decision only codex knows");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    yield this.chunk("first", 1, "and its reason");
    await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    yield this.chunk("second", 0, "something later");
  }
  private chunk(sessionId: string, messageIndex: number, content: string): ConversationChunk {
    return {
      tool: "codex",
      sessionId,
      timestamp: new Date(Date.parse("2026-09-02T10:00:00Z") + messageIndex * 1000),
      role: messageIndex === 0 ? "user" : "assistant",
      content,
      metadata: { messageIndex },
    };
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

describe("a partial scan leaves usable sessions behind", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-rollup-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls a session up while it is still streaming in", async () => {
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      "H:/projects/app",
      [{ tool: "codex", scraper: new PausingScraper(4_000) }],
      { refreshBudgetMs: 2_000 },
    );

    // Returns on the budget: both of "first"'s messages are in, and the
    // scraper is stalled before "second".
    await index.listRecentSessions(5);

    const first = (await index.listIndexedSessions(5)).find((s) => s.session_ref === "codex:first");
    expect(first).toBeDefined();
    expect(first?.message_count).toBe(2);
    expect(first?.preview).toContain("the decision only codex knows");
  });
});
