import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class FixtureScraper implements ConversationScraper {
  readonly tool = "codex";
  detectCalls = 0;
  fullSyncCalls = 0;

  constructor(private readonly chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    this.detectCalls += 1;
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    this.fullSyncCalls += 1;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(_state: ScraperState): Promise<void> {
    return;
  }
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fixture-embedding";

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => fixtureVector(text));
  }
}

describe("SqliteHandoffIndex", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-index-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("indexes lazily and preserves same-timestamp messages", async () => {
    const scraper = new FixtureScraper([
      chunk("same-time-session", 0, "user", "first message"),
      chunk("same-time-session", 1, "assistant", "second message"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const recent = await index.listRecentSessions(5);
    const detail = await index.getSessionDetail("codex:same-time-session", 0, 10);

    expect(scraper.fullSyncCalls).toBe(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].message_count).toBe(2);
    expect(detail.map((message) => message.content)).toEqual([
      "first message",
      "second message",
    ]);

    await index.close();
  });

  it("searches indexed transcript content through SQLite FTS", async () => {
    const scraper = new FixtureScraper([
      chunk("search-session", 0, "user", "investigate token refresh regression"),
      chunk("search-session", 1, "assistant", "patched the auth callback"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const results = await index.searchSessions("token", 5, undefined, "keyword");

    expect(results.map((session) => session.session_ref)).toEqual(["codex:search-session"]);

    await index.close();
  });

  it("semantic search embeds chronological transcript windows", async () => {
    const scraper = new FixtureScraper([
      chunk("semantic-session", 0, "user", "initial idea: use an external vector store"),
      chunk("semantic-session", 1, "assistant", "switch to sqlite vector storage"),
      chunk("semantic-session", 2, "user", "final state: chronological handoff windows"),
    ]);
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper }],
      {
        embeddingProvider: new FixtureEmbeddingProvider(),
        windowSize: 2,
        windowStride: 1,
      },
    );

    const results = await index.searchSessions("chronological sqlite vector", 5, undefined, "vector");
    const [match] = results[0].matches ?? [];
    const status = await index.getStatus();

    expect(results[0]).toMatchObject({
      session_ref: "codex:semantic-session",
      retrieval: "vector",
    });
    expect(match).toMatchObject({
      message_start_index: 1,
      message_end_index: 2,
    });
    expect(status.retrieval_units).toBe(2);
    expect(status.vectorized_units).toBe(2);
    expect(status.vector_model).toBe("fixture-embedding");

    await index.close();
  });
});

function chunk(
  sessionId: string,
  messageIndex: number,
  role: ConversationChunk["role"],
  content: string,
): ConversationChunk {
  return {
    tool: "codex",
    sessionId,
    timestamp: new Date("2026-05-10T10:00:00.000Z"),
    role,
    content,
    metadata: {
      messageIndex,
      tokenEstimate: 1,
      layer: 0,
    },
  };
}

function fixtureVector(text: string): Float32Array {
  const dimensions = [
    "token",
    "auth",
    "sqlite",
    "vector",
    "chronological",
    "handoff",
    "external",
  ];
  const normalized = text.toLowerCase();
  const vector = new Float32Array(dimensions.length);
  dimensions.forEach((term, index) => {
    vector[index] = normalized.includes(term) ? 1 : 0;
  });

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm === 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] *= scale;
  }
  return vector;
}
