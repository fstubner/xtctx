import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { glob } from "glob";
import type { GeminiChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

const SCRAPER_NAME = "gemini";

/**
 * Shapes the gemini scraper tolerates silently. Anything else warns.
 * Required-schema violations (messages must be an array) warn and return
 * zero chunks for that file so the rest of the batch still processes.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** History path absent — Gemini CLI not installed. */
  missingHistoryPath: "~/.gemini/tmp not present",
  /** Unparseable JSON file — warn, skip. */
  malformedJsonFile: "session JSON not parseable",
  /** Legacy layout with 'sessions' array (supported explicitly). */
  legacySessionsLayout: "session file uses legacy 'sessions' layout",
  /** Info/error typed entries are intentionally skipped. */
  infoOrErrorMessage: "info/error messages are not conversation turns",
  /** Empty content (tool-call only etc.). */
  emptyContent: "message has no user-visible content",
  /** Forward-compat unknown siblings. */
  unknownFieldsAlongside: "extra keys alongside known schema",
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

const ROLE_MAP: Record<string, GeminiChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  model: "assistant",
  gemini: "assistant",
  system: "system",
  tool: "tool",
};

interface ParsedGeminiMessage {
  sessionId: string;
  role?: string;
  content?: string;
  timestamp?: string | number;
  model?: string;
  promptTokens?: number;
  responseTokens?: number;
}

export class GeminiCliScraper extends AbstractScraper<GeminiChunk> {
  readonly tool = "gemini";

  constructor(
    private readonly geminiHistoryPath: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.geminiHistoryPath);
      return target.isFile() || target.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.geminiHistoryPath];
  }

  async *scrape(since?: Date): AsyncIterable<GeminiChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllMessages(cutoff);
  }

  async *fullSync(): AsyncIterable<GeminiChunk> {
    yield* this.readAllMessages(new Date(0));
  }

  parseRaw(raw: unknown): GeminiChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";

    return {
      tool: "gemini",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role: normalizeRole(toStringValue(value.role)),
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        model: toStringValue(value.model),
        promptTokens: toNumberOrUndefined(value.promptTokens),
        responseTokens: toNumberOrUndefined(value.responseTokens),
      },
    };
  }

  private async *readAllMessages(since: Date): AsyncIterable<GeminiChunk> {
    const files = await this.resolveJsonFiles();
    const messageIndexBySession = new Map<string, number>();

    for (const filePath of files) {
      let parsed: unknown;
      const fileSessionId = inferSessionId(filePath);

      try {
        parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
      } catch (err) {
        warnDrift(filePath, `session JSON not parseable: ${(err as Error).message}`, 0);
        continue;
      }

      const messages = extractGeminiMessages(parsed, fileSessionId, filePath);
      for (const message of messages) {
        const timestamp = toDate(message.timestamp);
        if (timestamp <= since) {
          continue;
        }

        const sessionId = message.sessionId || fileSessionId;
        const nextIndex = messageIndexBySession.get(sessionId) ?? 0;
        messageIndexBySession.set(sessionId, nextIndex + 1);

        yield this.parseRaw({
          ...message,
          timestamp,
          sessionId,
          messageIndex: nextIndex,
        });
      }
    }
  }

  /**
   * Resolves JSON files to parse. Prefers the Gemini CLI chat session layout:
   *   <geminiHistoryPath>/<project>/chats/session-*.json
   * Falls back to flat *.json files in the directory for custom/legacy paths.
   */
  private async resolveJsonFiles(): Promise<string[]> {
    try {
      const target = await stat(this.geminiHistoryPath);
      if (target.isFile()) {
        return this.geminiHistoryPath.endsWith(".json") ? [this.geminiHistoryPath] : [];
      }

      if (!target.isDirectory()) {
        return [];
      }

      // Primary: Gemini CLI stores sessions under <project>/chats/session-*.json
      if (this.projectRoot) {
        const projectName = basename(this.projectRoot);
        return glob(`${projectName}/chats/session-*.json`, {
          cwd: this.geminiHistoryPath,
          absolute: true,
          nodir: true,
        });
      }

      const sessionFiles = await glob("**/chats/session-*.json", {
        cwd: this.geminiHistoryPath,
        absolute: true,
        nodir: true,
      });

      if (sessionFiles.length > 0) {
        return sessionFiles;
      }

      // Fallback: flat directory of *.json files (custom or legacy layout)
      const files = await readdir(this.geminiHistoryPath);
      return files
        .filter((file) => file.endsWith(".json"))
        .map((file) => join(this.geminiHistoryPath, file));
    } catch {
      return [];
    }
  }
}

/**
 * Extracts conversation messages from a parsed Gemini session file.
 *
 * Supports three layouts:
 *  1. Gemini CLI format: { sessionId, messages: [{type, content, timestamp}] }
 *     where type ∈ {"user","gemini","error","info"} and content is a [{text}] array or string.
 *  2. Sessions-with-turns: { sessions: [{ turns: [{prompt, response}] }] }
 *  3. Flat array of messages: [{role, content, timestamp}]
 */
