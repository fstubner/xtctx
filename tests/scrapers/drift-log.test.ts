import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

  /**
   * The ceiling has to drop the least interesting entry, and a brand-new
   * surprise is never that. Entries touched in one scan share a `lastSeen`, so
   * a tie-break that favours the incumbent means a tool sitting at the ceiling
   * with recurring surprises can never record a genuine new format break —
   * precisely the event this file exists to capture.
   */
  it("keeps a new surprise even when the ceiling is already full of recurring ones", async () => {
    const recurring: Array<[string, string]> = Array.from({ length: 50 }, (_unused, i) => [
      `/store/a.jsonl:${i}`,
      `recurring surprise ${i}`,
    ]);

    await scan("codex", recurring);
    // The upstream tool renames a field; every old surprise is still present.
    await scan("codex", [...recurring, ["/store/a.jsonl:99", "messages[] became conversation[]"]]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises.map((entry) => entry.surprise)).toContain(
      "messages[] became conversation[]",
    );
  });

  it("drops the surprise that stopped happening, not the one that still does", async () => {
    await scan("codex", [["/store/old.jsonl:1", "stale surprise"]]);
    const filler: Array<[string, string]> = Array.from({ length: 50 }, (_unused, i) => [
      `/store/a.jsonl:${i}`,
      `current surprise ${i}`,
    ]);
    await scan("codex", filler);

    const kept = (await readDriftLog(stateDir, "codex"))?.surprises.map((e) => e.surprise) ?? [];
    expect(kept).not.toContain("stale surprise");
    expect(kept).toHaveLength(50);
  });

  /**
   * A surprise string can quote a value taken from another tool's transcript,
   * and a transcript is untrusted input. `status` prints these straight to a
   * terminal, so an escape sequence in one would let a poisoned transcript
   * clear the screen and forge lines of xtctx's own output.
   */
  it("strips terminal control characters out of a surprise", async () => {
    await scan("codex", [
      ["/store/a.jsonl:4", "unknown type '\u001b[2J\u001b[HSearch   all good'"],
      ["/store/a.jsonl:5", "unknown type 'two\nlines'"],
    ]);

    const log = await readDriftLog(stateDir, "codex");
    for (const entry of log?.surprises ?? []) {
      expect(entry.surprise).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(log?.surprises.map((e) => e.surprise).join(" ")).toContain("all good");
  });

  it("strips control characters a hand-edited log smuggles back in", async () => {
    await writeFile(
      join(stateDir, "codex-drift.json"),
      JSON.stringify({
        tool: "codex",
        updatedAt: "2026-08-23T10:00:00.000Z",
        droppedSurprises: 0,
        surprises: [
          {
            surprise: "\u001b[2Jforged",
            firstLocation: "\u001b[2J/store/a.jsonl:1",
            firstSeen: "2026-08-23T10:00:00.000Z",
            lastSeen: "2026-08-23T10:00:00.000Z",
            records: 1,
          },
        ],
      }),
      "utf-8",
    );

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises[0]?.surprise).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(log?.surprises[0]?.firstLocation).not.toMatch(/[\u0000-\u001f\u007f]/);
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

  /**
   * The syntax-error case above is the easy half. A file that parses but holds
   * the wrong shape reached both the reader (`entry.surprise` on a null) and
   * the writer, where the throw was swallowed as "could not persist" — leaving
   * that tool unable to record drift ever again, and `xtctx status` unable to
   * print anything at all.
   */
  it.each([
    ["a null entry", '{"surprises":[null]}'],
    ["a string entry", '{"surprises":["not an object"]}'],
    ["an entry missing its surprise text", '{"surprises":[{"records":2}]}'],
    ["an entry whose count is not a number", '{"surprises":[{"surprise":"a","records":"lots"}]}'],
    ["surprises as an object", '{"surprises":{"a":1}}'],
  ])("ignores %s rather than failing the reader", async (_label, contents) => {
    await writeFile(join(stateDir, "codex-drift.json"), contents, "utf-8");

    const log = await readDriftLog(stateDir, "codex");
    for (const entry of log?.surprises ?? []) {
      expect(typeof entry.surprise).toBe("string");
      expect(typeof entry.records).toBe("number");
    }
  });

  it("keeps recording drift after a malformed log rather than wedging the tool", async () => {
    await writeFile(join(stateDir, "codex-drift.json"), '{"surprises":[null]}', "utf-8");

    await scan("codex", [["/store/a.jsonl:4", "a real surprise"]]);

    const log = await readDriftLog(stateDir, "codex");
    expect(log?.surprises.map((entry) => entry.surprise)).toEqual(["a real surprise"]);
  });

  /**
   * A consumer that abandons a scraper's iterator without calling `.return()`
   * never runs the generator's `finally`, so the scan stays registered at depth
   * 1 forever and every later scan of that tool accumulates into a log nothing
   * flushes — drift reporting off for the life of the process, silently.
   */
  it("recovers after a scan is abandoned mid-stream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      async function* abandoned(): AsyncIterable<number> {
        recordDrift("codex", "/store/a.jsonl:1", "found before being abandoned");
        yield 1;
        yield 2;
      }
      // One step, then drop it on the floor — no `.return()`, no `finally`.
      const iterator = withDriftReport("codex", abandoned(), stateDir)[Symbol.asyncIterator]();
      await iterator.next();

      vi.advanceTimersByTime(11 * 60_000);
      await scan("codex", [["/store/b.jsonl:2", "found by the next scan"]]);

      const kept = (await readDriftLog(stateDir, "codex"))?.surprises.map((e) => e.surprise) ?? [];
      expect(kept).toContain("found by the next scan");
      // The abandoned scan's finding is adopted, not thrown away.
      expect(kept).toContain("found before being abandoned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing when a scan finds no surprises", async () => {
    await scan("codex", []);

    await expect(readFile(join(stateDir, "codex-drift.json"), "utf-8")).rejects.toThrow();
  });
});

