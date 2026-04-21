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
  /** Optional: delete all rows whose metadata carries the given source_tool. */
  purgeByTool?(tableName: string, tool: string): Promise<number>;
}

export interface RebuildToolResult {
  tool: string;
  purged: number;
  processedChunks: number;
}

/** Optional hook called after each ingestion cycle completes a write. */
export interface SessionCacheInvalidator {
  invalidate(): void;
}

export interface IngestionCoordinatorDependencies {
  registry: ScraperRegistryLike;
  embeddings: EmbeddingProvider;
  store: VectorStoreLike;
  /** If provided, its cache is invalidated after each write so reads stay fresh. */
  sessionCache?: SessionCacheInvalidator;
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
        // Invalidate the session cache so subsequent reads reflect the new data.
        this.deps.sessionCache?.invalidate();
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

  /**
   * Clean-rebuild a single tool: purge its existing chunks from the store,
   * reset its scraper state to time zero, then fullSync just that scraper.
   *
   * Primary use case: one-shot migration after a chunk-ID scheme change,
   * where upserting fresh chunks would leave legacy rows in place and
   * duplicate every piece of conversation history for the affected tool.
   *
   * Throws if the tool isn't detected (no scraper available or the tool
   * has no data on disk) — callers should validate the tool name first.
   */
  async rebuildTool(toolName: string): Promise<RebuildToolResult> {
    const available = await this.deps.registry.detectAvailable();
    const scraper = available.find((s) => s.tool === toolName);
    if (!scraper) {
      throw new Error(
        `No scraper named '${toolName}' is detected. ` +
          `Available: ${available.map((s) => s.tool).join(", ") || "(none)"}`,
      );
    }

    const purged = this.deps.store.purgeByTool
      ? await this.deps.store.purgeByTool(this.tableName, toolName)
      : 0;

    // Reset the scraper's state so fullSync emits every chunk.
    await scraper.saveScrapedPosition({ lastTimestamp: new Date(0) });

    // Any purge is a visibility change, even when fullSync yields zero chunks
    // afterward (e.g. the tool was uninstalled). Invalidate the session cache
    // before re-ingest so stale entries can't survive the rebuild.
    if (purged > 0) {
      this.deps.sessionCache?.invalidate();
    }

    const chunks = await collectChunks(scraper.fullSync());
    if (chunks.length > 0) {
      const records = await this.toVectorRecords(chunks);
      if (records.length > 0) {
        await this.deps.store.upsert(this.tableName, records);
        this.deps.sessionCache?.invalidate();
      }
      await scraper.saveScrapedPosition({ lastTimestamp: maxTimestamp(chunks) });
    }

    return { tool: toolName, purged, processedChunks: chunks.length };
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
        // Invalidate the session cache so subsequent reads reflect the new data.
        this.deps.sessionCache?.invalidate();
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
        layer: chunk.metadata.layer ?? 0,
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
  // Include messageIndex in the hash basis so that scrapers which stamp the
  // same session-level timestamp on every turn (notably Copilot, which stores
  // only session `creationDate`) can still emit multiple chunks without ID
  // collisions. Without messageIndex, two "yes" replies in the same session
  // would hash identically and silently overwrite on upsert, losing history.
  const hash = createHash("sha256");
  hash.update(
    `${chunk.tool}|${chunk.sessionId}|${chunk.timestamp.toISOString()}|${chunk.role}|${chunk.metadata.messageIndex}|${chunk.content}`,
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
