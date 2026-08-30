import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import type { CopilotChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";
import { pathMatchesProject } from "../utils/project-scope.js";
import { recordDrift, withDriftReport } from "./drift-log.js";

/** VS Code stores Copilot Chat history in workspaceStorage SQLite files. */
const SESSIONS_KEY = "interactive.sessions";

const SCRAPER_NAME = "copilot";

/**
 * Shapes that the Copilot scraper tolerates silently without logging.
 * Each entry documents the shape being accepted and why it is not drift.
 * Anything not listed here that falls outside the happy path MUST warn
 * (or throw, for required-schema violations).
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Workspace has no state.vscdb yet — pristine VS Code install. */
  missingStateVscdb: "workspace directory has no state.vscdb yet",
  /** workspaceStorage root missing — VS Code not installed. */
  missingWorkspaceStorage: "workspaceStorage directory does not exist",
  /** better-sqlite3 native module absent — Copilot ingestion is opt-in. */
  missingSqliteBinding: "better-sqlite3 native module unavailable",
  /** State.vscdb has no interactive.sessions row — workspace never used Copilot chat. */
  noInteractiveSessionsKey: "workspaceStorage has no chat history",
  /** ItemTable shape varies across VS Code versions; tolerate open/query failure. */
  unreadableItemTable: "ItemTable row is unreadable or unexpected shape",
  /** A canceled request is intentionally skipped — not drift. */
  canceledRequest: "request was canceled by the user",
  /** Some sessions legitimately have no user-text (agent-only runs); skip silently. */
  emptyUserText: "request has no user-visible text parts",
  /** Empty assistant response (thinking timeout etc.) — not drift. */
  emptyAssistantText: "request has no assistant response text",
  /** Extra/unknown fields alongside known ones are forward-compatible. */
  unknownFieldsAlongside: "unknown sibling field added by a newer VS Code version",
};

/** Shape of a single Copilot request/response pair inside ItemTable. */
interface CopilotRequest {
  message?: { parts?: Array<{ text?: string }> };
  response?: Array<{ value?: string }>;
  isCanceled?: boolean;
  model?: string;
  agentId?: string;
}

/** Shape of a Copilot session object stored under SESSIONS_KEY. */
interface CopilotSession {
  sessionId?: string;
  creationDate?: number;
  requests?: CopilotRequest[];
}

function warnDrift(sourcePath: string, surprise: string, _recordsAffected: number): void {
  recordDrift(SCRAPER_NAME, sourcePath, surprise);
}

export class CopilotScraper extends AbstractScraper<CopilotChunk> {
  readonly tool = "copilot";

