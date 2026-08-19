export interface SessionSummary {
  session_ref: string;
  tool: string;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  preview?: string;
  source_path?: string;
  score?: number;
  retrieval?: SessionSearchMode;
  matches?: RetrievalMatch[];
}

export interface SessionMessage {
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  source_pointer?: string;
}

export interface HandoffStatus {
  project_root: string;
  db_path: string;
  last_scan_at: string | null;
  sessions: number;
  messages: number;
  retrieval_units: number;
  vectorized_units: number;
  vector_model: string;
  /** Last semantic-search failure, or null. Non-null means hybrid search is
   *  silently answering from keyword only. */
  embedding_error: string | null;
  tools: Array<{
    tool: string;
    detected: boolean;
    last_error: string | null;
    store_paths: string[];
    indexed_sessions: number;
    indexed_messages: number;
    last_indexed_at: string | null;
  }>;
}

export interface SessionService {
  listRecentSessions(limit: number, toolFilter?: string[]): Promise<SessionSummary[]>;
  getSessionByRef(sessionRef: string): Promise<SessionSummary | null>;
  getSessionDetail(sessionRef: string, offset: number, limit: number): Promise<SessionMessage[]>;
  searchSessions(
    query: string,
    limit: number,
    toolFilter?: string[],
    mode?: SessionSearchMode,
  ): Promise<SessionSummary[]>;
  getStatus(): Promise<HandoffStatus>;
  close(): Promise<void>;
}

export type SessionSearchMode = "hybrid" | "keyword" | "vector";

export interface RetrievalMatch {
  unit_id: string;
  message_start_index: number;
  message_end_index: number;
  started_at: string;
  ended_at: string;
  preview: string;
  score: number;
  semantic_score?: number;
  keyword_score?: number;
  recency_score: number;
  continuity_score: number;
}
