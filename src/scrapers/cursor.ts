import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { glob } from "glob";
import type { CursorChunk } from "../types/scraper.js";
import { AbstractScraper, describeType, driftWarner, estimateTokens, isRecord, toDate } from "./base.js";
import { pathMatchesProject } from "../utils/project-scope.js";
import { withDriftReport } from "./drift-log.js";

// Bubble type constants from Cursor's internal format.
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

const SCRAPER_NAME = "cursor";
const STATE_DB_NAME = "state.vscdb";

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

const warnDrift = driftWarner(SCRAPER_NAME);

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
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  /**
   * Is Cursor installed with a store here — nothing about this project.
   *
   * This used to answer via `resolveWorkspaceDatabasePaths()`, which opens
   * every workspace to test project membership: 3.2s per call on a real
   * machine, paid on every `getStatus()`, which runs detection for all seven
   * scrapers. It also made `status` report "not detected" for an installed
   * Cursor that simply had no sessions for this project, which is not what
   * detection means for any of the other six scrapers.
   *
   * Stops at the first store found rather than enumerating them all.
   */
  async detect(): Promise<boolean> {
    let target;
    try {
      target = await stat(this.cursorStorePath);
    } catch {
      return false;
    }

    if (target.isFile()) {
      return true;
    }
    if (!target.isDirectory()) {
      return false;
    }

    let entries;
    try {
      entries = await readdir(this.cursorStorePath, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === STATE_DB_NAME) {
        return true;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      if (await pathExists(join(this.cursorStorePath, entry.name, STATE_DB_NAME))) {
        return true;
      }
    }

    return false;
  }

  getStorePaths(): string[] {
    return [this.cursorStorePath];
  }

  async *scrape(since?: Date): AsyncIterable<CursorChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages(cutoff), this.stateDir);
  }

  async *fullSync(): AsyncIterable<CursorChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllMessages(new Date(0)), this.stateDir);
  }

  private async *readAllMessages(since: Date): AsyncIterable<CursorChunk> {
    // Dynamic import keeps better-sqlite3 an optional runtime dependency,
    // matching the copilot and opencode scrapers.
    let DatabaseCtor: typeof Database;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      DatabaseCtor = ((await import("better-sqlite3")) as any).default as typeof Database;
    } catch {
      // Native module unavailable — treat the source as absent.
      return;
    }

    const workspacePaths = await this.resolveWorkspaceDatabasePaths();
    const seenComposerIds = new Set<string>();

    for (const wsPath of workspacePaths) {
      const composerRefs = this.readWorkspaceComposers(DatabaseCtor, wsPath);
      for (const ref of composerRefs) {
        seenComposerIds.add(ref.composerId);
      }
      if (composerRefs.length === 0) {
        continue;
      }

      const globalPath = deriveGlobalStoragePath(wsPath);
      if (!globalPath) {
        continue;
      }

      let globalDb: Database.Database | null = null;
      try {
        globalDb = new DatabaseCtor(globalPath, { readonly: true, fileMustExist: true });
        yield* this.readComposerMessages(globalDb, composerRefs, since, wsPath);
      } catch (err) {
        // Global storage unreadable — treat as schema drift and warn.
        // The cursorDiskKV table is required; if it's gone, something changed.
        warnDrift(
          globalPath,
          `globalStorage unreadable: ${(err as Error).message}`,
        );
      } finally {
        globalDb?.close();
      }
    }

    // From the store path, not from a workspace that happened to match. Basing
    // it on a matched workspace meant a pruned workspaceStorage entry, or a
    // multi-root workspace with no `folder`, left this doing nothing at all —
    // while globalStorage sat exactly where it always sits.
    yield* this.readUnreferencedComposers(
      DatabaseCtor,
      globalStoragePathForStore(this.cursorStorePath),
      seenComposerIds,
    );
  }

  /**
   * Read conversations that globalStorage holds but no workspace lists.
   *
   * A workspace only keeps a composer in `composer.composerData` for as long as
   * it cares to; globalStorage keeps the conversation. On one machine that was
   * 165 referenced against 593 stored, so discovery through workspaces alone
   * could not reach most of the history that exists.
   *
   * Attribution is the whole difficulty. A workspace-referenced composer
   * belongs to that workspace's folder, and nothing else has to be decided. An
   * orphan has no workspace, so it is attributed only by file paths recorded
   * inside it. That is deliberately strict: matching on any mention of a
   * project's name is what once handed one project another project's private
   * transcripts, and a conversation that cannot be placed is skipped rather
   * than guessed at.
   */
  private *readUnreferencedComposers(
    DatabaseCtor: typeof Database,
    globalPath: string | null,
    referenced: Set<string>,
  ): Iterable<CursorChunk> {
    // Without a project root there is nothing to attribute against, and an
    // orphan's only claim to belong anywhere is a path match. Reading them
    // unscoped would mean every conversation on the machine, which is the
    // opposite of what an unscoped reader should do with unattributable data.
    if (!globalPath || !this.projectRoot) {
      return;
    }

    let globalDb: Database.Database | null = null;
    try {
      globalDb = new DatabaseCtor(globalPath, { readonly: true, fileMustExist: true });
    } catch {
      // Already reported per-workspace above; not worth a second warning.
      globalDb?.close();
      return;
    }

    try {
      // Narrowed in SQL before anything is parsed. Walking every stored
      // composer took a scan from 1.3s to 6.2s on a real store — past the
      // refresh budget, on the critical path of a tool call. The project's
      // directory name survives every encoding these blobs use (Windows paths,
      // `file:///` URIs), so it is a safe coarse filter; `composerMentionsProject`
      // still decides, and a name like `core` merely lets more candidates
      // through rather than admitting them.
      const refs: WorkspaceComposerRef[] = [];
      const rows = globalDb
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value LIKE ?")
        .all(`%${basename(this.projectRoot)}%`) as Array<{ key: string; value: string }>;

      for (const row of rows) {
        const composerId = row.key.slice("composerData:".length);
        if (!composerId || referenced.has(composerId)) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value) as unknown;
        } catch {
          // A malformed orphan is reported by readComposerMessages if it is
          // ever selected; here it simply cannot be attributed.
          continue;
        }

        // Some rows hold a literal `null`, which parses cleanly and then
        // throws on the first property access — enough to take down the whole
        // scan, including every workspace-referenced conversation.
        if (!isRecord(parsed)) {
          continue;
        }
        const composer = parsed as unknown as CursorComposerData;

        // Most orphans are abandoned chats with no turns at all — 405 of 504
        // on the machine this was measured on. Skipping them before the path
        // walk keeps the common case cheap.
        const headers = composer.fullConversationHeadersOnly;
        if (!Array.isArray(headers) || headers.length === 0) {
          continue;
        }

        if (!composerMentionsProject(composer, this.projectRoot)) {
          continue;
        }

        refs.push({ composerId, unifiedMode: composer.unifiedMode });
      }

      if (refs.length > 0) {
        // Deliberately not `since`. These conversations are ones no workspace
        // lists, so they are older than the cursor by definition — filtering
        // them by it meant the whole feature fired only on a never-indexed
        // project and did nothing for anyone with an existing index. The
        // copilot reader made the same call for the same reason. Re-emitting
        // is safe: upserts collapse on a chunk id that includes the message
        // index, so a conversation read twice is stored once.
        yield* this.readComposerMessages(globalDb, refs, new Date(0), globalPath);
      }
    } catch (err) {
      // The same condition the workspace loop treats as drift and continues
      // past. Without this it escaped the scraper instead, which the index
      // records as a scrape error for the whole tool — so one unreadable
      // globalStorage lost every workspace-referenced conversation too, and
      // left `last_error` set in `status` until something cleared it.
      warnDrift(
        globalPath,
        `globalStorage unreadable while looking for unlisted conversations: ${(err as Error).message}`,
      );
    } finally {
      globalDb.close();
    }
  }

  private readWorkspaceComposers(
    DatabaseCtor: typeof Database,
    wsDbPath: string,
  ): WorkspaceComposerRef[] {
    let db: Database.Database | null = null;

    try {
      db = new DatabaseCtor(wsDbPath, { readonly: true, fileMustExist: true });
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
        );
        return [];
      }

      if (data.allComposers !== undefined && !Array.isArray(data.allComposers)) {
        warnDrift(
          wsDbPath,
          `expected 'allComposers' to be an array, got ${describeType(data.allComposers)}`,
        );
        return [];
      }

      return data.allComposers ?? [];
    } catch (err) {
      // The ItemTable is a required workspace-storage contract — the db
      // opened but a query against it failed, meaning Cursor's internal
      // format changed. Warn loudly, but do not abort the remaining
      // workspaces over one broken database.
      warnDrift(wsDbPath, `ItemTable unreadable: ${(err as Error).message}`);
      return [];
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
        );
        continue;
      }

      if (!Array.isArray(composer.fullConversationHeadersOnly)) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          `expected 'fullConversationHeadersOnly' to be an array, got ` +
            describeType(composer.fullConversationHeadersOnly),
        );
        continue;
      }

      if (composer.modelConfig !== undefined && composer.modelConfig !== null &&
          !isRecord(composer.modelConfig)) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          `expected 'modelConfig' to be object or absent, got ${describeType(composer.modelConfig)}`,
        );
      } else if (composer.modelConfig === null) {
        warnDrift(
          `${wsPathForWarn}#composerData:${ref.composerId}`,
          "'modelConfig' is null — falling back to composerId as model label",
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
        if (since.getTime() > 0 && timestamp <= since) {
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
        // Scoped like any database found by walking. This branch used to
        // return the path unchecked, and it is the branch a `storePath`
        // override reaches — a committable `.xtctx/config.yaml` naming any
        // `state.vscdb` on the machine, whose every composer was then read as
        // this project's.
        if (!this.projectRoot) {
          return [this.cursorStorePath];
        }
        return (await workspaceMatchesProject(this.cursorStorePath, this.projectRoot))
          ? [this.cursorStorePath]
          : [];
      }

      if (!target.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const paths = await glob("**/state.vscdb", {
      cwd: this.cursorStorePath,
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
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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

/**
 * Derive the Cursor global storage path from a workspace database path.
 *
 * Workspace path structure:
 *   .../Cursor/User/workspaceStorage/<hash>/state.vscdb
 * Global storage:
 *   .../Cursor/User/globalStorage/state.vscdb
 */
/**
 * Fields Cursor records file locations under, inside a composer.
 *
 * Named explicitly rather than matching anything that looks like a path: the
 * question being answered is "did this conversation touch this project", and
 * only a recorded file location answers it. Prose that happens to contain a
 * path-shaped string does not — a conversation quoting someone else's error
 * message must not be filed under their project.
 */
const COMPOSER_PATH_FIELDS = new Set(["fsPath", "external", "toolDisplayPath", "repoPath", "path"]);

/** How deep to walk a composer looking for recorded file locations. */
const COMPOSER_PATH_DEPTH = 6;

/**
 * Whether a composer records a file inside the given project.
 *
 * Fails closed: a conversation with no recorded location is not attributed to
 * anything, matching the project boundary the other readers hold to.
 */
export function composerMentionsProject(composer: unknown, projectRoot: string): boolean {
  return walkForProjectPath(composer, projectRoot, 0);
}

function walkForProjectPath(value: unknown, projectRoot: string, depth: number): boolean {
  if (depth > COMPOSER_PATH_DEPTH) return false;

  if (Array.isArray(value)) {
    return value.some((item) => walkForProjectPath(item, projectRoot, depth + 1));
  }

  if (!isRecord(value)) return false;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && COMPOSER_PATH_FIELDS.has(key)) {
      if (pathMatchesProject(decodeFileUri(item), projectRoot)) return true;
      continue;
    }
    if (walkForProjectPath(item, projectRoot, depth + 1)) return true;
  }

  return false;
}

function decodeFileUri(value: string): string {
  if (!value.startsWith("file:///")) return value;
  try {
    return decodeURIComponent(value.slice("file:///".length));
  } catch {
    return value.slice("file:///".length);
  }
}

/**
 * globalStorage for a configured store path.
 *
 * The store is normally `<user>/workspaceStorage`, but it can also be pointed
 * at a single workspace directory inside it, which is what the tests do and
 * what a `storePath` override may do. Both resolve to the same sibling.
 */
export function globalStoragePathForStore(storePath: string): string | null {
  const normalized = storePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/workspaceStorage");
  if (index === -1) return null;
  return join(normalized.slice(0, index), "globalStorage", "state.vscdb");
}

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