  constructor(
    /** Path to %APPDATA%/Code/User/workspaceStorage (or a test stand-in). */
    private readonly workspaceStoragePath: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.workspaceStoragePath);
      return target.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.workspaceStoragePath];
  }

  async *scrape(since?: Date): AsyncIterable<CopilotChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages(since), this.stateDir);
  }

  async *fullSync(): AsyncIterable<CopilotChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages(), this.stateDir);
  }

  parseRaw(raw: unknown): CopilotChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";

    return {
      tool: "copilot",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role: normalizeRole(toStringValue(value.role)),
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        model: toStringValue(value.model),
        completionType: toStringValue(value.completionType),
      },
    };
  }

  private async *readAllMessages(since?: Date): AsyncIterable<CopilotChunk> {
    const dbPaths = await this.resolveDbPaths();
    // Import is deferred so the module loads even if better-sqlite3 is absent.
    type DatabaseConstructor = new (
      path: string,
      options?: import("better-sqlite3").Options,
    ) => import("better-sqlite3").Database;
    let Database: DatabaseConstructor | undefined;
    try {
      // Dynamic import so the module remains optional at startup.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Database = ((await import("better-sqlite3")) as any).default as DatabaseConstructor;
    } catch {
      // ACCEPTED_DEGRADATIONS.missingSqliteBinding — opt-in peer dep.
      return;
    }
    if (!Database) return;

    for (const dbPath of dbPaths) {
      let db!: import("better-sqlite3").Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        // ACCEPTED_DEGRADATIONS.missingStateVscdb — workspace never wrote a db yet.
        continue;
      }

      try {
        yield* this.readFromDb(db, dbPath, since);
      } finally {
        db.close();
      }
    }

    // Newer VS Code keeps each chat in its own file beside the database rather
    // than in the `interactive.sessions` blob, so a reader that only opened the
    // database saw nothing from any recent session.
    for (const dbPath of dbPaths) {
      yield* this.readChatSessionFiles(dirname(dbPath), since);
    }
  }

  /**
   * Read the per-session files under `<workspace>/chatSessions/`.
   *
   * Two shapes live there. `.json` holds a session object directly — the same
   * shape as the database blob, which is why parsing is shared. `.jsonl` wraps
   * it, one record per line, under a `v` key; only the record carrying the
   * session is of interest and the rest are editor bookkeeping.
   *
   * The `chat.ChatSessionStore.index` key in the database lists these too, but
   * the directory is read directly: the files are the data, the index is a
   * cache of it, and a stale index would silently hide sessions that exist.
   */
  private async *readChatSessionFiles(
    workspaceDir: string,
    since?: Date,
  ): AsyncIterable<CopilotChunk> {
    const sessionsDir = join(workspaceDir, "chatSessions");
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch {
      // No chat-session directory: this workspace predates the format, or was
      // never used for chat. Not a surprise.
      return;
    }

    const sinceMs = since ? since.getTime() : 0;

    for (const name of names) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = join(sessionsDir, name);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (err) {
        warnDrift(filePath, `chat session file unreadable: ${(err as Error).message}`, 0);
        continue;
      }

      // The file name without its extension is the session id VS Code gave it,
      // and the only identity an id-less session has.
      const sessionKey = name.replace(/\.jsonl?$/, "");
      for (const session of parseChatSessionFile(raw, name, filePath)) {
        yield* this.readSession(session, sessionKey, filePath, sinceMs);
      }
    }
  }

  private *readFromDb(
    db: import("better-sqlite3").Database,
    dbPath: string,
    since?: Date,
  ): Iterable<CopilotChunk> {
    let rawValue: string | null;
    try {
      const row = db
        .prepare<[string], { value: string }>("SELECT value FROM ItemTable WHERE key = ?")
        .get(SESSIONS_KEY);
      rawValue = row?.value ?? null;
    } catch (err) {
      // Required table missing / shape changed — this is a real surprise.
      warnDrift(dbPath, `ItemTable query failed: ${(err as Error).message}`, 0);
      return;
    }

    if (!rawValue) {
      // ACCEPTED_DEGRADATIONS.noInteractiveSessionsKey
      return;
    }

    let sessionsMap: unknown;
    try {
      sessionsMap = JSON.parse(rawValue) as unknown;
    } catch (err) {
      warnDrift(
        dbPath,
        `interactive.sessions value is not valid JSON: ${(err as Error).message}`,
        0,
      );
      return;
    }

    // VS Code writes this key as an array, and always has on the machines
    // checked: 64 workspaces, every one an array, 18 of them holding sessions.
    // Requiring an object meant this reader produced nothing at all from real
    // VS Code data — it only ever worked against its own fixtures. The entries
    // themselves are the same shape either way, so only the container differs.
    let sessionEntries: Array<[string, unknown]>;
    if (Array.isArray(sessionsMap)) {
      sessionEntries = sessionsMap.map((session, index) => [String(index), session]);
    } else if (isRecord(sessionsMap)) {
      sessionEntries = Object.entries(sessionsMap);
    } else {
      warnDrift(
        dbPath,
        `expected interactive.sessions to be an object or array, got ${describeType(sessionsMap)}`,
        0,
      );
      return;
    }

    const sinceMs = since ? since.getTime() : 0;

    for (const [sessionKey, rawSession] of sessionEntries) {
      yield* this.readSession(rawSession, sessionKey, dbPath, sinceMs);
    }
  }
  /**
   * Turn one stored session into chunks.
   *
   * Shared by both places VS Code keeps chat: the `interactive.sessions`
   * blob in state.vscdb, and the per-session files under `chatSessions/`.
   * The two differ only in where the object comes from, so the parsing —
   * and every drift check in it — is written once.
   */
  private *readSession(
    rawSession: unknown,
    sessionKey: string,
    location: string,
    sinceMs: number,
  ): Iterable<CopilotChunk> {
    if (!isRecord(rawSession)) {
      warnDrift(
        `${location}#${sessionKey}`,
        `session entry is not an object (got ${describeType(rawSession)})`,
        0,
      );
      return;
    }

    const session = rawSession as CopilotSession;
    // `sessionKey` is the file name for on-disk sessions, which VS Code names
    // after the session's own id. Falling back to a constant instead merged
    // every id-less conversation into one `copilot:unknown` session with
    // colliding message indexes — two unrelated chats interleaved as one.
    const sessionId = session.sessionId ?? sessionKey ?? "unknown";

    if (session.sessionId === undefined) {
      warnDrift(
        `${location}#${sessionKey}`,
        "session missing 'sessionId' field — using fallback 'unknown'",
        0,
      );
    }

    if (session.creationDate === null || (session.creationDate !== undefined &&
        typeof session.creationDate !== "number" &&
        typeof session.creationDate !== "string")) {
      warnDrift(
        `${location}#${sessionId}`,
        `expected 'creationDate' to be a number, got ${describeType(session.creationDate)}`,
        0,
      );
    }

    // Copilot only stamps a session-level creationDate — individual turns
    // inherit it. Using creationDate for the scrape cursor drops whole
    // sessions that existed before the cursor but gained NEW turns after
    // it, causing permanent turn loss (P1 from review). Fix: emit every
    // turn every cycle and rely on chunk-ID-based upsert dedupe upstream
    // (the ID basis now includes messageIndex so duplicates collapse
    // safely). Note: sinceMs is still referenced below so that a future
    // per-turn timestamp upgrade only needs a narrow edit.
    void sinceMs;

    const creationDate = toDate(session.creationDate);

    if (session.requests !== undefined && !Array.isArray(session.requests)) {
      // Schema drift: 'requests' was renamed or retyped. This is the
      // highest-risk mutation because it silently empties whole sessions.
      warnDrift(
        `${location}#${sessionId}`,
        `expected 'requests' to be an array, got ${describeType(session.requests)}`,
        0,
      );
      return;
    }

    if (!("requests" in rawSession)) {
      // 'requests' is missing entirely. If any other non-whitelisted key
      // looks like a request array, it's almost certainly a rename — warn.
      // A truly empty pre-v1 session would have no array-shaped sibling.
      const suspiciousRename = Object.entries(rawSession).find(
        ([k, v]) => k !== "sessionId" && k !== "creationDate" && Array.isArray(v),
      );
      if (suspiciousRename) {
        warnDrift(
          `${location}#${sessionId}`,
          `session has no 'requests' key; suspected rename to '${suspiciousRename[0]}'`,
          0,
        );
      }
      return;
    }

    const requests = Array.isArray(session.requests) ? session.requests : [];

    let messageIndex = 0;

    for (const req of requests) {
      if (!isRecord(req)) {
        warnDrift(
          `${location}#${sessionId}`,
          `request entry is not an object (got ${describeType(req)})`,
          0,
        );
        continue;
      }

      if (req.isCanceled) {
        // ACCEPTED_DEGRADATIONS.canceledRequest
        continue;
      }

      const userText = extractUserText(req as CopilotRequest);
      if (userText) {
        yield this.parseRaw({
          sessionId,
          role: "user",
          content: userText,
          timestamp: creationDate,
          model: (req as CopilotRequest).model,
          completionType: (req as CopilotRequest).agentId ? "agent" : "chat",
          messageIndex: messageIndex++,
        });
      }

      const assistantText = extractAssistantText(req as CopilotRequest);
      if (assistantText) {
        yield this.parseRaw({
          sessionId,
          role: "assistant",
          content: assistantText,
          timestamp: creationDate,
          model: (req as CopilotRequest).model,
          completionType: (req as CopilotRequest).agentId ? "agent" : "chat",
          messageIndex: messageIndex++,
        });
      }
    }
  }


  /**
   * Discovers VS Code workspaceStorage SQLite databases.
   * Pattern: &lt;workspaceStoragePath&gt;/[hash]/state.vscdb
   */
  private async resolveDbPaths(): Promise<string[]> {
    try {
      const target = await stat(this.workspaceStoragePath);
      if (!target.isDirectory()) {
        // The root must be a directory — a non-directory here is drift.
        warnDrift(
          this.workspaceStoragePath,
          "expected workspaceStorage to be a directory",
          0,
        );
        return [];
      }

      const paths = await glob("*/state.vscdb", {
        cwd: this.workspaceStoragePath,
        absolute: true,
        nodir: true,
      });
      if (!this.projectRoot) {
        return paths;
      }

      const filtered: string[] = [];
      for (const path of paths) {
        if (await workspaceMatchesProject(path, this.projectRoot)) {
          filtered.push(path);
        }
      }
      return filtered;
    } catch {
      // ACCEPTED_DEGRADATIONS.missingWorkspaceStorage
      return [];
    }
  }
}

