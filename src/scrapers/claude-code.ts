import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ChunkMetadata, ClaudeCodeChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens } from "./base.js";
import { encodePathForToolDirectory, pathMatchesProject } from "../utils/project-scope.js";
import { recordDrift, withDriftReport } from "./drift-log.js";

const SCRAPER_NAME = "claude-code";

/**
 * Mutation shapes the claude-code scraper tolerates silently (no warn, no
 * throw). Everything else that falls outside the happy path warns.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Projects directory missing — Claude Code is simply not installed. */
  missingProjectsDir: "~/.claude/projects not present",
  /** A JSONL line that fails to parse — we skip but warn upstream. */
  malformedJsonlLine: "JSONL line is not valid JSON — warned, not fatal",
  /** Unknown sibling fields on a line (forward-compat for new keys). */
  unknownFieldsAlongside: "extra keys alongside known schema",
  /** Empty/blank lines in JSONL. */
  blankJsonlLine: "blank line inside JSONL file",
};

const ROLE_MAP: Record<string, ClaudeCodeChunk["role"]> = {
  human: "user",
  user: "user",
  assistant: "assistant",
  system: "system",
  tool_use: "tool",
  tool_result: "tool",
};

const NON_MESSAGE_TYPES = new Set([
  // `{"type":"atis-latch","atis":"","sessionId":"..."}` — bookkeeping, no
  // conversational content. Found by the format fingerprint the day Claude
  // Code started writing it, 18 in a single transcript.
  // A generated session title, alongside the user-set `custom-title` below.
  "ai-title",
  "atis-latch",
  "attachment",
  "custom-title",
  // A path/URL reference, alongside `pr-link` below.
  "frame-link",
  "last-prompt",
  // Session mode markers (`{"type":"mode","mode":"normal",…}`). Bookkeeping,
  // no conversational content — and frequent: 169 of them in a single
  // transcript here, each previously reported twice as drift.
  "mode",
  "pr-link",
  "progress",
  "queue-operation",
]);

export class ClaudeCodeScraper extends AbstractScraper<ClaudeCodeChunk> {
  readonly tool = "claude-code";

