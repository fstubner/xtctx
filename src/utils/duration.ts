/**
 * Human-readable durations for status output.
 *
 * `xtctx status` and `xtctx_continuity_status` both report how long the last
 * scan took and how much embedding is outstanding, and a raw millisecond count
 * is the wrong unit for both — "1770 windows left" says nothing until it is
 * "about 30 seconds".
 */

/** `1.4s`, `2m 05s`, `340ms`. Null in, null out, so callers can pass through. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * How much embedding is left, from the backlog and the last pass's rate.
 *
 * Returns null when there is nothing outstanding or no rate has been measured
 * yet — an estimate invented from no measurement is worse than no estimate.
 */
export function estimateVectorBacklog(
  retrievalUnits: number,
  vectorizedUnits: number,
  msPerUnit: number | null | undefined,
): { remaining: number; eta: string | null } {
  const remaining = Math.max(0, retrievalUnits - vectorizedUnits);
  if (remaining === 0 || msPerUnit === null || msPerUnit === undefined || !(msPerUnit > 0)) {
    return { remaining, eta: null };
  }
  return { remaining, eta: formatDuration(remaining * msPerUnit) };
}
