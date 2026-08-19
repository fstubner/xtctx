import { describe, expect, it } from "vitest";
import { poolVectors, splitTextForEmbedding } from "@xtctx/handoff/embeddings";

describe("splitTextForEmbedding", () => {
  it("returns a single segment for short text", () => {
    expect(splitTextForEmbedding("short text", 1000)).toEqual(["short text"]);
  });

  it("splits long multi-line text at line boundaries and reconstructs exactly", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(90)}`);
    const text = lines.join("\n");

    const segments = splitTextForEmbedding(text, 1000);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(1000);
    }
    expect(segments.join("\n")).toBe(text);
  });

  it("hard-splits a single oversized line without losing content", () => {
    const text = "y".repeat(2500);

    const segments = splitTextForEmbedding(text, 1000);

    expect(segments.length).toBe(3);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(1000);
    }
    expect(segments.join("")).toBe(text);
  });
});

describe("poolVectors", () => {
  it("returns a single vector unchanged", () => {
    const vector = Float32Array.from([0.6, 0.8]);
    expect(poolVectors([vector])).toBe(vector);
  });

  it("mean-pools multiple vectors and re-normalizes to unit length", () => {
    const pooled = poolVectors([
      Float32Array.from([1, 0]),
      Float32Array.from([0, 1]),
    ]);

    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(pooled[1]).toBeCloseTo(Math.SQRT1_2, 5);
    const norm = Math.hypot(...pooled);
    expect(norm).toBeCloseTo(1, 5);
  });
});
