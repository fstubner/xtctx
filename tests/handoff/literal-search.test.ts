/**
 * Literal search answers without the index, which is the point and also the
 * risk.
 *
 * The point: every other mode reads `retrieval_units`, so every other mode is
 * only as good as the last scan. That is the wrong dependency at the moment
 * the question is asked most — the first session after another tool worked
 * here. Two live trials ended with the agent grepping `~/.codex/sessions` by
 * hand after the tools gave it nothing, and getting the right answer that way.
 *
 * The risk: a grep over a transcript store returns every project's
 * conversations. This route must not become the hole in the boundary the rest
 * of the project spent its effort closing, so it streams what a scraper
 * yields — attribution already applied — rather than reading files itself.
 * The first test is that one, and it is the reason this file exists.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { literalSearch } from "@xtctx/handoff/literal-search";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/** Yields what it is given, the way a scraper yields what it attributed. */
class FixtureScraper implements ConversationScraper {
  scrapes = 0;

  constructor(
    readonly tool: string,
    private readonly chunks: ConversationChunk[],
    private readonly delayMs = 0,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return [`fixture://${this.tool}`];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    this.scrapes += 1;
    for (const chunk of this.chunks) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      yield chunk;
    }
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

/** A scraper whose store cannot be read at all. */
class BrokenScraper implements ConversationScraper {
  readonly tool = "cursor";
  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://cursor"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    throw new Error("store unreadable");
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {}
}

function chunk(
  tool: string,
  sessionId: string,
  index: number,
  content: string,
): ConversationChunk {
  return {
    tool,
    sessionId,
    timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + index * 1000),
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

const budget = { limit: 5, budgetMs: 30_000 };

describe("literal search", () => {
  it("returns only what the scraper attributed to this project", async () => {
    // The boundary. A scraper scoped to a project yields that project's
    // chunks and nothing else, and this route must not widen that — it has no
    // business reading a store directly, precisely because a grep would.
    const ours = new FixtureScraper("codex", [
      chunk("codex", "ours", 0, "the tokenrefresh regression we chased"),
    ]);

    const { sessions } = await literalSearch([{ tool: "codex", scraper: ours }], "tokenrefresh", budget);

    expect(sessions.map((s) => s.session_ref)).toEqual(["codex:ours"]);
    // Whatever a foreign transcript contains, this route never saw it: the
    // scraper is the only source, and it already applied the filter.
    expect(ours.scrapes).toBe(1);
  });

  it("finds a match with nothing indexed at all", async () => {
    // The whole reason for the route: no database is touched here.
    const { sessions, exhausted } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [
            chunk("codex", "a", 0, "we rejected the reduce-based approach"),
            chunk("codex", "a", 1, "map states the intent better"),
          ]),
        },
      ],
      "reduce-based",
      budget,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].retrieval).toBe("literal");
    expect(sessions[0].matches?.[0]?.preview).toContain("reduce-based");
    expect(exhausted).toBe(true);
  });

  it("matches without regard to case", async () => {
    const { sessions } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [chunk("codex", "a", 0, "The Parser Fallback")]),
        },
      ],
      "parser fallback",
      budget,
    );

    expect(sessions).toHaveLength(1);
  });

  it("says so when it stopped on the session limit", async () => {
    // "No more matches" and "I stopped looking" are different answers, and
    // this route cannot tell the caller which unless it reports the stop.
    const many = Array.from({ length: 6 }, (_, i) => chunk("codex", `s${i}`, 0, "shared term"));
    const { sessions, exhausted } = await literalSearch(
      [{ tool: "codex", scraper: new FixtureScraper("codex", many) }],
      "shared term",
      { limit: 2, budgetMs: 30_000 },
    );

    expect(sessions).toHaveLength(2);
    expect(exhausted).toBe(false);
  });

  it("says so when it ran out of time", async () => {
    const slow = new FixtureScraper(
      "codex",
      Array.from({ length: 50 }, (_, i) => chunk("codex", `s${i}`, 0, "no match here")),
      20,
    );

    const { sessions, exhausted } = await literalSearch(
      [{ tool: "codex", scraper: slow }],
      "never appears",
      { limit: 5, budgetMs: 60 },
    );

    expect(sessions).toEqual([]);
    expect(exhausted).toBe(false);
  });

  it("keeps the matches it found when another store cannot be read", async () => {
    const { sessions, exhausted } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [chunk("codex", "a", 0, "found this one")]),
        },
        { tool: "cursor", scraper: new BrokenScraper() },
      ],
      "found this",
      budget,
    );

    expect(sessions.map((s) => s.session_ref)).toEqual(["codex:a"]);
    // Incomplete, and it says so rather than reporting a clean sweep.
    expect(exhausted).toBe(false);
  });

  /**
   * Naming the store is the difference between a retry that can work and one
   * that never will.
   *
   * A broken store and an exhausted budget both set `exhausted: false`, and
   * that was all the caller got — so it told the user the pass "stopped at its
   * limit or time budget" and advised narrowing the query. Against a store
   * that throws, every narrower query returns the same nothing, and the tool
   * that is actually broken is never mentioned.
   */
  it("names the store it could not read", async () => {
    const { unreadable } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [chunk("codex", "a", 0, "found this one")]),
        },
        { tool: "cursor", scraper: new BrokenScraper() },
      ],
      "found this",
      budget,
    );

    expect(unreadable).toEqual(["cursor"]);
  });

  it("names no store when the pass merely ran out of budget", async () => {
    // The other half: hitting a limit is not a broken store, and reporting one
    // would send the reader to check a tool that is working.
    const { exhausted, unreadable } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [
            chunk("codex", "a", 0, "found this one"),
            chunk("codex", "b", 0, "found this too"),
          ]),
        },
      ],
      "found this",
      { limit: 1, budgetMs: budget.budgetMs },
    );

    expect(exhausted).toBe(false);
    expect(unreadable).toEqual([]);
  });

  it("reads only the tools it was asked for", async () => {
    const codex = new FixtureScraper("codex", [chunk("codex", "a", 0, "shared term")]);
    const cursor = new FixtureScraper("cursor", [chunk("cursor", "b", 0, "shared term")]);

    const { sessions } = await literalSearch(
      [
        { tool: "codex", scraper: codex },
        { tool: "cursor", scraper: cursor },
      ],
      "shared term",
      budget,
      ["cursor"],
    );

    expect(sessions.map((s) => s.session_ref)).toEqual(["cursor:b"]);
    // Not merely filtered afterwards — the other store was never opened.
    expect(codex.scrapes).toBe(0);
  });

  it("groups several hits in one session rather than repeating the session", async () => {
    const { sessions } = await literalSearch(
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [
            chunk("codex", "a", 0, "the fallback again"),
            chunk("codex", "a", 1, "still the fallback"),
            chunk("codex", "a", 2, "fallback once more"),
          ]),
        },
      ],
      "fallback",
      budget,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].matches).toHaveLength(3);
    expect(sessions[0].message_count).toBe(3);
  });
});

