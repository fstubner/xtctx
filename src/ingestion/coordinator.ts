import { createHash } from "node:crypto";
import type { VectorRecord } from "../store/lance.js";
import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";

export interface ScraperRegistryLike {
  detectAvailable(): Promise<ConversationScraper[]>;
}

export interface EmbeddingProvider {
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface VectorStoreLike {
  upsert(tableName: string, records: VectorRecord[]): Promise<void>;
}

export interface IngestionCoordinatorDependencies {
  registry: ScraperRegistryLike;
  embeddings: EmbeddingProvider;
  store: VectorStoreLike;
}

export interface IngestionCoordinatorOptions {
  tableName?: string;
}

export interface IngestionCycleResult {
  processedScrapers: number;
  processedChunks: number;
}

export class IngestionCoordinator {
  private readonly tableName: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleInFlight = false;
  private rerunQueued = false;

  constructor(
    private readonly deps: IngestionCoordinatorDependencies,
    options: IngestionCoordinatorOptions = {},
  ) {
    this.tableName = options.tableName ?? "context";
  }

  async runCycle(): Promise<IngestionCycleResult> {
    const available = await this.deps.registry.detectAvailable();
    let processedChunks = 0;
    let processedScrapers = 0;

    for (const scraper of available) {
      const state = await scraper.getLastScrapedPosition();
      const chunks = await collectChunks(scraper.scrape(state.lastTimestamp));
      if (chunks.length === 0) {
        continue;
      }

      const records = await this.toVectorRecords(chunks);
      if (records.length > 0) {
        await this.deps.store.upsert(this.tableName, records);
      }

      await scraper.saveScrapedPosition({
        ...state,
        lastTimestamp: maxTimestamp(chunks),
      });

      processedScrapers += 1;
      processedChunks += chunks.length;
    }

    return { processedScrapers, processedChunks };
  }

  async fullSync(): Promise<IngestionCycleResult> {
    const available = await this.deps.registry.detectAvailable();
    let processedChunks = 0;
    let processedScrapers = 0;

    for (const scraper of available) {
      const chunks = await collectChunks(scraper.fullSync());
      if (chunks.length === 0) {
        continue;
      }

      const records = await this.toVectorRecords(chunks);
      if (records.length > 0) {
        await this.deps.store.upsert(this.tableName, records);
      }

      const state = await scraper.getLastScrapedPosition();
      await scraper.saveScrapedPosition({
        ...state,
        lastTimestamp: maxTimestamp(chunks),
      });

      processedScrapers += 1;
      processedChunks += chunks.length;
    }

    return { processedScrapers, processedChunks };
  }

  start(intervalMs: number): void {
    if (this.timer) {
      return;
    }

    const tick = async () => {
      if (this.cycleInFlight) {
        this.rerunQueued = true;
        return;
      }

      this.cycleInFlight = true;
      try {
        await this.runCycle();
      } finally {
        this.cycleInFlight = false;
        if (this.rerunQueued) {
          this.rerunQueued = false;
          void tick();
        }
      }
    };

    this.timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async toVectorRecords(chunks: ConversationChunk[]): Promise<VectorRecord[]> {
    const vectors = await this.deps.embeddings.embedBatch(chunks.map((chunk) => chunk.content));

    return chunks.map((chunk, index) => ({
      id: createChunkId(chunk),
      text: chunk.content,
      vector: vectors[index] ?? [],
      metadata: JSON.stringify({
        source_tool: chunk.tool,
        source_session: chunk.sessionId,
        role: chunk.role,
        timestamp: chunk.timestamp.toISOString(),
        messageIndex: chunk.metadata.messageIndex,
        referenced_files: chunk.metadata.referencedFiles ?? [],
      }),
    }));
  }
}

async function collectChunks(iterable: AsyncIterable<ConversationChunk>): Promise<ConversationChunk[]> {
  const chunks: ConversationChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

function createChunkId(chunk: ConversationChunk): string {
  const hash = createHash("sha256");
  hash.update(
    `${chunk.tool}|${chunk.sessionId}|${chunk.timestamp.toISOString()}|${chunk.role}|${chunk.content}`,
  );
  return hash.digest("hex").slice(0, 24);
}

function maxTimestamp(chunks: ConversationChunk[]): Date {
  let max = chunks[0]?.timestamp ?? new Date(0);
  for (const chunk of chunks) {
    if (chunk.timestamp > max) {
      max = chunk.timestamp;
    }
  }
  return max;
}
