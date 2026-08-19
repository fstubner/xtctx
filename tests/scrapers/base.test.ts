import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ScraperStateManager } from "@xtctx/scrapers/base";
import { estimateTokens, toDate } from "@xtctx/scrapers/base";

describe("estimateTokens", () => {
  it("estimates 0 for empty or null text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles plain text standard scaling (4 chars per token)", () => {
    expect(estimateTokens("Hello World")).toBe(Math.ceil(11 / 4));
  });

  it("weighs code symbols and syntax elements more heavily", () => {
    const plain = "let x = 123;";
    // length is 12. 12 / 4 = 3. symbols: { = , ; } -> 2 symbols.
    // 2 / 2 = 1. total = 3 + 1 = 4.
    expect(estimateTokens(plain)).toBe(4);
  });
});

describe("toDate", () => {
  it("returns input if already a Date object", () => {
    const now = new Date();
    expect(toDate(now)).toBe(now);
  });

  it("parses numeric timestamps correctly", () => {
    const timestampMs = 1716578000000;
    expect(toDate(timestampMs).getTime()).toBe(timestampMs);

    const timestampSec = 1716578000;
    expect(toDate(timestampSec).getTime()).toBe(timestampMs);
  });

  it("parses ISO date strings correctly", () => {
    const isoString = "2026-05-24T20:00:00.000Z";
    expect(toDate(isoString).toISOString()).toBe(isoString);
  });

  it("returns sentinel date(0) for invalid inputs", () => {
    expect(toDate(null).getTime()).toBe(0);
    expect(toDate("invalid-date").getTime()).toBe(0);
  });
});

describe("ScraperStateManager", () => {
  it("round-trips saved positions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    try {
      const manager = new ScraperStateManager(dir);
      const saved = new Date("2026-05-10T10:00:00.000Z");
      await manager.save("codex", { lastTimestamp: saved });

      const state = await manager.load("codex");
      expect(state.lastTimestamp.getTime()).toBe(saved.getTime());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets an invalid persisted timestamp to epoch instead of Invalid Date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    try {
      await writeFile(join(dir, "codex-state.json"), '{"lastTimestamp":"garbage"}', "utf-8");

      const state = await new ScraperStateManager(dir).load("codex");

      // An Invalid Date poisons every cutoff comparison (all false), which
      // re-emits the entire history on every scrape forever.
      expect(Number.isNaN(state.lastTimestamp.getTime())).toBe(false);
      expect(state.lastTimestamp.getTime()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
