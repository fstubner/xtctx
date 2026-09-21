/**
 * A literal search must not queue behind a scan it never reads.
 *
 * `mode: "literal"` streams the transcript stores directly — that is the whole
 * reason it exists, to answer while the index is still filling. It was still
 * paying `refreshBudgetMs` first, because the refresh happened before the mode
 * was looked at. On the defaults that put four seconds of waiting in front of
 * its own five, on the one route chosen for being fast when the index is cold.
 *
 * The scan is still STARTED — the next caller does read the index, and a
 * literal search is often the first call in a session — it is just not waited
 * on.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * Slow to SCAN, quick to read literally.
 *
 * `scanTool` drives `scrape()`; a literal pass drives `fullSync()`. Splitting
 * them is what isolates the wait under test from the literal read itself —
 * with one slow generator behind both, the test measures its own fixture.
 */
class SlowScraper implements ConversationScraper {
  readonly tool = "codex";
  started = false;

  constructor(private readonly delayMs: number) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    this.started = true;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    // Nothing to serve; this route is being timed, not exercised.
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {
    return;
  }
}

let tempDir = "";
let index: SqliteHandoffIndex;
let scraper: SlowScraper;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "xtctx-literal-wait-"));
  scraper = new SlowScraper(3_000);
  index = new SqliteHandoffIndex(
    join(tempDir, "xtctx.db"),
    tempDir,
    [{ tool: "codex", scraper }],
    // A refresh budget a test can measure against, and a literal budget small
    // enough that the literal pass itself is not what is being timed.
    { refreshBudgetMs: 2_000, literalBudgetMs: 200 },
  );
});

afterEach(async () => {
  await index?.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("a literal search while a scan is running", () => {
  it("answers without waiting out the refresh budget", async () => {
    const started = Date.now();
    await index.searchSessions("anything", 5, undefined, "literal");
    const elapsed = Date.now() - started;

    // Comfortably under the 2s refresh budget it used to sit behind, and well
    // under the 3s scan. Generous upper bound because the literal pass has its
    // own 200ms budget and CI machines are not quiet.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("still starts the scan it declined to wait for", async () => {
    await index.searchSessions("anything", 5, undefined, "literal");

    // The next caller reads the index, so the scan has to be under way.
    expect(scraper.started).toBe(true);
    expect(index.isScanning()).toBe(true);
  });

  it("leaves every other mode waiting as before", async () => {
    const started = Date.now();
    await index.searchSessions("anything", 5, undefined, "keyword");
    const elapsed = Date.now() - started;

    // Keyword reads the index, so it is right for it to pay the budget.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
  });
});
