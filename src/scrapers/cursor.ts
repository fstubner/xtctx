import { stat } from "node:fs/promises";
import { basename } from "node:path";
import Database from "better-sqlite3";
import { glob } from "glob";
import type { ConversationScraper, CursorChunk, ScraperState } from "../types/scraper.js";
import { estimateTokens, ScraperStateManager } from "./base.js";

const ROLE_MAP: Record<string, CursorChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  system: "system",
  tool: "tool",
};

const QUERY_CANDIDATES = [
  `
    SELECT
      id AS rowId,
      session_id AS sessionId,
      role,
      content,
      created_at AS timestamp,
      model,
      composer_mode AS composerMode
    FROM messages
    ORDER BY created_at ASC
  `,
  `
    SELECT
      id AS rowId,
      conversation_id AS sessionId,
      author AS role,
      text AS content,
      timestamp,
      model,
      mode AS composerMode
    FROM chat_messages
    ORDER BY timestamp ASC
  `,
  `
    SELECT
      id AS rowId,
      sessionId,
      role,
      content,
      timestamp,
      model,
      composerMode
    FROM cursor_messages
    ORDER BY timestamp ASC
  `,
];

interface RawCursorRow {
  rowId?: number;
  sessionId?: string;
  role?: string;
  content?: string;
  timestamp?: string | number;
  model?: string;
  composerMode?: string;
}

export class CursorScraper implements ConversationScraper<CursorChunk> {
  readonly tool = "cursor";
  private readonly stateManager: ScraperStateManager;

  constructor(
    private readonly cursorStorePath: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
  }

  async detect(): Promise<boolean> {
    const paths = await this.resolveDatabasePaths();
    return paths.length > 0;
  }

  getStorePaths(): string[] {
    return [this.cursorStorePath];
  }

  async *scrape(since?: Date): AsyncIterable<CursorChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllMessages(cutoff);
  }

  async *fullSync(): AsyncIterable<CursorChunk> {
    yield* this.readAllMessages(new Date(0));
  }

  parseRaw(raw: unknown): CursorChunk {
    const value = raw as Record<string, unknown>;
    const timestamp = coerceDate(value.timestamp);
    const sessionId = toNonEmptyString(value.sessionId) ?? "unknown";
    const content = toNonEmptyString(value.content) ?? "";
    const role = normalizeRole(toNonEmptyString(value.role));
    const model = toNonEmptyString(value.model) ?? "unknown";
    const composerMode = normalizeComposerMode(toNonEmptyString(value.composerMode));

    return {
      tool: "cursor",
      sessionId,
      timestamp,
      role,
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        model,
        composerMode,
      },
    };
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }

  private async *readAllMessages(since: Date): AsyncIterable<CursorChunk> {
    const dbPaths = await this.resolveDatabasePaths();

    for (const dbPath of dbPaths) {
      let db: Database.Database | null = null;

      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = this.queryRows(db);
        const messageIndexBySession = new Map<string, number>();

        for (const row of rows) {
          const timestamp = coerceDate(row.timestamp);
          if (timestamp <= since) {
            continue;
          }

          const sessionId = row.sessionId ?? inferSessionId(dbPath);
          const nextIndex = messageIndexBySession.get(sessionId) ?? 0;
          messageIndexBySession.set(sessionId, nextIndex + 1);

          yield this.parseRaw({
            ...row,
            sessionId,
            timestamp,
            messageIndex: nextIndex,
          });
        }
      } catch {
        // Skip malformed or unsupported databases.
      } finally {
        db?.close();
      }
    }
  }

  private queryRows(db: Database.Database): RawCursorRow[] {
    for (const sql of QUERY_CANDIDATES) {
      try {
        const rows = db.prepare(sql).all() as RawCursorRow[];
        return rows;
      } catch {
        // Continue to next candidate query.
      }
    }

    return [];
  }

  private async resolveDatabasePaths(): Promise<string[]> {
    try {
      const target = await stat(this.cursorStorePath);
      if (target.isFile()) {
        return [this.cursorStorePath];
      }

      if (!target.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const patterns = ["**/*.sqlite", "**/*.sqlite3", "**/*.db", "**/*.vscdb"];
    const resolved = await Promise.all(
      patterns.map((pattern) =>
        glob(pattern, {
          cwd: this.cursorStorePath,
          absolute: true,
          nodir: true,
        }),
      ),
    );

    return [...new Set(resolved.flat())];
  }
}

function normalizeRole(value?: string): CursorChunk["role"] {
  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function normalizeComposerMode(value?: string): CursorChunk["metadata"]["composerMode"] {
  return value === "agent" ? "agent" : "normal";
}

function inferSessionId(path: string): string {
  const file = basename(path);
  return file.replace(/\.[^.]+$/, "") || "unknown";
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toMessageIndex(value: unknown): number {
  const index = Number(value);
  if (Number.isFinite(index) && index >= 0) {
    return Math.floor(index);
  }

  return 0;
}

function coerceDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis);
  }

  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(millis);
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(0);
}
