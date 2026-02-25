import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { CodexChunk, ConversationScraper, ScraperState } from "../types/scraper.js";
import { estimateTokens, ScraperStateManager } from "./base.js";

const ROLE_MAP: Record<string, CodexChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

type ApprovalMode = CodexChunk["metadata"]["approvalMode"];

export class CodexCliScraper implements ConversationScraper<CodexChunk> {
  readonly tool = "codex";
  private readonly stateManager: ScraperStateManager;

  constructor(
    private readonly codexSessionsPath: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.codexSessionsPath);
      return target.isDirectory() || target.isFile();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.codexSessionsPath];
  }

  async *scrape(since?: Date): AsyncIterable<CodexChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<CodexChunk> {
    yield* this.readAllSessions(new Date(0));
  }

  parseRaw(raw: unknown): CodexChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";
    const role = normalizeRole(toStringValue(value.role) ?? toStringValue(value.type));

    return {
      tool: "codex",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role,
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        approvalMode: normalizeApprovalMode(toStringValue(value.approvalMode)),
        sandboxed: toBoolean(value.sandboxed),
      },
    };
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }

  private async *readAllSessions(since: Date): AsyncIterable<CodexChunk> {
    const files = await this.resolveJsonlFiles();

    for (const filePath of files) {
      const sessionId = inferSessionId(filePath);
      const reader = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      let messageIndex = 0;
      for await (const line of reader) {
        if (!line.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const timestamp = toDate(parsed.timestamp ?? parsed.created_at ?? parsed.createdAt);
          if (timestamp <= since) {
            messageIndex += 1;
            continue;
          }

          yield this.parseRaw({
            ...parsed,
            sessionId: parsed.sessionId ?? parsed.session_id ?? sessionId,
            messageIndex,
            timestamp,
            approvalMode: parsed.approvalMode ?? parsed.approval_mode,
          });
          messageIndex += 1;
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }

  private async resolveJsonlFiles(): Promise<string[]> {
    try {
      const target = await stat(this.codexSessionsPath);
      if (target.isFile()) {
        return this.codexSessionsPath.endsWith(".jsonl") ? [this.codexSessionsPath] : [];
      }

      const files = await readdir(this.codexSessionsPath);
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => join(this.codexSessionsPath, file));
    } catch {
      return [];
    }
  }
}

function normalizeRole(value?: string): CodexChunk["role"] {
  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function normalizeApprovalMode(value?: string): ApprovalMode {
  switch (value) {
    case "auto-edit":
      return "auto-edit";
    case "full-auto":
      return "full-auto";
    default:
      return "suggest";
  }
}

function inferSessionId(filePath: string): string {
  return basename(filePath).replace(".jsonl", "") || "unknown";
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return 0;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return false;
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
