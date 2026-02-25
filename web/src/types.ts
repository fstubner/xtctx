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
  type: "decision" | "error_solution" | "insight" | "convention" | "gotcha";
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

export interface ConfigListResponse {
  type: string;
  count: number;
  configs: Array<{
    type: "skill" | "command" | "agent";
    name: string;
    content: Record<string, unknown>;
  }>;
}
