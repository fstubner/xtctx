/**
 * The segment backlog counts this project's windows, like the window count
 * beside it.
 *
 * `xtctx status` prints "N windows outstanding, about X left", where N is
 * scoped to the project and X was computed from every unvectorized window in
 * the database. One index can legitimately hold another project's sessions —
 * a copied `.xtctx/`, a renamed root — and then the duration described more
 * work than the count it was printed next to.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@xtctx/handoff/schema";
import { countUnvectorizedSegments } from "@xtctx/handoff/vectors";
import { normalizeRootForCompare } from "@xtctx/handoff/queries";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xtctx-segment-scope-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function addWindow(db: Database.Database, projectRoot: string, ref: string, chars: number): void {
  const now = "2026-09-23T00:00:00.000Z";
  db.prepare(
    `INSERT INTO sessions (session_ref, tool, source_session_id, project_root, started_at, last_activity_at, updated_at)
     VALUES (?, 'codex', ?, ?, ?, ?, ?)`,
  ).run(ref, ref, projectRoot, now, now, now);
  db.prepare(
    `INSERT INTO retrieval_units (id, session_ref, tool, message_start_index, message_end_index, started_at, ended_at, content, content_hash, updated_at)
     VALUES (?, ?, 'codex', 0, 8, ?, ?, ?, ?, ?)`,
  ).run(`${ref}-u`, ref, now, now, "x".repeat(chars), `${ref}-h`, now);
}

describe("segment backlog", () => {
  it("counts only this project's windows when asked to", () => {
    const db = openDatabase(join(dir, "index.db")) as unknown as Database.Database;
    try {
      // 3 segments here, 5 in a project that happens to share the database.
      addWindow(db, "/repo/mine", "codex:mine", 3_000);
      addWindow(db, "/repo/theirs", "codex:theirs", 5_000);

      const all = countUnvectorizedSegments(db, "test-model");
      const mine = countUnvectorizedSegments(db, "test-model", normalizeRootForCompare("/repo/mine"));

      expect(all).toBe(8);
      expect(mine).toBe(3);
    } finally {
      db.close();
    }
  });
});
