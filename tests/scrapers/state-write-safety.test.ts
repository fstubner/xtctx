/**
 * Three writers under `.xtctx/state/` did their own tmp-then-rename instead of
 * using `writeFileAtomic`, and each one picked a temp name an attacker can
 * predict: `<path>.tmp`, `<path>.<pid>.tmp`, and — for the hook's store-dir
 * cache — no temp file at all.
 *
 * A plain `writeFile` to a predictable path follows whatever is already there.
 * `writeFileAtomic` was written for exactly this: a random suffix so the name
 * cannot be guessed, and `flag: "wx"` so the open fails rather than writing
 * through something pre-planted. The project had the answer and these three
 * did not use it.
 *
 * The tests assert the property rather than staging a symlink, because file
 * symlinks need elevation on Windows and a test that quietly skips on the
 * maintainer's own platform is worth less than no test. Pre-planting a plain
 * file at the predictable name proves the same thing: the writer must not
 * touch it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScraperStateManager } from "@xtctx/scrapers/base";
import { recordDrift, withDriftReport } from "@xtctx/scrapers/drift-log";

const SENTINEL = "someone else's file\n";

describe("state writes do not go through predictable temp paths", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-statewrite-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("leaves a file squatting the scraper-state temp name untouched", async () => {
    const target = join(stateDir, "claude-code-state.json");
    const squatted = `${target}.tmp`;
    await writeFile(squatted, SENTINEL, "utf-8");

    await new ScraperStateManager(stateDir).save("claude-code", {
      lastTimestamp: new Date("2026-02-24T10:00:00Z"),
    });

    expect(await readFile(squatted, "utf-8")).toBe(SENTINEL);
    // …and the real write still landed.
    const saved = JSON.parse(await readFile(target, "utf-8")) as { lastTimestamp: string };
    expect(saved.lastTimestamp).toBe("2026-02-24T10:00:00.000Z");
  });

  it("leaves a file squatting the drift-log temp name untouched", async () => {
    // `<path>.<pid>.tmp` is only unique against *other* processes. Anything
    // that can read `/proc`, or simply pre-create a few thousand candidates,
    // predicts it.
    const target = join(stateDir, "claude-code-drift.json");
    const squatted = `${target}.${process.pid}.tmp`;
    await writeFile(squatted, SENTINEL, "utf-8");

    async function* scan(): AsyncIterable<number> {
      recordDrift("claude-code", "s.jsonl:1", "unknown record type");
      yield 1;
    }
    // The log is written when the scan ends, so it has to be drained.
    for await (const value of withDriftReport("claude-code", scan(), stateDir)) void value;

    expect(await readFile(squatted, "utf-8")).toBe(SENTINEL);
    expect(JSON.parse(await readFile(target, "utf-8"))).toMatchObject({ tool: "claude-code" });
  });
});
