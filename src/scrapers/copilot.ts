import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationScraper, CopilotChunk, ScraperState } from "../types/scraper.js";
import { estimateTokens, ScraperStateManager } from "./base.js";

const ROLE_MAP: Record<string, CopilotChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

interface ParsedMessage {
  sessionId: string;
  role?: string;
  content?: string;
  timestamp?: string | number;
  model?: string;
  completionType?: string;
}

export class CopilotScraper implements ConversationScraper<CopilotChunk> {
  readonly tool = "copilot";
  private readonly stateManager: ScraperStateManager;

  constructor(
    private readonly copilotHistoryPath: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.copilotHistoryPath);
      return target.isFile() || target.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.copilotHistoryPath];
  }

  async *scrape(since?: Date): AsyncIterable<CopilotChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllMessages(cutoff);
  }

  async *fullSync(): AsyncIterable<CopilotChunk> {
    yield* this.readAllMessages(new Date(0));
  }

  parseRaw(raw: unknown): CopilotChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";

    return {
      tool: "copilot",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role: normalizeRole(toStringValue(value.role)),
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        model: toStringValue(value.model),
        completionType: toStringValue(value.completionType),
      },
    };
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }

  private async *readAllMessages(since: Date): AsyncIterable<CopilotChunk> {
    const files = await this.resolveJsonFiles();
    const messageIndexBySession = new Map<string, number>();

    for (const filePath of files) {
      const fileSessionId = inferSessionId(filePath);
      let parsed: unknown;

      try {
        parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
      } catch {
        continue;
      }

      const messages = extractMessages(parsed, fileSessionId);
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
      const target = await stat(this.copilotHistoryPath);
      if (target.isFile()) {
        return this.copilotHistoryPath.endsWith(".json") ? [this.copilotHistoryPath] : [];
      }

      const files = await readdir(this.copilotHistoryPath);
      return files
        .filter((file) => file.endsWith(".json"))
        .map((file) => join(this.copilotHistoryPath, file));
    } catch {
      return [];
    }
  }
}

function extractMessages(input: unknown, fallbackSessionId: string): ParsedMessage[] {
  if (Array.isArray(input)) {
    return input
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => mapMessage(entry, fallbackSessionId));
  }

  if (!isRecord(input)) {
    return [];
  }

  if (Array.isArray(input.messages)) {
    const sessionId = toStringValue(input.sessionId ?? input.session_id) ?? fallbackSessionId;
    return input.messages
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => mapMessage(entry, sessionId));
  }

  if (Array.isArray(input.conversations)) {
    const rows: ParsedMessage[] = [];
    for (const conversation of input.conversations) {
      if (!isRecord(conversation) || !Array.isArray(conversation.messages)) {
        continue;
      }

      const sessionId =
        toStringValue(conversation.sessionId ?? conversation.session_id ?? conversation.id) ??
        fallbackSessionId;

      for (const message of conversation.messages) {
        if (isRecord(message)) {
          rows.push(mapMessage(message, sessionId));
        }
      }
    }

    return rows;
  }

  return [];
}

function mapMessage(message: Record<string, unknown>, sessionId: string): ParsedMessage {
  return {
    sessionId,
    role: toStringValue(message.role) ?? toStringValue(message.author),
    content: toStringValue(message.content) ?? toStringValue(message.text),
    timestamp: (message.timestamp ?? message.created_at ?? message.createdAt) as
      | string
      | number
      | undefined,
    model: toStringValue(message.model),
    completionType: toStringValue(message.completionType ?? message.completion_type),
  };
}

function normalizeRole(value?: string): CopilotChunk["role"] {
  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function inferSessionId(filePath: string): string {
  return basename(filePath).replace(".json", "") || "unknown";
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return 0;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
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
