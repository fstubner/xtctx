/**
 * A Codex record too large to read is skipped — and now says so.
 *
 * It did not. The reader discards a line over the 8MB cap and hands back
 * `line: null`, and codex's handler for that case was
 * `if (!entry.oversized) continue; continue;` — the same thing either way, in
 * silence. The classification meant to run there sat below a length check the
 * reader makes unreachable: any line that arrives has already passed the cap,
 * so `isWithinLineLimit` on it is always true.
 *
 * The result was permanent, unreported loss. An incremental scan never
 * re-reads a record it has passed, so a skipped one is gone for good, and
 * codex was the only reader that went quiet about it — claude-code and
 * copilot-cli both report the same case. Measured before the fix: a 9MB
 * record between two ordinary ones yielded the two and warned zero times.
 *
 * Silence was not simply an oversight, which is why the fix is not "warn
 * always". A `compacted` record inlines the whole prior conversation, so it is
 * routinely tens of megabytes and carries nothing unique — a real store emits
 * 47 a scan. Reporting those is the crying-wolf failure this project already
 * made once. Telling them apart needs the record's `type`, which is why the
 * reader now keeps a bounded head of what it discarded.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import { readDriftLog } from "@xtctx/scrapers/drift-log";
import type { CodexChunk } from "@xtctx/types/scraper";

/** Just over the 8MB cap, so the reader discards it unread. */
const OVER_CAP_CHARS = 9 * 1024 * 1024;

describe("a codex record too large to read", () => {
  let storeDir = "";
  let stateDir = "";
  let projectRoot = "";

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "xtctx-codex-oversized-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-codex-oversized-state-"));
    projectRoot = join("H:", "projects", "app");
  });

  afterEach(async () => {
    for (const dir of [storeDir, stateDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** A session whose middle record is over the cap, with the given type. */
  async function writeSession(oversizedType: string): Promise<void> {
    const dir = join(storeDir, "2026", "05", "10");
    await rm(dir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });

    const meta = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "oversized-session", cwd: projectRoot, originator: "codex_cli_rs" },
    });
    const message = (text: string, at: string) =>
      JSON.stringify({
        timestamp: at,
        type: "event_msg",
        payload: { type: "user_message", message: text },
      });
    // `type` first, so it sits inside the head the reader keeps.
    const oversized = `{"type":"${oversizedType}","timestamp":"2026-05-10T10:00:01.000Z","payload":{"blob":"${"x".repeat(OVER_CAP_CHARS)}"}}`;

    await writeFile(
      join(dir, "rollout-oversized.jsonl"),
      [
        meta,
        message("the first ordinary record", "2026-05-10T10:00:00.500Z"),
        oversized,
        message("the second ordinary record", "2026-05-10T10:00:02.000Z"),
      ].join("\n") + "\n",
      "utf-8",
    );
  }

  async function scrape(): Promise<CodexChunk[]> {
    const chunks: CodexChunk[] = [];
    for await (const chunk of new CodexCliScraper(storeDir, stateDir, projectRoot).fullSync()) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("keeps reading the records around it", async () => {
    await writeSession("response_item");

    const contents = (await scrape()).map((chunk) => chunk.content);

    expect(contents).toContain("the first ordinary record");
    expect(contents).toContain("the second ordinary record");
  }, 60_000);

  it("reports the skip, so the loss is not silent", async () => {
    // The failure this exists for: before the fix this produced no warning at
    // all, and an incremental scan never revisits the record.
    await writeSession("response_item");

    await scrape();

    const surprises = (await readDriftLog(stateDir, "codex"))?.surprises ?? [];
    expect(surprises.map((entry) => entry.surprise).join(" | ")).toMatch(/exceeds .*skipped/);
  }, 60_000);

  it("stays quiet about a compacted restatement, which carries nothing new", async () => {
    // The other half. These are routinely tens of megabytes and their turns
    // are already indexed from the records they were copied from, so warning
    // on 47 of them a scan teaches everyone to ignore the log.
    await writeSession("compacted");

    await scrape();

    const log = await readDriftLog(stateDir, "codex");
    const surprises = (log?.surprises ?? []).map((entry) => entry.surprise).join(" | ");
    expect(surprises).not.toMatch(/exceeds/);
  }, 60_000);
});
