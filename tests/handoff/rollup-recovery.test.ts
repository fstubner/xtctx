/**
 * `message_count` and `preview` are rolled up once per scan, after every
 * scraper has finished, and only for the sessions that scan touched
 * (`sqlite-index.ts`, the `touchedSessions` loop). Each scraper advances its
 * own cursor as soon as *it* finishes, though — well before that roll-up runs.
 *
 * So there is a window where a scraper's messages are committed and its cursor
 * has moved past them, but the roll-up has not happened yet. With seven
 * scrapers the window spans every later scraper's work, which on a large store
 * is minutes. If the process dies in it — MCP client restart, machine sleep,
 * an agent timing out the call — the next scan re-reads nothing for that
 * scraper, so `touchedSessions` is empty and the roll-up never runs for it.
 *
 * The session then reports zero messages forever while its content is fully
 * retrievable, and an agent reading that count reasonably decides the session
 * is empty and skips it. That is the failure this repairs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

/**
 * A scraper with a cursor that actually advances, unlike the fixture used
 * elsewhere in this suite. Once it has yielded, a later scan gets nothing —
 * which is what makes the missed roll-up unrecoverable rather than self-healing.
 */
class CursoredScraper implements ConversationScraper {
  readonly tool = "codex";
  private drained = false;

  constructor(private readonly chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    if (this.drained) return;
    yield* this.chunks;
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.scrape();
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(_state: ScraperState): Promise<void> {
    this.drained = true;
  }
}

function chunk(sessionId: string, messageIndex: number, content: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId,
    timestamp: new Date("2026-05-10T10:00:00.000Z"),
    role: messageIndex % 2 === 0 ? "user" : "assistant",
    content,
    metadata: { messageIndex, tokenEstimate: 1, layer: 0 },
  };
}

describe("roll-up recovery after an interrupted scan", () => {
  let tempDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-rollup-"));
    dbPath = join(tempDir, "xtctx.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("repairs a session whose roll-up was lost, without re-reading the store", async () => {
    const scraper = new CursoredScraper([
      chunk("s1", 0, "first message"),
      chunk("s1", 1, "second message"),
      chunk("s1", 2, "third message"),
    ]);

    const first = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);
    expect((await first.listRecentSessions(5))[0]?.message_count).toBe(3);
    await first.close();

    // Simulate the interruption: messages are committed and the cursor has
    // advanced, but the roll-up never ran. Editing the column directly is the
    // faithful way to express "this row never got rolled up" — killing a real
    // process mid-scan produces exactly this row state.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE sessions SET message_count = 0, preview = NULL").run();
    raw.close();

    // A fresh index over the SAME store. The scraper is drained, so nothing is
    // re-read and `touchedSessions` is empty — recovery cannot come from
    // re-ingesting, only from reconciling what is already stored.
    const second = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);
    const recent = await second.listRecentSessions(5);

    expect(recent[0]?.message_count).toBe(3);
    expect(recent[0]?.preview).toContain("first message");

    // The content was never in doubt; the count was. Assert both so a fix that
    // repaired the count by dropping messages would still fail.
    const detail = await second.getSessionDetail("codex:s1", 0, 10);
    expect(detail).toHaveLength(3);
    await second.close();
  });

  it("leaves a correct count alone rather than rewriting every row each scan", async () => {
    const scraper = new CursoredScraper([chunk("s2", 0, "only message")]);

    const first = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);
    expect((await first.listRecentSessions(5))[0]?.message_count).toBe(1);
    await first.close();

    const raw = new Database(dbPath);
    const before = raw.prepare("SELECT updated_at FROM sessions WHERE session_ref = ?").get("codex:s2") as
      | { updated_at: string }
      | undefined;
    raw.close();

    const second = new SqliteHandoffIndex(dbPath, tempDir, [{ tool: "codex", scraper }]);
    expect((await second.listRecentSessions(5))[0]?.message_count).toBe(1);
    await second.close();

    const rawAfter = new Database(dbPath);
    const after = rawAfter.prepare("SELECT updated_at FROM sessions WHERE session_ref = ?").get("codex:s2") as
      | { updated_at: string }
      | undefined;
    rawAfter.close();

    // Reconciliation must be a no-op where nothing drifted, or every scan
    // dirties every row and the write cost grows with the whole corpus.
    expect(after?.updated_at).toBe(before?.updated_at);
  });
});
