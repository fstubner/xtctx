import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  ChunkMetadata,
  ClaudeCodeChunk,
  ConversationScraper,
  ScraperState,
} from "../types/scraper.js";
import { estimateTokens, ScraperStateManager } from "./base.js";

const ROLE_MAP: Record<string, ClaudeCodeChunk["role"]> = {
  human: "user",
  assistant: "assistant",
  system: "system",
  tool_use: "tool",
  tool_result: "tool",
};

export class ClaudeCodeScraper implements ConversationScraper<ClaudeCodeChunk> {
  readonly tool = "claude-code";
  private readonly stateManager: ScraperStateManager;

  constructor(
    private readonly claudeProjectsDir: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
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
    const timestamp = new Date((obj.timestamp as string) || Date.now());
    const content = (obj.content as string) || "";
    const type = (obj.type as string) || "unknown";

    return {
      tool: "claude-code",
      sessionId: (obj.sessionId as string) || "unknown",
      timestamp,
      role: ROLE_MAP[type] || "system",
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

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }

  private async *readAllSessions(since: Date): AsyncIterable<ClaudeCodeChunk> {
    let projectDirs: string[];

    try {
      projectDirs = await readdir(this.claudeProjectsDir);
    } catch {
      return;
    }

    for (const projectHash of projectDirs) {
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
        for await (const line of reader) {
          if (!line.trim()) {
            continue;
          }

          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const timestamp = new Date((obj.timestamp as string) ?? 0);

            if (timestamp <= since) {
              messageIndex += 1;
              continue;
            }

            obj.sessionId = sessionId;
            obj.messageIndex = messageIndex;
            messageIndex += 1;
            yield this.parseRaw(obj);
          } catch {
            // Skip malformed lines.
          }
        }
      }
    }
  }
}
