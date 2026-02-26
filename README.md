# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Release Please](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

Cross-tool context for AI coding agents.

xtctx is a local-first context layer that ingests session history and project knowledge, then exposes it consistently through:

- MCP tools (for agents)
- HTTP API (`/api/*`)
- bundled web UI (`/`)

## Features

- Multi-tool ingestion support (Claude Code, Codex CLI, Cursor, Copilot, Gemini).
- Hybrid search (semantic + keyword fusion) across indexed context.
- Knowledge repository with auto-tagging and dedup/supersession behavior.
- Config sync for tool-native files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot instructions).
- Single `xtctx serve` runtime with API + web UI + MCP.
- Secure-by-default local API behavior (localhost bind, CORS filtering, optional token auth, rate limiting).

## Quick Start

Install and build:

```bash
npm ci
npm --prefix web ci
npm run build
```

Initialize in your project:

```bash
npx xtctx init
```

Ingest data:

```bash
npx xtctx ingest --full
```

Run services:

```bash
npx xtctx serve
```

Then open:

- Web UI: `http://127.0.0.1:3232/`
- Health: `http://127.0.0.1:3232/health`
- API: `http://127.0.0.1:3232/api/*`

## CLI Commands

- `xtctx init [path]`: scaffold `.xtctx/` config and knowledge structure.
- `xtctx serve [--mcp-only]`: start runtime services.
- `xtctx ingest [--full]`: run ingestion on demand.
- `xtctx sync`: generate/update managed tool-native config sections.

## Configuration (File-First)

xtctx is configured from `.xtctx/config.yaml`. No environment variables are required for normal usage.

Default config:

```yaml
version: "1"
project:
  name: ""
  root: "."
ingestion:
  scrapers: []
  watchPaths: []
  pollIntervalMs: 30000
  excludePatterns:
    - node_modules/**
    - dist/**
compaction:
  strategy: rule-based
  sessionBoundaryMinutes: 30
search:
  defaultMode: hybrid
  defaultDepth: summary
  defaultLimit: 10
domainTags: {}
web:
  port: 3232
api:
  security:
    token: ""
    allowedOrigins: []
    allowLocalhostOrigins: true
    rateLimitWindowMs: 60000
    rateLimitMax: 120
```

`api.security.token` is optional:

- `""` (empty): no API auth required.
- non-empty token: `/api/*` requires `Authorization: Bearer <token>` (or `X-Xtctx-Api-Token`).
- `/health` remains unauthenticated.

Environment variables are optional explicit overrides (useful for temporary local sessions/CI):

- `XTCTX_API_TOKEN`
- `XTCTX_ALLOWED_ORIGINS` (comma-separated)
- `XTCTX_ALLOW_LOCALHOST_ORIGINS` (`true`/`false`)
- `XTCTX_RATE_LIMIT_WINDOW_MS`
- `XTCTX_RATE_LIMIT_MAX`

Example (file-based token):

```yaml
api:
  security:
    token: "change-me-local-token"
```

Then call:

```bash
curl -H "Authorization: Bearer change-me-local-token" http://127.0.0.1:3232/api/sources/status
```

## Security Defaults

- API binds to `127.0.0.1`.
- `/api/*` is rate limited.
- CORS is restricted to localhost/same-origin patterns by default.
- API token auth is available when `api.security.token` is set.

## Development

Run full verification:

```bash
npm run verify:release
```

Run packaging smoke check:

```bash
npm pack --dry-run
```

## Landing Site (GitHub Pages)

- This repo publishes a project Pages site from `landing/`.
- Current URL pattern is `https://fstubner.github.io/xtctx/`.
- This does not take over all `fstubner.github.io/*` paths. Each repo can have its own project path.
- Only the special repository named `fstubner.github.io` controls the root user site (`https://fstubner.github.io/`).
- Custom domains are supported by GitHub Pages (set DNS + Pages custom domain and add `landing/CNAME`).

## Maintainers

- Conventional commits drive release notes/versioning via Release Please.
- Merge release PRs on `main` to create GitHub releases.
- GitHub release publish triggers npm publish with OIDC trusted publishing.
- For contribution expectations, see `CONTRIBUTING.md`.
