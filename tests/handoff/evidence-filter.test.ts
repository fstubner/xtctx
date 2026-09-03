/**
 * The evidence filter drops windows that match neither semantically nor on
 * words, before anything is ranked. Its comment records why it exists: raw
 * cosine sits near zero for unrelated content, so without it the whole corpus
 * came back for a query matching nothing, formatted exactly like a real hit.
 *
 * Nothing tested it. The existing nonsense-query tests pass with the filter
 * deleted, because when *nothing* is similar the confidence gate below it
 * already returns empty — the two guards overlap there, and the second one
 * does the work.
 *
 * They come apart in the case this pins: one window genuinely matches, so the
 * corpus is confident and the gate lets everything through, and the filter is
 * the only thing standing between the caller and every unrelated window in
 * the project. Found by deleting the filter and watching the suite stay green.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * One document sits exactly on the query's axis; every other sits across it.
 * So a search has one strong hit (cosine 1) and a corpus of near-zero ones,
 * which is the shape the evidence filter exists for.
 */
class OneMatchEmbeddingProvider implements EmbeddingProvider {
  readonly model = "one-match-test-model";

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) =>
      text.includes("MATCHING") ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]),
    );
  }
}

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
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

function chunk(sessionId: string, index: number, content: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId,
    timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + index * 1000),
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

describe("the evidence filter", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-evidence-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the unrelated corpus out of a search that does have a real hit", async () => {
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      dir,
      [
        {
          tool: "codex",
          scraper: new FixtureScraper([
            chunk("hit", 0, "the MATCHING window about token refresh"),
            chunk("hit", 1, "MATCHING follow-up on the same subject"),
            chunk("noise-one", 0, "an entirely different conversation"),
            chunk("noise-one", 1, "about unrelated deployment work"),
            chunk("noise-two", 0, "a third conversation on another topic"),
            chunk("noise-two", 1, "with nothing to do with the query"),
          ]),
        },
      ],
      { embeddingProvider: new OneMatchEmbeddingProvider(), windowSize: 2, windowStride: 1 },
    );

    const results = await index.searchSessions("MATCHING", 5, undefined, "vector");

    // The corpus is confident — one window is a perfect match — so the
    // confidence gate lets everything through and only the evidence filter
    // separates the hit from the rest.
    expect(results.map((session) => session.session_ref)).toEqual(["codex:hit"]);
  });
});
