/**
 * Advice from a literal search belongs to that search, not to the index.
 *
 * `literalSearchStoppedEarly` and `literalUnreadableTools` were written by a
 * literal pass and never cleared, while `getIndexProgress` — which every tool
 * calls to build its progress note — reports them. So one truncated literal
 * search attached "The literal pass stopped at its limit or time budget.
 * Narrow the query or raise `limit`." to every later `xtctx_recent_sessions`
 * and `xtctx_session_detail` answer for the life of the process.
 *
 * Those calls carry no query to narrow. An agent either follows advice that
 * cannot apply, or learns to ignore these notes — which costs the ones that do
 * matter, like a tool whose store could not be read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import { NullEmbeddingProvider } from "@xtctx/handoff/null-embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

let tempDir = "";

/** Enough messages that a one-result literal budget has to stop early. */
class ChattyScraper implements ConversationScraper {
  readonly tool = "codex";
  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["memory://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    for (let index = 0; index < 12; index += 1) {
      yield {
        tool: "codex",
        sessionId: `session-${index}`,
        timestamp: new Date(Date.UTC(2026, 8, 21, 0, index)),
        role: "user",
        content: `we changed the retry budget again, note ${index}`,
        metadata: { messageIndex: 0, tokenEstimate: 1, layer: 0 },
      };
    }
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "xtctx-literal-advice-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeIndex(): SqliteHandoffIndex {
  return new SqliteHandoffIndex(
    join(tempDir, "advice.db"),
    tempDir,
    [{ tool: "codex", scraper: new ChattyScraper() }],
    { embeddingProvider: new NullEmbeddingProvider(), refreshBudgetMs: 30_000 },
  );
}

describe("literal search advice", () => {
  it("does not follow a later call that has no query to narrow", async () => {
    const index = makeIndex();
    try {
      // A literal pass capped low enough that it cannot finish.
      await index.searchSessions("retry budget", 1, undefined, "literal");
      const afterLiteral = index.getIndexProgress?.();
      expect(afterLiteral?.literalSearchStoppedEarly).toBe(true);

      // A different question entirely. `recent_sessions` takes no query.
      await index.listRecentSessions(5);

      expect(index.getIndexProgress?.().literalSearchStoppedEarly).toBeUndefined();
    } finally {
      await index.close();
    }
  });

  it("is also dropped before a detail call", async () => {
    const index = makeIndex();
    try {
      const sessions = await index.searchSessions("retry budget", 1, undefined, "literal");
      expect(index.getIndexProgress?.().literalSearchStoppedEarly).toBe(true);

      await index.getSessionDetail(sessions[0]?.session_ref ?? "codex:session-0", 0, 5);

      expect(index.getIndexProgress?.().literalSearchStoppedEarly).toBeUndefined();
    } finally {
      await index.close();
    }
  });
});
