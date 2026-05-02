/**
 * Ranking eval harness.
 *
 * Generates a deterministic synthetic corpus, ingests it through the real
 * embedding + LanceDB + hybrid-search path, runs template-derived queries,
 * and computes MRR / Recall@k / top-1 accuracy / negation correctness per
 * anchor category.
 *
 * Results are written to tests/eval/results/ranking-baseline.json.
 *
 *  - First run (no baseline file)                       -> writes baseline, passes.
 *  - `XTCTX_UPDATE_EVAL_BASELINE=1 npm run test:eval`   -> regenerates baseline.
 *  - Subsequent runs                                    -> asserts no metric
 *                                                         regresses by more than
 *                                                         BASELINE_TOLERANCE.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { EmbeddingService } from "@xtctx/store/embeddings";
import { LanceStore, type VectorRecord } from "@xtctx/store/lance";
import { HybridSearch } from "@xtctx/store/search";

import {
  generateCorpus,
  computeChunkId,
  type AnchorCategory,
  type GeneratedCorpus,
} from "./corpus-generator.js";
import { deriveQueries, type EvalQuery, type QueryIntent } from "./query-templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, "results/ranking-baseline.json");
const BASELINE_TOLERANCE = 0.05; // 5% regression gate.

const SEED = 20260420;
const SESSIONS_PER_TOOL = 40; // 7 tools -> 280 sessions total
const ANCHOR_RATE = 0.4;
const TURNS_PER_SESSION = 6;

interface IntentMetrics {
  queryCount: number;
  mrr: number;
  recallAt5: number;
  recallAt10: number;
  top1Accuracy: number;
}

interface CategoryMetrics {
  overall: IntentMetrics;
  byIntent: Partial<Record<QueryIntent, IntentMetrics>>;
}

interface EvalResults {
  seed: number;
  sessionsPerTool: number;
  anchorRate: number;
  turnsPerSession: number;
  totalAnchors: number;
  totalQueries: number;
  generatedAt: string;
  overall: IntentMetrics;
  /** Percentage of negation queries where the anchor stayed *out* of top-1. */
  negationOutOfTop1: number;
  byCategory: Record<string, CategoryMetrics>;
}

describe("Ranking eval harness", () => {
  let tempDir = "";
  let corpus: GeneratedCorpus;
  let embeddings: EmbeddingService;
  let store: LanceStore;
  let search: HybridSearch;
  const tableName = "eval_context";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-eval-"));

    corpus = generateCorpus({
      seed: SEED,
      sessionsPerTool: SESSIONS_PER_TOOL,
      anchorRate: ANCHOR_RATE,
      turnsPerSession: TURNS_PER_SESSION,
    });

    embeddings = new EmbeddingService();
    await embeddings.initialize();

    const lanceDir = join(tempDir, "lancedb");
    await mkdir(lanceDir, { recursive: true });
    store = new LanceStore(lanceDir);
    await store.initialize();

    // Embed + upsert in batches — mirrors IngestionCoordinator but bypasses
    // the scraper layer (we already have the chunks in hand, deterministically).
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
      await store.upsert(tableName, records);
    }

    search = new HybridSearch(store, embeddings);
  }, 300_000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("retrieves anchor chunks with MRR and Recall@k at or above baseline", async () => {
    const queries: EvalQuery[] = corpus.anchors.flatMap(deriveQueries);
    expect(queries.length).toBeGreaterThan(0);

    // Run every query once and collect the rank of the expected chunk.
    const perQuery: Array<{ query: EvalQuery; rank: number | null }> = [];
    for (const query of queries) {
      const results = await search.search(tableName, query.text, "hybrid", 10);
      const rank = results.findIndex((r) => r.id === query.expectedChunkId);
      perQuery.push({ query, rank: rank === -1 ? null : rank + 1 });
    }

    const results = computeResults(perQuery);
    await writeResultsArtifact(results);

    // Baseline gating --------------------------------------------------
    const updateBaseline =
      process.env.XTCTX_UPDATE_EVAL_BASELINE === "1" || !existsSync(BASELINE_PATH);

    if (updateBaseline) {
      await mkdir(dirname(BASELINE_PATH), { recursive: true });
      await writeFile(BASELINE_PATH, JSON.stringify(results, null, 2) + "\n", "utf-8");
      // Sanity floor: the corpus is designed so at least half of top-1-style
      // queries hit. If we can't clear that on a fresh baseline something is
      // fundamentally broken — catch it now rather than freeze bad numbers.
      expect(results.overall.mrr).toBeGreaterThan(0.3);
      expect(results.overall.recallAt10).toBeGreaterThan(0.4);
      return;
    }

    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf-8")) as EvalResults;

    expectNoRegression("overall MRR", results.overall.mrr, baseline.overall.mrr);
    expectNoRegression("overall Recall@5", results.overall.recallAt5, baseline.overall.recallAt5);
    expectNoRegression("overall Recall@10", results.overall.recallAt10, baseline.overall.recallAt10);
    expectNoRegression("overall top-1", results.overall.top1Accuracy, baseline.overall.top1Accuracy);
    expectNoRegression(
      "negation out-of-top-1",
      results.negationOutOfTop1,
      baseline.negationOutOfTop1,
    );

    for (const [category, metrics] of Object.entries(results.byCategory)) {
      const baseMetrics = baseline.byCategory[category];
      if (!baseMetrics) continue;
      expectNoRegression(
        `${category} MRR`,
        metrics.overall.mrr,
        baseMetrics.overall.mrr,
      );
      expectNoRegression(
        `${category} Recall@10`,
        metrics.overall.recallAt10,
        baseMetrics.overall.recallAt10,
      );
    }
  }, 300_000);
});

