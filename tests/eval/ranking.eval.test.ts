/**
 * Retrieval ranking eval.
 *
 * Nothing else in this repo measures whether search is any *good* — the unit
 * tests assert that a query returns the one session that exists, which passes
 * for almost any ranking. This indexes a corpus where many sessions discuss
 * the same topics and exactly one answers each query, then scores the result
 * order against a committed baseline.
 *
 * It runs the real embedding model against the real SQLite index, so it is
 * slow and deliberately kept out of `npm test`:
 *
 *   npm run test:eval                              compare against baseline
 *   XTCTX_UPDATE_EVAL_BASELINE=1 npm run test:eval  rewrite the baseline
 *
 * A metric may drift down by TOLERANCE before the gate fails; anything worse
 * is a regression that needs an explanation in the PR that causes it.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { SessionSearchMode } from "@xtctx/handoff/types";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";
import { generateCorpus, type Anchor, type NegativeQuery } from "./corpus.js";

const BASELINE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "results",
  "ranking-baseline.json",
);
const TOLERANCE = 0.05;
const MODES: SessionSearchMode[] = ["hybrid", "vector", "keyword"];

interface Metrics {
  queries: number;
  mrr: number;
  recallAt5: number;
  top1: number;
  /**
   * Share of queries the corpus genuinely cannot answer — no shared
   * vocabulary, or not language at all — that returned something anyway.
   *
   * The other three metrics only reward finding things, so a change that
   * returns more for every query improves all of them while making search
   * worse. This is the counterweight.
   */
  falsePositiveRate: number;
  /** Same, for queries that are not even well-formed English. */
  gibberishFalsePositiveRate: number;
  /**
   * Queries naming something absent in words the corpus does use.
   *
   * Reported, not policed. Asked about "tidal cache eviction" this corpus has
   * nothing, but it does have cache warming, and offering that is arguable
   * rather than wrong. Counting these as false positives put the rate at 41.7%
   * and sent two rounds of work at a defect that was not there — every query
   * that returned anything was one of these, and every genuinely unanswerable
   * one already returned nothing.
   */
  relatedTopicHitRate: number;
}

type Report = Record<string, Metrics>;

