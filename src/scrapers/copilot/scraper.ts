import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import type { CopilotChunk } from "../../types/scraper.js";
import {
  AbstractScraper,
  describeType,
  estimateTokens,
  isRecord,
  toDate,
  toMessageIndex,
} from "../base.js";
import { pathMatchesProject } from "../../utils/project-scope.js";
import { withDriftReport } from "../drift-log.js";
import { MAX_FILE_BYTES, isWithinFileLimit } from "../limits.js";
import { parseChatSessionFile } from "./journal.js";
import { SCRAPER_NAME, warnDrift } from "./shared.js";

/** VS Code stores Copilot Chat history in workspaceStorage SQLite files. */
const SESSIONS_KEY = "interactive.sessions";

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

      // Skip files untouched since the last scrape.
      //
      // Not a timestamp cursor: the comment below explains why one of those
      // caused permanent turn loss, since Copilot stamps only a session-level
      // creationDate that individual turns inherit. This is a *file* mtime,
      // and a file VS Code has not written cannot have gained a turn — so
      // every turn in every changed file is still emitted every cycle, and the
      // correctness property is untouched. Without this the scraper re-read
      // and re-parsed the entire history on every refresh, which is the only
      // scraper that does so and grows without bound.
      if (sinceMs > 0) {
        const modifiedAt = await fileModifiedMs(filePath);
        if (modifiedAt !== null && modifiedAt <= sinceMs) {
          continue;
        }
      }

      // The whole file is read into memory and then split, so an oversized one
      // costs the long-lived server twice its size. These files are written by
      // another tool, so their size is not ours to trust.
      if (!(await isWithinFileLimit(filePath))) {
        warnDrift(filePath, `chat session file exceeds ${MAX_FILE_BYTES} bytes; skipped`);
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (err) {
        warnDrift(filePath, `chat session file unreadable: ${(err as Error).message}`);
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
      warnDrift(dbPath, `ItemTable query failed: ${(err as Error).message}`);
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
      );
    }

    if (session.creationDate === null || (session.creationDate !== undefined &&
        typeof session.creationDate !== "number" &&
        typeof session.creationDate !== "string")) {
      warnDrift(
        `${location}#${sessionId}`,
        `expected 'creationDate' to be a number, got ${describeType(session.creationDate)}`,
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

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

/**
 * File mtime in epoch ms, or null when it cannot be read — in which case the
 * caller must fall back to reading the file, since "unknown" is not "unchanged".
 */
async function fileModifiedMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
