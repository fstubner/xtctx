import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationScraper, GeminiChunk, ScraperState } from "../types/scraper.js";
import { estimateTokens, ScraperStateManager } from "./base.js";

const ROLE_MAP: Record<string, GeminiChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  model: "assistant",
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

export class GeminiCliScraper implements ConversationScraper<GeminiChunk> {
  readonly tool = "gemini";
  private readonly stateManager: ScraperStateManager;

  constructor(
    private readonly geminiHistoryPath: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
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

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }

  private async *readAllMessages(since: Date): AsyncIterable<GeminiChunk> {
    const files = await this.resolveJsonFiles();
    const messageIndexBySession = new Map<string, number>();

    for (const filePath of files) {
      let parsed: unknown;
      const fileSessionId = inferSessionId(filePath);

      try {
        parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
      } catch {
        continue;
      }

      const messages = extractGeminiMessages(parsed, fileSessionId);
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

  private async resolveJsonFiles(): Promise<string[]> {
    try {
      const target = await stat(this.geminiHistoryPath);
      if (target.isFile()) {
        return this.geminiHistoryPath.endsWith(".json") ? [this.geminiHistoryPath] : [];
      }

      const files = await readdir(this.geminiHistoryPath);
      return files
        .filter((file) => file.endsWith(".json"))
        .map((file) => join(this.geminiHistoryPath, file));
    } catch {
      return [];
    }
  }
}

function extractGeminiMessages(input: unknown, fallbackSessionId: string): ParsedGeminiMessage[] {
  if (Array.isArray(input)) {
    return input
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => mapSimpleMessage(entry, fallbackSessionId));
  }

  if (!isRecord(input)) {
    return [];
  }

  if (Array.isArray(input.messages)) {
    const sessionId = toStringValue(input.sessionId ?? input.session_id) ?? fallbackSessionId;
    return input.messages
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => mapSimpleMessage(entry, sessionId));
  }

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

  return [];
}

function mapSimpleMessage(message: Record<string, unknown>, sessionId: string): ParsedGeminiMessage {
  return {
    sessionId,
    role: toStringValue(message.role ?? message.author),
    content: toStringValue(message.content ?? message.text),
    timestamp: (message.timestamp ?? message.created_at ?? message.createdAt) as
      | string
      | number
      | undefined,
    model: toStringValue(message.model),
    promptTokens: toNumberOrUndefined(message.promptTokens ?? message.prompt_tokens),
    responseTokens: toNumberOrUndefined(message.responseTokens ?? message.response_tokens),
  };
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

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis);
  }

  if (typeof value === "string") {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
