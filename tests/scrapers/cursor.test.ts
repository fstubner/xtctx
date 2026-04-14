import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorScraper } from "@xtctx/scrapers/cursor";
import type { CursorChunk } from "@xtctx/types/scraper";

/**
 * Cursor's real storage is split across two SQLite databases:
 *
 *  <root>/workspaceStorage/<hash>/state.vscdb
 *    └─ ItemTable: { key: 'composer.composerData', value: JSON }
 *       JSON has allComposers[].composerId linking to the global DB.
 *
 *  <root>/globalStorage/state.vscdb
 *    └─ cursorDiskKV:
 *         composerData:<composerId>  → session metadata + bubble header list
 *         bubbleId:<composerId>:<bubbleId> → individual message content
 *
 * The scraper derives the global DB path by replacing "/workspaceStorage/..."
 * with "/globalStorage/state.vscdb" relative to the Cursor user directory.
 */

const COMPOSER_ID = "comp-test-1234";
const BUBBLE_USER_ID = "bubble-user-0001";
const BUBBLE_ASST_ID = "bubble-asst-0002";

function createWorkspaceDb(path: string, composerIds: string[]) {
  const db = new Database(path);
  db.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const composerData = {
    allComposers: composerIds.map((id) => ({ composerId: id })),
  };
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "composer.composerData",
    JSON.stringify(composerData),
  );
  db.close();
}

function createGlobalDb(path: string) {
  const db = new Database(path);
  db.exec(
    `CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );

  // Composer-level metadata with ordered bubble headers.
  const composerData = {
    composerId: COMPOSER_ID,
    fullConversationHeadersOnly: [
      { bubbleId: BUBBLE_USER_ID, type: 1 },
      { bubbleId: BUBBLE_ASST_ID, type: 2 },
    ],
    createdAt: new Date("2026-02-24T10:00:00Z").getTime(),
    lastUpdatedAt: new Date("2026-02-24T10:00:05Z").getTime(),
    modelConfig: { modelName: "gpt-4.1" },
    unifiedMode: "agent",
  };

  // Individual message bubbles.
  const userBubble = {
    type: 1,
    text: "cursor first",
    createdAt: "2026-02-24T10:00:00Z",
  };
  const asstBubble = {
    type: 2,
    text: "cursor second",
    createdAt: "2026-02-24T10:00:05Z",
    modelInfo: { modelName: "gpt-4.1" },
  };

  const insert = db.prepare(
    "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)",
  );
  insert.run(`composerData:${COMPOSER_ID}`, JSON.stringify(composerData));
  insert.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_USER_ID}`,
    JSON.stringify(userBubble),
  );
  insert.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_ASST_ID}`,
    JSON.stringify(asstBubble),
  );
  db.close();
}

describe("CursorScraper", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";
  let scraper: CursorScraper;

  beforeEach(async () => {
    // Replicate Cursor's directory layout so deriveGlobalStoragePath() works:
    //   rootDir/
    //     workspaceStorage/abc123/state.vscdb  ← workspace DB
    //     globalStorage/state.vscdb             ← global DB
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-cursor-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    workspaceDir = join(rootDir, "workspaceStorage", "abc123");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(rootDir, "globalStorage"), { recursive: true });

    createWorkspaceDb(join(workspaceDir, "state.vscdb"), [COMPOSER_ID]);
    createGlobalDb(join(rootDir, "globalStorage", "state.vscdb"));

    scraper = new CursorScraper(workspaceDir, stateDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects cursor workspace storage", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads bubbles from global cursorDiskKV and maps metadata", async () => {
    const chunks: CursorChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);

    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("cursor first");
    expect(chunks[0].sessionId).toBe(COMPOSER_ID);

    // Model comes from composerData.modelConfig when bubble has no modelInfo.
    expect(chunks[0].metadata.model).toBe("gpt-4.1");

    // composerMode comes from composerData.unifiedMode.
    expect(chunks[0].metadata.composerMode).toBe("agent");

    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].content).toBe("cursor second");
    // Model on second bubble overrides from bubble.modelInfo.
    expect(chunks[1].metadata.model).toBe("gpt-4.1");
  });

  it("supports incremental scraping with since cutoff", async () => {
    const chunks: CursorChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("cursor second");
  });

  it("returns no chunks when workspace has no composer data", async () => {
    // Create a scraper pointing at a workspace with no composer.composerData key.
    const emptyWsDir = join(rootDir, "workspaceStorage", "empty");
    await mkdir(emptyWsDir, { recursive: true });
    const emptyDb = new Database(join(emptyWsDir, "state.vscdb"));
    emptyDb.exec(
      `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    emptyDb.close();

    const emptyWsStateDir = await mkdtemp(join(tmpdir(), "xtctx-state2-"));
    const emptyScraper = new CursorScraper(emptyWsDir, emptyWsStateDir);
    const chunks: CursorChunk[] = [];
    for await (const chunk of emptyScraper.fullSync()) {
      chunks.push(chunk);
    }
    await rm(emptyWsStateDir, { recursive: true, force: true });

    expect(chunks).toHaveLength(0);
  });
});
