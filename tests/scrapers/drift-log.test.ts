import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDriftLog, withDriftReport, recordDrift } from "@xtctx/scrapers/drift-log";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";

/**
 * Drift warnings used to go to stderr and nowhere else, which in MCP means the
 * host agent's log — a place nobody reads and nothing retains. The warnings
 * matter most exactly when a reader meets a tool's real transcripts for the
 * first time, so they have to outlive the scan that produced them.
 */
describe("drift log persistence", () => {
  let stateDir = "";

  async function scan(tool: string, surprises: Array<[string, string]>): Promise<void> {
    async function* source(): AsyncIterable<number> {
      for (const [location, surprise] of surprises) {
        recordDrift(tool, location, surprise);
        yield 1;
      }
    }

    // Drain it: the report is written when the scan ends.
    const drained: number[] = [];
    for await (const value of withDriftReport(tool, source(), stateDir)) {
      drained.push(value);
    }
    expect(drained).toHaveLength(surprises.length);
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-drift-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps a surprise after the scan that found it has ended", async () => {
    await scan("codex", [["/store/a.jsonl:4", "unknown 'type' value \"world_state\""]]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises).toHaveLength(1);
    expect(log?.surprises[0]?.surprise).toContain("world_state");
    expect(log?.surprises[0]?.firstLocation).toBe("/store/a.jsonl:4");
    expect(log?.surprises[0]?.records).toBe(1);
  });

  it("still warns on stderr, so a watching host sees it live", async () => {
    await scan("codex", [["/store/a.jsonl:4", "unknown 'type' value \"world_state\""]]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("world_state"));
  });

  it("accumulates repeat sightings instead of duplicating them", async () => {
    await scan("codex", [["/store/a.jsonl:4", "same surprise"]]);
    await scan("codex", [
      ["/store/b.jsonl:9", "same surprise"],
      ["/store/b.jsonl:11", "same surprise"],
    ]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises).toHaveLength(1);
    // Three records across two scans, and the first sighting is still the first.
    expect(log?.surprises[0]?.records).toBe(3);
    expect(log?.surprises[0]?.firstLocation).toBe("/store/a.jsonl:4");
  });

  it("keeps one tool's surprises out of another's file", async () => {
    await scan("codex", [["/store/a.jsonl:4", "codex surprise"]]);
    await scan("cursor", [["/store/b.db", "cursor surprise"]]);

    expect((await readDriftLog(stateDir, "codex"))?.surprises[0]?.surprise).toBe("codex surprise");
    expect((await readDriftLog(stateDir, "cursor"))?.surprises[0]?.surprise).toBe("cursor surprise");
  });

  /**
   * JSON.parse embeds a byte offset in its message, so a store full of
   * malformed lines yields a distinct surprise string per line. Without a cap
   * the diagnostic file grows without bound — the exact failure the drift
   * summary was introduced to fix, moved from stderr to disk.
   */
  it("caps distinct surprises rather than growing without bound", async () => {
    const many: Array<[string, string]> = Array.from({ length: 120 }, (_unused, i) => [
      `/store/a.jsonl:${i}`,
      `line is not valid JSON at position ${i}`,
    ]);

    await scan("codex", many);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises.length).toBeLessThanOrEqual(50);
    // The drop is stated, not silent.
    expect(log?.droppedSurprises).toBeGreaterThan(0);
  });

  it("truncates an unbounded surprise string", async () => {
    await scan("codex", [["/store/a.jsonl:4", "x".repeat(5_000)]]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises[0]?.surprise.length).toBeLessThanOrEqual(300);
  });

  it("does not fail the scan when the log cannot be written", async () => {
    // A file where the state directory should be: every write beneath it fails.
    const blocked = join(stateDir, "blocked");
    await writeFile(blocked, "not a directory", "utf-8");

    const yielded: number[] = [];
    async function* source(): AsyncIterable<number> {
      recordDrift("codex", "/store/a.jsonl:4", "a surprise");
      yield 1;
    }
    for await (const value of withDriftReport("codex", source(), blocked)) {
      yielded.push(value);
    }

    // The scan completed; only the diagnostic was lost.
    expect(yielded).toEqual([1]);
  });

  it("reports no log for a tool that has never drifted", async () => {
    expect(await readDriftLog(stateDir, "codex")).toBeNull();
  });

  it("survives a corrupt log rather than throwing the scan away", async () => {
    await writeFile(join(stateDir, "codex-drift.json"), "{ not json", "utf-8");

    await scan("codex", [["/store/a.jsonl:4", "a surprise"]]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises[0]?.surprise).toBe("a surprise");
  });

  it("writes nothing when a scan finds no surprises", async () => {
    await scan("codex", []);

    await expect(readFile(join(stateDir, "codex-drift.json"), "utf-8")).rejects.toThrow();
  });
});

/**
 * The unit tests above pass `stateDir` themselves, so they would still pass if
 * every scraper passed the wrong thing — or nothing. This drives a real
 * scraper over a real store instead, which is what actually has to work.
 */
describe("a scraper's own drift log", () => {
  let storeDir = "";
  let stateDir = "";

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "xtctx-drift-store-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-drift-state-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(storeDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("lands beside the scraper's state after a real scan", async () => {
    const projectDir = join(storeDir, "a-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session-drift.jsonl"),
      [
        '{"type":"human","content":"hello","timestamp":"2026-02-24T10:00:00Z"}',
        // An event type the reader does not know: the drift this exists to catch.
        '{"type":"world_state","content":"x","timestamp":"2026-02-24T10:00:01Z"}',
      ].join("\n") + "\n",
      "utf-8",
    );

    const scraper = new ClaudeCodeScraper(storeDir, stateDir);
    const chunks = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }
    // The surprising record is still emitted — drift warns, it does not drop.
    expect(chunks).toHaveLength(2);

    const log = await readDriftLog(stateDir, "claude-code");
    expect(log?.surprises.some((entry) => entry.surprise.includes("world_state"))).toBe(true);
  });
});