  constructor(
    private readonly claudeProjectsDir: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const dirStat = await stat(this.claudeProjectsDir);
      return dirStat.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.claudeProjectsDir];
  }

  async *scrape(since?: Date): AsyncIterable<ClaudeCodeChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* withDriftReport(SCRAPER_NAME, this.readAllSessions(cutoff), this.stateDir);
  }

  async *fullSync(): AsyncIterable<ClaudeCodeChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllSessions(new Date(0)), this.stateDir);
  }

  parseRaw(raw: unknown): ClaudeCodeChunk {
    const obj = raw as Record<string, unknown>;
    const timestamp = parseRecordTimestamp(obj.timestamp);
    const content = extractContent(obj);
    const type = (obj.type as string) || "unknown";
    const role = extractRole(obj, type);

    return {
      tool: "claude-code",
      sessionId: (obj.sessionId as string) || "unknown",
      timestamp,
      role,
      content,
      metadata: {
        messageIndex: (obj.messageIndex as number) || 0,
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        toolCalls: type === "tool_use" ? [(obj.name as string) || ""] : undefined,
        costUsd: obj.costUsd as number | undefined,
        // Recorded per record by Claude Code itself, so it is the branch the
        // work actually happened on rather than whatever is checked out now.
        gitBranch: toOptionalString(obj.gitBranch),
        sessionType: "interactive",
      } as ChunkMetadata & ClaudeCodeChunk["metadata"],
    };
  }

  private async *readAllSessions(since: Date): AsyncIterable<ClaudeCodeChunk> {
    let projectDirs: string[];

    try {
      projectDirs = await readdir(this.claudeProjectsDir);
    } catch {
      // ACCEPTED_DEGRADATIONS.missingProjectsDir
      return;
    }

    const encodedProject = this.projectRoot
      ? encodePathForToolDirectory(this.projectRoot).toLowerCase()
      : null;

    yield* this.readProjects(projectDirs, encodedProject, since);
  }

  private async *readProjects(
    projectDirs: string[],
    encodedProject: string | null,
    since: Date,
  ): AsyncIterable<ClaudeCodeChunk> {
    for (const projectHash of this.filterProjectDirs(projectDirs)) {
      const projectDir = join(this.claudeProjectsDir, projectHash);
      const exactDirectory =
        encodedProject === null || projectHash.toLowerCase() === encodedProject;
      let files: string[];

      try {
        files = await readdir(projectDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }

        const sessionId = file.replace(/\.jsonl$/, "");
        const filePath = join(projectDir, file);
        try {
          yield* this.readSessionFile(filePath, sessionId, since, exactDirectory);
        } catch (err) {
          // One unreadable file must not abort the remaining files/projects.
          recordDrift(
            SCRAPER_NAME,
            filePath,
            `unreadable transcript file: ${(err as Error).message}`,
        );
        }
      }
    }
  }

  private async *readSessionFile(
    filePath: string,
    sessionId: string,
    since: Date,
    exactDirectory: boolean,
  ): AsyncIterable<ClaudeCodeChunk> {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let messageIndex = 0;
    let lineNo = 0;
    for await (const line of reader) {
      lineNo++;
      if (!line.trim()) {
        continue;
      }

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        // ACCEPTED_DEGRADATIONS.malformedJsonlLine, but warn so the
        // mutation test can see drift instead of data silently vanishing.
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          `line is not valid JSON: ${(err as Error).message}`,
        );
        continue;
      }

      if (NON_MESSAGE_TYPES.has(String(obj.type)) && !carriesPlan(obj)) {
        continue;
      }

      if (!this.recordMatchesProject(obj, exactDirectory)) {
        continue;
      }

      // Strict-mode schema check: warn (but still emit) on shape surprise.
      if (!("type" in obj)) {
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          "record is missing required 'type' field — likely renamed",
        );
      } else if (
        // A plan arrives as `type: "attachment"`, which is not in ROLE_MAP and
        // never will be — it is admitted deliberately by carriesPlan above, so
        // reporting it as an unknown type is noise about a known shape.
        !carriesPlan(obj) &&
        (typeof obj.type !== "string" || !(obj.type in ROLE_MAP))
      ) {
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          `unknown 'type' value ${JSON.stringify(obj.type)}`,
        );
      }

      if (
        "content" in obj &&
        obj.content !== undefined &&
        typeof obj.content !== "string"
      ) {
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          `expected 'content' to be a string, got ${describeType(obj.content)}`,
        );
      }

      if (!("timestamp" in obj)) {
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          "record is missing 'timestamp' field",
        );
      } else if (typeof obj.timestamp !== "string") {
        recordDrift(
          SCRAPER_NAME,
          `${filePath}:${lineNo}`,
          `expected 'timestamp' string, got ${describeType(obj.timestamp)}`,
        );
      }

      const timestamp = parseRecordTimestamp(obj.timestamp);

      // Every message-shaped record consumes an index, whether or not it is
      // emitted, so chunk identity is identical between full and incremental
      // scrapes (chunk ids hash the index).
      const currentIndex = messageIndex;
      messageIndex += 1;

      // A zero `since` means full sync: emit even epoch-sentinel timestamps.
      if (since.getTime() > 0 && timestamp <= since) {
        continue;
      }

      obj.sessionId = sessionId;
      obj.messageIndex = currentIndex;
      const chunk = this.parseRaw(obj);
      if (!chunk.content.trim()) {
        continue;
      }

      yield chunk;
    }
  }

  /**
   * Coarse pre-filter over encoded store directory names.
   *
   * Encoded names are ambiguous — `-` stands for `:`, `\` and `/` alike — so
   * this only decides which directories are worth opening. Each record's own
   * `cwd` is what actually attributes it (see `recordMatchesProject`), which
   * is both unambiguous and platform-independent. Keeping the prefix wide
   * here lets sessions started from a subdirectory through; the per-record
   * check then rejects a sibling like `<project>--secret`.
   */
  private filterProjectDirs(projectDirs: string[]): string[] {
    if (!this.projectRoot) {
      return projectDirs;
    }

    const encodedProject = encodePathForToolDirectory(this.projectRoot).toLowerCase();
    return projectDirs.filter((projectDir) => {
      const normalized = projectDir.toLowerCase();
      return normalized === encodedProject || normalized.startsWith(`${encodedProject}-`);
    });
  }

  /**
   * Attribute a record to the project by the `cwd` Claude Code stamps on it.
   * Records without a `cwd` fall back to the directory-name decision already
   * made by `filterProjectDirs`.
   */
  private recordMatchesProject(obj: Record<string, unknown>, exactDirectory: boolean): boolean {
    if (!this.projectRoot) {
      return true;
    }
    const cwd = obj.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      // No provenance on the record. An exact store-directory match is itself
      // provenance, so keep it; a directory that only matched by prefix could
      // be a plain sibling (`proj-v2` beside `proj`), so fail closed.
      return exactDirectory;
    }
    return pathMatchesProject(cwd, this.projectRoot);
  }
}

