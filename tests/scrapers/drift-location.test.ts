/**
 * Where a scraper says it saw something strange.
 *
 * Three tests drove a real scraper to a real drift log and every one of them
 * asserted only the surprise TEXT. The two that did assert a `firstLocation`
 * passed the string to `recordDrift` themselves, so they pinned the drift
 * log's plumbing and nothing any scraper computed. Replacing the location with
 * `${obj}` — the `[object Object]` already shipping in the antigravity
 * client — left the suite green.
 *
 * That gap was hiding a live defect. The counter started at zero on every
 * pass, but a resumed read starts at `startAt` BYTES: `readJsonlLines` yields
 * only lines past the cursor, so a record appended as line 101 reported as
 * `path:1`. Every location from an incremental scan pointed at the wrong
 * place, and a drift location is the only pointer anyone has when chasing an
 * upstream format break.
 *
 * It is now a byte offset, written `path@offset`, which means the same thing
 * on a first read and a resumed one.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { readDriftLog } from "@xtctx/scrapers/drift-log";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

const PROJECT = "H:/projects/demo";

const record = (text: string, ts: string): string =>
  JSON.stringify({ type: "human", content: text, timestamp: ts, cwd: PROJECT });

/** A record whose `type` the scraper does not know, which is what it reports. */
const strange = (ts: string): string =>
  JSON.stringify({ type: "not-a-known-type", timestamp: ts, cwd: PROJECT });

let rootDir = "";
let stateDir = "";
let storeDir = "";
let transcript = "";

async function drain(scraper: ClaudeCodeScraper, full: boolean): Promise<ClaudeCodeChunk[]> {
  const chunks: ClaudeCodeChunk[] = [];
  for await (const chunk of full ? scraper.fullSync() : scraper.scrape()) {
    chunks.push(chunk);
  }
  return chunks;
}

function locations(log: Awaited<ReturnType<typeof readDriftLog>>): string[] {
  return (log?.surprises ?? []).map((entry) => entry.firstLocation);
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "xtctx-driftloc-"));
  stateDir = await mkdtemp(join(tmpdir(), "xtctx-driftloc-state-"));
  // First argument is the projects directory itself, as the sibling tests do.
  storeDir = join(rootDir, "H--projects-demo");
  await mkdir(storeDir, { recursive: true });
  transcript = join(storeDir, "session.jsonl");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe("a scraper's drift location", () => {
  it("names the place in the file, not the place in the read", async () => {
    await writeFile(
      transcript,
      [record("one", "2026-05-10T10:00:00.000Z"), strange("2026-05-10T10:00:01.000Z"), ""].join("\n"),
      "utf-8",
    );

    await drain(new ClaudeCodeScraper(rootDir, stateDir, PROJECT), true);

    const reported = locations(await readDriftLog(stateDir, "claude-code"));
    expect(reported.length).toBeGreaterThan(0);
    // The real path, and a real position in it — not `[object Object]`, not a
    // bare filename, not zero.
    for (const location of reported) {
      expect(location.startsWith(transcript)).toBe(true);
      const at = Number(location.slice(transcript.length + 1));
      expect(Number.isFinite(at)).toBe(true);
      expect(at).toBeGreaterThan(0);
    }
  });

  it("does not restart its count after a resume", async () => {
    // First pass: ordinary records only, so the cursor advances past them.
    await writeFile(
      transcript,
      [
        record("one", "2026-05-10T10:00:00.000Z"),
        record("two", "2026-05-10T10:00:01.000Z"),
        record("three", "2026-05-10T10:00:02.000Z"),
        "",
      ].join("\n"),
      "utf-8",
    );

    const scraper = new ClaudeCodeScraper(rootDir, stateDir, PROJECT);
    await drain(scraper, false);
    await scraper.saveScrapedPosition({ lastTimestamp: new Date("2026-05-10T10:00:02.000Z") });

    const before = locations(await readDriftLog(stateDir, "claude-code"));

    // Now append the odd record, and scan again from the cursor.
    await appendFile(transcript, `${strange("2026-05-10T10:00:03.000Z")}\n`, "utf-8");
    await drain(new ClaudeCodeScraper(rootDir, stateDir, PROJECT), false);

    const after = locations(await readDriftLog(stateDir, "claude-code")).filter(
      (entry) => !before.includes(entry),
    );
    expect(after.length).toBeGreaterThan(0);

    // The appended record sits past three complete records, so its reported
    // position must too. Counting from the resume point produced a 1 here,
    // which is what made every incremental drift location wrong.
    for (const location of after) {
      const at = Number(location.slice(transcript.length + 1));
      expect(at).toBeGreaterThan(100);
    }
  });
});
