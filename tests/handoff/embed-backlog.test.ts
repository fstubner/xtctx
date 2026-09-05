/**
 * Semantic search was, in practice, unavailable on any real history.
 *
 * Searches vectorize incrementally — six seconds per call — on the reasoning
 * that recall improves call over call and nobody should wait for the whole
 * corpus. That holds at the scale it was designed against and stops holding
 * well before a real one. Measured on a live 9,232-window project: a warm
 * search embedded about sixteen windows and took ten seconds, so covering the
 * corpus needed on the order of 570 searches. It sat at 1.5% after three
 * hours, and every search paid the six seconds regardless.
 *
 * Nothing works the backlog down between commands — there is no daemon — so
 * `scan --embed` is the piece that does. The tests below pin the two halves
 * that matter: it finishes the job, and `scan` without the flag does not
 * start it. That second half is not a detail. The session-start hook launches
 * `scan` detached, so draining by default would kick off hours of embedding
 * every time an agent opened a large project.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * How long one batch takes. Must exceed the clock's resolution.
 *
 * A batch that embeds instantly is what made the first version of this file
 * flaky: `vectorBudgetMs: 1` only bites if the clock advances past the
 * deadline between two batches, and on a fast runner all ten batches of the
 * fixture completed inside a single millisecond. CI caught it — green on
 * Windows and Linux, "expected 79 to be less than 79" on macOS.
 */
const BATCH_DELAY_MS = 5;

/** Deterministic, and counts how many texts it was asked to embed. */
class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fixture-embedding";
  embedBatchCalls = 0;

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.embedBatchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    return texts.map((text) => {
      const vector = new Float32Array(4);
      for (let i = 0; i < text.length; i++) {
        vector[i % 4] += text.charCodeAt(i) / 1000;
      }
      return vector;
    });
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
    yield* this.chunks;
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(): Promise<void> {
    return;
  }
}

/** Enough messages that one search's budget could not cover them all. */
function conversation(messageCount: number): ConversationChunk[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    tool: "codex" as const,
    sessionId: "backlog-session",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)),
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${index} about deployment migrations and auth callbacks`,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  }));
}

describe("embedBacklog", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-embed-backlog-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * `vectorBudgetMs: 1` is what makes this test a test.
   *
   * With the real six-second budget the fixture covers the whole corpus during
   * the scan and `embedBacklog` is handed nothing to do — every assertion
   * below then passes without the code under test doing anything. A
   * one-millisecond budget reproduces the condition this feature exists for:
   * the deadline is checked between batches, so one batch runs and the rest is
   * left outstanding, which is the real index's ordinary state at a far larger
   * scale.
   *
   * It only reproduces it because `BATCH_DELAY_MS` makes each batch outlast
   * the clock's resolution — see the note there.
   */
  function build(): SqliteHandoffIndex {
    return new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper: new FixtureScraper(conversation(80)) }],
      {
        embeddingProvider: new CountingEmbeddingProvider(),
        windowSize: 2,
        windowStride: 1,
        vectorBudgetMs: 1,
      },
    );
  }

  it("leaves nothing outstanding", async () => {
    const index = build();
    try {
      await index.listRecentSessions(1);
      await index.whenScanSettled();

      const before = await index.getStatus();
      // The precondition, asserted rather than assumed: without a real
      // backlog the rest of this proves nothing.
      expect(before.retrieval_units).toBeGreaterThan(0);
      expect(before.vectorized_units).toBeLessThan(before.retrieval_units);

      const remaining = await index.embedBacklog();
      const after = await index.getStatus();

      expect(remaining).toBe(0);
      expect(after.vectorized_units).toBe(after.retrieval_units);
    } finally {
      await index.close();
    }
  }, 60_000);

  it("reports progress against a total, so a long run is not silent", async () => {
    // The run this exists for takes about two hours. A command that prints
    // nothing for that long cannot be told apart from a hung one.
    const index = build();
    try {
      await index.listRecentSessions(1);
      await index.whenScanSettled();

      const seen: Array<[number, number]> = [];
      await index.embedBacklog((embedded, total) => seen.push([embedded, total]));

      expect(seen.length).toBeGreaterThan(1);
      // Monotonic, and the last report accounts for everything.
      expect(seen.map(([embedded]) => embedded)).toEqual(
        [...seen.map(([embedded]) => embedded)].sort((a, b) => a - b),
      );
      const [lastEmbedded, lastTotal] = seen[seen.length - 1];
      expect(lastEmbedded).toBe(lastTotal);
    } finally {
      await index.close();
    }
  }, 60_000);

  it("is resumable: a second call has nothing left to do", async () => {
    // Each batch commits before the next starts, so an interrupted run is
    // progress rather than wasted work.
    const index = build();
    try {
      await index.listRecentSessions(1);
      await index.whenScanSettled();
      await index.embedBacklog();

      const calls: Array<[number, number]> = [];
      const remaining = await index.embedBacklog((embedded, total) => calls.push([embedded, total]));

      expect(remaining).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      await index.close();
    }
  }, 60_000);

  /**
   * The pass reads windows a page at a time rather than pulling the whole
   * backlog into one array — measured on a real 9,013-window index, that
   * single allocation was 104MB, and `--embed` is what runs it at full size.
   *
   * Paging is where a drain quietly goes wrong: skip a page and the run
   * reports success with windows still unvectorized; re-read the same page and
   * it never terminates. Every other test in this file uses fewer windows than
   * one page holds, so none of them touch that code at all.
   */
  it("covers every window when the backlog spans several pages", async () => {
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      // 600 messages at size 2 / stride 1 is 599 windows: three pages, with
      // the last one partial.
      [{ tool: "codex", scraper: new FixtureScraper(conversation(600)) }],
      {
        embeddingProvider: new CountingEmbeddingProvider(),
        windowSize: 2,
        windowStride: 1,
        vectorBudgetMs: 1,
      },
    );
    try {
      await index.listRecentSessions(1);
      await index.whenScanSettled();

      const before = await index.getStatus();
      expect(before.retrieval_units).toBeGreaterThan(256);
      expect(before.vectorized_units).toBeLessThan(before.retrieval_units);

      const remaining = await index.embedBacklog();
      const after = await index.getStatus();

      expect(remaining).toBe(0);
      expect(after.vectorized_units).toBe(after.retrieval_units);
    } finally {
      await index.close();
    }
  }, 120_000);

  it("finishes what a budgeted search only chips at", async () => {
    // The behaviour in one assertion: a search embeds a batch and stops; the
    // backlog pass covers the rest. The search's own budget is what makes it
    // stop, which is the product behaviour, not a property of the fixture.
    const index = build();
    try {
      await index.searchSessions("deployment migrations", 5, undefined, "vector");
      const afterSearch = await index.getStatus();
      expect(afterSearch.vectorized_units).toBeLessThan(afterSearch.retrieval_units);

      await index.embedBacklog();
      const afterDrain = await index.getStatus();

      expect(afterDrain.vectorized_units).toBe(afterDrain.retrieval_units);
    } finally {
      await index.close();
    }
  }, 60_000);
});
