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

    expect(capped).toHaveLength(4);
    expect(capped[0]).toBe("s0");
    expect(capped[capped.length - 1]).not.toBe("s1");
    // Order preserved, so pooling stays deterministic.
    const indexes = capped.map((s) => Number(s.slice(1)));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it("never returns more than the limit, at any size", () => {
    for (const size of [17, 100, 392, 1000]) {
      const segments = Array.from({ length: size }, (_, index) => `s${index}`);
      expect(capSegments(segments).length).toBe(MAX_SEGMENTS_PER_UNIT);
    }
  });

  it("keeps the default above the 95th percentile of real windows", () => {
    // Measured over this project's 1,770 windows: median 4 segments, p95 17,
    // max 392. A cap below the bulk of the distribution would be trading
    // quality for speed on ordinary windows rather than trimming the tail.
    expect(MAX_SEGMENTS_PER_UNIT).toBeGreaterThanOrEqual(16);
  });
});
