/**
 * Drift reporting, collected per scan and reported once per kind of surprise.
 *
 * The product's promise about other tools changing their formats is that it
 * warns rather than silently dropping data. Warning per record honours that
 * only while a surprise is rare. When one is common the signal drowns itself:
 * a single claude-code scan emitted 344 warnings and 74KB of stderr into the
 * MCP host's log, and codex does the same the moment a new event type appears
 * — `world_state` was in every recent transcript here.
 *
 * So each distinct surprise is reported once, with how many records it
 * affected and where it was first seen. Every scraper had its own copy of the
 * per-record version; they share this one.
 */
class DriftLog {
  private readonly surprises = new Map<string, { firstLocation: string; records: number }>();

  constructor(private readonly tool: string) {}

  record(location: string, surprise: string): void {
    const seen = this.surprises.get(surprise);
    if (seen) {
      seen.records += 1;
      return;
    }
    this.surprises.set(surprise, { firstLocation: location, records: 1 });
  }

  flush(): void {
    for (const [surprise, { firstLocation, records }] of this.surprises) {
      console.warn(
        `[${this.tool}] schema-drift surprise at ${firstLocation}: ${surprise} ` +
          `(records affected: ${records})`,
      );
    }
    this.surprises.clear();
  }
}

/**
 * Scans in progress, by tool.
 *
 * Depth-counted rather than replaced: two scans of the same tool can overlap
 * (two projects served by one process), and the second finishing must not
 * flush the first one's findings out from under it.
 */
const activeScans = new Map<string, { log: DriftLog; depth: number }>();

/**
 * Report a surprise found while reading another tool's transcript.
 *
 * Inside a scan this is collected and summarised at the end. Outside one it
 * warns immediately, so a direct caller still sees it rather than nothing.
 */
export function recordDrift(tool: string, location: string, surprise: string): void {
  const active = activeScans.get(tool);
  if (active) {
    active.log.record(location, surprise);
    return;
  }

  console.warn(`[${tool}] schema-drift surprise at ${location}: ${surprise} (records affected: 1)`);
}

/**
 * Wrap a scan so its drift findings are summarised when it ends.
 *
 * `finally` rather than after the loop: a consumer that stops reading early
 * still gets the warnings for the part it did read.
 */
export async function* withDriftReport<T>(
  tool: string,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  const existing = activeScans.get(tool);
  const active = existing ?? { log: new DriftLog(tool), depth: 0 };
  active.depth += 1;
  activeScans.set(tool, active);

  try {
    yield* source;
  } finally {
    active.depth -= 1;
    if (active.depth === 0) {
      activeScans.delete(tool);
      active.log.flush();
    }
  }
}
