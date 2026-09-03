/**
 * Every scraper answers to the tool id the rest of the system looks it up by.
 *
 * A scraper's name is load-bearing in two places that never meet: it is the
 * key `xtctx status` and the index group sessions under, and it is the key its
 * drift log is filed against. Those used to be separate literals in each
 * scraper — a module-level `SCRAPER_NAME` for the drift log and a
 * `readonly tool` for everything else — so one could be changed without the
 * other. A scraper whose drift name had drifted would file its format
 * warnings under a name nothing reads: silently, forever, and exactly when
 * an upstream format has moved and the warning matters most.
 *
 * The two are one value now, so they cannot disagree. What they can still be
 * is wrong — a typo, or a tool renamed in one place — and that was caught by
 * nothing: renaming a scraper wholesale passed all 346 scraper and config
 * tests. This ties the scrapers the runtime builds to the tool table
 * everything else reads, so a name that exists nowhere else fails here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORTED_TOOLS, createDefaultScrapers } from "@xtctx/tools/sources";

describe("scraper identity", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-identity-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("names itself with an id the tool table declares", () => {
    const declared = new Set(SUPPORTED_TOOLS.map((tool) => tool.id));
    const scrapers = createDefaultScrapers(stateDir);

    expect(scrapers.length).toBeGreaterThan(0);
    for (const scraper of scrapers) {
      expect(declared, `${scraper.tool} is not in SUPPORTED_TOOLS`).toContain(scraper.tool);
    }
  });

  it("builds one scraper per supported tool, with no id used twice", () => {
    // A duplicate id would have two scrapers writing one drift log and one
    // session group, which reads as a single tool behaving strangely rather
    // than as two tools colliding.
    const scrapers = createDefaultScrapers(stateDir);
    const ids = scrapers.map((scraper) => scraper.tool);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(SUPPORTED_TOOLS.map((tool) => tool.id).sort());
  });
});
