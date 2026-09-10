/**
 * A match has to say where it is in terms the detail tool understands.
 *
 * `xtctx_search_sessions` rendered `Match ${message_start_index}-${end}` next
 * to a tool whose parameter is documented as "Message offset for pagination".
 * An agent auditing this project took that invitation literally — and those
 * are not offsets. `getSessionDetail` pages by POSITION in the session's
 * timestamp ordering; a window stores the `message_index` VALUES at its edges.
 *
 * The two agree only while a session's numbering is dense and monotonic in
 * time order, and real transcripts are neither. Measured on a live index: 430
 * of 9,728 windows (4.4%) had an end index BELOW their start — the rendered
 * range read backwards, `Match 5987-2108` — because one session carried 828
 * duplicate messages and 862 places where index order disagrees with time
 * order. Following such a pointer landed three weeks away from the match.
 *
 * The fixture below reproduces that shape deliberately: message indices that
 * do not ascend with time, so position and index cannot be confused for one
 * another.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class FixtureScraper implements ConversationScraper {
  readonly tool = "codex";
  constructor(private readonly chunks: ConversationChunk[]) {}
  async detect(): Promise<boolean> {
    return true;
  }
  getStorePaths(): string[] {
    return ["fixture://codex"];
  }
  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }
  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }
  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }
  async saveScrapedPosition(): Promise<void> {
    return;
  }
}

/**
 * Messages whose `message_index` deliberately does not ascend with time.
 *
 * The second half is numbered far above the first but timestamped after it —
 * the signature of a transcript that was re-ingested under fresh numbering,
 * which is what a Claude Code `/compact` produces.
 */
function skewedConversation(): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
  for (let i = 0; i < 12; i++) {
    chunks.push({
      tool: "codex",
      sessionId: "skewed",
      timestamp: at(i),
      role: i % 2 === 0 ? "user" : "assistant",
      content: `early message ${i} about the parser fallback`,
      metadata: { messageIndex: i, tokenEstimate: 1, layer: 0 },
    });
  }
  for (let i = 0; i < 12; i++) {
    chunks.push({
      tool: "codex",
      sessionId: "skewed",
      timestamp: at(12 + i),
      // Numbered 500+ while sorting after the block above.
      content: `late message ${i} about the parser fallback`,
      role: i % 2 === 0 ? "user" : "assistant",
      metadata: { messageIndex: 500 + i, tokenEstimate: 1, layer: 0 },
    });
  }
  return chunks;
}

describe("a match's detail offset", () => {
  let tempDir = "";
  let index: SqliteHandoffIndex;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-offset-"));
    index = new SqliteHandoffIndex(
      join(tempDir, "xtctx.db"),
      tempDir,
      [{ tool: "codex", scraper: new FixtureScraper(skewedConversation()) }],
      { windowSize: 4, windowStride: 2 },
    );
    await index.listRecentSessions(1);
    await index.whenScanSettled();
  });

  afterEach(async () => {
    await index.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lands on the match, not wherever the index numbers happen to fall", async () => {
    const results = await index.searchSessions("parser fallback", 5, undefined, "keyword");
    const matches = results.flatMap((session) =>
      (session.matches ?? []).map((match) => ({ ref: session.session_ref, match })),
    );
    expect(matches.length).toBeGreaterThan(0);

    for (const { ref, match } of matches) {
      expect(match.detail_offset, "every indexed match should carry a pointer").toBeDefined();

      // The message the pointer reaches must be the window's own first
      // message. Read through the public detail path, exactly as an agent
      // would follow it.
      const [landed] = await index.getSessionDetail(ref, match.detail_offset as number, 1);
      const [expected] = await index.getSessionDetail(ref, 0, 100).then((all) =>
        all.slice(match.detail_offset as number, (match.detail_offset as number) + 1),
      );

      expect(landed).toBeDefined();
      expect(landed.content).toBe(expected.content);
    }
  }, 60_000);

  it("does not hand back the raw index values, which are not offsets", async () => {
    // The specific confusion: on this fixture the later windows carry indices
    // of 500+, while the session holds only 24 messages. An offset of 500
    // reaches nothing at all.
    const results = await index.searchSessions("late message", 5, undefined, "keyword");
    const matches = results.flatMap((session) => session.matches ?? []);
    const skewed = matches.filter((match) => match.message_start_index >= 500);

    expect(skewed.length, "fixture should produce high-numbered windows").toBeGreaterThan(0);
    for (const match of skewed) {
      expect(match.detail_offset).toBeLessThan(24);
      expect(match.detail_offset).not.toBe(match.message_start_index);
    }
  }, 60_000);
});
