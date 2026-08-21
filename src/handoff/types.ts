export interface SessionSummary {
  session_ref: string;
  tool: string;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  preview?: string;
  source_path?: string;
  /**
   * The branch and commit the session ran on, as the tool recorded them at the
   * time. Absent for tools that do not record it; never inferred from the
   * working tree at index time, which would be a different branch entirely.
   */
  git_branch?: string;
  git_commit?: string;
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
  listRecentSessions(
    limit: number,
    toolFilter?: string[],
    branchFilter?: string[],
  ): Promise<SessionSummary[]>;
  getSessionByRef(sessionRef: string): Promise<SessionSummary | null>;
  getSessionDetail(sessionRef: string, offset: number, limit: number): Promise<SessionMessage[]>;
  searchSessions(
    query: string,
    limit: number,
    toolFilter?: string[],
    mode?: SessionSearchMode,
    branchFilter?: string[],
  ): Promise<SessionSummary[]>;
  getStatus(): Promise<HandoffStatus>;
  close(): Promise<void>;
  /**
   * What the last answer did not include, if anything.
   *
   * Scanning and vectorizing are both bounded per call so an agent is never
   * left waiting on the whole machine's history. That makes an answer capable
   * of being incomplete, and an incomplete answer presented as a complete one
   * is the worse failure — the agent concludes the history is not there.
   */
  getIndexProgress?(): IndexProgress;
  /**
   * Recent sessions from the index as it already stands, without scanning.
   *
   * `listRecentSessions` will start a scan of every transcript store on the
   * machine and wait several seconds for it. That is the right trade inside a
   * tool call the agent is already waiting on, and the wrong one in the
   * SessionStart hook, which runs before the user's first turn and would add
   * that delay to every agent startup.
   */
  listIndexedSessions?(limit: number): Promise<SessionSummary[]>;
  /**
   * Resolves once no scan is in flight.
   *
   * Serving a tool call deliberately stops waiting for the scan and lets it
   * finish in the background, so a caller that needs the *complete* index —
   * shutdown, or a test asserting that every tool was picked up — has to be
   * able to say so. Without this the only way to wait is to guess a duration,
   * which is a race dressed up as a test.
   */
  whenScanSettled?(): Promise<void>;
}

export interface IndexProgress {
  /** A scan started by an earlier call is still running. */
  scanning: boolean;
  /** Windows indexed but not yet vectorized, so semantic recall is partial. */
  vectorBacklog: number;
  /** The embedding model is still loading, so this answer is keyword-only. */
  embeddingWarming: boolean;
}

export type SessionSearchMode = "hybrid" | "keyword" | "vector";

export interface RetrievalMatch {
  unit_id: string;
  message_start_index: number;
  message_end_index: number;
  started_at: string;
  ended_at: string;
  preview: string;
  /**
   * How similar this window is to the query, on the same absolute scale as the
   * session's score. Absent for keyword-only matches, whose keyword score is
   * reciprocal rank — the top hit is 1.0 whatever it matched.
   */
  score?: number;
  semantic_score?: number;
  keyword_score?: number;
  recency_score: number;
  continuity_score: number;
}
