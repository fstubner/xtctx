import type { Pool } from "pg";

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface UploadLimits {
  maxBodyBytes: number;
  maxMessageBytes: number;
  maxMetadataBytes: number;
  maxSessionsPerRequest: number;
  maxMessagesPerRequest: number;
}

export interface DashboardAssets {
  html: string;
  css: string;
  js: string;
}

export interface CloudContext {
  pool: Pool;
  appRole?: string;
  embedder: Embedder | null;
  embedOnUpload?: boolean;
  embedOnUploadMaxJobs?: number;
  embedOnUploadBudgetMs?: number;
  publicUrl: string;
  jwtSecret?: string;
  githubClientId: string;
  githubClientSecret?: string;
  allowedGithubIds?: string;
  allowedOrigins?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
  hostedMessageQuota?: number;
  uploadLimits: UploadLimits;
  dashboardAssets?: DashboardAssets;
}

export interface AuthUser {
  userId: string;
  username: string;
  deviceId?: string;
}

/** The MCP tools. */
export const SCOPE_READ = "read";
/** POST /api/stream, POST /api/coverage, POST /api/tokens. */
export const SCOPE_SYNC_WRITE = "sync:write";
/** DELETE /api/me. Only the CLI's own login carries it. */
export const SCOPE_ACCOUNT_DELETE = "account:delete";

export interface SessionRecord {
  session_ref: string;
  user_id: string;
  device_id: string;
  device_name?: string | null;
  tool: string;
  source_session_id: string;
  repo_url: string;
  project_root: string;
  git_branch: string | null;
  git_commit: string | null;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  preview: string | null;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  session_ref: string;
  tool: string;
  source_session_id: string;
  timestamp: string;
  role: string;
  content: string;
  message_index: number;
  content_hash: string;
  metadata_json: string;
  indexed_at: string;
}
