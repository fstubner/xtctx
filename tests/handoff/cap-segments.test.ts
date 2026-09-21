import { describe, expect, it } from "vitest";
import { capSegments, MAX_SEGMENTS_PER_UNIT } from "@xtctx/handoff/embeddings";

describe("capSegments", () => {
  it("leaves a window that is already short enough alone", () => {
    const segments = ["a", "b", "c"];
    expect(capSegments(segments)).toBe(segments);
  });

  it("spreads the sample across the window rather than taking its opening", () => {
    // The first 16KB of a 400KB window is an arbitrary slice of it. A pooled
    // vector is meant to summarise the window, so the sample has to reflect
    // how it begins, develops and ends.
    const segments = Array.from({ length: 100 }, (_, index) => `s${index}`);
    const capped = capSegments(segments, 4);

    // The whole sample, not its endpoints. Asserting only the first and last
    // element left this passing against `segments.slice(0, limit)` — proven by
    // replacing the body with exactly that and watching the file stay green,
    // which meant the behaviour the function exists for was undefended.
    expect(capped).toEqual(["s0", "s25", "s50", "s75"]);

    // Order preserved, so pooling stays deterministic.
    const indexes = capped.map((s) => Number(s.slice(1)));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);

    // The property the exact values above encode: every element comes from a
    // different quarter of the window, which truncation cannot satisfy.
    const spread = indexes[indexes.length - 1] - indexes[0];
    expect(spread).toBeGreaterThan(segments.length / 2);
  });

  it("never returns more than the limit, at any size", () => {
    for (const size of [17, 100, 392, 1000]) {
      const segments = Array.from({ length: size }, (_, index) => `s${index}`);
      expect(capSegments(segments).length).toBe(MAX_SEGMENTS_PER_UNIT);
    }
  });

  it("pins the cap against being lowered", () => {
    // Measured over this project's 1,770 windows: median 4 segments, p95 17,
    // max 392. A cap below the bulk of the distribution would be trading
    // quality for speed on ordinary windows rather than trimming the tail.
    // A floor, not a property: `>= 16` against a constant of 16 only restates
    // the value, so this catches the cap being lowered and nothing else. It
    // does NOT establish what the heading claims — p95 is 17, so 16 already
    // clips part of that bucket, deliberately. Raising the cap to 17 is a cost
    // decision about embedding time, not a test fix, and is not made here.
    expect(MAX_SEGMENTS_PER_UNIT).toBeGreaterThanOrEqual(16);
  });
});
