/**
 * A scan runs on the thread that answers tool calls, over synchronous SQLite.
 *
 * Measured before these tests existed, on a 15,000-message corpus: a request
 * needing no index at all (`tools/list`) waited up to 3.8 seconds behind the
 * scan; a server told to shut down mid-scan sat out its whole two-second grace
 * window and was then killed by its own timer, so it never closed the index;
 * and with several servers open, write-ahead logs of up to 30MB stayed behind
 * after every server had exited.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScanLease } from "@xtctx/handoff/scan-lease";
import { openDatabase } from "@xtctx/handoff/schema";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/** Turns are long in real transcripts, and building windows costs with their text. */
const WORDS = Array.from({ length: 300 }, (_, i) => `word${i % 97} parser fallback budget`).join(" ");

function chunk(session: number, index: number): ConversationChunk {
  return {
    tool: "codex",
    sessionId: `s${session}`,
    timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + index * 1000),
    role: index % 2 === 0 ? "user" : "assistant",
    content: `session ${session} message ${index} ${WORDS}`,
    metadata: { messageIndex: index, tokenEstimate: 1, layer: 0 },
  };
}

/** Yields without ever touching I/O, so nothing in it lets the event loop turn. */
class InMemoryScraper implements ConversationScraper {
  readonly tool = "codex";
  saves = 0;
  constructor(private readonly chunks: () => Iterable<ConversationChunk>) {}
  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.chunks();
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks();
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {
    this.saves += 1;
  }
}