/**
 * Missing or unparseable timestamps become the epoch sentinel rather than an
 * Invalid Date, which would poison cutoff comparisons and toISOString().
 */
function parseRecordTimestamp(value: unknown): Date {
  const parsed = new Date((value as string) || 0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function extractRole(
  obj: Record<string, unknown>,
  type: string,
): ClaudeCodeChunk["role"] {
  const message = isRecord(obj.message) ? obj.message : {};
  const role = typeof message.role === "string" ? message.role : type;
  return ROLE_MAP[role] ?? ROLE_MAP[type] ?? "system";
}

/**
 * Whether an otherwise-skipped record is a plan.
 *
 * `attachment` is in NON_MESSAGE_TYPES for good reason — most attachments are
 * pasted file contents, and indexing those would bury the conversation in
 * source code. But Claude Code also writes plans as attachments, with the plan
 * markdown in `attachment.planContent` and no `message` key at all, so the
 * blanket exclusion dropped every one: 11 records and 170,627 characters
 * across the transcripts on this machine, none of it retrievable.
 *
 * A plan is the decisions rather than the keystrokes, which makes it the most
 * worth retrieving thing in a session. Narrow on purpose: this admits records
 * carrying plan text and nothing else, so the file-dump attachments stay out.
 */
function carriesPlan(obj: Record<string, unknown>): boolean {
  const attachment = isRecord(obj.attachment) ? obj.attachment : undefined;
  return typeof attachment?.planContent === "string" && attachment.planContent.trim() !== "";
}

function extractContent(obj: Record<string, unknown>): string {
  if (typeof obj.content === "string") {
    return obj.content;
  }

  const message = isRecord(obj.message) ? obj.message : undefined;
  const fromMessage = message ? stringifyContent(message.content) : "";
  if (fromMessage.trim()) {
    return fromMessage;
  }

  // A plan record carries its text in `attachment.planContent` and nothing in
  // `message.content`, so reading only the latter produced an empty chunk that
  // the caller then dropped. Found by the format fingerprint, then measured
  // against real transcripts: 11 records, every one of them dropped, 170,627
  // characters — and a plan is the single most retrievable thing in a
  // session, being the decisions rather than the keystrokes.
  const attachment = isRecord(obj.attachment) ? obj.attachment : undefined;
  if (attachment && typeof attachment.planContent === "string") {
    return attachment.planContent;
  }

  return fromMessage;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return "";
      }
      if (typeof item.text === "string") {
        return item.text;
      }
      if (typeof item.content === "string") {
        return item.content;
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n");
}

/** A non-empty string, or nothing. An empty branch is no branch. */
function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
