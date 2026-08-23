import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 *
 * The summary is also written to `<stateDir>/<tool>-drift.json`, because
 * stderr from an MCP server goes to the host agent's log — somewhere nobody
 * reads and nothing retains. A surprise matters most the first time a reader
 * meets a tool's real transcripts, which is exactly when no one is watching
 * the log, so it has to outlive the scan that found it.
 */

/** Enough to identify a surprise; the rest is a parser's opinion of it. */
const MAX_SURPRISE_LENGTH = 300;

/**
 * `JSON.parse` puts a byte offset in its message, so one malformed store
 * yields a distinct surprise string per bad line. Without a ceiling the file
 * grows without bound — the same drowning this module exists to prevent, moved
 * from stderr onto disk.
 */
const MAX_SURPRISES = 50;

export interface DriftSurprise {
  surprise: string;
  firstLocation: string;
  firstSeen: string;
  lastSeen: string;
  records: number;
}

export interface DriftLogFile {
  tool: string;
  updatedAt: string;
  /** Distinct surprises discarded to stay under the ceiling; never silent. */
  droppedSurprises: number;
  surprises: DriftSurprise[];
}

function driftLogPath(stateDir: string, tool: string): string {
  return join(stateDir, `${tool}-drift.json`);
}

/**
 * Strip terminal control characters.
 *
 * A surprise quotes values read out of another tool's transcript, and a
 * transcript is untrusted input — a poisoned repository produces a poisoned
 * transcript. `status` prints these straight to a terminal, so an escape
 * sequence in one would let that transcript clear the screen and forge lines
 * of xtctx's own output. Applied on the way in and again on the way out, so a
 * log written by an older version or edited by hand cannot smuggle any back.
 */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/** Read a tool's persisted drift log; null when it has never drifted. */
export async function readDriftLog(stateDir: string, tool: string): Promise<DriftLogFile | null> {
  let raw: string;
  try {
    raw = await readFile(driftLogPath(stateDir, tool), "utf-8");
  } catch {
    // No log is the normal case, not an error: most tools never drift.
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as DriftLogFile;
    if (!Array.isArray(parsed?.surprises)) return null;
    return {
      tool: typeof parsed.tool === "string" ? parsed.tool : tool,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      droppedSurprises: typeof parsed.droppedSurprises === "number" ? parsed.droppedSurprises : 0,
      // Every element is checked, not just the array around them. A file that
      // parses but holds the wrong shape used to reach `entry.surprise` in
      // `status` — which then printed nothing at all, the diagnostic command
      // being the one that died — and to throw inside the writer, wedging that
      // tool's log for good. Unusable entries are dropped, not repaired.
      surprises: parsed.surprises.filter(isDriftSurprise).map((entry) => ({
        ...entry,
        surprise: stripControlCharacters(entry.surprise),
        firstLocation: stripControlCharacters(entry.firstLocation),
      })),
    };
  } catch {
    // A corrupt log is a lost diagnostic, not a reason to fail a caller.
    return null;
  }
}

function isDriftSurprise(value: unknown): value is DriftSurprise {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.surprise === "string" &&
    typeof entry.firstLocation === "string" &&
    typeof entry.firstSeen === "string" &&
    typeof entry.lastSeen === "string" &&
    typeof entry.records === "number" &&
    Number.isFinite(entry.records)
  );
}

/**
 * Writes for one tool's log are serialised within this process.
 *
 * The read-modify-write below would otherwise lose an update when two scans of
 * the same tool overlap, and what it would lose is the record this whole file
 * exists to keep. Nothing watches a background scan, so the loss would be
 * invisible.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(key: string, work: () => Promise<void>): Promise<void> {
  const queued = (writeQueues.get(key) ?? Promise.resolve()).then(work, work);
  writeQueues.set(key, queued);
  return queued.finally(() => {
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  });
}

/**
 * A lock is only stale once it is this old.
 *
 * Judged from the lock file's own age rather than from how long this process
 * has been waiting: a busy machine can make a perfectly healthy write take
 * longer than a short patience threshold, and breaking a live holder's lock is
 * exactly the interleaving the lock exists to prevent. A real write is
 * milliseconds, so this leaves three orders of magnitude of headroom while
 * still reclaiming a lock from a process that died holding one.
 */
