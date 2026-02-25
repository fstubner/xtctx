export interface ChunkMetadata {
  messageIndex: number;
  tokenEstimate?: number;
  referencedFiles?: string[];
}

export interface ConversationChunk {
  tool: string;
  sessionId: string;
  timestamp: Date;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: ChunkMetadata;
}

export interface ScraperState {
  lastTimestamp: Date;
  lastOffset?: number;
  lastRowId?: number;
  checksum?: string;
}

export interface ConversationScraper<
  T extends ConversationChunk = ConversationChunk,
> {
  readonly tool: string;
  detect(): Promise<boolean>;
  getStorePaths(): string[];
  scrape(since?: Date): AsyncIterable<T>;
  fullSync(): AsyncIterable<T>;
  parseRaw(raw: unknown): T;
  getLastScrapedPosition(): Promise<ScraperState>;
  saveScrapedPosition(state: ScraperState): Promise<void>;
}

export interface ClaudeCodeChunk extends ConversationChunk {
  tool: "claude-code";
  metadata: ChunkMetadata & {
    toolCalls?: string[];
    costUsd?: number;
    sessionType: "interactive" | "headless";
    permissionMode?: string;
  };
}

export interface CursorChunk extends ConversationChunk {
  tool: "cursor";
  metadata: ChunkMetadata & {
    composerMode: "normal" | "agent";
    model: string;
    tabContext?: string[];
    codebaseSearchResults?: number;
  };
}

export interface CodexChunk extends ConversationChunk {
  tool: "codex";
  metadata: ChunkMetadata & {
    approvalMode: "suggest" | "auto-edit" | "full-auto";
    sandboxed: boolean;
  };
}

export interface CopilotChunk extends ConversationChunk {
  tool: "copilot";
  metadata: ChunkMetadata & {
    model?: string;
    completionType?: string;
  };
}

export interface GeminiChunk extends ConversationChunk {
  tool: "gemini";
  metadata: ChunkMetadata & {
    model?: string;
    promptTokens?: number;
    responseTokens?: number;
  };
}
