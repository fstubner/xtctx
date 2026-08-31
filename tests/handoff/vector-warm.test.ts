/**
 * A scan skipped vectorising whenever the embedding model was not already
 * loaded, warming it and leaving the work "to the next scan". That reasoning
 * holds for a long-lived server and fails for this one: the CLI is spawned per
 * MCP session and exits shortly after the client disconnects, so `isReady()`
 * is false at the start of every process and there is no next scan to defer
 * to. The result on a real machine was 0 vectors against 1,770 windows after
 * 25 days — semantic search inert while reporting itself merely "outstanding".
 *
 * The constraint the old shape was protecting is real and kept: `close()`
 * waits for the scan, so an unbounded model load would turn shutting the
 * server down into a multi-minute hang. The wait is bounded instead of
 * skipped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * Mirrors the real provider's lifecycle: not ready until warmed, warming is
 * asynchronous and returns void, and embedding works once loaded.
 */
class LazyProvider implements EmbeddingProvider {
  readonly model = "test-model";
  readonly dimensions = 4;
  private ready = false;
  warmCalls = 0;
  embedCalls = 0;

  constructor(private readonly warmMs: number) {}

  isReady(): boolean {
    return this.ready;
  }

  warm(): void {
    this.warmCalls += 1;
    setTimeout(() => {
      this.ready = true;
    }, this.warmMs);
  }

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls += 1;
    return texts.map((_, i) => Float32Array.from([1, 0, 0, i / 1000]));
  }
}

class OneShotScraper implements ConversationScraper {
  readonly tool = "codex";
  private drained = false;
  constructor(private readonly chunks: ConversationChunk[]) {}
  async detect(): Promise<boolean> { return true; }
  getStorePaths(): string[] { return ["fixture://codex"]; }
  async *scrape(): AsyncIterable<ConversationChunk> {
    if (this.drained) return;
    yield* this.chunks;
  }
  async *fullSync(): AsyncIterable<ConversationChunk> { yield* this.scrape(); }
  async getLastScrapedPosition(): Promise<ScraperState> { return { lastTimestamp: new Date(0) }; }
  async saveScrapedPosition(_s: ScraperState): Promise<void> { this.drained = true; }
}

function chunk(i: number): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "s1",
    timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + i * 1000),
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message number ${i} about indexing`,
    metadata: { messageIndex: i, tokenEstimate: 1, layer: 0 },
  };
}

function vectorCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM retrieval_unit_vectors").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("vector warming in a short-lived process", () => {
  let tempDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-warm-"));
    dbPath = join(tempDir, "xtctx.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("vectorises within the first scan when the model loads quickly", async () => {
    const provider = new LazyProvider(50);
    const index = new SqliteHandoffIndex(
      dbPath,
      tempDir,
      [{ tool: "codex", scraper: new OneShotScraper(Array.from({ length: 16 }, (_, i) => chunk(i))) }],
      // Set explicitly: this test asserts the wait, and `tests/setup.ts`
      // zeroes it for every suite that does not.
      { embeddingProvider: provider, embeddingWarmBudgetMs: 5_000 },
    );

    await index.listRecentSessions(5);
    await index.whenScanSettled?.();
    await index.close();

    expect(provider.warmCalls).toBeGreaterThan(0);
    // The point: this process is the only one there will be.
    expect(vectorCount(dbPath)).toBeGreaterThan(0);
  });

  it("gives up rather than hanging when the model will not load in time", async () => {
    // `close()` waits for the scan, so the wait has to be bounded — a model
    // that never loads must not stall shutdown.
    const provider = new LazyProvider(60_000);
    const index = new SqliteHandoffIndex(
      dbPath,
      tempDir,
      [{ tool: "codex", scraper: new OneShotScraper(Array.from({ length: 8 }, (_, i) => chunk(i))) }],
      { embeddingProvider: provider, vectorBudgetMs: 300, embeddingWarmBudgetMs: 400 },
    );

    const startedAt = Date.now();
    await index.listRecentSessions(5);
    await index.whenScanSettled?.();
    await index.close();
    const elapsed = Date.now() - startedAt;

    // Comfortably under the 60s load, comfortably over the 400ms budget and
    // the scan's own work, so this fails on a hang rather than timing noise.
    expect(elapsed).toBeLessThan(10_000);
    expect(vectorCount(dbPath)).toBe(0);
  });
});
