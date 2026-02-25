import { describe, it, expect } from "vitest";
import { fuseResults, type RankedResult } from "@xtctx/store/search";

describe("fuseResults (RRF)", () => {
  it("ranks items appearing in both lists higher", () => {
    const vectorResults: RankedResult[] = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.7 },
      { id: "c", score: 0.5 },
    ];
    const bm25Results: RankedResult[] = [
      { id: "b", score: 0.95 },
      { id: "d", score: 0.8 },
      { id: "a", score: 0.6 },
    ];

    const fused = fuseResults(vectorResults, bm25Results);

    expect(fused[0].id).toBe("b");
    expect(fused[1].id).toBe("a");
    expect(fused.length).toBe(4);
  });

  it("returns empty for empty inputs", () => {
    expect(fuseResults([], [])).toEqual([]);
  });
});
