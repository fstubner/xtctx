export interface SearchResultItem {
  id: string;
  text: string;
  metadata: string;
  score: number;
  fusedScore: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
}

export interface KnowledgeRecord {
  id: string;
  type:
    | "decision"
    | "error_solution"
    | "insight"
    | "convention"
    | "gotcha"
    | "faq";
  created_at: string;
  source_tool: string;
  title: string;
  body: string;
  domain_tags: string[];
}

export interface KnowledgeResponse {
  type: string;
  count: number;
  records: KnowledgeRecord[];
}

export interface SourceInfo {
  name: string;
  kind: string;
  path?: string;
  records?: number;
  detected?: boolean;
  tools?: Array<{
    tool: string;
    path: string;
    enabled: boolean;
    detected: boolean;
  }>;
}

export interface SourcesResponse {
  projectRoot: string;
  sources: SourceInfo[];
  sessions: Array<{
    session_ref: string;
    tool: string;
    started_at: string;
    summary?: string;
    message_count?: number;
  }>;
}

export interface SourceStatusResponse {
  ok: boolean;
  knowledgeRecords: number;
  connectedSources: number;
  toolPortabilityReady: boolean;
  scrapers: Array<{
    tool: string;
    path: string;
    enabled: boolean;
    detected: boolean;
  }>;
}

export type ContinuityCategory =
  | "context_feed"
  | "skills"
  | "commands"
  | "agents"
  | "mcp_servers"
  | "slash_commands"
  | "whitelist_policy";

export type ContinuityScope = "project" | "global" | "hybrid";

export type ToolState = "in_sync" | "drifted" | "missing_target" | "disabled_by_policy";

export interface ToolContinuityStatus {
  tool: string;
  scope: ContinuityScope;
  enabled: boolean;
  categories: Record<ContinuityCategory, boolean>;
  state: ToolState;
  warnings: string[];
  targets: Array<{
    path: string;
    exists: boolean;
    managed_block_present: boolean;
    drifted: boolean;
    updated: boolean;
    created: boolean;
    warning?: string;
  }>;
}

export interface ContinuityToolsStatusResponse {
  tools: ToolContinuityStatus[];
}

export interface EffectivePolicyResponse {
  defaults: {
    sync_enabled: boolean;
    categories_enabled: ContinuityCategory[];
    scope: ContinuityScope;
  };
  tools: Record<
    string,
    {
      enabled: boolean;
      scope: ContinuityScope;
      categories: Record<ContinuityCategory, boolean>;
      preferences: Record<string, unknown>;
    }
  >;
  policy: {
    whitelist: {
      allowed_patterns: string[];
      denied_patterns: string[];
      advisory_level: "warn" | "strict-hint";
    };
  };
  source_layers: Array<{
    layer: "global" | "repo";
    path: string;
    loaded: boolean;
  }>;
  resolved_at: string;
}

export interface ContinuityWarningsResponse {
  count: number;
  warnings: Array<{
    tool: string;
    warning: string;
  }>;
}

export interface ConfigListResponse {
  type: string;
  count: number;
  configs: Array<{
    type: "skill" | "command" | "agent";
    name: string;
    content: Record<string, unknown>;
  }>;
}
