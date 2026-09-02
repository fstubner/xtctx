/**
 * How recently a scan must have finished for a starting process not to
 * begin another.
 *
 * The index is only as fresh as the last scan, and scans happen on demand —
 * so the first session after another tool's work found nothing. Measured
 * live: Codex left a decision in its transcript, Claude Code opened next, its
 * session-start hook printed "Last scan: never", and the agent refactored
 * that decision away. One MCP call later the same hook named the Codex
 * session and the agent read it unprompted before touching the file.
 *
 * The MCP server now starts a scan when it starts, so the index is warm for
 * the next session (and for any call in this one that comes after the scan).
 * It was first tried as a detached child of the hook, which worked when the
 * hook was run by hand and never ran under Claude Code on Windows: the hook's
 * process tree is torn down when the hook returns, detached or not. The MCP
 * server process is started by the host and lives for the whole session, so
 * it needs no escape from anything.
 *
 * Not on every start, though: a scan walks every transcript store on the
 * machine (about 20s against a 19GB Codex store, measured), and one that
 * finished a minute ago has nothing new to find.
 */
export const SCAN_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** True when a scan should be started now, given when the last one finished. */
export function indexNeedsScan(lastScanAt: string | null, now = Date.now()): boolean {
  if (lastScanAt === null) {
    return true;
  }
  const finished = Date.parse(lastScanAt);
  return !Number.isFinite(finished) || now - finished > SCAN_MIN_INTERVAL_MS;
}
