import { stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { glob } from "glob";
import type { CursorChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

// Bubble type constants from Cursor's internal format.
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

interface WorkspaceComposerRef {
  composerId: string;
  unifiedMode?: string;
  forceMode?: string;
}

interface CursorComposerData {
  composerId: string;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
  createdAt?: number;
  lastUpdatedAt?: number;
  modelConfig?: { modelName?: string };
  unifiedMode?: string;
  forceMode?: string;
}

interface CursorBubbleData {
  type: number;
  text?: string;
  createdAt?: string | number;
  modelInfo?: { modelName?: string };
}

export class CursorScraper extends AbstractScraper<CursorChunk> {
  readonly tool = "cursor";

  constructor(
    private readonly cursorStorePath: string,
    stateDir: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    const paths = await this.resolveWorkspaceDatabasePaths();
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

  private async *readAllMessages(since: Date): AsyncIterable<CursorChunk> {
    const workspacePaths = await this.resolveWorkspaceDatabasePaths();

    for (const wsPath of workspacePaths) {
      const composerRefs = this.readWorkspaceComposers(wsPath);
      if (composerRefs.length === 0) {
        continue;
      }

      const globalPath = deriveGlobalStoragePath(wsPath);
      if (!globalPath) {
        continue;
      }

      let globalDb: Database.Database | null = null;
      try {
        globalDb = new Database(globalPath, { readonly: true, fileMustExist: true });
        yield* this.readComposerMessages(globalDb, composerRefs, since);
      } catch {
        // Skip if global storage is unavailable or malformed.
      } finally {
        globalDb?.close();
      }
    }
  }

  private readWorkspaceComposers(wsDbPath: string): WorkspaceComposerRef[] {
    let db: Database.Database | null = null;
    try {
      db = new Database(wsDbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;

      if (!row) return [];

      const data = JSON.parse(row.value) as {
        allComposers?: WorkspaceComposerRef[];
      };

      return data.allComposers ?? [];
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  private *readComposerMessages(
    globalDb: Database.Database,
    composerRefs: WorkspaceComposerRef[],
    since: Date,
  ): Iterable<CursorChunk> {
    const getComposer = globalDb.prepare(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
    );
    const getBubble = globalDb.prepare(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
    );

    for (const ref of composerRefs) {
      const composerRow = getComposer.get(
        `composerData:${ref.composerId}`,
      ) as { value: string } | undefined;

      if (!composerRow) continue;

      let composer: CursorComposerData;
      try {
        composer = JSON.parse(composerRow.value) as CursorComposerData;
      } catch {
        continue;
      }

      const headers = composer.fullConversationHeadersOnly ?? [];
      if (headers.length === 0) continue;

      const model =
        composer.modelConfig?.modelName ?? ref.composerId;
      const composerMode = normalizeComposerMode(
        composer.unifiedMode ?? ref.unifiedMode,
      );
      const sessionId = ref.composerId;

      let messageIndex = 0;
      for (const header of headers) {
        const bubbleRow = getBubble.get(
          `bubbleId:${ref.composerId}:${header.bubbleId}`,
        ) as { value: string } | undefined;

        if (!bubbleRow) continue;

        let bubble: CursorBubbleData;
        try {
          bubble = JSON.parse(bubbleRow.value) as CursorBubbleData;
        } catch {
          continue;
        }

        const timestamp = toDate(bubble.createdAt);
        if (timestamp <= since) {
          messageIndex++;
          continue;
        }

        const content = toNonEmptyString(bubble.text) ?? "";
        if (!content) {
          messageIndex++;
          continue;
        }

        const role = normalizeRole(bubble.type);

        yield {
          tool: "cursor",
          sessionId,
          timestamp,
          role,
          content,
          metadata: {
            messageIndex,
            tokenEstimate: estimateTokens(content),
            referencedFiles: [],
            model: bubble.modelInfo?.modelName ?? model,
            composerMode,
          },
        };
        messageIndex++;
      }
    }
  }

  private async resolveWorkspaceDatabasePaths(): Promise<string[]> {
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

/**
 * Derive the Cursor global storage path from a workspace database path.
 *
 * Workspace path structure:
 *   .../Cursor/User/workspaceStorage/<hash>/state.vscdb
 * Global storage:
 *   .../Cursor/User/globalStorage/state.vscdb
 */
function deriveGlobalStoragePath(workspaceDbPath: string): string | null {
  const normalized = workspaceDbPath.replace(/\\/g, "/");
  const wsIdx = normalized.indexOf("/workspaceStorage/");
  if (wsIdx === -1) return null;

  const userDir = normalized.slice(0, wsIdx);
  return join(userDir, "globalStorage", "state.vscdb");
}

function normalizeRole(value?: number | string): CursorChunk["role"] {
  // Numeric type from bubble data: 1 = user, 2 = assistant.
  if (typeof value === "number") {
    if (value === BUBBLE_TYPE_USER) return "user";
    if (value === BUBBLE_TYPE_ASSISTANT) return "assistant";
    return "system";
  }

  // String role from legacy format.
  const map: Record<string, CursorChunk["role"]> = {
    user: "user",
    human: "user",
    assistant: "assistant",
    ai: "assistant",
    system: "system",
    tool: "tool",
  };
  return map[(value ?? "").toLowerCase()] ?? "system";
}

function normalizeComposerMode(value?: string): CursorChunk["metadata"]["composerMode"] {
  return value === "agent" ? "agent" : "normal";
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

