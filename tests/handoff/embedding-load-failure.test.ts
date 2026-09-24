/**
 * A model that cannot load must not look like a model that is still loading.
 *
 * Hybrid search answers from keyword while the embedding model loads, on the
 * reasoning that a cold cache takes minutes and nobody should wait for it
 * holding a tool call open. That branch asked one question — `isReady()` — and
 * a model still downloading and a model that will never download both answer
 * false.
 *
 * So a failed load produced, on every call and forever: keyword results, the
 * note "embedding model still loading, so this answer is keyword-only — ask
 * again shortly for more", and an `xtctx status` with no semantic-unavailable
 * line, because the only code that records the error is a catch this branch
 * returns before reaching. Advice that can never come true, attached to a
 * failure nothing reports.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

let tempDir = "";

class OneChunkScraper implements ConversationScraper {
  readonly tool = "codex";
  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["memory://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield {
      tool: "codex",
      sessionId: "one",
      timestamp: new Date("2026-09-21T00:00:00.000Z"),
      role: "user",
      content: "the cache eviction policy we settled on",
      metadata: { messageIndex: 0, tokenEstimate: 1, layer: 0 },
    };
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

/** A provider whose model never loads, the way an offline machine's does not. */
class UnloadableProvider implements EmbeddingProvider {
  readonly model = "test/never-loads";
  warmCalls = 0;
  async embed(): Promise<Float32Array> {
    throw new Error("model is not loaded");
  }
  async embedBatch(): Promise<Float32Array[]> {
    throw new Error("model is not loaded");
  }
  isReady(): boolean {
    return false;
  }
  loadError(): string | undefined {
    return "getaddrinfo ENOTFOUND huggingface.co";
  }
  warm(): void {
    this.warmCalls += 1;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "xtctx-embed-fail-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("a local model that cannot load", () => {
  it("is reported in status instead of read as still loading", async () => {
    const provider = new UnloadableProvider();
    const index = new SqliteHandoffIndex(
      join(tempDir, "fail.db"),
      tempDir,
      [{ tool: "codex", scraper: new OneChunkScraper() }],
      { embeddingProvider: provider, refreshBudgetMs: 30_000 },
    );

    try {
      // Hybrid still answers — degrading to keyword is correct and is not what
      // this is about.
      const results = await index.searchSessions("cache eviction", 5, undefined, "hybrid");
      expect(results.length).toBeGreaterThan(0);

      const status = await index.getStatus();
      expect(status.embedding_error).toBe("getaddrinfo ENOTFOUND huggingface.co");

      // Still retried, because the usual cause is transient.
      expect(provider.warmCalls).toBeGreaterThan(0);
    } finally {
      await index.close();
    }
  });
});
