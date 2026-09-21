export interface XtctxConfig {
  project?: {
    root?: string;
  };
  handoff?: {
    mode?: "raw-transcript-pointer";
    indexing?: "on-demand";
    summaries?: false;
  };
  mcp?: {
    command?: string;
    args?: string[];
  };
  skills?: {
    sourceDir?: string;
    selected?: Record<string, { hash?: string; source?: string }>;
    targets?: Record<string, { mode?: string; path?: string }>;
  };
  tools?: Record<string, ToolConfig>;
  embedding?: EmbeddingConfig;
}

export interface ToolConfig {
  enabled?: boolean;
  storePath?: string;
  hook?: "executable" | "instruction-only" | "mcp-only";
}

/**
 * Per-project embedding settings from `.xtctx/config.yaml`.
 *
 * Opt-in endpoint only — never inferred from an env var that happens to be
 * set. The API key itself must not appear here; `apiKeyEnv` names the env var.
 */
export interface EmbeddingConfig {
  provider: "local" | "openai-compatible";
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  batchSize: number;
  timeoutMs: number;
  minSemanticCosine: number;
  minConfidentCosine: number;
}
