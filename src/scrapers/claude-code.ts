import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ChunkMetadata, ClaudeCodeChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens } from "./base.js";
import { encodePathForToolDirectory } from "../utils/project-scope.js";

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
  "pr-link",
  "progress",
  "queue-operation",
]);

function warnDrift(sourcePath: string, surprise: string, recordsAffected: number): void {
  console.warn(
    `[${SCRAPER_NAME}] schema-drift surprise at ${sourcePath}: ${surprise} ` +
      `(records affected: ${recordsAffected})`,
  );
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
    const timestamp = new Date((obj.timestamp as string) || 0);
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

    for (const projectHash of this.filterProjectDirs(projectDirs)) {
      const projectDir = join(this.claudeProjectsDir, projectHash);
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

        const sessionId = file.replace(".jsonl", "");
        const filePath = join(projectDir, file);
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
            warnDrift(
              `${filePath}:${lineNo}`,
              `line is not valid JSON: ${(err as Error).message}`,
              1,
            );
            continue;
          }

          if (NON_MESSAGE_TYPES.has(String(obj.type))) {
            continue;
          }

          // Strict-mode schema check: warn (but still emit) on shape surprise.
          if (!("type" in obj)) {
            warnDrift(
              `${filePath}:${lineNo}`,
              "record is missing required 'type' field — likely renamed",
              1,
            );
          } else if (typeof obj.type !== "string" || !(obj.type in ROLE_MAP)) {
            warnDrift(
              `${filePath}:${lineNo}`,
              `unknown 'type' value ${JSON.stringify(obj.type)}`,
              1,
            );
          }

          if (
            "content" in obj &&
            obj.content !== undefined &&
            typeof obj.content !== "string"
          ) {
            warnDrift(
              `${filePath}:${lineNo}`,
              `expected 'content' to be a string, got ${describeType(obj.content)}`,
              1,
            );
          }

          if (!("timestamp" in obj)) {
            warnDrift(
              `${filePath}:${lineNo}`,
              "record is missing 'timestamp' field",
              1,
            );
          } else if (typeof obj.timestamp !== "string") {
            warnDrift(
              `${filePath}:${lineNo}`,
              `expected 'timestamp' string, got ${describeType(obj.timestamp)}`,
              1,
            );
          }

          const timestamp = new Date((obj.timestamp as string) ?? 0);

          if (timestamp <= since) {
            messageIndex += 1;
            continue;
          }

          obj.sessionId = sessionId;
          obj.messageIndex = messageIndex;
          const chunk = this.parseRaw(obj);
          if (!chunk.content.trim()) {
            continue;
          }

          messageIndex += 1;
          yield chunk;
        }
      }
    }
  }

  private filterProjectDirs(projectDirs: string[]): string[] {
    if (!this.projectRoot) {
      return projectDirs;
    }

    const encodedProject = encodePathForToolDirectory(this.projectRoot).toLowerCase();
    return projectDirs.filter((projectDir) => {
      const normalized = projectDir.toLowerCase();
      return normalized === encodedProject || normalized.startsWith(`${encodedProject}--`);
    });
  }
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
