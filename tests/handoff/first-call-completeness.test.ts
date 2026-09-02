/**
 * The first call after a cold start returns a partial answer that reads as a
 * complete one.
 *
 * Observed in a live cross-tool trial: a Codex session and a Claude Code
 * session existed in one repo. The first `xtctx_recent_sessions` call returned
 * only the Claude Code session — the scan had not reached the Codex store
 * inside its budget. The reply carried a note saying "still scanning", which
 * is true and useless: an agent looking for another tool's history sees a
 * plausible list, no sign that the tool it cares about is missing, and
 * concludes there is no cross-tool history to find.
 *
 * The budget itself is not the bug. Waiting for every store on the machine
 * before answering would put the whole scan in front of the first question,
 * and the scan keeps running either way. What was missing is *which* tools
 * have not been read yet — the one fact that turns "here is a list" into
 * "here is a list, and codex is not in it yet".
 *
 * So this pins naming, not timing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import { createRecentSessionsHandler } from "@xtctx/mcp/tools/sessions";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/** Yields one message, after an optional delay that outlives the budget. */
class SlowScraper implements ConversationScraper {
  constructor(
    readonly tool: string,
    private readonly delayMs: number,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return [`fixture://${this.tool}`];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.emit();
  }
  private async *emit(): AsyncIterable<ConversationChunk> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    yield {
      tool: this.tool,
      sessionId: `${this.tool}-session`,
      timestamp: new Date("2026-02-24T10:00:00Z"),
      role: "user",
      content: `a ${this.tool} session`,
      metadata: { messageIndex: 0 },
    };
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

describe("a partial first answer says what is missing", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-firstcall-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** One fast tool and one slower than the answer budget. */
  function buildIndex(budgetMs: number): SqliteHandoffIndex {
    return new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      "H:/projects/app",
      [
        { tool: "claude-code", scraper: new SlowScraper("claude-code", 0) },
        { tool: "codex", scraper: new SlowScraper("codex", 400) },
      ],
      { refreshBudgetMs: budgetMs },
    );
  }

  it("names the tool it has not read yet", async () => {
    index = buildIndex(40);
    const handler = createRecentSessionsHandler(index);

    const output = (await handler({ limit: 10 })) as string;

    // The answer it can give is still given…
    expect(output).toContain("claude-code");
    // …and the gap in it is named, not merely implied by "still scanning".
    expect(output).toMatch(/codex/);
    expect(output).toMatch(/not (yet )?(been )?(read|scanned)/i);
  });

  it("says nothing about unread tools once every store has been read", async () => {
    // The note has to disappear, or it becomes background noise that stops
    // meaning anything on the call where it matters.
    index = buildIndex(30_000);
    const handler = createRecentSessionsHandler(index);

    const output = (await handler({ limit: 10 })) as string;

    expect(output).toContain("claude-code");
    expect(output).toContain("codex");
    expect(output).not.toMatch(/not (yet )?(been )?(read|scanned)/i);
  });
});