/**
 * One project is normally served by several xtctx processes at once — every
 * connected agent spawns its own `npx -y xtctx` — so concurrent scans of one
 * tool are ordinary, not a corner. An in-process queue cannot see them, and
 * they silently overwrote each other's findings. An incremental scan does not
 * re-read records it has already consumed, so a surprise lost that way is
 * never found again.
 *
 * Only real processes can fail this, which is why it pays the cost of spawning
 * them.
 */
describe("drift logs written by concurrent processes", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-drift-procs-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps every process's surprises", async () => {
    const worker = join(stateDir, "worker.mjs");
    const driftLogUrl = pathToFileURL(resolve("src/scrapers/drift-log.ts")).href;
    await writeFile(
      worker,
      [
        `const { recordDrift, withDriftReport } = await import(${JSON.stringify(driftLogUrl)});`,
        "const [stateDir, label] = process.argv.slice(2);",
        // Each surprise is recorded by exactly one scan and never again — the
        // case that matters, because an incremental scan does not re-read the
        // records it has already consumed. A worker that re-asserted its own
        // findings every scan would paper over a lost update on the next pass.
        "async function* source(scan) {",
        `  recordDrift("codex", "/store/" + label + ".jsonl:" + scan, label + " surprise " + scan);`,
        "  yield 1;",
        "}",
        "for (let scan = 0; scan < 15; scan += 1) {",
        `  for await (const _chunk of withDriftReport("codex", source(scan), stateDir)) { void _chunk; }`,
        "}",
      ].join("\n"),
      "utf-8",
    );

    await Promise.all(
      ["A", "B", "C"].map(
        (label) =>
          new Promise<void>((resolvePromise, rejectPromise) => {
            const child = spawn(
              process.execPath,
              [resolve("node_modules/tsx/dist/cli.mjs"), worker, stateDir, label],
              { stdio: "ignore" },
            );
            child.once("error", rejectPromise);
            child.once("exit", (code) =>
              code === 0 ? resolvePromise() : rejectPromise(new Error(`worker ${label} exited ${code}`)),
            );
          }),
      ),
    );

    const log = await readDriftLog(stateDir, "codex");
    // 3 workers x 15 one-shot surprises, all under the 50 ceiling: nothing here
    // has a legitimate reason to be missing.
    expect(log?.surprises).toHaveLength(45);
  }, 120_000);
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
