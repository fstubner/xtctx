/**
 * `detail_offset` has to survive a session with duplicate message indexes.
 *
 * The statement exists because a window records the `message_index` VALUES at
 * its edges while detail pages by POSITION, and real transcripts make those
 * two disagree — one session in a live index carries 828 duplicate message
 * indexes and 862 places where index order disagrees with time order.
 *
 * Duplicates are exactly what broke it. The `target` CTE had no `LIMIT 1` and
 * the query cross-joins `messages` against it, so N rows sharing an index
 * multiplied the count by N. The offset then pointed past the end of the
 * session and detail returned an empty page — the same "the match is not
 * there" failure, in its worst form.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, prepareStatements } from "@xtctx/handoff/schema";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xtctx-offset-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seed(): ReturnType<typeof openDatabase> {
  const db = openDatabase(join(dir, "index.db"));
  db.prepare(
    `INSERT INTO sessions (session_ref, tool, source_session_id, project_root,
       started_at, last_activity_at, message_count, updated_at)
     VALUES (?, 'claude-code', 'src', ?, ?, ?, 6, ?)`,
  ).run("session-dupes", dir, "2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z", "2026-01-01T00:00:05Z");

  const insert = db.prepare(
    `INSERT INTO messages (id, session_ref, tool, source_session_id, timestamp,
       role, content, message_index, content_hash, metadata_json, indexed_at)
     VALUES (?, ?, 'claude-code', 'src', ?, 'user', 'body', ?, 'h', '{}', ?)`,
  );
  // Six messages; three of them share message_index 3.
  const rows: Array<[number, string]> = [
    [0, "2026-01-01T00:00:00Z"],
    [1, "2026-01-01T00:00:01Z"],
    [2, "2026-01-01T00:00:02Z"],
    [3, "2026-01-01T00:00:03Z"],
    [3, "2026-01-01T00:00:04Z"],
    [3, "2026-01-01T00:00:05Z"],
  ];
  rows.forEach(([index, timestamp], position) => {
    insert.run(`m${position}`, "session-dupes", timestamp, index, timestamp);
  });
  return db;
}

describe("messageOffsetInSession", () => {
  it("counts each earlier message once when indexes repeat", () => {
    const db = seed();
    try {
      const statements = prepareStatements(db);
      const row = statements.messageOffsetInSession.get(
        "session-dupes",
        3,
        "session-dupes",
      ) as { count: number };

      // Three messages sort before the first message_index 3, so the offset
      // is 3 — not 12, which is what a cross-join against three duplicate
      // target rows produced, and which pages past a six-row session.
      expect(row.count).toBe(3);
      expect(row.count).toBeLessThan(6);
    } finally {
      db.close();
    }
  });
});

/**
 * `buildIndexProgress` builds its result field by field, and the caller passes
 * its inputs by spread — so a field the interface does not declare is dropped
 * without a type error. That happened to `literalUnreadableTools`, which left
 * the "this store cannot be read" branch in `mcp/tools/sessions.ts`
 * unreachable: every unreadable store was reported as a search that stopped
 * at its limit, advising the caller to narrow a query that cannot ever match.
 */
describe("buildIndexProgress", () => {
  it("passes through the tools whose store could not be read", async () => {
    const { buildIndexProgress } = await import("@xtctx/handoff/status");

    const progress = buildIndexProgress({
      scanning: false,
      tools: [{ tool: "codex" }],
      scannedTools: new Set(["codex"]),
      vectorBacklog: 0,
      embeddingWarming: false,
      literalSearchStoppedEarly: true,
      literalUnreadableTools: ["cursor"],
    });

    expect(progress.literalUnreadableTools).toEqual(["cursor"]);
    expect(progress.literalSearchStoppedEarly).toBe(true);
  });
});
