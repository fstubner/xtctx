import { stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { glob } from "glob";
import type { CursorChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

// Bubble type constants from Cursor's internal format.
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

const SCRAPER_NAME = "cursor";

/**
 * Shapes the cursor scraper tolerates silently without logging. All other
 * shape surprises warn; missing required tables throw.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Store path missing — Cursor not installed on this machine. */
  missingStorePath: "cursor workspaceStorage path absent",
  /** Workspace has no composerData yet — empty workspace. */
  emptyWorkspace: "workspace has no composer.composerData row",
  /** A composer whose bubble row is missing — bubble pruned by Cursor. */
  prunedBubble: "bubble referenced by composer but missing from globalStorage",
  /** Empty bubble text (tool-call only, etc.). */
  emptyBubbleText: "bubble has no user-visible text",
  /** Forward-compat unknown keys alongside known composer fields. */
  unknownFieldsAlongside: "extra keys alongside known composer schema",
};

function warnDrift(sourcePath: string, surprise: string, recordsAffected: number): void {
  console.warn(
    `[${SCRAPER_NAME}] schema-drift surprise at ${sourcePath}: ${surprise} ` +
      `(records affected: ${recordsAffected})`,
  );
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

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
        yield* this.readComposerMessages(globalDb, composerRefs, since, wsPath);
      } catch (err) {
        // Global storage unreadable — treat as schema drift and warn.
        // The cursorDiskKV table is required; if it's gone, something changed.
        warnDrift(
          globalPath,
          `globalStorage unreadable: ${(err as Error).message}`,
          composerRefs.length,
        );
      } finally {
        globalDb?.close();
      }
    }
  }

  private readWorkspaceComposers(wsDbPath: string): WorkspaceComposerRef[] {
    let db: Database.Database | null = null;

    try {
      db = new Database(wsDbPath, { readonly: true, fileMustExist: true });
    } catch {
      // File missing / unopenable — treat as absent workspace, not drift.
      return [];
    }

    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;

      if (!row) {
        // ACCEPTED_DEGRADATIONS.emptyWorkspace
        return [];
      }

      let data: { allComposers?: WorkspaceComposerRef[] };
      try {
        data = JSON.parse(row.value) as { allComposers?: WorkspaceComposerRef[] };
      } catch (err) {
        warnDrift(
          wsDbPath,
          `composer.composerData value is not valid JSON: ${(err as Error).message}`,
          0,
        );
        return [];
      }

      if (data.allComposers !== undefined && !Array.isArray(data.allComposers)) {
        warnDrift(
          wsDbPath,
          `expected 'allComposers' to be an array, got ${describeType(data.allComposers)}`,
          0,
        );
        return [];
      }

      return data.allComposers ?? [];
    } catch (err) {
      // The ItemTable is a required workspace-storage contract — the db
      // opened but a query against it failed, meaning Cursor's internal
      // format changed. Throw so callers surface the drift instead of
      // silently returning zero chunks.
      throw new Error(
        `[${SCRAPER_NAME}] ItemTable unreadable at ${wsDbPath}: ${(err as Error).message}`,
      );
    } finally {
      db?.close();
    }
  }

  private *readComposerMessages(
    globalDb: Database.Database,
    composerRefs: WorkspaceComposerRef[],
    since: Date,
    wsPathForWarn: string,
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

      if (!composerRow) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          "workspace references a composer that is missing from globalStorage",
          0,
        );
        continue;
      }

      let composer: CursorComposerData;
      try {
        composer = JSON.parse(composerRow.value) as CursorComposerData;
      } catch (err) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          `composer JSON not parseable: ${(err as Error).message}`,
          0,
        );
        continue;
      }

      // Strict-mode schema check: 'fullConversationHeadersOnly' is the
      // required list of turns. If it's missing or renamed, emitting zero
      // chunks would be silent data loss. Warn so drift is observable.
      if (composer.fullConversationHeadersOnly === undefined) {
        const suspiciousRename = Object.entries(composer as unknown as Record<string, unknown>).find(
          ([, v]) =>
            Array.isArray(v) &&
            v.length > 0 &&
            isRecord(v[0]) &&
            "bubbleId" in (v[0] as Record<string, unknown>),
        );
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          suspiciousRename
            ? `'fullConversationHeadersOnly' missing; suspected rename to '${suspiciousRename[0]}'`
            : "'fullConversationHeadersOnly' missing — composer has no turn list",
          0,
        );
        continue;
      }

      if (!Array.isArray(composer.fullConversationHeadersOnly)) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          `expected 'fullConversationHeadersOnly' to be an array, got ` +
            describeType(composer.fullConversationHeadersOnly),
          0,
        );
        continue;
      }

      if (composer.modelConfig !== undefined && composer.modelConfig !== null &&
          !isRecord(composer.modelConfig)) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          `expected 'modelConfig' to be object or absent, got ${describeType(composer.modelConfig)}`,
          0,
        );
      } else if (composer.modelConfig === null) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          "'modelConfig' is null — falling back to composerId as model label",
          0,
        );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

