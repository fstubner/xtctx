import { stat } from "node:fs/promises";
import { glob } from "glob";
import type { CopilotChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

/** VS Code stores Copilot Chat history in workspaceStorage SQLite files. */
const SESSIONS_KEY = "interactive.sessions";

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

  async *scrape(_since?: Date): AsyncIterable<CopilotChunk> {
    yield* this.readAllMessages();
  }

  async *fullSync(): AsyncIterable<CopilotChunk> {
    yield* this.readAllMessages();
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

  private async *readAllMessages(): AsyncIterable<CopilotChunk> {
    const dbPaths = await this.resolveDbPaths();
    // Import is deferred so the module loads even if better-sqlite3 is absent.
    type DatabaseConstructor = new (path: string, options?: import("better-sqlite3").Options) => import("better-sqlite3").Database;
    let Database: DatabaseConstructor | undefined;
    try {
      // Dynamic import so the module remains optional at startup.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Database = ((await import("better-sqlite3")) as any).default as DatabaseConstructor;
    } catch {
      return;
    }
    if (!Database) return;

    for (const dbPath of dbPaths) {
      let db!: import("better-sqlite3").Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        continue;
      }

      try {
        yield* this.readFromDb(db);
      } finally {
        db.close();
      }
    }
  }

  private *readFromDb(db: import("better-sqlite3").Database): Iterable<CopilotChunk> {
    let rawValue: string | null;
    try {
      const row = db
        .prepare<[string], { value: string }>("SELECT value FROM ItemTable WHERE key = ?")
        .get(SESSIONS_KEY);
      rawValue = row?.value ?? null;
    } catch {
      return;
    }

    if (!rawValue) {
      return;
    }

    let sessionsMap: Record<string, unknown>;
    try {
      sessionsMap = JSON.parse(rawValue) as Record<string, unknown>;
    } catch {
      return;
    }

    for (const rawSession of Object.values(sessionsMap)) {
      if (!isRecord(rawSession)) {
        continue;
      }

      const session = rawSession as CopilotSession;
      const sessionId = session.sessionId ?? "unknown";
      const creationDate = toDate(session.creationDate);

      // Always scan all sessions: Copilot only exposes a session-level creation
      // date, not per-message timestamps. Relying on creationDate to skip whole
      // sessions would miss new messages appended to older sessions. The vector
      // store's content-hash upsert handles deduplication of re-processed messages.
      const requests = Array.isArray(session.requests) ? session.requests : [];
      let messageIndex = 0;

      for (const req of requests) {
        if (req.isCanceled) {
          continue;
        }

        const userText = extractUserText(req);
        if (userText) {
          yield this.parseRaw({
            sessionId,
            role: "user",
            content: userText,
            timestamp: creationDate,
            model: req.model,
            completionType: req.agentId ? "agent" : "chat",
            messageIndex: messageIndex++,
          });
        }

        const assistantText = extractAssistantText(req);
        if (assistantText) {
          yield this.parseRaw({
            sessionId,
            role: "assistant",
            content: assistantText,
            timestamp: creationDate,
            model: req.model,
            completionType: req.agentId ? "agent" : "chat",
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
        return [];
      }

      return glob("*/state.vscdb", {
        cwd: this.workspaceStoragePath,
        absolute: true,
        nodir: true,
      });
    } catch {
      return [];
    }
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
