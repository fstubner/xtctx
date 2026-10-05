/**
 * The checkpointer swallows a worker that fails, by design: the scan must not
 * fail over a checkpoint. That makes a broken worker invisible — the log just
 * waits for this connection to checkpoint it, on the thread the worker exists
 * to keep that off — so these check the worker actually did the work.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@xtctx/handoff/schema";
import { WalCheckpointer } from "@xtctx/handoff/wal-checkpointer";

describe("WalCheckpointer", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-checkpointer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("checkpoints on its worker while it runs, and hands the connection back as it found it", async () => {
    const dbPath = join(dir, "xtctx.db");
    const db = openDatabase(dbPath);
    try {
      const before = db.pragma("wal_autocheckpoint", { simple: true });

      const checkpointer = WalCheckpointer.start(db, dbPath);
      // No checkpoint on this connection while the worker has them.
      expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);

      const text = "x".repeat(100_000);
      for (let i = 0; i < 20; i++) {
        db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(`k${i}`, text);
      }
      await checkpointer.durable();
      const last = await checkpointer.stop();

      expect(last).not.toBeNull();
      expect(last!.log).toBeGreaterThan(0);
      expect(last!.checkpointed).toBe(last!.log);
      expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(before);
    } finally {
      db.close();
    }
  });

  // Closing mid-scan waited for the worker: one more checkpoint in `stop`, after
  // any already running. With the disk busy that took a close to 3,977ms
  // (25 closes, two other processes writing and flushing), against a server's
  // two-second grace window.
  it("waits for no checkpoint once abandoned, and still hands the connection back", async () => {
    const dbPath = join(dir, "xtctx.db");
    const db = openDatabase(dbPath);
    try {
      const before = db.pragma("wal_autocheckpoint", { simple: true });
      const checkpointer = WalCheckpointer.start(db, dbPath);
      db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("k", "x".repeat(100_000));

      checkpointer.abandon();

      expect(await checkpointer.stop()).toBeNull();
      expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(before);
    } finally {
      db.close();
    }
  });

  // The test runner keeps its own process alive, so only a process of its own
  // shows this: with the worker unreferenced, a scan awaiting its answer had
  // nothing holding the event loop open, and a one-off command such as
  // `xtctx scan` exited halfway through, successfully.
  it("keeps a process that has nothing else to do alive until the scan is done", async () => {
    const script = join(dir, "scan.mjs");
    const index = pathToFileURL(join(process.cwd(), "src", "handoff", "sqlite-index.ts")).href;
    await writeFile(
      script,
      `
import { SqliteHandoffIndex } from ${JSON.stringify(index)};
const dir = ${JSON.stringify(dir)};
const text = "word parser fallback budget ".repeat(300);
const scraper = {
  tool: "codex",
  async detect() { return true; },
  getStorePaths() { return ["fixture://codex"]; },
  async *scrape() {
    for (let s = 0; s < 10; s++) for (let i = 0; i < 40; i++) {
      yield { tool: "codex", sessionId: "s" + s, timestamp: new Date(Date.UTC(2026, 4, 10, 10, 0, i)),
        role: i % 2 ? "assistant" : "user", content: s + " " + i + " " + text,
        metadata: { messageIndex: i, tokenEstimate: 1, layer: 0 } };
    }
  },
  async *fullSync() {},
  async getLastScrapedPosition() { return { lastTimestamp: new Date(0) }; },
  async saveScrapedPosition() {},
};
const index = new SqliteHandoffIndex(dir + "/xtctx.db", dir, [{ tool: "codex", scraper }], { refreshBudgetMs: 0 });
await index.listRecentSessions(5);
await index.whenScanSettled();
const sessions = await index.listIndexedSessions(20);
await index.close();
console.log("indexed " + sessions.reduce((n, s) => n + s.message_count, 0));
`,
    );

    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
    });

    expect(stdout.trim()).toBe("indexed 400");
  }, 30_000);
});
