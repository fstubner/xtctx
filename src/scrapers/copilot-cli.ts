import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CopilotCliChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

const SCRAPER_NAME = "copilot-cli";

/**
 * Mutation shapes the copilot-cli scraper tolerates silently. Anything
 * outside this whitelist that drops records must warn.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Sessions root missing — Copilot CLI not installed. */
  missingSessionRoot: "~/.copilot/session-state directory absent",
  /** Session directory has no events.jsonl file yet — fresh session. */
  missingEventsJsonl: "session directory has no events.jsonl",
  /** Blank line in events.jsonl. */
  blankJsonlLine: "blank line in events.jsonl",
  /** Event with no extractable role — many event types (status, tool_call,
   *  subagent meta, etc.) legitimately have no role. */
  noRole: "event has no role — non-conversation event",
  /** Event with no extractable text content. */
  noContent: "event has role but no text content",
  /** Forward-compat unknown keys alongside known fields. */
  unknownFieldsAlongside: "extra keys alongside known event schema",
};

const ROLE_MAP: Record<string, CopilotCliChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  system: "system",
  tool: "tool",
};

function warnDrift(sourcePath: string, surprise: string, recordsAffected: number): void {
  console.warn(
    `[${SCRAPER_NAME}] schema-drift surprise at ${sourcePath}: ${surprise} ` +
      `(records affected: ${recordsAffected})`,
  );
}

export class CopilotCliScraper extends AbstractScraper<CopilotCliChunk> {
  readonly tool = "copilot-cli";

  constructor(
    private readonly sessionStateDir: string,
    stateDir: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.sessionStateDir);
      return target.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.sessionStateDir];
  }

  async *scrape(since?: Date): AsyncIterable<CopilotCliChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<CopilotCliChunk> {
    yield* this.readAllSessions(new Date(0));
  }

  private async *readAllSessions(since: Date): AsyncIterable<CopilotCliChunk> {
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(this.sessionStateDir);
    } catch {
      // ACCEPTED_DEGRADATIONS.missingSessionRoot
      return;
    }

    for (const sessionId of sessionDirs) {
      const sessionDir = join(this.sessionStateDir, sessionId);
      let dirStat;
      try {
        dirStat = await stat(sessionDir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const eventsPath = join(sessionDir, "events.jsonl");
      try {
        const eventsStat = await stat(eventsPath);
        if (!eventsStat.isFile()) continue;
      } catch {
        // ACCEPTED_DEGRADATIONS.missingEventsJsonl
        continue;
      }

      yield* this.readEventsFile(eventsPath, sessionId, since);
    }
  }

  private async *readEventsFile(
    filePath: string,
    sessionId: string,
    since: Date,
  ): AsyncIterable<CopilotCliChunk> {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let messageIndex = 0;
    let lineNo = 0;

    for await (const line of reader) {
      lineNo++;
      if (!line.trim()) {
        // ACCEPTED_DEGRADATIONS.blankJsonlLine
        continue;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        warnDrift(
          `${filePath}:${lineNo}`,
          `events.jsonl line is not valid JSON: ${(err as Error).message}`,
          1,
        );
        continue;
      }

      if (!isRecord(event)) {
        warnDrift(
          `${filePath}:${lineNo}`,
          `events.jsonl line is not an object (got ${describeType(event)})`,
          1,
        );
        continue;
      }

      const role = extractRole(event);
      const content = extractContent(event);

      if (!role) {
        // If the event looks like a conversation message (has extractable
        // content AND a 'message' or 'role'-shaped sibling that we COULDN'T
        // route), warn — likely a rename. Routine non-conversation events
        // (status, tool_call, etc.) carry no content and are silent.
        if (content) {
          const looksLikeMessage =
            event.type === "message" ||
            "role" in event ||
            (isRecord(event.message) && "role" in event.message);
          if (looksLikeMessage) {
            warnDrift(
              `${filePath}:${lineNo}`,
              "event has content but no readable role — likely role-field rename",
              1,
            );
          }
        }
        // ACCEPTED_DEGRADATIONS.noRole — non-conversation events are
        // routine in events.jsonl. Skip silently.
        continue;
      }

      if (!content) {
        // Role is present but no content extractable. If a 'content' key
        // exists in an unexpected shape (null, number, etc.), warn — silent
        // skip would hide a content-field retype. A genuinely-missing content
        // key on a role'd event is unusual but not necessarily drift.
        if ("content" in event && typeof event.content !== "string" && !Array.isArray(event.content)) {
          warnDrift(
            `${filePath}:${lineNo}`,
            `event has role but 'content' is unexpected type ${describeType(event.content)}`,
            1,
          );
        }
        // ACCEPTED_DEGRADATIONS.noContent
        continue;
      }

      const tsValue = event.timestamp ?? event.created_at ?? event.createdAt ?? event.time;
      const timestamp = toDate(tsValue);
      if (timestamp <= since) {
        messageIndex++;
        continue;
      }

      const eventType = typeof event.type === "string" ? event.type : undefined;

      yield {
        tool: "copilot-cli",
        sessionId,
        timestamp,
        role,
        content,
        metadata: {
          messageIndex,
          tokenEstimate: estimateTokens(content),
          referencedFiles: [],
          eventType,
        },
      };
      messageIndex++;
    }
  }
}

function extractRole(event: Record<string, unknown>): CopilotCliChunk["role"] | null {
  // Try event.role first.
  if (typeof event.role === "string") {
    const mapped = ROLE_MAP[event.role.toLowerCase()];
    if (mapped) return mapped;
  }

  // Try event.message.role.
  const message = event.message;
  if (isRecord(message) && typeof message.role === "string") {
    const mapped = ROLE_MAP[message.role.toLowerCase()];
    if (mapped) return mapped;
  }

  return null;
}

function extractContent(event: Record<string, unknown>): string | undefined {
  // 1. event.content as string.
  if (typeof event.content === "string") {
    const trimmed = event.content.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // 2. event.text as string.
  if (typeof event.text === "string") {
    const trimmed = event.text.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // 3. event.message.content as string or array of {type, text}.
  const message = event.message;
  if (isRecord(message)) {
    const inner = message.content;
    if (typeof inner === "string") {
      const trimmed = inner.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(inner)) {
      const texts = inner
        .map((item) => {
          if (typeof item === "string") return item;
          if (isRecord(item) && typeof item.text === "string") return item.text;
          return "";
        })
        .filter((t) => t.length > 0);
      const joined = texts.join("\n").trim();
      if (joined.length > 0) return joined;
    }
  }

  // 4. event.content as array of {type, text}.
  if (Array.isArray(event.content)) {
    const texts = event.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter((t) => t.length > 0);
    const joined = texts.join("\n").trim();
    if (joined.length > 0) return joined;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