async function workspaceMatchesProject(
  workspaceDbPath: string,
  projectRoot: string,
): Promise<boolean> {
  try {
    const raw = await readFile(join(dirname(workspaceDbPath), "workspace.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const folder = typeof parsed.folder === "string" ? parsed.folder : undefined;
    if (!folder) {
      return false;
    }
    const folderPath = folder.startsWith("file:") ? fileURLToPath(folder) : folder;
    return pathMatchesProject(folderPath, projectRoot);
  } catch {
    return false;
  }
}

/** Concatenates all text parts from a user message. */
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
      warnDrift(location, `chat session line is not valid JSON: ${(err as Error).message}`, 0);
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
    warnDrift(location, "chat session log has no snapshot record to rebuild from", 0);
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
    warnDrift(location, `chat session file is not valid JSON: ${(err as Error).message}`, 0);
  }
}

function extractUserText(req: CopilotRequest): string | undefined {
  const parts = req.message?.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const text = parts
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

/** Concatenates all value segments from an assistant response. */
function extractAssistantText(req: CopilotRequest): string | undefined {
  const response = req.response;
  if (!Array.isArray(response)) {
    return undefined;
  }

  const text = response
    .map((r) => r.value ?? "")
    .join("")
    .trim();

  return text.length > 0 ? text : undefined;
}

function normalizeRole(value?: string): CopilotChunk["role"] {
  const ROLE_MAP: Record<string, CopilotChunk["role"]> = {
    user: "user",
    human: "user",
    assistant: "assistant",
    system: "system",
    tool: "tool",
  };

  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return 0;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
