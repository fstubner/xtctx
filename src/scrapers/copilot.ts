import { readFile, stat } from "node:fs/promises";
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
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages(since));
  }

  async *fullSync(): AsyncIterable<CopilotChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages());
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

    if (!isRecord(sessionsMap)) {
      warnDrift(
        dbPath,
        `expected interactive.sessions to be an object, got ${describeType(sessionsMap)}`,
        0,
      );
      return;
    }

    const sinceMs = since ? since.getTime() : 0;

    for (const [sessionKey, rawSession] of Object.entries(sessionsMap)) {
      if (!isRecord(rawSession)) {
        warnDrift(
          `${dbPath}#${sessionKey}`,
          `session entry is not an object (got ${describeType(rawSession)})`,
          0,
        );
        continue;
      }

      const session = rawSession as CopilotSession;
      const sessionId = session.sessionId ?? "unknown";

      if (session.sessionId === undefined) {
        warnDrift(
          `${dbPath}#${sessionKey}`,
          "session missing 'sessionId' field — using fallback 'unknown'",
          0,
        );
      }

      if (session.creationDate === null || (session.creationDate !== undefined &&
          typeof session.creationDate !== "number" &&
          typeof session.creationDate !== "string")) {
        warnDrift(
          `${dbPath}#${sessionId}`,
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
          `${dbPath}#${sessionId}`,
          `expected 'requests' to be an array, got ${describeType(session.requests)}`,
          0,
        );
        continue;
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
            `${dbPath}#${sessionId}`,
            `session has no 'requests' key; suspected rename to '${suspiciousRename[0]}'`,
            0,
          );
        }
        continue;
      }

      const requests = Array.isArray(session.requests) ? session.requests : [];

      let messageIndex = 0;

      for (const req of requests) {
        if (!isRecord(req)) {
          warnDrift(
            `${dbPath}#${sessionId}`,
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
