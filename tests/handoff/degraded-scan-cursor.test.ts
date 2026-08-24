import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * A scan that ends in failure must not move the incremental cursor.
 *
 * This is what makes a degraded Antigravity scan survivable. That reader falls
 * back to a handful of recent brain artifacts when the language server cannot
 * be read, while the server itself holds a thousand older messages. If the
 * cursor advanced to the timestamps of those few recent artifacts, every older
 * message would sit permanently behind it and no later scan would ever look
 * again.
 */
class PartialScraper implements ConversationScraper {
  readonly tool = "codex";
  saved: ScraperState[] = [];

  constructor(
    private readonly chunks: ConversationChunk[],
    private readonly failAtEnd: boolean,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }

  private async *emit(): AsyncIterable<ConversationChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
    if (this.failAtEnd) {
      throw new Error("antigravity scan incomplete: 3 of 24 trajectories could not be fetched");
    }
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    this.saved.push(state);
  }
}

function chunk(minutesAgo: number, content: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "degraded",
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    role: "user",
    content,
    metadata: { messageIndex: 0 },
  };
}

describe("cursor handling for a scan that fails partway", () => {
  let projectRoot = "";

  async function runScan(scraper: PartialScraper): Promise<void> {
    const index = new SqliteHandoffIndex(
      join(projectRoot, ".xtctx", "state", "xtctx.db"),
      projectRoot,
      [{ tool: "codex", scraper }],
      { refreshBudgetMs: 10_000 },
    );
    await index.listRecentSessions(5);
    await index.whenScanSettled();
    await index.close();
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-degraded-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("does not advance the cursor when the scan ends in failure", async () => {
    const scraper = new PartialScraper([chunk(5, "the little that could be read")], true);

    await runScan(scraper);

    expect(scraper.saved).toEqual([]);
  });

  it("keeps what the failed scan did manage to read", async () => {
    const scraper = new PartialScraper([chunk(5, "the little that could be read")], true);

    await runScan(scraper);

    // Re-opened read-only: the chunks were upserted as they arrived, so a
    // degraded scan is still worth more than nothing.
    const index = new SqliteHandoffIndex(
      join(projectRoot, ".xtctx", "state", "xtctx.db"),
      projectRoot,
      [],
    );
    try {
      const sessions = await index.listRecentSessions(5);
      expect(sessions).toHaveLength(1);
    } finally {
      await index.close();
    }
  });

  it("does advance the cursor when the scan completes", async () => {
    const scraper = new PartialScraper([chunk(5, "read in full")], false);

    await runScan(scraper);

    expect(scraper.saved).toHaveLength(1);
  });
});
