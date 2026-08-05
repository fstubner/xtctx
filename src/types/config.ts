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
}

export interface ToolConfig {
  enabled?: boolean;
  storePath?: string;
  hook?: "executable" | "instruction-only" | "mcp-only";
}
