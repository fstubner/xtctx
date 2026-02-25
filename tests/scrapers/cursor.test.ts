import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorScraper } from "@xtctx/scrapers/cursor";
import type { CursorChunk } from "@xtctx/types/scraper";

describe("CursorScraper", () => {
  let tempDir = "";
  let stateDir = "";
  let dbPath = "";
  let scraper: CursorScraper;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-cursor-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    dbPath = join(tempDir, "cursor.sqlite");

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        model TEXT,
        composer_mode TEXT
      );
    `);
    db.exec(`
      INSERT INTO messages (session_id, role, content, created_at, model, composer_mode)
      VALUES
        ('session-1', 'user', 'cursor first', '2026-02-24T10:00:00Z', 'gpt-4.1', 'normal'),
        ('session-1', 'assistant', 'cursor second', '2026-02-24T10:00:05Z', 'gpt-4.1', 'agent');
    `);
    db.close();

    scraper = new CursorScraper(dbPath, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects cursor sqlite storage", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads cursor rows and maps metadata", async () => {
    const chunks: CursorChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[0].metadata.model).toBe("gpt-4.1");
    expect(chunks[1].metadata.composerMode).toBe("agent");
  });

  it("supports incremental scraping with since cutoff", async () => {
    const chunks: CursorChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("cursor second");
  });
});
