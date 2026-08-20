import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ChunkMetadata, ClaudeCodeChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens } from "./base.js";
import { encodePathForToolDirectory, pathMatchesProject } from "../utils/project-scope.js";

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
  "attachment",
  "custom-title",
  "last-prompt",
  // Session mode markers (`{"type":"mode","mode":"normal",…}`). Bookkeeping,
  // no conversational content — and frequent: 169 of them in a single
  // transcript here, each previously reported twice as drift.
  "mode",
  "pr-link",
  "progress",
  "queue-operation",
]);

/**
 * Drift warnings, collected per scan and reported once per kind.
 *
 * Warning per record made the signal useless the moment a surprise was common
 * rather than rare: one new record type Claude Code started writing produced
 * 344 warnings and 74KB of stderr in a single scan, dumped into the host's log.
 * The product promises to warn rather than silently drop, so what matters is
 * that each distinct surprise is seen — not that it is repeated per record.
 */
class DriftLog {
  private readonly surprises = new Map<string, { firstLocation: string; records: number }>();

  record(location: string, surprise: string): void {
    const seen = this.surprises.get(surprise);
    if (seen) {
      seen.records += 1;
      return;
    }
    this.surprises.set(surprise, { firstLocation: location, records: 1 });
  }

  flush(): void {
    for (const [surprise, { firstLocation, records }] of this.surprises) {
      console.warn(
        `[${SCRAPER_NAME}] schema-drift surprise at ${firstLocation}: ${surprise} ` +
          `(records affected: ${records})`,
      );
    }
    this.surprises.clear();
  }
}

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
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<ClaudeCodeChunk> {
    yield* this.readAllSessions(new Date(0));
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

    // Collected across the whole scan and reported once per kind. `finally`
    // so a consumer that stops early still gets the warnings for what it read.
    const drift = new DriftLog();
    try {
      yield* this.readProjects(projectDirs, encodedProject, since, drift);
    } finally {
      drift.flush();
    }
  }

  private async *readProjects(
    projectDirs: string[],
    encodedProject: string | null,
    since: Date,
    drift: DriftLog,
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
          yield* this.readSessionFile(filePath, sessionId, since, exactDirectory, drift);
        } catch (err) {
          // One unreadable file must not abort the remaining files/projects.
          drift.record(filePath, `unreadable transcript file: ${(err as Error).message}`);
        }
      }
    }
  }

  private async *readSessionFile(
    filePath: string,
    sessionId: string,
    since: Date,
    exactDirectory: boolean,
    drift: DriftLog,
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
        drift.record(
          `${filePath}:${lineNo}`,
          `line is not valid JSON: ${(err as Error).message}`,
          );
        continue;
      }

      if (NON_MESSAGE_TYPES.has(String(obj.type))) {
        continue;
      }

      if (!this.recordMatchesProject(obj, exactDirectory)) {
        continue;
      }

      // Strict-mode schema check: warn (but still emit) on shape surprise.
      if (!("type" in obj)) {
        drift.record(
          `${filePath}:${lineNo}`,
          "record is missing required 'type' field — likely renamed",
          );
      } else if (typeof obj.type !== "string" || !(obj.type in ROLE_MAP)) {
        drift.record(
          `${filePath}:${lineNo}`,
          `unknown 'type' value ${JSON.stringify(obj.type)}`,
          );
      }

      if (
        "content" in obj &&
        obj.content !== undefined &&
        typeof obj.content !== "string"
      ) {
        drift.record(
          `${filePath}:${lineNo}`,
          `expected 'content' to be a string, got ${describeType(obj.content)}`,
          );
      }

      if (!("timestamp" in obj)) {
        drift.record(
          `${filePath}:${lineNo}`,
          "record is missing 'timestamp' field",
          );
      } else if (typeof obj.timestamp !== "string") {
        drift.record(
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

function extractContent(obj: Record<string, unknown>): string {
  if (typeof obj.content === "string") {
    return obj.content;
  }

  const message = isRecord(obj.message) ? obj.message : undefined;
  if (!message) {
    return "";
  }

  return stringifyContent(message.content);
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

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
