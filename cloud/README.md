# xtctx-cloud

The optional sync server behind [xtctx cloud sync](../docs/cloud-sync.md): a unified **Node 24 + PostgreSQL 17 (`pgvector >= 0.8`)** service that stores redacted transcripts uploaded by opted-in projects, serves them back over Streamable HTTP MCP and the web dashboard, and computes async embeddings via a built-in Postgres job worker.

Run the same container image via `docker compose up -d` for self-hosting or deploy `api` + `worker` against Managed PostgreSQL with `DATABASE_URL`. Nothing leaves your machine unless you log in (`xtctx login --sync-url <url>`) **and** opt a project in (`xtctx sync enable`).

## Quick start (Docker Compose)

```bash
cd cloud
export JWT_SECRET="$(openssl rand -base64 48)"
export ALLOWED_GITHUB_IDS="<your numeric github id>"
docker compose up -d
```

To also run the background embedding worker container:

```bash
docker compose --profile worker up -d
```

The compose stack boots:
- `postgres`: `pgvector/pgvector:pg17` with the `xtctx_app` (`NOBYPASSRLS`) role initialized by `docker/init-app-role.sql`.
- `api`: Node 24 HTTP server (`dist/server.mjs`) running migrations on startup, serving MCP, `/api/*`, OAuth 2.1, `/dashboard`, and Stripe billing webhooks.
- `worker` (`--profile worker`): async embedding queue consumer (`dist/worker.mjs`) using PostgreSQL `FOR UPDATE SKIP LOCKED`.

## What it serves

| Route | Who calls it | Auth |
|---|---|---|
| `POST /mcp` | MCP clients (Streamable HTTP; `2026-07-28`, `2025-11-25`, `2025-06-18`) | OAuth access token (`read`) or scoped bearer token (`read`) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | MCP OAuth 2.1 resource metadata | none |
| `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token`, `/authorize`, `/oauth/github/callback` | MCP OAuth 2.1 authorization server + dashboard login | PKCE S256 required |
| `GET /dashboard`, `/dashboard/api/*` | Archive browser, connect tokens, billing | GitHub OAuth cookie (`SameSite=Strict`) |
| `POST /auth/device/code`, `POST /auth/device/poll` | `xtctx login` (GitHub Device Flow) | none |
| `POST /api/stream`, `GET /api/sync-capabilities` | `xtctx sync` & browser extension | CLI/sync token (`sync:write`) |
| `POST /api/coverage` | v1/v2 source coverage receipts | Sync token (`sync:write`) with device id |
| `POST /api/tokens` | `xtctx sync token` | Sync token (`sync:write`) -> `read`-only token |
| `POST /auth/logout`, `DELETE /api/me` | `xtctx logout [--delete-data]` | CLI token (`account:delete` for deletion) |
| `POST /api/stripe/webhook` | Stripe webhooks | `Stripe-Signature` HMAC-SHA256 |
| `GET /health` | Health check | none (`X-Xtctx-Server-Version` header on all responses) |

## Authentication, RLS & Durability

- **PostgreSQL Row-Level Security:** Every tenant table enables RLS (`user_id = current_setting('app.user_id', true)`). Authenticated user queries run inside `withUserDb` using `SET LOCAL ROLE ${DATABASE_APP_ROLE}` (e.g. `xtctx_app`, `NOBYPASSRLS`) and transaction-local `set_config('app.user_id', ...)`.
- **Durable `token_epochs`:** `POST /auth/logout` and `DELETE /api/me` increment the account's epoch without cascading on `users` deletion, so prior JWTs and refresh tokens remain revoked even if the same GitHub account returns later.
- **Account deletion & Stripe fail-closed:** `DELETE /api/me` and `DELETE /dashboard/api/account` cancel any active Stripe subscription before deleting user data and fail with `502` if Stripe cannot be reached.
- **Lossless message storage:** Raw UTF-8 message payloads are stored in `messages.content_bytes` (`BYTEA`) alongside `content_chars` for surrogate-pair paging and embedded `\0` preservation, while `search_tsv` and GIN-indexed `metadata` (`JSONB`) are scrubbed of NULs.

## Hybrid Search & Embeddings

`EMBEDDING_PROVIDER` selects the embedding backend:
- `local` (default): `Xenova/bge-small-en-v1.5` (384-dim `halfvec(384)`, FP32 via `@huggingface/transformers`). Runs locally in Node with zero external AI API calls.
- `openai`: calls an OpenAI-compatible embeddings endpoint (`EMBEDDING_API_URL`, optional `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`) returning 384-dim vectors.
- `none`: disables embeddings cleanly; lexical (`to_tsvector('simple')`) search stays active and `hybrid` reports explicit lexical fallback.

Vector search queries `message_chunks` (`halfvec(384)`) with `pgvector >= 0.8` HNSW (`halfvec_cosine_ops`) using `SET LOCAL hnsw.iterative_scan = relaxed_order` and `ef_search = 80`, then fuses lexical + dense rankings with Reciprocal Rank Fusion (`k = 60`).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` / `DATABASE_URL_FILE` | PostgreSQL 17 connection string (required) | — |
| `DATABASE_APP_ROLE` | Non-owner `NOBYPASSRLS` role for `withUserDb` | unset (`xtctx_app` in compose) |
| `PUBLIC_URL` | Canonical origin (`https://...` outside localhost) | `http://localhost:8788` |
| `JWT_SECRET` / `JWT_SECRET_FILE` | HS256 signing secret (>= 32 chars, required) | — |
| `ALLOWED_GITHUB_IDS` | Comma-separated numeric GitHub IDs (required unless `STRIPE_SECRET_KEY` set) | unset |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App credentials (Device Flow + `/authorize` / `/dashboard`) | unset |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed for CORS (e.g. Chrome extension) | unset |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | Optional Stripe checkout, portal & webhook gating | unset |
| `HOSTED_MESSAGE_QUOTA` | Per-account message quota for non-allowlisted paid users | `100000` |
| `MAX_UPLOAD_BODY_BYTES` / `MAX_UPLOAD_MESSAGE_BYTES` | Override `/api/stream` body/message byte caps | `8 MiB` / `4 MiB` |
| `EMBEDDING_PROVIDER` | `local`, `openai`, or `none` | `local` |
| `HOST` / `PORT` | Bind address and HTTP port | `127.0.0.1` (`0.0.0.0` in Docker) / `8788` |

## Build, CLI & Tests

```bash
cd cloud
npm ci
npm run build         # bundles dist/server.mjs, dist/worker.mjs, migrations/, dashboard/
npm run typecheck
npm test              # unit tests (no DB required)

# Real-Postgres integration tests (requires pgvector/pgvector:pg17)
TEST_DATABASE_URL=postgresql://xtctx:xtctx@127.0.0.1:5432/xtctx npm run test:integration
```

Server CLI commands (`node dist/server.mjs <command>`): `serve` (default), `worker`, `migrate`, `token`, `revoke`.