const STALE_LOCK_MS = 30_000;
/** Hard ceiling on waiting, so a scan can never hang on a lock. */
const MAX_LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 25;

/**
 * Serialise across processes as well, because one project is normally served
 * by several of them: every connected agent spawns its own `npx -y xtctx`, so
 * two concurrent scans of one tool is the ordinary case rather than a corner.
 * An in-process queue alone let those processes overwrite each other, and an
 * incremental scan does not re-read records it has already consumed — so a
 * surprise lost this way is not found again on the next pass.
 *
 * `wx` fails when the lock exists, which is the atomic test-and-set this needs.
 * A lock older than the timeout is assumed to belong to a process that died
 * holding it; leaving one behind would disable drift persistence permanently,
 * which is worse than the interleaving the lock prevents.
 */
async function withFileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const giveUpAt = Date.now() + MAX_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await work();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const heldFor = await lockAge(lockPath);
      if (heldFor === null) {
        // Released between the failed open and the stat: just try again.
        continue;
      }
      if (heldFor > STALE_LOCK_MS || Date.now() >= giveUpAt) {
        // Whoever held this is not coming back. Break it and take it.
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Age of the lock file in ms, or null if it is already gone. */
async function lockAge(lockPath: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

async function persist(
  stateDir: string,
  tool: string,
  found: Map<string, { firstLocation: string; records: number }>,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await readDriftLog(stateDir, tool);
  const merged = new Map<string, DriftSurprise>(
    (existing?.surprises ?? []).map((entry) => [entry.surprise, entry]),
  );

  for (const [rawSurprise, { firstLocation: rawLocation, records }] of found) {
    const surprise = stripControlCharacters(rawSurprise.slice(0, MAX_SURPRISE_LENGTH));
    const firstLocation = stripControlCharacters(rawLocation);
    const seen = merged.get(surprise);
    if (seen) {
      seen.records += records;
      seen.lastSeen = now;
      continue;
    }
    merged.set(surprise, { surprise, firstLocation, firstSeen: now, lastSeen: now, records });
  }

  // Most recently seen first, so the ceiling drops what stopped happening.
  //
  // Ties are broken by first sighting, newest first, and that tie-break is the
  // whole point: every surprise seen in one scan shares a `lastSeen`, so a
  // stable sort alone would keep the incumbents and discard the newcomer. A
  // tool sitting at the ceiling on recurring surprises could then never record
  // a genuine new format break — the one event this file exists to capture.
  const ordered = [...merged.values()].sort(
    (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.firstSeen.localeCompare(a.firstSeen),
  );
  const kept = ordered.slice(0, MAX_SURPRISES);

  const log: DriftLogFile = {
    tool,
    updatedAt: now,
    // What this write discarded, not a running total. Accumulating it counted
    // the same overflow again on every scan, producing a number with no
    // relationship to how many distinct surprises had actually been lost.
    droppedSurprises: ordered.length - kept.length,
    surprises: kept,
  };

  const path = driftLogPath(stateDir, tool);
  // Unique per process: a shared fixed tmp name is one file two writers can be
  // inside at once, which is the corruption the rename is supposed to prevent.
  const tmpPath = `${path}.${process.pid}.tmp`;
  // Same tmp-then-rename as scraper state: a crash mid-write must not leave a
  // corrupt log behind.
  await writeFile(tmpPath, JSON.stringify(log, null, 2), "utf-8");
  await rename(tmpPath, path);
}

class DriftLog {
  private readonly surprises = new Map<string, { firstLocation: string; records: number }>();

  constructor(
    private readonly tool: string,
    readonly stateDir?: string,
  ) {}

  record(location: string, surprise: string): void {
    const seen = this.surprises.get(surprise);
    if (seen) {
      seen.records += 1;
      return;
    }
    this.surprises.set(surprise, { firstLocation: location, records: 1 });
  }

  async flush(): Promise<void> {
    if (this.surprises.size === 0) {
      return;
    }

    for (const [surprise, { firstLocation, records }] of this.surprises) {
      console.warn(
        `[${this.tool}] schema-drift surprise at ${firstLocation}: ${surprise} ` +
          `(records affected: ${records})`,
      );
    }

    const found = new Map(this.surprises);
    this.surprises.clear();

    if (!this.stateDir) {
      return;
    }

    const stateDir = this.stateDir;
    await enqueueWrite(`${stateDir}\u0000${this.tool}`, async () => {
      try {
        // Before the lock, because the lock file lives in this directory.
        await mkdir(stateDir, { recursive: true });
        await withFileLock(`${driftLogPath(stateDir, this.tool)}.lock`, () =>
          persist(stateDir, this.tool, found),
        );
      } catch (err) {
        // Losing the diagnostic must not fail the scan that produced it — but
        // say so, rather than dropping it twice over.
        console.warn(`[${this.tool}] could not persist drift log: ${(err as Error).message}`);
      }
    });
  }
}

/**
 * Scans in progress, by tool.
 *
 * Depth-counted rather than replaced: two scans of the same tool can overlap
 * (two projects served by one process), and the second finishing must not
 * flush the first one's findings out from under it. When those two projects
 * disagree about the state directory the first one's wins, so the log lands
 * beside one of the two indexes rather than being split across both.
 */
const activeScans = new Map<string, { log: DriftLog; depth: number; touchedAt: number }>();

/**
 * How long an unfinished scan may sit before the next one treats it as dead.
 *
 * The depth count is released in the generator's `finally`, and a consumer that
 * abandons an iterator without calling `.return()` never runs it — `for await`
 * and `break` both do, so this is about a caller that stops mid-stream, which
 * `AbstractScraper` invites as a documented extension point. The entry would
 * then sit at depth 1 forever and every later scan of that tool would
 * accumulate into a log nothing ever flushes, silently disabling drift
 * reporting for the life of the process.
 *
 * Generous on purpose: it only has to exceed a real scan, and every recorded
 * surprise pushes it back. The findings of an abandoned scan are not lost —
 * the next scan of that tool adopts and flushes them.
 */
const ABANDONED_SCAN_MS = 10 * 60_000;

/**
 * Report a surprise found while reading another tool's transcript.
 *
 * Inside a scan this is collected and summarised at the end. Outside one it
 * warns immediately, so a direct caller still sees it rather than nothing.
 */
export function recordDrift(tool: string, location: string, surprise: string): void {
  const active = activeScans.get(tool);
  if (active) {
    active.touchedAt = Date.now();
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
  stateDir?: string,
): AsyncIterable<T> {
  const previous = activeScans.get(tool);
  // An entry that has sat untouched past the threshold belongs to a scan whose
  // `finally` will never run. Adopt its findings rather than joining it, so the
  // count starts clean and the abandoned scan's surprises still reach disk.
  const abandoned = previous !== undefined && Date.now() - previous.touchedAt > ABANDONED_SCAN_MS;
  const existing = abandoned ? undefined : previous;
  const active = existing ?? {
    log: abandoned && previous ? previous.log : new DriftLog(tool, stateDir),
    depth: 0,
    touchedAt: Date.now(),
  };
  active.depth += 1;
  active.touchedAt = Date.now();
  activeScans.set(tool, active);

  try {
    yield* source;
  } finally {
    active.depth -= 1;
    if (active.depth === 0) {
      activeScans.delete(tool);
      await active.log.flush();
    }
  }
}
