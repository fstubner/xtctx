/**
 * A pruned bubble must not shift every later turn's index.
 *
 * Cursor stores a composer's turn order as a header list and each turn's text
 * as a separate `bubbleId:` row, and it prunes those rows — the scraper's own
 * `ACCEPTED_DEGRADATIONS.prunedBubble` records "bubble referenced by composer
 * but missing from globalStorage" as normal operation.
 *
 * The loop skipped a missing bubble without advancing `messageIndex`, while
 * the two skips below it did advance. `scan.ts` hashes `messageIndex` into
 * the row id, so a bubble disappearing between scans renumbered every later
 * turn and re-inserted them under new ids beside the rows already stored —
 * and `pruneRereadSessions` only clears those when the re-read reached at or
 * below the lowest stored index, which an incremental pass does not.
 *
 * The index has to describe the turn's position in the conversation, not its
 * position among the rows that happen to have survived.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CursorScraper } from "@xtctx/scrapers/cursor";
import type { CursorChunk } from "@xtctx/types/scraper";

const COMPOSER_ID = "comp-prune-0001";
const FIRST = "bubble-first-0001";
const PRUNED = "bubble-pruned-0002";
const LAST = "bubble-last-0003";

let rootDir = "";
let workspaceDir = "";
let stateDir = "";

/** The composer lists three turns; only the first and third still have rows. */
function createGlobalDb(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");

  insert.run(
    `composerData:${COMPOSER_ID}`,
    JSON.stringify({
      composerId: COMPOSER_ID,
      fullConversationHeadersOnly: [
        { bubbleId: FIRST, type: 1 },
        { bubbleId: PRUNED, type: 2 },
        { bubbleId: LAST, type: 2 },
      ],
      createdAt: new Date("2026-02-24T10:00:00Z").getTime(),
      lastUpdatedAt: new Date("2026-02-24T10:00:10Z").getTime(),
      unifiedMode: "agent",
    }),
  );
  insert.run(
    `bubbleId:${COMPOSER_ID}:${FIRST}`,
    JSON.stringify({ type: 1, text: "first turn", createdAt: "2026-02-24T10:00:00Z" }),
  );
  // No row for PRUNED — this is the case under test.
  insert.run(
    `bubbleId:${COMPOSER_ID}:${LAST}`,
    JSON.stringify({ type: 2, text: "third turn", createdAt: "2026-02-24T10:00:10Z" }),
  );
  db.close();
}

function createWorkspaceDb(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "composer.composerData",
    JSON.stringify({ allComposers: [{ composerId: COMPOSER_ID }] }),
  );
  db.close();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "xtctx-cursor-prune-"));
  stateDir = await mkdtemp(join(tmpdir(), "xtctx-cursor-prune-state-"));
  workspaceDir = join(rootDir, "workspaceStorage", "abc123");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(rootDir, "globalStorage"), { recursive: true });
  createWorkspaceDb(join(workspaceDir, "state.vscdb"));
  createGlobalDb(join(rootDir, "globalStorage", "state.vscdb"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe("CursorScraper with a pruned bubble", () => {
  it("keeps the surviving turns at their original indexes", async () => {
    const chunks: CursorChunk[] = [];
    for await (const chunk of new CursorScraper(workspaceDir, stateDir).fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content)).toEqual(["first turn", "third turn"]);
    // The third turn is index 2 because it is the third turn — not index 1
    // because the second one's row is gone.
    expect(chunks.map((chunk) => chunk.metadata.messageIndex)).toEqual([0, 2]);
  });
});
