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
import { generateCorpus, type Anchor } from "./corpus.js";

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

function score(ranks: Array<number | null>): Metrics {
  const found = ranks.filter((rank): rank is number => rank !== null);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    queries: ranks.length,
    mrr: round(sum(found.map((rank) => 1 / rank)) / ranks.length),
    recallAt5: round(found.filter((rank) => rank <= 5).length / ranks.length),
    top1: round(found.filter((rank) => rank === 1).length / ranks.length),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe("retrieval ranking", () => {
  let tempDir = "";
  let index: SqliteHandoffIndex;
  let anchors: Anchor[] = [];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-eval-"));
    const corpus = generateCorpus();
    anchors = corpus.anchors;

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
      report[mode] = score(ranks);
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
