-- Unified PostgreSQL 17 + pgvector >= 0.8 schema for xtctx-cloud.
-- Applied sequentially and tracked in schema_migrations.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- System / identity / OAuth tables (accessed via withSystemDb).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately NOT foreign-keyed with ON DELETE CASCADE to users:
-- revocations and delete-my-data epochs must survive account deletion so
-- pre-deletion JWTs stay dead if the same GitHub account returns later.
CREATE TABLE IF NOT EXISTS token_epochs (
  user_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_pending_auth (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cookie_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending_auth (expires_at);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens (user_id);

-- Tenant tables (protected by PostgreSQL Row-Level Security).
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_ref TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  project_root TEXT NOT NULL,
  git_branch TEXT,
  git_commit TEXT,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_activity
  ON sessions (user_id, last_activity_at DESC, session_ref ASC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_repo_activity
  ON sessions (user_id, repo_url, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS session_projects (
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  device_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  PRIMARY KEY (session_ref, repo_url, device_id)
);

CREATE INDEX IF NOT EXISTS idx_session_projects_lookup
  ON session_projects (user_id, repo_url, session_ref);

-- Lossless UTF-8 bytes allow embedded NUL (\0) preservation; Postgres TEXT/JSONB reject 0x00.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  role TEXT NOT NULL,
  content_bytes BYTEA NOT NULL,
  content_chars INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_raw TEXT NOT NULL DEFAULT '{}',
  search_tsv TSVECTOR NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_order
  ON messages (session_ref, message_index ASC, timestamp ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_messages_user_session
  ON messages (user_id, session_ref);
CREATE INDEX IF NOT EXISTS idx_messages_search_tsv
  ON messages USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_messages_metadata_gin
  ON messages USING GIN (metadata);

CREATE TABLE IF NOT EXISTS message_chunks (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_start INTEGER NOT NULL,
  chunk_len INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  model TEXT NOT NULL,
  embedding halfvec(384) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, model, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_message_chunks_embedding_hnsw
  ON message_chunks USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_message_chunks_user_model
  ON message_chunks (user_id, model, message_id);

CREATE TABLE IF NOT EXISTS embedding_jobs (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embedding_jobs_pending
  ON embedding_jobs (next_attempt_at ASC);

CREATE TABLE IF NOT EXISTS uploads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  repo_url TEXT NOT NULL,
  project_name TEXT NOT NULL,
  last_upload_at TIMESTAMPTZ NOT NULL,
  client_version TEXT,
  PRIMARY KEY (user_id, device_id, repo_url)
);

CREATE INDEX IF NOT EXISTS idx_uploads_user_last
  ON uploads (user_id, last_upload_at DESC);

CREATE TABLE IF NOT EXISTS source_coverage (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  device_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL,
  discovered_sessions BIGINT,
  indexed_sessions BIGINT,
  indexed_messages BIGINT,
  excluded_records BIGINT,
  notes TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, source)
);

CREATE TABLE IF NOT EXISTS coverage_evidence (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  device_name TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, source, scope, kind)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  price_id TEXT,
  current_period_end BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer
  ON subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription
  ON subscriptions (stripe_subscription_id);

-- Enforce Row-Level Security on every tenant-owned table.
-- Non-owner application role (DATABASE_APP_ROLE / xtctx_app) is subject to RLS,
-- while table-owner migrations and system auth/webhook/worker transactions can run via withSystemDb.
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON devices;
CREATE POLICY tenant_isolation ON devices
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON session_projects;
CREATE POLICY tenant_isolation ON session_projects
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON messages;
CREATE POLICY tenant_isolation ON messages
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON message_chunks;
CREATE POLICY tenant_isolation ON message_chunks
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON embedding_jobs;
CREATE POLICY tenant_isolation ON embedding_jobs
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON uploads;
CREATE POLICY tenant_isolation ON uploads
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON source_coverage;
CREATE POLICY tenant_isolation ON source_coverage
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON coverage_evidence;
CREATE POLICY tenant_isolation ON coverage_evidence
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
CREATE POLICY tenant_isolation ON subscriptions
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
