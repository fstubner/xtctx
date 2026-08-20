import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { EmbeddingProvider } from "@xtctx/handoff/embeddings";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class FixtureScraper implements ConversationScraper {
  readonly tool = "codex";
  detectCalls = 0;
  fullSyncCalls = 0;

  constructor(private readonly chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    this.detectCalls += 1;
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    this.fullSyncCalls += 1;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(_state: ScraperState): Promise<void> {
    return;
  }
}

class FailingScraper implements ConversationScraper {
  readonly tool = "codex";

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    throw new Error("boom: transcript store unreadable");
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    throw new Error("boom: transcript store unreadable");
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(_state: ScraperState): Promise<void> {
    return;
  }
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fixture-embedding";
  embeddedTexts = 0;

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.embeddedTexts += texts.length;
    return texts.map((text) => fixtureVector(text));
  }
}

describe("SqliteHandoffIndex", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-index-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("indexes lazily and preserves same-timestamp messages", async () => {
    const scraper = new FixtureScraper([
      chunk("same-time-session", 0, "user", "first message"),
      chunk("same-time-session", 1, "assistant", "second message"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const recent = await index.listRecentSessions(5);
    const detail = await index.getSessionDetail("codex:same-time-session", 0, 10);

    expect(scraper.fullSyncCalls).toBe(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].message_count).toBe(2);
    expect(detail.map((message) => message.content)).toEqual([
      "first message",
      "second message",
    ]);

    await index.close();
  });

  it("searches indexed transcript content through SQLite FTS", async () => {
    const scraper = new FixtureScraper([
      chunk("search-session", 0, "user", "investigate token refresh regression"),
      chunk("search-session", 1, "assistant", "patched the auth callback"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const results = await index.searchSessions("token", 5, undefined, "keyword");

    expect(results.map((session) => session.session_ref)).toEqual(["codex:search-session"]);

    await index.close();
  });

  it("keeps status bounded and does not trigger transcript indexing", async () => {
    const scraper = new FixtureScraper([
      chunk("status-session", 0, "user", "this should not be indexed by status"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const status = await index.getStatus();

    expect(scraper.detectCalls).toBe(1);
    expect(scraper.fullSyncCalls).toBe(0);
    expect(status.sessions).toBe(0);
    expect(status.messages).toBe(0);

    await index.close();
  });

  it("keyword search ranks by relevance, not recency", async () => {
    const scraper = new FixtureScraper([
      chunk("relevant-session", 0, "user", "sqlite sqlite sqlite deep dive", "2026-05-01T10:00:00.000Z"),
      chunk("relevant-session", 1, "assistant", "more sqlite internals and sqlite tuning", "2026-05-01T10:01:00.000Z"),
      chunk("recent-session", 0, "user", "unrelated planning notes", "2026-05-20T10:00:00.000Z"),
      chunk("recent-session", 1, "assistant", "a passing sqlite mention", "2026-05-20T10:01:00.000Z"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const results = await index.searchSessions("sqlite", 5, undefined, "keyword");

    expect(results.map((session) => session.session_ref)).toEqual([
      "codex:relevant-session",
      "codex:recent-session",
    ]);

    await index.close();
  });

  it("does not zero the score when only one candidate survives", async () => {
    // Semantic scores are rescaled across a query's candidates, which maps
    // the weakest to 0. With a single survivor there is nothing to rescale
    // against, and treating it as the weakest would score the only match at
    // zero and drop it below anything else.
    const scraper = new FixtureScraper([
      chunk("solo-session", 0, "user", "sqlite vector handoff"),
      chunk("solo-session", 1, "assistant", "chronological windows"),
    ]);
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper }],
      { embeddingProvider: new FixtureEmbeddingProvider(), windowSize: 8, windowStride: 8 },
    );

    const results = await index.searchSessions("sqlite vector", 5, undefined, "vector");

    expect(results).toHaveLength(1);
    expect(results[0].score ?? 0).toBeGreaterThan(0);

    await index.close();
  });

  it("returns nothing for a hybrid query with no relevance to the corpus", async () => {
    // Cosine similarity normalises to ~0.5 for unrelated content, so with
    // recency and continuity added every session scored 0.49-0.76 and was
    // returned formatted exactly like a real hit — the calling agent cannot
    // tell "nearest vector" from "actually relevant".
    const scraper = new FixtureScraper([
      chunk("corpus-session", 0, "user", "sqlite vector handoff notes"),
      chunk("corpus-session", 1, "assistant", "chronological windows"),
    ]);
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper }],
      { embeddingProvider: new FixtureEmbeddingProvider(), windowSize: 2, windowStride: 1 },
    );

    const nonsense = await index.searchSessions("SECRETLEAKCANARY", 5, undefined, "hybrid");
    const real = await index.searchSessions("sqlite vector", 5, undefined, "hybrid");

    expect(nonsense).toEqual([]);
    expect(real.map((session) => session.session_ref)).toEqual(["codex:corpus-session"]);

    await index.close();
  });

  it("does not match on xtctx's own window scaffolding", async () => {
    // Retrieval windows are wrapped in "Session: …", "Turn 1/2 |
    // message_index=0 | user @ …" headers that give the embedding model
    // ordering context. Indexing that text for keyword search meant
    // searching `message_index` or a tool name matched every session.
    const scraper = new FixtureScraper([
      chunk("scaffold-session", 0, "user", "we discussed pricing tiers"),
      chunk("scaffold-session", 1, "assistant", "and the renewal flow"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    expect(await index.searchSessions("message_index", 5, undefined, "keyword")).toEqual([]);
    expect(await index.searchSessions("Chronological", 5, undefined, "keyword")).toEqual([]);
    // Real transcript text still matches.
    expect(
      (await index.searchSessions("pricing", 5, undefined, "keyword")).map((s) => s.session_ref),
    ).toEqual(["codex:scaffold-session"]);

    await index.close();
  });

  it("looks up a session by ref regardless of recency", async () => {
    const scraper = new FixtureScraper([
      chunk("lookup-session", 0, "user", "find me by ref"),
    ]);
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper },
    ]);

    const found = await index.getSessionByRef("codex:lookup-session");
    const missing = await index.getSessionByRef("codex:no-such-session");

    expect(found?.session_ref).toBe("codex:lookup-session");
    expect(found?.message_count).toBe(1);
    expect(missing).toBeNull();

    await index.close();
  });

  it("does not re-embed unchanged windows when a session is re-indexed", async () => {
    const provider = new FixtureEmbeddingProvider();
    const chunks = [
      chunk("stable-session", 0, "user", "alpha sqlite message"),
      chunk("stable-session", 1, "assistant", "beta vector message"),
      chunk("stable-session", 2, "user", "gamma handoff message"),
    ];
    const dbPath = join(tempDir, "xtctx.db");
    const options = { embeddingProvider: provider, windowSize: 2, windowStride: 1 };

    const first = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper(chunks) },
    ], options);
    await first.searchSessions("sqlite", 5, undefined, "vector");
    await first.close();
    const afterFirst = provider.embeddedTexts;

    const second = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper(chunks) },
    ], options);
    await second.searchSessions("sqlite", 5, undefined, "vector");
    await second.close();

    // The second search re-indexes identical content, so only the query
    // itself should be embedded — never the unchanged windows.
    expect(provider.embeddedTexts).toBe(afterFirst + 1);
  });

  it("re-indexing the same content leaves all counts unchanged", async () => {
    const chunks = [
      chunk("idem-session", 0, "user", "alpha message"),
      chunk("idem-session", 1, "assistant", "beta message"),
    ];
    const dbPath = join(tempDir, "xtctx.db");

    const first = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper(chunks) },
    ]);
    await first.listRecentSessions(5);
    const statusFirst = await first.getStatus();
    await first.close();

    const second = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper(chunks) },
    ]);
    await second.listRecentSessions(5);
    const statusSecond = await second.getStatus();
    await second.close();

    expect(statusSecond.sessions).toBe(statusFirst.sessions);
    expect(statusSecond.messages).toBe(statusFirst.messages);
    expect(statusSecond.retrieval_units).toBe(statusFirst.retrieval_units);
  });

  it("surfaces an embedding failure instead of silently degrading to keyword", async () => {
    class BrokenEmbeddingProvider {
      readonly model = "broken-embedding";
      async embed(): Promise<Float32Array> {
        throw new Error("embedding model unavailable");
      }
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error("embedding model unavailable");
      }
    }

    const scraper = new FixtureScraper([
      chunk("degraded-session", 0, "user", "sqlite handoff notes"),
    ]);
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper }],
      { embeddingProvider: new BrokenEmbeddingProvider() },
    );

    // Hybrid still answers from keyword, but the failure must not be silent.
    const results = await index.searchSessions("sqlite", 5, undefined, "hybrid");
    const status = await index.getStatus();

    expect(results.length).toBeGreaterThan(0);
    expect(status.embedding_error).toContain("embedding model unavailable");

    await index.close();
  });

  it("rebuilds a corrupt index database instead of crashing", async () => {
    const dbPath = join(tempDir, "xtctx.db");
    await writeFile(dbPath, "this is not a sqlite database", "utf-8");
    const scraper = new FixtureScraper([chunk("recovered-session", 0, "user", "hello again")]);
    const index = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);

    const recent = await index.listRecentSessions(5);

    expect(recent).toHaveLength(1);
    expect(recent[0].session_ref).toBe("codex:recovered-session");

    await index.close();
  });

  it("clears scraper cursors when the index file was deleted, not just corrupted", async () => {
    // Deleting the db is the recovery the docs actively invite ("can always
    // be deleted and rebuilt"). A missing file opens cleanly, so the
    // corrupt-path cursor reset never ran: the fresh index was topped up from
    // each stale cursor forward and older sessions vanished with no warning.
    const dbPath = join(tempDir, "xtctx.db");
    const cursorPath = join(tempDir, "codex-state.json");
    await writeFile(
      cursorPath,
      JSON.stringify({ lastTimestamp: "2030-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const index = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper([chunk("s", 0, "user", "hi")]) },
    ]);
    await index.listRecentSessions(5);

    await expect(readFile(cursorPath, "utf-8")).rejects.toThrow();

    await index.close();
  });

  it("clears scraper cursors when it rebuilds, so no history is skipped", async () => {
    // A rebuilt index starts empty, but a surviving cursor means each scraper
    // only tops up from its last position forward — sessions still on disk
    // vanish silently. `setup --repair` clears the whole state dir; the
    // automatic path must not be lossier than the documented manual one.
    const dbPath = join(tempDir, "xtctx.db");
    const cursorPath = join(tempDir, "codex-state.json");
    await writeFile(dbPath, "this is not a sqlite database", "utf-8");
    await writeFile(
      cursorPath,
      JSON.stringify({ lastTimestamp: "2030-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const index = new SqliteHandoffIndex(dbPath, tempDir, [
      { tool: "codex", scraper: new FixtureScraper([chunk("s", 0, "user", "hi")]) },
    ]);
    await index.listRecentSessions(5);

    await expect(readFile(cursorPath, "utf-8")).rejects.toThrow();

    await index.close();
  });

  it("rebuilds when the stored schema version does not match", async () => {
    const dbPath = join(tempDir, "xtctx.db");
    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE sessions (session_ref TEXT PRIMARY KEY)");
    legacy.pragma("user_version = 999");
    legacy.close();

    const scraper = new FixtureScraper([chunk("fresh-session", 0, "user", "fresh start")]);
    const index = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);

    const recent = await index.listRecentSessions(5);

    expect(recent).toHaveLength(1);
    expect(recent[0].session_ref).toBe("codex:fresh-session");

    await index.close();
  });

  it("surfaces scraper failures in status instead of hiding them", async () => {
    const index = new SqliteHandoffIndex(join(tempDir, "xtctx.db"), tempDir, [
      { tool: "codex", scraper: new FailingScraper() },
    ]);

    await index.listRecentSessions(5);
    const status = await index.getStatus();

    const tool = status.tools.find((entry) => entry.tool === "codex");
    expect(tool?.last_error).toContain("boom");

    await index.close();
  });

  it("semantic search embeds chronological transcript windows", async () => {
    const scraper = new FixtureScraper([
      chunk("semantic-session", 0, "user", "initial idea: use an external vector store"),
      chunk("semantic-session", 1, "assistant", "switch to sqlite vector storage"),
      chunk("semantic-session", 2, "user", "final state: chronological handoff windows"),
    ]);
    const index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper }],
      {
        embeddingProvider: new FixtureEmbeddingProvider(),
        windowSize: 2,
        windowStride: 1,
      },
    );

    const results = await index.searchSessions("chronological sqlite vector", 5, undefined, "vector");
    const [match] = results[0].matches ?? [];
    const status = await index.getStatus();

    expect(results[0]).toMatchObject({
      session_ref: "codex:semantic-session",
      retrieval: "vector",
    });
    expect(match).toMatchObject({
      message_start_index: 1,
      message_end_index: 2,
    });
    expect(status.retrieval_units).toBe(2);
    expect(status.vectorized_units).toBe(2);
    expect(status.vector_model).toBe("fixture-embedding");

    await index.close();
  });
});

function chunk(
  sessionId: string,
  messageIndex: number,
  role: ConversationChunk["role"],
  content: string,
  timestamp = "2026-05-10T10:00:00.000Z",
): ConversationChunk {
  return {
    tool: "codex",
    sessionId,
    timestamp: new Date(timestamp),
    role,
    content,
    metadata: {
      messageIndex,
      tokenEstimate: 1,
      layer: 0,
    },
  };
}

function fixtureVector(text: string): Float32Array {
  const dimensions = [
    "token",
    "auth",
    "sqlite",
    "vector",
    "chronological",
    "handoff",
    "external",
  ];
  const normalized = text.toLowerCase();
  const vector = new Float32Array(dimensions.length);
  dimensions.forEach((term, index) => {
    vector[index] = normalized.includes(term) ? 1 : 0;
  });

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm === 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] *= scale;
  }
  return vector;
}
