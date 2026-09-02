import { describe, expect, it } from "vitest";
import { SCAN_MIN_INTERVAL_MS, indexNeedsScan } from "@xtctx/runtime/index-freshness";

/**
 * The gate in front of the startup scan. See the module for why there is a
 * startup scan at all; this pins only that it fires when the index is cold or
 * stale and not when a scan just finished.
 */
describe("indexNeedsScan", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");

  it("scans an index that has never been scanned", () => {
    expect(indexNeedsScan(null, now)).toBe(true);
  });

  it("scans when the last scan is older than the interval", () => {
    const stale = new Date(now - SCAN_MIN_INTERVAL_MS - 1).toISOString();
    expect(indexNeedsScan(stale, now)).toBe(true);
  });

  it("does not scan when one finished recently", () => {
    // Every process start would otherwise walk every store on the machine;
    // one that just finished has nothing new to find.
    const fresh = new Date(now - 30_000).toISOString();
    expect(indexNeedsScan(fresh, now)).toBe(false);
  });

  it("scans when the recorded time cannot be read", () => {
    // A value that parses as nothing is not evidence of freshness.
    expect(indexNeedsScan("not a date", now)).toBe(true);
  });
});