/** Replays a fixed set of chunks; the corpus, not the scraper, is under test. */
class CorpusScraper implements ConversationScraper {
  constructor(
    readonly tool: string,
    private readonly chunks: ConversationChunk[],
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return [`corpus://${this.tool}`];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(): Promise<void> {
    return;
  }
}

function score(
  ranks: Array<number | null>,
  falsePositives: { unanswerable: number[]; gibberish: number[]; related: number[] },
): Metrics {
  const found = ranks.filter((rank): rank is number => rank !== null);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const rate = (hits: number[]) =>
    hits.length === 0 ? 0 : round(hits.filter((count) => count > 0).length / hits.length);
  return {
    queries: ranks.length,
    mrr: round(sum(found.map((rank) => 1 / rank)) / ranks.length),
    recallAt5: round(found.filter((rank) => rank <= 5).length / ranks.length),
    top1: round(found.filter((rank) => rank === 1).length / ranks.length),
    falsePositiveRate: rate([...falsePositives.unanswerable, ...falsePositives.gibberish]),
    gibberishFalsePositiveRate: rate(falsePositives.gibberish),
    relatedTopicHitRate: rate(falsePositives.related),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe("retrieval ranking", () => {
  let tempDir = "";
  let index: SqliteHandoffIndex;
  let anchors: Anchor[] = [];
  let negatives: NegativeQuery[] = [];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-eval-"));
    const corpus = generateCorpus();
    anchors = corpus.anchors;
    negatives = corpus.negatives;

    const byTool = new Map<string, ConversationChunk[]>();
    for (const chunk of corpus.chunks) {
      byTool.set(chunk.tool, [...(byTool.get(chunk.tool) ?? []), chunk]);
    }

    index = new SqliteHandoffIndex(
      join(tempDir, "eval.db"),
      tempDir,
      [...byTool.entries()].map(([tool, chunks]) => ({
        tool,
        scraper: new CorpusScraper(tool, chunks),
      })),
      // Serving a tool call bounds scanning and vectorizing so an agent is
      // never left waiting on a whole machine's history. This harness is
      // measuring ranking quality, not that tradeoff, so it removes the
      // bounds: a truncated index would score the corpus it happened to
      // finish rather than the corpus under test.
      { refreshBudgetMs: 600_000, vectorBudgetMs: 600_000 },
    );

    // Warm the index, then the embedding model and the vectors. `vector` mode
    // rather than the default: hybrid deliberately answers from keyword while
    // the model is still loading, so warming through it would leave the model
    // cold and measure the fallback instead of the ranking.
    await index.listRecentSessions(1);
    await index.searchSessions("warm the embedding model", 1, undefined, "vector");
  }, 600_000);

  afterAll(async () => {
    await index?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ranks the answering session at or near the top", async () => {
    const report: Report = {};

    for (const mode of MODES) {
      const ranks: Array<number | null> = [];
      for (const anchor of anchors) {
        const results = await index.searchSessions(anchor.query, 10, undefined, mode);
        const position = results.findIndex((session) => session.session_ref === anchor.sessionRef);
        ranks.push(position === -1 ? null : position + 1);
      }

      // Queries with no right answer. Counted separately by kind, because a
      // well-formed question about an absent topic and a string of nonsense
      // fail for different reasons and may need different fixes.
      const falsePositives = {
        unanswerable: [] as number[],
        gibberish: [] as number[],
        related: [] as number[],
      };
      for (const negative of negatives) {
        const results = await index.searchSessions(negative.query, 10, undefined, mode);
        falsePositives[negative.kind].push(results.length);
      }

      report[mode] = score(ranks, falsePositives);
    }

    console.log("ranking metrics:", JSON.stringify(report, null, 2));

    const shouldUpdate =
      process.env.XTCTX_UPDATE_EVAL_BASELINE === "1" || !existsSync(BASELINE_PATH);
    if (shouldUpdate) {
      await writeFile(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");
      // A freshly written baseline proves nothing about quality, so still
      // assert the corpus is retrievable at all — otherwise a broken index
      // would happily record its own failure as the new normal.
      expect(report.hybrid.recallAt5).toBeGreaterThan(0.5);
      return;
    }

    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf-8")) as Report;
    const regressions: string[] = [];

    // The false-positive metrics run the other way: returning *more* for a
    // query with no answer is the regression. Checked separately rather than
    // folded into the loop below, because a single "did it go down" rule
    // would have rated a search that answers everything as an improvement on
    // every metric at once.
    for (const mode of MODES) {
      for (const metric of ["falsePositiveRate", "gibberishFalsePositiveRate"] as const) {
        const before = baseline[mode]?.[metric];
        const after = report[mode][metric];
        if (typeof before === "number" && after > before + TOLERANCE) {
          regressions.push(`${mode}.${metric}: ${before} -> ${after} (higher is worse)`);
        }
      }
    }

    for (const mode of MODES) {
      for (const metric of ["mrr", "recallAt5", "top1"] as const) {
        const before = baseline[mode]?.[metric];
        const after = report[mode][metric];
        if (typeof before === "number" && after < before - TOLERANCE) {
          regressions.push(`${mode}.${metric}: ${before} -> ${after}`);
        }
      }
    }

    expect(regressions).toEqual([]);
  }, 900_000);
});

/**
 * The false-positive rate only means anything while the queries it counts are
 * genuinely unanswerable. A single shared word turns one into a question the
 * corpus has a defensible answer for, and the metric quietly starts measuring
 * something else — which is exactly what sent two rounds of work at a defect
 * that was not there.
 */
describe("negative query hygiene", () => {
  it("keeps unanswerable queries free of any corpus vocabulary", () => {
    const corpus = generateCorpus();
    const vocabulary = new Set(
      corpus.chunks
        .map((chunk) => chunk.content.toLowerCase())
        .join(" ")
        .match(/[a-z0-9_./:-]{2,}/g) ?? [],
    );

    const leaks: string[] = [];
    for (const negative of corpus.negatives.filter((entry) => entry.kind === "unanswerable")) {
      const topic = negative.query.replace(/^.*(for|touching) /, "");
      const shared = topic.split(" ").filter((word) => vocabulary.has(word));
      if (shared.length > 0) leaks.push(topic + " shares " + shared.join(","));
    }

    expect(leaks).toEqual([]);
  });
});
