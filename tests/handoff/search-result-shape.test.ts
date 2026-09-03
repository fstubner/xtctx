/**
 * What a search result actually contains: how many windows a session shows,
 * and how much of each window is read out of the database.
 *
 * Both are governed by constants that a mutation sweep found no suite
 * defended — not the unit tests, not the eval, not drift, not smoke. Capping
 * matches at one, or truncating the source read to a single character, left
 * every one of them green. They are worth pinning because both are the
 * agent-visible shape of an answer: too few matches and the caller cannot see
 * why a session was returned; too little content and the preview it reads is
 * a fragment of a sentence.
 *
 * These assert the contract, not the numbers themselves — a deliberate change
 * to either constant should not have to come here, but silently losing the
 * behaviour should.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class FixtureScraper implements ConversationScraper {
  readonly tool = "codex";

  constructor(private readonly chunks: ConversationChunk[]) {}

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
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

function chunk(index: number, content: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "shape-session",
    timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + index * 1000),
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

describe("the shape of a search result", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-shape-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("shows several matching windows for one session, not just the best", async () => {
    // Twenty messages all mentioning the term, at a stride that makes many
    // overlapping windows, so the cap is what limits the answer rather than
    // the corpus.
    const chunks = Array.from({ length: 20 }, (_, i) =>
      chunk(i, `notes about the tokenrefresh regression, message ${i}`),
    );
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      dir,
      [{ tool: "codex", scraper: new FixtureScraper(chunks) }],
      { windowSize: 4, windowStride: 2, refreshBudgetMs: 30_000 },
    );

    const [session] = await index.searchSessions("tokenrefresh", 5, undefined, "keyword");

    expect(session).toBeDefined();
    // More than one, so a caller can see the shape of the evidence…
    expect(session.matches?.length ?? 0).toBeGreaterThan(1);
    // …and capped, so one long session cannot fill the whole answer.
    expect(session.matches?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it("reads enough of a window to preview a sentence, not a fragment", async () => {
    const sentence =
      "the parser fallback was rewritten so a malformed record no longer aborts the whole scan";
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      dir,
      [
        {
          tool: "codex",
          scraper: new FixtureScraper([
            chunk(0, `${sentence} and here is a great deal of trailing detail. `.repeat(6)),
            chunk(1, "a reply that also mentions the parser fallback in passing"),
          ]),
        },
      ],
      { refreshBudgetMs: 30_000 },
    );

    const [session] = await index.searchSessions("fallback", 5, undefined, "keyword");
    const preview = session?.matches?.[0]?.preview ?? "";

    // Long enough to be a readable excerpt rather than a truncated fragment.
    expect(preview.length).toBeGreaterThan(40);
    expect(preview).toContain("parser fallback");
  });
});
