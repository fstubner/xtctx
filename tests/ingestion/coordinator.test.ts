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

  describe("rebuildTool", () => {
    it("purges the tool's chunks, resets state, then fullSyncs just that scraper", async () => {
      const chunks = [
        makeChunk("s1", "2026-01-01T00:00:03.000Z", "user", "hello"),
        makeChunk("s1", "2026-01-01T00:00:08.000Z", "assistant", "hi"),
      ];
      const scraper = new MockScraper(chunks);
      // Pre-existing state that would otherwise gate `scrape()`, but `fullSync`
      // should ignore it AND `rebuildTool` resets it beforehand.
      await scraper.saveScrapedPosition({
        lastTimestamp: new Date("2099-01-01T00:00:00.000Z"),
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

      const result = await coordinator.rebuildTool("mock-tool");

      expect(result.tool).toBe("mock-tool");
      expect(result.purged).toBe(0); // FakeStore.purgeByTool returns 0 (no prior rows)
      expect(result.processedChunks).toBe(2);

      expect(store.purges).toEqual([{ table: "context", tool: "mock-tool" }]);
      expect(store.upserts).toHaveLength(1);
      expect(store.upserts[0].records).toHaveLength(2);

      // Final saved state should track fullSync's max timestamp, not the
      // pre-rebuild future-dated state.
      const finalState = await scraper.getLastScrapedPosition();
      expect(finalState.lastTimestamp.toISOString()).toBe("2026-01-01T00:00:08.000Z");
    });

    it("throws when the named tool is not detected", async () => {
      const coordinator = new IngestionCoordinator(
        {
          registry: new FakeRegistry([new MockScraper([])]),
          store: new FakeStore(),
          embeddings: new FakeEmbeddings(),
        },
        { tableName: "context" },
      );

      await expect(coordinator.rebuildTool("unknown-tool")).rejects.toThrow(
        /No scraper named 'unknown-tool'/,
      );
    });

    it("invalidates session cache on purge-only rebuild (even when fullSync yields zero chunks)", async () => {
      // Scraper with no chunks available — fullSync emits nothing, but the
      // pre-existing purge still needs to invalidate cached reads.
      const scraper = new MockScraper([]);
      const store = new FakeStore();
      store.purgeReturnValue = 7; // pretend 7 rows were purged
      const invalidations: number[] = [];
      const coordinator = new IngestionCoordinator(
        {
          registry: new FakeRegistry([scraper]),
          store,
          embeddings: new FakeEmbeddings(),
          sessionCache: {
            invalidate: () => invalidations.push(Date.now()),
          },
        },
        { tableName: "context" },
      );

      const result = await coordinator.rebuildTool("mock-tool");

      expect(result.purged).toBe(7);
      expect(result.processedChunks).toBe(0);
      expect(invalidations.length).toBe(1); // invalidated once despite zero chunks
    });

    it("does not invalidate cache when there's nothing to purge or ingest", async () => {
      const scraper = new MockScraper([]);
      const store = new FakeStore();
      store.purgeReturnValue = 0;
      const invalidations: number[] = [];
      const coordinator = new IngestionCoordinator(
        {
          registry: new FakeRegistry([scraper]),
          store,
          embeddings: new FakeEmbeddings(),
          sessionCache: {
            invalidate: () => invalidations.push(Date.now()),
          },
        },
        { tableName: "context" },
      );

      await coordinator.rebuildTool("mock-tool");

      expect(invalidations.length).toBe(0);
    });
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
  readonly purges: Array<{ table: string; tool: string }> = [];
  purgeReturnValue = 0;

  async upsert(
    table: string,
    records: Array<{ id: string; text: string; vector: number[]; metadata: string }>,
  ): Promise<void> {
    this.upserts.push({ table, records });
  }

  async purgeByTool(table: string, tool: string): Promise<number> {
    this.purges.push({ table, tool });
    return this.purgeReturnValue;
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
