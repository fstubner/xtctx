import type { EmbeddingService } from "./embeddings.js";
import type { LanceStore, SearchResult } from "./lance.js";

export interface RankedResult {
  id: string;
  score: number;
}

export interface HybridSearchResult extends SearchResult {
  fusedScore: number;
}

export type SearchMode = "hybrid" | "semantic" | "keyword";

export function fuseResults(
  vectorResults: RankedResult[],
  bm25Results: RankedResult[],
  k = 60,
): RankedResult[] {
  const scores = new Map<string, number>();

  for (const [rank, result] of vectorResults.entries()) {
    scores.set(result.id, (scores.get(result.id) ?? 0) + 1 / (k + rank + 1));
  }

  for (const [rank, result] of bm25Results.entries()) {
    scores.set(result.id, (scores.get(result.id) ?? 0) + 1 / (k + rank + 1));
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export class HybridSearch {
  constructor(
    private readonly store: LanceStore,
    private readonly embeddings: EmbeddingService,
  ) {}

  async search(
    tableName: string,
    query: string,
    mode: SearchMode,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    if (mode === "keyword") {
      const results = await this.store.ftsSearch(tableName, query, limit);
      return results.map((result) => ({ ...result, fusedScore: result.score }));
    }

    if (mode === "semantic") {
      const vector = await this.embeddings.embed(query);
      const results = await this.store.vectorSearch(tableName, vector, limit);
      return results.map((result) => ({ ...result, fusedScore: result.score }));
    }

    const vector = await this.embeddings.embed(query);
    const [vectorResults, ftsResults] = await Promise.all([
      this.store.vectorSearch(tableName, vector, limit * 2),
      this.store.ftsSearch(tableName, query, limit * 2),
    ]);

    const fused = fuseResults(
      vectorResults.map((result) => ({ id: result.id, score: result.score })),
      ftsResults.map((result) => ({ id: result.id, score: result.score })),
    );

    const allResults = new Map<string, SearchResult>();
    for (const result of [...vectorResults, ...ftsResults]) {
      const existing = allResults.get(result.id);
      if (!existing || result.score > existing.score) {
        allResults.set(result.id, result);
      }
    }

    return fused
      .slice(0, limit)
      .map((result) => {
        const full = allResults.get(result.id);
        if (!full) {
          return null;
        }

        return { ...full, fusedScore: result.score };
      })
      .filter((result): result is HybridSearchResult => result !== null);
  }
}
