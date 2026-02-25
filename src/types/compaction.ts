export interface CompactedSession {
  sessionId: string;
  tool: string;
  timeRange: { start: string; end: string };
  summary: string;
  tasksCompleted: string[];
  decisionsIdentified: string[];
  filesModified: string[];
  openQuestions: string[];
  chunkRefs: string[];
  chunkCount: number;
  estimatedTokens: number;
}

export interface CompactionConfig {
  strategy: "rule-based" | "llm-assisted";
  sessionBoundaryMinutes: number;
  llm?: {
    provider: "cli" | "ollama" | "openai";
    command?: string;
    args?: string[];
    model?: string;
    endpoint?: string;
    apiKeyEnv?: string;
  };
}
