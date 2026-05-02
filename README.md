# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Landing Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml)
[![Release Please](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

> Cross-tool memory and config sync for AI coding agents. Local-first.
> One searchable index of your project history across seven tools, plus
> a single shared config rendered into each tool's native files.

xtctx (short for **cross-tool context**, with `ctx` taken from the Python
variable convention) is a CLI + MCP server that does two things across the
AI coding tools you actually use:

1. **Reads** each tool's local conversation history into one searchable
   index (LanceDB, BM25 + vector via Reciprocal Rank Fusion).
2. **Writes** one shared config (skills, hooks, slash commands, MCP
   servers, whitelist policy) into each tool's native files inside
   fenced markers.

Result: switch between AI coding tools without re-pasting decisions or
re-configuring setup. Everything stays on your machine. No account, no
telemetry, no outbound calls during normal operation.

![xtctx landing page](docs/screenshots/landing-light.png)

## Supported tools

xtctx reads conversation history from and writes shared config into seven
AI coding tools:

| Tool | Memory file (instructions) | Native MCP destination |
|---|---|---|
| **Claude Code** | `CLAUDE.md` (project) · `~/.claude/CLAUDE.md` (global) | `.mcp.json` |
| **Cursor** | `.cursorrules` (project) · `~/.cursor/rules/.cursorrules` (global) | `.cursor/mcp.json` |
| **GitHub Copilot** (VS Code) | `.github/copilot-instructions.md` | `.vscode/mcp.json` (root key: `servers`) |
| **GitHub Copilot CLI** | `.github/copilot-instructions.md` (shared with VS Code) | `~/.copilot/mcp-config.json` (user-level) |
| **Codex CLI** | `AGENTS.md` (shared with opencode) · `~/.codex/AGENTS.md` (global) | `~/.codex/config.toml` (TOML, `[mcp_servers.<name>]`) |
| **Gemini CLI** | `GEMINI.md` (project) · `~/.gemini/GEMINI.md` (global) | `~/.gemini/settings.json` (`mcpServers`) |
| **opencode** (sst/opencode-ai) | `AGENTS.md` (shared with Codex) · `~/.config/opencode/AGENTS.md` (global) | `opencode.json` (nested `mcp` key, `command` as array) |

Hand-edits outside the managed markers are preserved verbatim. `xtctx
serve` reconciles drift on a timer if a tool overwrites a managed
section.

## Install

End-user (most cases):

```bash
npm install -g xtctx        # requires Node >= 20
xtctx init                  # scaffolds .xtctx/ in your project
xtctx serve                 # starts MCP + API + ingestion daemon
```

That's it. The first time you run `xtctx serve`, it downloads a ~28 MB
embedding model from HuggingFace; subsequent starts are fast.

Optional one-time full re-index (rebuilds LanceDB from every conversation
file the scrapers can find):

```bash
xtctx ingest --full
```

## Quick session pattern

The MCP tools that follow are calls **your AI assistant makes** (driven
through the MCP protocol), not shell commands. `xtctx sync` generates a
`SessionStart` hook for Claude Code that fires the recall calls
automatically; for the other tools, ask the assistant to run them or
configure their equivalent session-opener mechanism.

**Before coding** — recall:
```
xtctx_search("auth error after last deploy")
xtctx_project_knowledge({ type: "all" })
```

**After coding** — write outcomes back so the next handoff has them:
```
xtctx_save_decision({ title, rationale, alternatives_considered })
xtctx_save_error_solution({ error, solution, context })
xtctx_save_faq({ question, answer })
```

That's the cross-tool handoff loop.

## CLI cheat sheet

xtctx is CLI-first — humans drive it from the terminal, AI assistants
drive it through MCP. Key introspection commands:

| Command | What it does |
|---|---|
| `xtctx status` | One-screen runtime summary: store size, last ingest, per-tool sync state. Reads from disk; works whether or not `xtctx serve` is running. |
| `xtctx context recent [--watch]` | List recent sessions across tools. `--watch` re-renders every 2s; Ctrl+C to exit. |
| `xtctx knowledge ls [--type=...] [--query="..."] [--limit=N]` | List structured knowledge records (decisions, error solutions, gotchas, FAQs, etc.) as a table. |
| `xtctx search "..."` | Hybrid (BM25 + vector) search across the whole index. |
| `xtctx sync [--diff]` | Reconcile tool-native config files. `--diff` prints a unified diff of what would change instead of writing. |
| `xtctx ingest [--full]` | Manually trigger ingestion (incremental by default). |
| `xtctx ingest --rebuild-tool <name>` | Wipe one tool's chunks from the store and re-ingest cleanly. Useful after the chunk-ID scheme changes between versions. |
| `xtctx serve` | Run MCP + API + ingestion daemon. Prints a status block at startup. |

## Surfaces (when `xtctx serve` is running)

- **MCP**: stdio (consumed by your AI assistant via the standard MCP transport)
- **API**: `http://127.0.0.1:3232/api/*`
- **Health**: `http://127.0.0.1:3232/health`
- **Status page**: `http://127.0.0.1:3232/` — single static HTML cheat sheet, replaces the older Vue SPA

## Continuity policy model

Repo policy lives in:

```text
.xtctx/tool-config/shared.yaml
```

Optional global baseline:

```text
~/.xtctx/global-policy.yaml
```

Merge order:

1. global baseline
2. repo policy
3. runtime overrides (future)

Per-tool controls:

- `scope`: `project` | `global` | `hybrid`
- categories (the seven that map to managed-block content):
  - `context_feed`
  - `skills`
  - `commands`
  - `agents`
  - `mcp_servers`
  - `slash_commands`
  - `whitelist_policy`

## Sync surfaces

### CLI

- `xtctx sync` — manual reconciliation
- `xtctx sync --diff` — preview without writing
- `xtctx serve` — startup sync + periodic drift reconciliation

### API

- `GET /api/continuity/effective-policy`
- `GET /api/continuity/tools-status`
- `POST /api/continuity/sync`
- `POST /api/continuity/sync/:tool`
- `PUT /api/continuity/tools/:tool`
- `GET /api/continuity/warnings`

### MCP tools

- `xtctx_continuity_status`
- `xtctx_effective_policy`
- Plus all recall (`xtctx_search`, `xtctx_project_knowledge`,
  `xtctx_recent_sessions`, `xtctx_session_detail`) and writeback
  (`xtctx_save_decision`, `xtctx_save_error_solution`, `xtctx_save_faq`,
  `xtctx_save_insight`, `xtctx_save_convention`, `xtctx_save_gotcha`)
  tools.

## Knowledge types

xtctx stores structured records in `.xtctx/knowledge/*`:

- `decision`
- `error_solution`
- `insight`
- `convention`
- `gotcha`
- `faq`

## Search

`xtctx_search` (MCP), `xtctx search` (CLI), and `GET /api/search` (HTTP)
all use the same **LanceDB hybrid search pipeline** (vector + full-text,
Reciprocal Rank Fusion):

- `hybrid` (default) — fuses semantic and keyword rankings
- `semantic` — embedding vector similarity only
- `keyword` — full-text search (FTS) only

The first search in a new server process may be slower while the
embedding model loads lazily.

### Session cache

The runtime holds a short-lived in-memory index of conversation sessions
for `xtctx_recent_sessions`. The cache is refreshed:

1. **Automatically** — entries expire after 60 seconds (configurable).
2. **On write** — any ingestion cycle that produces new data invalidates
   the cache, so the next read reflects the new messages without waiting
   for the TTL.

## Config philosophy

- Primary source: `.xtctx/config.yaml` and `.xtctx/tool-config/shared.yaml`
- Environment variables are override-only for explicit temporary use

Security overrides:

- `XTCTX_API_TOKEN` — require Bearer auth on the HTTP API
- `XTCTX_ALLOWED_ORIGINS` — CORS allowlist
- `XTCTX_ALLOW_LOCALHOST_ORIGINS` — allow `http://localhost:*` / `http://127.0.0.1:*`
- `XTCTX_RATE_LIMIT_WINDOW_MS` — rate limit window
- `XTCTX_RATE_LIMIT_MAX` — max requests per window

## Drift resilience

Each scraper carries an `ACCEPTED_DEGRADATIONS` whitelist documenting
which schema-shape surprises are tolerated silently and which throw or
warn loudly. Format drift in any of the seven tools surfaces as either:

- A failing test in `tests/drift/scraper-mutations.test.ts` (synthetic
  mutation suite that runs on every CI build), or
- A failing run of `.github/workflows/drift-canary.yml` (nightly job
  that exercises the live CLIs of Claude Code, Codex, Gemini, opencode,
  and Copilot CLI against actual current releases).

Cursor and VS Code Copilot are GUI-only and are covered by mutation +
golden-snapshot tests, not the live canary.

## Troubleshooting

**`xtctx ingest` runs but produces zero chunks.** No supported tool's
storage was found. `xtctx status` reports per-tool detection state. If a
tool is installed but xtctx didn't find it, the storage path may be
non-default — set a `customStorePath` per tool under `.xtctx/config.yaml`.

**First `xtctx serve` startup takes ~30 seconds.** Expected — the
~28 MB embedding model is downloading. You'll see
`[xtctx] Loading embedding model (first run may download ~28 MB)...` on
stderr; subsequent starts are <2s.

**Sync overwrites my hand-edits.** It shouldn't. Hand-edits *outside*
the `xtctx:begin` / `xtctx:end` fenced markers are preserved verbatim;
edits *inside* the markers will be reconciled away on the next
`xtctx serve` tick (this is the drift-reconciliation feature, by
design). If a managed block is in the wrong place, edit the block
content yourself, then move it outside the markers — `xtctx sync` will
write a fresh block at the marker location and your moved copy stays.

**`better-sqlite3` MODULE_VERSION mismatch.** Native module compiled for
a different Node version than the one currently running. Run
`npm rebuild better-sqlite3` once after switching Node versions.

**Cross-tool recall returns nothing for a tool I know I used.** Check
`xtctx context recent --tool <name>` — does that tool's history show
up? If yes, the search index may be stale; run `xtctx ingest --full`.
If no, the scraper isn't finding the storage; check
`xtctx status`.

## Project layout

- `src/scrapers/` — per-tool conversation history readers (one file per tool).
- `src/config/` — sync engine, MCP renderers, hooks, skills, policy.
- `src/runtime/` — ingestion daemon, scraper registry, session cache.
- `src/mcp/` — MCP server + per-tool handlers.
- `src/api/` — HTTP API + static status page.
- `src/cli/` — CLI entry points (`init`, `sync`, `serve`, `ingest`,
  `compact`, `status`, `context`, `knowledge`).
- `landing/` — public site deployed via GitHub Pages.
- `tests/` — unit, integration, smoke, drift, eval, security suites.

## Development + release

```bash
npm ci
npm --prefix landing ci
npm run build
npm test                    # unit + integration
npm run test:smoke          # cross-tool subprocess smoke tests
npm run test:drift          # mutation + snapshot drift tests
npm run test:eval           # ranking eval against the synthetic corpus
npm run verify:release      # everything end-to-end
```

Release automation:

- Conventional commits → release-please opens a release PR.
- Merging the release PR on `main` → tagged GitHub Release.
- Published GitHub release → npm publish via OIDC trusted publishing.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md)
for contributor and security policy details.