function extractGeminiMessages(
  input: unknown,
  fallbackSessionId: string,
  sourcePath: string,
): ParsedGeminiMessage[] {
  if (Array.isArray(input)) {
    return input
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => mapSimpleMessage(entry, fallbackSessionId));
  }

  if (!isRecord(input)) {
    warnDrift(
      sourcePath,
      `expected session file to be an object or array, got ${describeType(input)}`,
      0,
    );
    return [];
  }

  // Gemini CLI native format: { sessionId, messages: [...] }
  // Strict-mode: if 'messages' is present as a non-array, that's structural
  // drift — warn. Don't return early, though: mixed files that carry valid
  // legacy 'sessions' alongside a non-array 'messages' metadata field must
  // still fall through to the legacy parser rather than dropping every
  // recoverable turn. The legacy branch below will handle them; if neither
  // shape is usable, the final "unknown shape" guard will report it.
  if (input.messages !== undefined && !Array.isArray(input.messages)) {
    warnDrift(
      sourcePath,
      `'messages' is present but not an array (got ${describeType(input.messages)})`,
      0,
    );
  }

  if (input.sessionId === null) {
    warnDrift(sourcePath, "'sessionId' is null — falling back to filename", 0);
  }

  if (Array.isArray(input.messages)) {
    const sessionId = toStringValue(input.sessionId ?? input.session_id) ?? fallbackSessionId;
    const rows: ParsedGeminiMessage[] = [];

    for (const entry of input.messages) {
      if (!isRecord(entry)) continue;

      // The Gemini CLI uses 'type' as the role discriminator.
      const typeField = toStringValue(entry.type);

      // Skip system/error/info messages — they're not conversation turns.
      if (typeField === "info" || typeField === "error") continue;

      // Resolve role: prefer 'role'/'author' field, fall back to 'type'.
      const role = toStringValue(entry.role ?? entry.author) ?? typeField;
      if (!role) continue;

      // Content may be an array of {text} parts or a plain string.
      const content = extractContent(entry.content);
      if (!content) continue;

      rows.push({
        sessionId,
        role,
        content,
        timestamp: (entry.timestamp ?? entry.created_at ?? entry.createdAt) as
          | string
          | number
          | undefined,
        model: toStringValue(entry.model),
        promptTokens: toNumberOrUndefined(entry.promptTokens ?? entry.prompt_tokens),
        responseTokens: toNumberOrUndefined(entry.responseTokens ?? entry.response_tokens),
      });
    }

    return rows;
  }

  // Legacy format: { sessions: [{ turns: [{prompt, response}] }] }
  if (Array.isArray(input.sessions)) {
    const rows: ParsedGeminiMessage[] = [];

    for (const session of input.sessions) {
      if (!isRecord(session)) {
        continue;
      }

      const sessionId =
        toStringValue(session.sessionId ?? session.session_id ?? session.id) ??
        fallbackSessionId;

      if (Array.isArray(session.turns)) {
        for (const turn of session.turns) {
          if (!isRecord(turn)) {
            continue;
          }

          const timestamp = turn.timestamp ?? turn.created_at ?? turn.createdAt;
          const model = toStringValue(turn.model);
          const promptTokens = toNumberOrUndefined(turn.promptTokens ?? turn.prompt_tokens);
          const responseTokens = toNumberOrUndefined(turn.responseTokens ?? turn.response_tokens);
          const prompt = toStringValue(turn.prompt);
          const response = toStringValue(turn.response);

          if (prompt) {
            rows.push({
              sessionId,
              role: "user",
              content: prompt,
              timestamp: timestamp as string | number | undefined,
              model,
              promptTokens,
              responseTokens,
            });
          }

          if (response) {
            rows.push({
              sessionId,
              role: "assistant",
              content: response,
              timestamp: timestamp as string | number | undefined,
              model,
              promptTokens,
              responseTokens,
            });
          }
        }
      }

      if (Array.isArray(session.messages)) {
        for (const message of session.messages) {
          if (isRecord(message)) {
            rows.push(mapSimpleMessage(message, sessionId));
          }
        }
      }
    }

    return rows;
  }

  // Neither 'messages' (native) nor 'sessions' (legacy) recognised. If the
  // file has any array-shaped sibling, treat it as a likely rename and warn.
  const suspiciousRename = Object.entries(input).find(([, v]) => Array.isArray(v));
  if (suspiciousRename) {
    warnDrift(
      sourcePath,
      `no 'messages' or 'sessions' key; suspected rename to '${suspiciousRename[0]}'`,
      0,
    );
  } else {
    warnDrift(
      sourcePath,
      "session object has neither 'messages' nor 'sessions' array",
      0,
    );
  }
  return [];
}

/** Maps a flat message record using role/author and content/text fields. */
function mapSimpleMessage(message: Record<string, unknown>, sessionId: string): ParsedGeminiMessage {
  return {
    sessionId,
    role: toStringValue(message.role ?? message.author),
    content: extractContent(message.content ?? message.text),
    timestamp: (message.timestamp ?? message.created_at ?? message.createdAt) as
      | string
      | number
      | undefined,
    model: toStringValue(message.model),
    promptTokens: toNumberOrUndefined(message.promptTokens ?? message.prompt_tokens),
    responseTokens: toNumberOrUndefined(message.responseTokens ?? message.response_tokens),
  };
}

/**
 * Extracts text content from a value that may be:
 *  - a plain string
 *  - an array of {text: string} objects (Gemini CLI content-part format)
 */
function extractContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((item) => (isRecord(item) ? toStringValue(item.text) : undefined))
      .filter((t): t is string => t !== undefined);
    const joined = texts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  }

  return undefined;
}

function normalizeRole(value?: string): GeminiChunk["role"] {
  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function inferSessionId(filePath: string): string {
  return basename(filePath).replace(".json", "") || "unknown";
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return undefined;
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
