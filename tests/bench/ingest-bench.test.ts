/**
 * Ingest & search scale baseline.
 *
 * Skipped by default. Enable explicitly:
 *   BENCH=1 npm run bench:ingest
 *
 * Captures wall time, peak RSS, on-disk footprint, and search latencies for a
 * 1000-session synthetic corpus. No assertions this iteration — baseline only.
 */

import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { EmbeddingService } from "@xtctx/store/embeddings";
import { LanceStore, type VectorRecord } from "@xtctx/store/lance";
import { HybridSearch } from "@xtctx/store/search";

import {
  generateCorpus,
  computeChunkId,
  type GeneratedCorpus,
} from "../eval/corpus-generator.js";
import { deriveQueries } from "../eval/query-templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, "baseline.json");

const RUN_BENCH = process.env.BENCH === "1";

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else {
        const info = await stat(full);
        total += info.size;
      }
    }
  } catch {
    // directory may not exist
  }
  return total;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

describe.skipIf(!RUN_BENCH)("Ingest bench (BENCH=1)", () => {
  it("captures a 1000-session ingest + search baseline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "xtctx-bench-"));
    const lanceDir = join(tempDir, "lancedb");
    await mkdir(lanceDir, { recursive: true });

    const corpus: GeneratedCorpus = generateCorpus({
      seed: 42,
      sessionsPerTool: 200, // 5 tools * 200 = 1000 sessions
      anchorRate: 0.4,
      turnsPerSession: 6,
    });

    const embeddings = new EmbeddingService();
    await embeddings.initialize();
    const store = new LanceStore(lanceDir);
    await store.initialize();

    const peakRssSamples: number[] = [];
    const sampler = setInterval(() => {
      peakRssSamples.push(process.memoryUsage().rss);
    }, 1000).unref();

    const ingestStart = Date.now();
    const BATCH = 32;
    for (let i = 0; i < corpus.chunks.length; i += BATCH) {
      const slice = corpus.chunks.slice(i, i + BATCH);
      const vectors = await embeddings.embedBatch(slice.map((c) => c.content));
      const records: VectorRecord[] = slice.map((chunk, idx) => ({
        id: computeChunkId(chunk),
        text: chunk.content,
        vector: vectors[idx] ?? [],
        metadata: JSON.stringify({
          source_tool: chunk.tool,
          source_session: chunk.sessionId,
          role: chunk.role,
          timestamp: chunk.timestamp.toISOString(),
          messageIndex: chunk.metadata.messageIndex,
        }),
      }));
      await store.upsert("bench_context", records);
    }
    const ingestMs = Date.now() - ingestStart;

    clearInterval(sampler);
    const peakRss = Math.max(process.memoryUsage().rss, ...peakRssSamples);

    // Search benchmarking
    const search = new HybridSearch(store, embeddings);
    const queries = corpus.anchors.flatMap(deriveQueries).slice(0, 100);
    const latencies: number[] = [];
    for (const query of queries) {
      const start = Date.now();
      await search.search("bench_context", query.text, "hybrid", 10);
      latencies.push(Date.now() - start);
    }
    latencies.sort((a, b) => a - b);

    const footprintBytes = await dirSize(lanceDir);

    const report = {
      generatedAt: new Date().toISOString(),
      chunkCount: corpus.chunks.length,
      sessionCount: corpus.sessions.length,
      ingestMs,
      ingestChunksPerSec: (corpus.chunks.length / ingestMs) * 1000,
      peakRssBytes: peakRss,
      footprintBytes,
      searchCount: latencies.length,
      searchP50Ms: quantile(latencies, 0.5),
      searchP95Ms: quantile(latencies, 0.95),
    };

    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log("[bench] wrote baseline:", BASELINE_PATH);
    console.log(report);

    await rm(tempDir, { recursive: true, force: true });
  }, 600_000);
});
