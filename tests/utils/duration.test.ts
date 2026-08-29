import { describe, expect, it } from "vitest";
import { estimateVectorBacklog, formatDuration } from "@xtctx/utils/duration";

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1_400)).toBe("1.4s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  it("returns null rather than a fabricated duration", () => {
    // Settings are stored as text, so a value written by an older version or
    // by hand reaches here as whatever it happens to be. Reporting "NaNms" in
    // a status readout is worse than reporting nothing.
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe("estimateVectorBacklog", () => {
  it("turns a backlog into a duration", () => {
    expect(estimateVectorBacklog(1770, 8, 18)).toEqual({ remaining: 1762, eta: "31.7s" });
  });

  it("gives no estimate when nothing has been measured", () => {
    // An estimate invented from no measurement is worse than no estimate: the
    // first scan on a fresh index has no rate yet, and guessing one would put
    // a number in front of a user that nothing supports.
    expect(estimateVectorBacklog(1770, 8, null)).toEqual({ remaining: 1762, eta: null });
    expect(estimateVectorBacklog(1770, 8, 0)).toEqual({ remaining: 1762, eta: null });
  });

  it("reports nothing outstanding once the corpus is covered", () => {
    expect(estimateVectorBacklog(1770, 1770, 18)).toEqual({ remaining: 0, eta: null });
    // More vectors than windows is possible mid-rebuild; it is not a negative
    // backlog.
    expect(estimateVectorBacklog(10, 12, 18).remaining).toBe(0);
  });
});