/**
 * The mode reaching the route through the real index, and — the part that
 * matters — answering from a database with nothing in it.
 */
describe("literal mode through the index", () => {
  let dir = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-literal-"));
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("answers before anything has been indexed", async () => {
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      dir,
      [
        {
          tool: "codex",
          scraper: new FixtureScraper("codex", [
            chunk("codex", "cold", 0, "the decision only codex knows about tokenrefresh"),
          ]),
        },
      ],
      // No wait for a scan at all: whatever this returns, it did not come from
      // an index built during this call.
      { refreshBudgetMs: 0 },
    );

    // Nothing indexed at this point, and asserted before the search rather
    // than after: `getStatus` refreshes, so asking afterwards would build the
    // very units whose absence is the point.
    expect(index.getIndexProgress().vectorBacklog).toBe(0);

    const results = await index.searchSessions("tokenrefresh", 5, undefined, "literal");

    expect(results.map((s) => s.session_ref)).toEqual(["codex:cold"]);
    expect(results[0].retrieval).toBe("literal");
    // Still nothing indexed: the answer came from the stores, not the index.
    expect(index.getIndexProgress().vectorBacklog).toBe(0);
    expect(index.getIndexProgress().unreadTools).toContain("codex");
  });

  it("reports an early stop through index progress", async () => {
    index = new SqliteHandoffIndex(
      join(dir, "xtctx.db"),
      dir,
      [
        {
          tool: "codex",
          scraper: new FixtureScraper(
            "codex",
            Array.from({ length: 4 }, (_, i) => chunk("codex", `s${i}`, 0, "shared term")),
          ),
        },
      ],
      { refreshBudgetMs: 0 },
    );

    await index.searchSessions("shared term", 1, undefined, "literal");

    expect(index.getIndexProgress().literalSearchStoppedEarly).toBe(true);
  });
});