describe("a scan shares its thread", () => {
  let dir = "";
  let dbPath = "";
  let index: SqliteHandoffIndex | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-shutdown-"));
    dbPath = join(dir, "xtctx.db");
  });

  afterEach(async () => {
    await index?.close().catch(() => {});
    index = undefined;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // Many short sessions, as the index first meets most projects, and one long
  // one, which is what a session's windows cost the most on.
  it.each([
    { corpus: "many short sessions", sessions: 40, messages: 40 },
    { corpus: "one long session", sessions: 1, messages: 1_600 },
  ])("lets the event loop turn while it works: $corpus", async ({ sessions, messages }) => {
    const scraper = new InMemoryScraper(function* () {
      for (let s = 0; s < sessions; s++) for (let i = 0; i < messages; i++) yield chunk(s, i);
    });
    index = new SqliteHandoffIndex(dbPath, dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    // Opened before the clock starts: this is about the scan. Opening creates
    // the schema in synchronous commits of its own, and with the disk busy it
    // was once the longest stretch measured here (4.3s), before the scan had
    // begun.
    await index.listIndexedSessions(1);

    let last = Date.now();
    let longestGap = 0;
    const ticker = setInterval(() => {
      longestGap = Math.max(longestGap, Date.now() - last);
      last = Date.now();
    }, 5);
    const started = Date.now();
    let took = 0;
    try {
      await index.listRecentSessions(5);
      await index.whenScanSettled();
      took = Date.now() - started;
      // A block that ends the scan is only seen by the ticker's next run.
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      clearInterval(ticker);
    }

    // Relative, so a loaded machine slowing everything down does not fail it.
    // Before, one stretch held the thread for over nine-tenths of the scan
    // (1,515ms of 1,621ms on the short sessions). After that the longest were
    // a session's windows, built in one transaction (up to 1,721ms of a
    // 2,188ms scan of the long session), and a commit flushing to a disk
    // other processes were writing to (4,445ms of a 6,515ms scan of the short
    // ones). Windows now go in in batches, and the flushing happens on
    // a worker thread (see `WalCheckpointer`).
    // The floor only checks the corpus gave the ratio something to measure.
    // It was 1,000ms and failed at 994ms on a fast CI runner; the ratio below
    // is the assertion that matters.
    expect(took).toBeGreaterThan(500);
    expect(longestGap).toBeLessThan(took / 4);
  });

  it("stops at its next checkpoint when the index closes, and claims nothing it did not finish", async () => {
    const scraper = new InMemoryScraper(function* () {
      for (let i = 0; ; i++) yield chunk(i % 50, Math.floor(i / 50));
    });
    index = new SqliteHandoffIndex(dbPath, dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    await index.listRecentSessions(5);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const started = Date.now();
    await index.close();
    index = undefined;

    expect(Date.now() - started).toBeLessThan(1_000);
    // Nothing recorded as read past what was written...
    expect(scraper.saves).toBe(0);
    // ...what was written stays written, and the lease is free for the next server.
    const db = openDatabase(dbPath);
    try {
      expect((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c).toBeGreaterThan(0);
      expect(new ScanLease(db).tryAcquire()).toBe(true);
    } finally {
      db.close();
    }
  });

  it("empties the write-ahead log on close while another server still has the index open", async () => {
    const scraper = new InMemoryScraper(function* () {
      for (let s = 0; s < 20; s++) for (let i = 0; i < 40; i++) yield chunk(s, i);
    });
    index = new SqliteHandoffIndex(dbPath, dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    await index.listRecentSessions(5);
    await index.whenScanSettled();

    // Another server's connection. SQLite only cleans the log up by itself
    // when the last connection closes, and with one server per agent session
    // that is rarely the one that wrote it.
    const other = new Database(dbPath);
    try {
      other.prepare("SELECT COUNT(*) FROM sessions").get();
      await index.close();
      index = undefined;

      const wal = `${dbPath}-wal`;
      expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    } finally {
      other.close();
    }
  });

  // Windows now go in over many transactions, so a scan can stop between two
  // of them. What it leaves must be safe to find in that state: the session
  // still marked for the windows it did not get, the keyword index matching
  // the windows, and the next scan finishing the job.
  it("leaves a session it stopped windowing marked, and the next scan finishes it", async () => {
    const sessionRef = "codex:s0";
    const scraper = new InMemoryScraper(function* () {
      for (let i = 0; i < 1_600; i++) yield chunk(0, i);
    });
    index = new SqliteHandoffIndex(dbPath, dir, [{ tool: "codex", scraper }], {
      refreshBudgetMs: 0,
    });
    await index.listIndexedSessions(1);

    // 8-message windows every 4 messages over 1,600 messages.
    const allWindows = 399;
    const reader = new Database(dbPath, { readonly: true });
    const count = (sql: string) => (reader.prepare(sql).get(sessionRef) as { c: number }).c;
    const unitsSql = "SELECT COUNT(*) AS c FROM retrieval_units WHERE session_ref = ?";
    const ftsSql = "SELECT COUNT(*) AS c FROM retrieval_units_fts WHERE session_ref = ?";
    const markSql = "SELECT COUNT(*) AS c FROM settings WHERE key = 'units_stale:' || ?";
    let seenMidway = -1;
    try {
      let closing: Promise<void> | undefined;
      const watcher = setInterval(() => {
        const units = count(unitsSql);
        if (!closing && units > 0) {
          seenMidway = units;
          closing = index!.close();
        }
      }, 2);
      try {
        await index.listRecentSessions(5);
        await index.whenScanSettled();
        await closing;
      } finally {
        clearInterval(watcher);
      }
      index = undefined;

      // Stopped partway: in one transaction this saw all of them or none.
      expect(seenMidway).toBeGreaterThan(0);
      expect(seenMidway).toBeLessThan(allWindows);
      const leftUnits = count(unitsSql);
      expect(leftUnits).toBeLessThan(allWindows);
      expect(count(ftsSql)).toBe(leftUnits);
      expect(count(markSql)).toBe(1);

      const nothingNew = new InMemoryScraper(() => []);
      index = new SqliteHandoffIndex(dbPath, dir, [{ tool: "codex", scraper: nothingNew }], {
        refreshBudgetMs: 0,
      });
      await index.listRecentSessions(5);
      await index.whenScanSettled();

      expect(count(unitsSql)).toBe(allWindows);
      expect(count(ftsSql)).toBe(allWindows);
      expect(count(markSql)).toBe(0);
    } finally {
      reader.close();
    }
  });
});
