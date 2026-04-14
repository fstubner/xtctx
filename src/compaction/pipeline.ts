import type { CompactedSession, CompactionConfig } from "../types/compaction.js";
import type { ConversationChunk } from "../types/scraper.js";
import { compactChunksLlmAssisted } from "./llm-assisted.js";
import { compactChunksRuleBased } from "./rule-based.js";

export interface CompactionChunkSource {
  listAllChunks(): Promise<ConversationChunk[]>;
  listChunksSince?(since: Date): Promise<ConversationChunk[]>;
}

export interface CompactionSink {
  saveCompactedSessions(sessions: CompactedSession[]): Promise<void>;
}

export class CompactionPipeline {
  constructor(
    private readonly source: CompactionChunkSource,
    private readonly sink: CompactionSink,
    private readonly config: CompactionConfig,
  ) {}

  async runFull(): Promise<CompactedSession[]> {
    const chunks = await this.source.listAllChunks();
    const sessions = await this.compact(chunks);
    await this.sink.saveCompactedSessions(sessions);
    return sessions;
  }

  async runIncremental(since: Date): Promise<CompactedSession[]> {
    const chunks = this.source.listChunksSince
      ? await this.source.listChunksSince(since)
      : await this.source.listAllChunks();
    const sessions = await this.compact(chunks);
    await this.sink.saveCompactedSessions(sessions);
    return sessions;
  }

  private compact(chunks: ConversationChunk[]): CompactedSession[] | Promise<CompactedSession[]> {
    if (this.config.strategy === "llm-assisted" && this.config.llm) {
      return compactChunksLlmAssisted(chunks, this.config);
    }

    return compactChunksRuleBased(chunks, {
      sessionBoundaryMinutes: this.config.sessionBoundaryMinutes,
    });
  }
}
