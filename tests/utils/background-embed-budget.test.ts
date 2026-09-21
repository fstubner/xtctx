/**
 * A backlog nothing is working on has to say so.
 *
 * The MCP server drains the vector backlog at session start only while the
 * estimate fits `BACKGROUND_EMBED_BUDGET_MS`. Above it, nothing is working the
 * backlog down and the only thing that will is `xtctx scan --embed`.
 *
 * That state is invisible without a line about it, and indistinguishable from
 * the one just above it in `xtctx status`: both read as a number of windows
 * outstanding with a time estimate, while one finishes on its own within
 * minutes and the other never finishes at all. The second is what a large
 * history on a CPU-only machine gets after a model change invalidates every
 * vector it had.
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_EMBED_BUDGET_MS, estimateVectorBacklog } from "@xtctx/utils/duration";

describe("background embed budget", () => {
  it("puts a large history on a slow machine over the budget", () => {
    // 9,232 windows at the CPU rate measured on this project, 551.9ms/window.
    const { etaMs } = estimateVectorBacklog(9232, 0, 551.9);

    expect(etaMs).not.toBeNull();
    expect(etaMs!).toBeGreaterThan(BACKGROUND_EMBED_BUDGET_MS);
  });

  it("keeps the same history under the budget once a GPU is chosen", () => {
    // The same 9,232 windows at 50.7ms/window, measured on DirectML. This is
    // the pairing that decides the threshold: one number, two devices, and the
    // budget has to separate them.
    const { etaMs } = estimateVectorBacklog(9232, 0, 50.7);

    expect(etaMs).not.toBeNull();
    expect(etaMs!).toBeLessThan(BACKGROUND_EMBED_BUDGET_MS);
  });

  it("reports no estimate when no rate has been measured yet", () => {
    // Nothing has embedded on this machine, so there is no basis for judging
    // affordability. The server leaves it alone rather than guessing.
    expect(estimateVectorBacklog(1000, 0, null).etaMs).toBeNull();
  });
});
