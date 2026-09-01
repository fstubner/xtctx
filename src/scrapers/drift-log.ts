import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";

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
 * Grace before a lock naming no live process is broken.
 *
 * Only covers the gap between `open` and the pid being written, so it needs to
 * be short. A lock whose holder is gone is broken immediately, which is what
 * keeps a killed server from stalling the next scan.
 */
const LOCK_PID_GRACE_MS = 250;
/**
 * Hard ceiling on waiting.
 *
 * `flush` is awaited in the scan's `finally`, so this sits on the critical path
 * of an MCP tool call, and hosts give up on those in well under a minute. A
 * lock left behind by a killed server — MCP servers are routinely SIGKILLed —
 * used to stall the next scan for a full thirty seconds. A write takes single
 * -digit milliseconds, so seconds are already enormous headroom.
 */
const MAX_LOCK_WAIT_MS = 3_000;

/**
 * Override for the wait budget, in milliseconds.
 *
 * The default is sized for an MCP tool call, not for correctness under
 * contention. A test that deliberately makes several processes fight over one
 * log is measuring the lock, and on a loaded machine three seconds says more
 * about the machine than about the lock.
 */
function lockWaitBudgetMs(): number {
  const raw = Number.parseInt(process.env.XTCTX_LOCK_WAIT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_LOCK_WAIT_MS;
}
const LOCK_RETRY_MS = 25;

/**
 * Errors that mean "someone else has it", not "this cannot work".
 *
 * `EEXIST` is the POSIX answer. Windows adds `EPERM` when the lock file is in
 * the delete-pending state — the previous holder called `rm` and the deletion
 * has not finalised — and `EBUSY`/`EACCES` for the same window under a
 * scanner or indexer. Treating those as fatal was a data-loss bug: the error
 * escaped the lock, the scan's findings were discarded, and an incremental
 * scan never re-reads the records that produced them. It cost 2 surprises in
 * 50 across ten concurrent writers.
 */
const LOCK_CONTENTION_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

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
  const giveUpAt = Date.now() + lockWaitBudgetMs();
  let brokeLock = false;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        // Whoever waits next needs to know if this holder is still alive.
        await handle.writeFile(String(process.pid), "utf-8");
        return await work();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      if (!LOCK_CONTENTION_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw err;

      const heldFor = await lockAge(lockPath);
      if (heldFor === null) {
        // Released between the failed open and the stat: try again at once.
        continue;
      }

      // Whether to wait is decided by the holder, not by the clock. A pure
      // time limit cannot win both ways: short enough to clear a dead holder's
      // lock promptly is short enough to break a live one that a loaded
      // machine has starved, which is the interleaving the lock exists to
      // prevent — and that is exactly how this flaked in two directions.
      const holder = await lockHolderPid(lockPath);
      const holderAlive = holder !== null && processIsAlive(holder);
      const withinGrace = holder === null && heldFor <= LOCK_PID_GRACE_MS;
      if ((holderAlive || withinGrace) && Date.now() < giveUpAt) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }

      // A live holder's lock is never broken, however long the wait has run.
      //
      // Breaking one lets two writers interleave a read-modify-write over the
      // same file, which is the corruption the lock exists to prevent — so the
      // timeout was capable of causing exactly the loss it was protecting
      // against, and did, whenever a loaded machine starved the holder past
      // three seconds. Giving up instead costs nothing: the caller keeps the
      // batch and the next flush writes it, whereas a broken lock can discard
      // surprises another process had already committed.
      if (holderAlive) {
        throw new Error(
          `drift log lock held by live process ${holder} for ${heldFor}ms; ` +
            "leaving the batch pending for the next flush",
        );
      }

      if (Date.now() >= giveUpAt) {
        // Out of patience. One deliberate attempt to break it, then give the
        // error to the caller rather than spinning: a contention code that
        // never clears is a real failure (a read-only directory reports
        // EACCES too), and a scan must not loop on it forever.
        if (brokeLock) throw err;
        brokeLock = true;
      }

      // Stale, or the holder never came back: break it and take it.
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

/** The pid recorded in a lock file, or null if it has none yet. */
async function lockHolderPid(lockPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(lockPath, "utf-8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Signal 0 asks the OS whether a process exists without touching it. `EPERM`
 * means it exists and belongs to someone else — still alive, so still waiting.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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

  // Which surprises this write is seeing for the first time. Tracked
  // explicitly rather than inferred from `firstSeen`, because two scans can
  // land inside the same millisecond — on a fast machine they routinely do —
  // and then every timestamp is equal and "newest first" decides nothing.
  const firstTimeSeen = new Set<string>();

  for (const [rawSurprise, { firstLocation: rawLocation, records }] of found) {
    const surprise = stripControlCharacters(rawSurprise.slice(0, MAX_SURPRISE_LENGTH));
    const firstLocation = stripControlCharacters(rawLocation);
    const seen = merged.get(surprise);
    if (seen) {
      seen.records += records;
      seen.lastSeen = now;
      continue;
    }
    firstTimeSeen.add(surprise);
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
    (a, b) =>
      b.lastSeen.localeCompare(a.lastSeen) ||
      // Seen for the first time in this write wins outright. Comparing
      // `firstSeen` instead made the guarantee depend on the clock: two scans
      // inside one millisecond gave every entry the same timestamp, the sort
      // fell back to insertion order, and the newcomer — appended last —
      // was the one the ceiling dropped. It held on a slow machine and failed
      // on a fast one.
      Number(firstTimeSeen.has(b.surprise)) - Number(firstTimeSeen.has(a.surprise)) ||
      b.firstSeen.localeCompare(a.firstSeen),
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

  // Same tmp-then-rename as scraper state: a crash mid-write must not leave a
  // corrupt log behind. The temp name used to be `<path>.<pid>.tmp`, which is
  // unique against other *writers* but not against an attacker — a pid is
  // guessable, and the write was plain, so a file already sitting at that name
  // was written through. `writeFileAtomic` randomises it and opens with `wx`.
  await writeFileAtomic(driftLogPath(stateDir, tool), JSON.stringify(log, null, 2));
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
    const key = `${stateDir}\u0000${this.tool}`;
    await enqueueWrite(key, async () => {
      // Anything an earlier flush could not write goes out with this one. The
      // scan that found those surprises is over and its `DriftLog` is gone, so
      // without this hand-off a failed write loses them for good — and an
      // incremental scan never re-reads the records that produced them.
      const batch = takePending(key, found);
      try {
        // Before the lock, because the lock file lives in this directory.
        await mkdir(stateDir, { recursive: true });
        await withFileLock(`${driftLogPath(stateDir, this.tool)}.lock`, () =>
          persist(stateDir, this.tool, batch),
        );
      } catch (err) {
        keepPending(key, batch);
        // Losing the diagnostic must not fail the scan that produced it — but
        // say so, rather than dropping it twice over.
        console.warn(`[${this.tool}] could not persist drift log: ${(err as Error).message}`);
      }
    });
  }
}

type FoundSurprises = Map<string, { firstLocation: string; records: number }>;

/**
 * Surprises a failed write still owes the log, by state directory and tool.
 *
 * Bounded by the same ceiling as the file itself, so a directory that can never
 * be written to cannot grow this without limit.
 */
const pendingWrites = new Map<string, FoundSurprises>();

function takePending(key: string, found: FoundSurprises): FoundSurprises {
  const waiting = pendingWrites.get(key);
  if (!waiting) return found;
  pendingWrites.delete(key);

  for (const [surprise, entry] of found) {
    const seen = waiting.get(surprise);
    if (seen) {
      seen.records += entry.records;
      continue;
    }
    waiting.set(surprise, entry);
  }
  return waiting;
}

function keepPending(key: string, batch: FoundSurprises): void {
  pendingWrites.set(key, new Map([...batch].slice(0, MAX_SURPRISES)));
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