function expectNoRegression(label: string, current: number, baseline: number): void {
  // Allow an absolute tolerance floor so tiny baselines (e.g. 0.05) don't
  // fail from sub-percentage embedding numerical noise.
  const delta = baseline - current;
  const relative = baseline > 0 ? delta / baseline : 0;
  if (relative > BASELINE_TOLERANCE && delta > 0.02) {
    throw new Error(
      `Regression in ${label}: current ${current.toFixed(4)} vs baseline ${baseline.toFixed(4)} ` +
        `(drop ${(relative * 100).toFixed(2)}%, tolerance ${BASELINE_TOLERANCE * 100}%)`,
    );
  }
}

function computeResults(
  perQuery: Array<{ query: EvalQuery; rank: number | null }>,
): EvalResults {
  const overall = summarise(perQuery);

  // Negation correctness: negation queries where anchor is NOT top-1.
  const negations = perQuery.filter((p) => p.query.intent === "negation");
  const negationOutOfTop1 =
    negations.length === 0
      ? 1
      : negations.filter((p) => p.rank === null || p.rank > 1).length / negations.length;

  const byCategory: Record<string, CategoryMetrics> = {};
  const categories = new Set<AnchorCategory>(perQuery.map((p) => p.query.category));
  for (const category of categories) {
    const forCategory = perQuery.filter((p) => p.query.category === category);
    const intents = new Set<QueryIntent>(forCategory.map((p) => p.query.intent));
    const byIntent: Partial<Record<QueryIntent, IntentMetrics>> = {};
    for (const intent of intents) {
      byIntent[intent] = summarise(forCategory.filter((p) => p.query.intent === intent));
    }
    byCategory[category] = { overall: summarise(forCategory), byIntent };
  }

  return {
    seed: SEED,
    sessionsPerTool: SESSIONS_PER_TOOL,
    anchorRate: ANCHOR_RATE,
    turnsPerSession: TURNS_PER_SESSION,
    totalAnchors: new Set(perQuery.map((p) => p.query.expectedChunkId)).size,
    totalQueries: perQuery.length,
    generatedAt: new Date().toISOString(),
    overall,
    negationOutOfTop1,
    byCategory,
  };
}

function summarise(
  entries: Array<{ query: EvalQuery; rank: number | null }>,
): IntentMetrics {
  if (entries.length === 0) {
    return { queryCount: 0, mrr: 0, recallAt5: 0, recallAt10: 0, top1Accuracy: 0 };
  }

  let mrr = 0;
  let r5 = 0;
  let r10 = 0;
  let top1 = 0;
  for (const entry of entries) {
    if (entry.rank === null) continue;
    mrr += 1 / entry.rank;
    if (entry.rank <= 5) r5++;
    if (entry.rank <= 10) r10++;
    if (entry.rank === 1) top1++;
  }

  const n = entries.length;
  return {
    queryCount: n,
    mrr: mrr / n,
    recallAt5: r5 / n,
    recallAt10: r10 / n,
    top1Accuracy: top1 / n,
  };
}

async function writeResultsArtifact(results: EvalResults): Promise<void> {
  const artifactPath = resolve(__dirname, "results/ranking-latest.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(results, null, 2) + "\n", "utf-8");
}
