# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Landing Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml)
[![Release Please](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx lets you **switch AI coding tools without restarting your project**.

The best AI coding tool today might not be tomorrow's, and usage caps can force a mid-project switch. xtctx makes either move free: decisions, conversation history, and configs travel with the project, locally, across seven supported tools.

It does this by:

1. ingesting local conversation history from every supported tool;
2. injecting a brief of the most-recent session in another tool into each tool's memory file (`CLAUDE.md` / `AGENTS.md` / `.cursor/rules/xtctx-managed.mdc` / etc.) inside a managed block;
3. syncing skills, slash commands, hooks, and MCP servers from one shared config to each tool's native location;
4. exposing the brief and recent-session listings over MCP so an agent that wants more than the brief can drill in.

![xtctx landing page](docs/screenshots/landing-light.png)

## Core Workflow

```text
Init -> Sync -> Serve -> Handoff
```

1. `xtctx init` (or `xtctx onboard` for the interactive wizard) scaffolds `.xtctx/`.
2. `xtctx sync` renders managed continuity blocks into tool-native targets.
3. `xtctx serve` runs the MCP server + API + ingestion daemon, periodically refreshes each tool's handoff brief, and auto-reconciles sync drift.
4. The agent in the next tool you open reads its own memory file natively at session start. The brief is already there. No MCP roundtrip required for the basic handoff.

xtctx is **handoff-scope only** (hours to days). For project-lifetime knowledge — durable decisions, multi-agent shared memory, cross-domain knowledge graphs — pair xtctx with [`construct`](https://github.com/fstubner/construct) (separate project, separate install).

## Quick Start

```bash
npm ci
npm --prefix landing ci
npm run build

npx xtctx init
npx xtctx sync
npx xtctx serve
```

Surfaces:

- API: `http://127.0.0.1:3232/api/*`
- Health: `http://127.0.0.1:3232/health`
- Landing (HTML cheat sheet): `http://127.0.0.1:3232/`
- MCP: stdio (consumed by your AI assistant)

Optional full re-index:

```bash
npx xtctx ingest --full
```

## CLI cheat sheet

xtctx is CLI-first — humans drive it from the terminal, AI assistants drive it
through MCP. Key introspection commands:

| Command | What it does |
|---|---|
| `xtctx status` | One-screen runtime summary: store size, last ingest, per-tool sync state. Reads from disk, works whether or not `xtctx serve` is running. |
| `xtctx context recent [--watch]` | List recent sessions across tools. `--watch` re-renders every 2 seconds; Ctrl+C to exit. |
| `xtctx sync [--diff]` | Reconcile tool-native config files (and refresh the handoff brief in each). With `--diff`, print a unified diff of what would change instead of writing. |
| `xtctx ingest [--full]` | Manually trigger ingestion (incremental by default). |
| `xtctx serve` | Run MCP + API + ingestion daemon. Prints a status block at startup. |

## Practical Cross-Tool Session Pattern

The basic handoff is **automatic** — the brief that `xtctx serve` injects into each tool's memory file is read by the agent natively at session start. No MCP call required. Open the next tool, ask whatever you were going to ask, the agent picks up from where the last tool left off.

When the agent wants more than the brief, three MCP tools are available:

```
xtctx_recent_sessions({ limit: 5 })       # list recent sessions across all tools
xtctx_session_detail({ session_ref, ... }) # full transcript of one session
xtctx_last_session_brief({ current_tool })  # programmatic version of the brief
```

For durable cross-session knowledge (decisions you want to outlive the handoff window, multi-agent shared memory), use [`construct`](https://github.com/fstubner/construct) — xtctx and construct are sibling products with deliberately different time horizons.

## Continuity Policy Model

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

- scope: `project` | `global` | `hybrid`
- categories: Core 7
  - `context_feed`
  - `skills`
  - `commands`
  - `agents`
  - `mcp_servers`
  - `slash_commands`
  - `whitelist_policy`

## Sync + Status Surfaces

### CLI

- `xtctx sync`: manual reconciliation
- `xtctx serve`: startup sync + periodic drift reconciliation

### API

- `GET /api/continuity/effective-policy`
- `GET /api/continuity/tools-status`
- `POST /api/continuity/sync`
- `POST /api/continuity/sync/:tool`
- `PUT /api/continuity/tools/:tool`
- `GET /api/continuity/warnings`

### MCP tools

- `xtctx_recent_sessions` — list recent sessions across tools
- `xtctx_session_detail` — drill into one session's full transcript
- `xtctx_last_session_brief` — programmatic version of the brief
- `xtctx_continuity_status` — per-tool sync state
- `xtctx_effective_policy` — resolved continuity policy
- `xtctx_list_configs` / `xtctx_get_config` / `xtctx_tool_preferences` — config queries

## Config Philosophy

- Primary source: `.xtctx/config.yaml` and `.xtctx/tool-config/shared.yaml`
- Environment variables are override-only for explicit temporary use

Security overrides:

- `XTCTX_API_TOKEN`
- `XTCTX_ALLOWED_ORIGINS`
- `XTCTX_ALLOW_LOCALHOST_ORIGINS`
- `XTCTX_RATE_LIMIT_WINDOW_MS`
- `XTCTX_RATE_LIMIT_MAX`

## Session indexing

xtctx maintains a local 7-day rolling index of recent conversation chunks across all supported tools (LanceDB, BM25 + vector). The brief generator picks the most-recent qualifying session not in the destination tool; `xtctx_recent_sessions` and `xtctx_session_detail` expose the same index for agents that want to dig deeper than the brief.

### Session cache

The runtime holds a short-lived in-memory index of conversation sessions for
`xtctx_recent_sessions`. The cache is refreshed:

1. **Automatically** — entries expire after 60 seconds (configurable).
2. **On write** — any ingestion cycle that produces new data immediately
   invalidates the cache, so the next read reflects the new messages without
   waiting for the TTL.

## Project Layout

- `src/`: CLI, API, MCP, ingestion, storage, sync engine
- `landing/`: public site deployed via GitHub Pages
- `tests/`: unit/integration/security suites

## Development + Release

```bash
npm run verify:release
```

Release automation:

- Conventional commits -> Release Please release PR
- Merge release PR on `main` -> GitHub Release
- Published GitHub release -> npm publish (OIDC trusted publishing)

See `CONTRIBUTING.md` and `SECURITY.md` for contributor and security policy details.
