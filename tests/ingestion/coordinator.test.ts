import { describe, it, expect } from "vitest";
import { IngestionCoordinator } from "@xtctx/ingestion/coordinator";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class MockScraper implements ConversationScraper {
  readonly tool = "mock-tool";
  private state: ScraperState = { lastTimestamp: new Date("2026-01-01T00:00:00.000Z") };

  constructor(private readonly chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return [];
  }

  async *scrape(since?: Date): AsyncIterable<ConversationChunk> {
    const cutoff = since ?? this.state.lastTimestamp;
    for (const chunk of this.chunks) {
      if (chunk.timestamp > cutoff) {
        yield chunk;
      }
    }
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  parseRaw(raw: unknown): ConversationChunk {
    return raw as ConversationChunk;
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.state;
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    this.state = state;
  }
}

describe("IngestionCoordinator", () => {
  it("processes new chunks and updates scraper state", async () => {
    const chunks = [
      makeChunk("s1", "2026-01-01T00:00:03.000Z", "user", "first message"),
      makeChunk("s1", "2026-01-01T00:00:08.000Z", "assistant", "second message"),
    ];

    const scraper = new MockScraper(chunks);
    const store = new FakeStore();
    const embeddings = new FakeEmbeddings();

    const coordinator = new IngestionCoordinator(
      {
        registry: new FakeRegistry([scraper]),
        store,
        embeddings,
      },
      { tableName: "context" },
    );

    const result = await coordinator.runCycle();
    expect(result.processedChunks).toBe(2);
    expect(result.processedScrapers).toBe(1);

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].table).toBe("context");
    expect(store.upserts[0].records).toHaveLength(2);

    const state = await scraper.getLastScrapedPosition();
    expect(state.lastTimestamp.toISOString()).toBe("2026-01-01T00:00:08.000Z");
  });

  it("skips upsert when no chunks are newer than checkpoint", async () => {
    const chunks = [
      makeChunk("s1", "2026-01-01T00:00:03.000Z", "user", "old message"),
      makeChunk("s1", "2026-01-01T00:00:08.000Z", "assistant", "old message 2"),
    ];

    const scraper = new MockScraper(chunks);
    await scraper.saveScrapedPosition({
      lastTimestamp: new Date("2026-01-01T00:00:08.000Z"),
    });

    const store = new FakeStore();
    const coordinator = new IngestionCoordinator(
      {
        registry: new FakeRegistry([scraper]),
        store,
        embeddings: new FakeEmbeddings(),
      },
      { tableName: "context" },
    );

    const result = await coordinator.runCycle();
    expect(result.processedChunks).toBe(0);
    expect(store.upserts).toHaveLength(0);
  });

  it("runs full sync using scraper.fullSync()", async () => {
    const chunks = [
      makeChunk("s1", "2026-01-01T00:00:03.000Z", "user", "full sync 1"),
      makeChunk("s1", "2026-01-01T00:00:09.000Z", "assistant", "full sync 2"),
    ];

    const scraper = new MockScraper(chunks);
    const store = new FakeStore();
    const coordinator = new IngestionCoordinator(
      {
        registry: new FakeRegistry([scraper]),
        store,
        embeddings: new FakeEmbeddings(),
      },
      { tableName: "context" },
    );

    const result = await coordinator.fullSync();
    expect(result.processedChunks).toBe(2);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].records[0].vector.length).toBeGreaterThan(0);
  });
});

class FakeRegistry {
  constructor(private readonly scrapers: ConversationScraper[]) {}

  async detectAvailable(): Promise<ConversationScraper[]> {
    return this.scrapers;
  }
}

class FakeEmbeddings {
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text, index) => [text.length, index + 1, 1]);
  }
}

class FakeStore {
  readonly upserts: Array<{
    table: string;
    records: Array<{
      id: string;
      text: string;
      vector: number[];
      metadata: string;
    }>;
  }> = [];

  async upsert(
    table: string,
    records: Array<{ id: string; text: string; vector: number[]; metadata: string }>,
  ): Promise<void> {
    this.upserts.push({ table, records });
  }
}

function makeChunk(
  sessionId: string,
  iso: string,
  role: ConversationChunk["role"],
  content: string,
): ConversationChunk {
  return {
    tool: "mock-tool",
    sessionId,
    timestamp: new Date(iso),
    role,
    content,
    metadata: {
      messageIndex: 0,
      referencedFiles: [],
    },
  };
}
