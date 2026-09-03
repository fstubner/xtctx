import { isRecord } from "../base.js";
import { warnDrift } from "./shared.js";

/** A journal record: 0 replaces the whole state, 1 sets a path, 2 splices an array. */
const LOG_SNAPSHOT = 0;
const LOG_SET = 1;
const LOG_SPLICE = 2;

/**
 * Rebuild a session from a `.jsonl` chat log.
 *
 * The file is a journal, not a list of sessions: the first record is a full
 * snapshot and every record after it is one mutation — `k` is a key path, `v`
 * the value, and for a splice `i` is where it goes. Reading it as "one session
 * per line" found only the snapshot, whose `requests` array is empty because
 * the turns arrive as later mutations, so a whole conversation read as an
 * empty session and said nothing about it. One 182KB file on the machine this
 * was written against holds four turns across 35 records.
 *
 * Turns are ordered by timestamp rather than by array position. A splice puts
 * requests in the order the editor wants to draw them, which is not the order
 * they happened — in that same file it places a later turn first.
 */
function replayChatSessionLog(raw: string, location: string): unknown {
  let state: Record<string, unknown> | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch (err) {
      warnDrift(location, `chat session line is not valid JSON: ${(err as Error).message}`);
      continue;
    }
    if (!isRecord(record)) continue;

    if (record.kind === LOG_SNAPSHOT) {
      state = isRecord(record.v) ? record.v : null;
      continue;
    }

    // A mutation before any snapshot has nothing to apply to. Later records
    // are still tried, in case a snapshot appears further down.
    if (!state || !Array.isArray(record.k)) continue;
    const path = record.k as Array<string | number>;

    if (record.kind === LOG_SET) {
      setAtPath(state, path, record.v);
    } else if (record.kind === LOG_SPLICE && Array.isArray(record.v)) {
      const target = readAtPath(state, path);
      if (Array.isArray(target)) {
        if (typeof record.i === "number") target.splice(record.i, 0, ...record.v);
        else target.push(...record.v);
      }
    }
  }

  if (!state) {
    warnDrift(location, "chat session log has no snapshot record to rebuild from");
    return null;
  }

  if (Array.isArray(state.requests)) {
    state.requests = sortRequestsByTime(state.requests);
  }
  return state;
}

/** Chronological where the data allows it, original order otherwise. */
function sortRequestsByTime(requests: unknown[]): unknown[] {
  const timed = requests.every(
    (request) => isRecord(request) && typeof request.timestamp === "number",
  );
  if (!timed) return requests;
  return [...requests].sort(
    (left, right) =>
      ((left as Record<string, number>).timestamp ?? 0) -
      ((right as Record<string, number>).timestamp ?? 0),
  );
}

/**
 * Key-path segments that reach the prototype chain instead of the object's own
 * data. The path comes out of the journal file, so it is attacker-controlled:
 * walking `__proto__` lands on `Object.prototype`, and writing there poisons
 * every object in the process.
 *
 * That is not a contained parsing bug. `better-sqlite3` reads its options with
 * `in`, which traverses the prototype chain, and turns a string `nativeBinding`
 * into a `require()` of that path — while the scrapers open databases with
 * `{readonly, fileMustExist}`, which owns neither key and so inherits both.
 *
 * `constructor` is currently unreachable by accident, because `readAtPath`
 * bails on a function, but it is listed rather than relied upon: the guard
 * should not depend on a `typeof` check elsewhere staying exactly as it is.
 */
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function hasUnsafeSegment(path: Array<string | number>): boolean {
  return path.some((key) => typeof key === "string" && UNSAFE_PATH_SEGMENTS.has(key));
}

function readAtPath(root: Record<string, unknown>, path: Array<string | number>): unknown {
  if (hasUnsafeSegment(path)) return undefined;
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

function setAtPath(
  root: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): void {
  if (path.length === 0 || hasUnsafeSegment(path)) return;
  const parent = readAtPath(root, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") return;
  (parent as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

/**
 * Pull the session objects out of one `chatSessions/` file.
 *
 * `.json` holds a session directly. `.jsonl` is a journal and is replayed.
 *
 * A file that does not parse is worth a warning: it is named like a session and
 * sits where sessions live, so if it cannot be read something has changed.
 * @internal Exported for tests only.
 */
export function* parseChatSessionFile(
  raw: string,
  name: string,
  location: string,
): Iterable<unknown> {
  if (name.endsWith(".jsonl")) {
    const session = replayChatSessionLog(raw, location);
    if (session) yield session;
    return;
  }

  try {
    yield JSON.parse(raw) as unknown;
  } catch (err) {
    warnDrift(location, `chat session file is not valid JSON: ${(err as Error).message}`);
  }
}
