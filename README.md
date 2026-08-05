# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Landing Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml)
[![Release Please](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx is local cross-tool handoff for AI coding agents.

It configures your project so the next tool you open can find recent local
transcript sessions and retrieve the raw messages through MCP. It does not run
a daemon, host an API, generate summaries, or maintain durable project memory.

The intended user is a solo developer who switches between local coding agents
and wants the next agent to recover recent context without a pasted recap.

## Workflow

```bash
npx -y xtctx setup
npx -y xtctx status
npx -y xtctx disconnect antigravity
```

`xtctx setup` writes project-level MCP config with `npx -y xtctx`, installs
real hooks where a tool supports them, and writes managed instruction blocks
that point agents to the MCP retrieval tools. It also syncs selected project
skills from `.xtctx/skills` into verified native or adapter surfaces for
supported tools. Antigravity MCP is always written to the app-level config
because Antigravity has no project MCP file. Use `xtctx setup --global-mcp`
to also configure the global-only GitHub Copilot CLI surface.

`xtctx status` reports actual handoff state: config, MCP command, local SQLite
index, detected transcript stores, hook mode, managed-block drift, and stale
generated references. It also reports selected skills, generated skill targets,
target drift, and tools that do not have a verified skill surface.
It reports the current local cache rather than forcing a transcript scan. If
the index is empty, ask a configured agent to call `xtctx_recent_sessions`.

`xtctx disconnect <tool>` stops xtctx from managing one tool for the project.
It removes the xtctx MCP entry for that tool, removes managed instruction
blocks where that tool owns them, removes supported startup hooks, and marks the
tool disabled in `.xtctx/config.yaml`. It removes generated skill adapters for
that tool. It does not delete transcript sources, canonical project skills, or
the local SQLite cache. Use `xtctx disconnect --all` to remove xtctx from every
supported tool. Antigravity stores MCP config at app level, so
`xtctx disconnect antigravity` removes the xtctx entry from Antigravity for the
current user account.

Generated MCP clients should use:

```json
{
  "mcpServers": {
    "xtctx": {
      "command": "npx",
      "args": ["-y", "xtctx"]
    }
  }
}
```

When invoked by an MCP client over stdio, bare `xtctx` starts the MCP server.
When invoked in a normal terminal, it shows the human CLI.

## MCP Tools

- `xtctx_recent_sessions` lists recent indexed transcript sessions.
- `xtctx_session_detail` returns raw messages for a `session_ref`.
- `xtctx_search_sessions` hybrid-searches chronological transcript windows with local semantic vectors plus keyword fallback.
- `xtctx_continuity_status` reports wiring and local index diagnostics.
- `xtctx_handoff_manifest` returns a read-only orchestrator envelope with stable
  session handoff IDs and pointers to raw-detail retrieval. A caller can attach
  a correlation ID; xtctx echoes it but does not persist task state.

The MCP tools scan transcript stores lazily and update `.xtctx/state/xtctx.db`
on demand. The database is a rebuildable cache; the source transcripts remain
authoritative.

Semantic search embeds sliding windows of raw transcript turns, not generated
summaries. Window text includes role, timestamp, and message order so retrieval
can prefer the relevant point in the conversation, then return the matching
message range for `xtctx_session_detail`.

## Supported Tools

- Claude Code
- Cursor
- Codex
- GitHub Copilot
- Google Antigravity
- opencode
- GitHub Copilot CLI

Each tool has a scraper for local handoff storage. Antigravity support reads
full transcript steps from the running local Antigravity language server when
it is available, and falls back to readable `brain` artifacts when the encrypted
`.pb` conversation store cannot be queried. Setup writes Antigravity MCP config
and a managed `GEMINI.md` handoff block (Antigravity CLI keeps project-memory
compatibility with that file). Some tools have native MCP config or executable
startup hooks; others receive MCP config plus managed instructions only.
`xtctx status` labels the real mode for each integration.

## Limits

- xtctx is local-only. It does not upload transcripts or run telemetry.
- Transcript formats belong to each upstream tool and can drift. The drift
  tests and nightly canary exist to catch parser breakage, but `xtctx status`
  is still the source of truth for your machine.
- Semantic search is lazy. The first semantic or hybrid query may initialize
  the local embedding provider and create local vectors; hybrid search falls
  back to keyword search if vector generation is unavailable.
- Antigravity conversation `.pb` files are not parsed directly; retrieval uses
  the local language-server API when available, otherwise readable `brain`
  artifacts.

## Skill Sync

Project skills live in `.xtctx/skills/<skill-id>/SKILL.md`. Fresh setup writes
the built-in `xtctx-handoff` skill. Interactive setup also inventories skills
from connected tool surfaces and lets you select which ones to keep in sync for
the project. Non-interactive `xtctx setup --yes` is conservative: it syncs the
built-in skill plus any skills already selected in `.xtctx/config.yaml`.

Skill sync uses real target surfaces only:

- Claude Code receives native project skills under `.claude/skills/`.
- Cursor receives generated rule adapters under `.cursor/rules/xtctx-skills/`.
- GitHub Copilot receives generated instruction adapters under `.github/instructions/`.
- Antigravity, Codex, opencode, and Copilot CLI receive skill pointers through
  managed handoff blocks (`GEMINI.md` / `AGENTS.md` / Copilot instructions).
- Tools without a verified native or adapter surface are reported as unsupported.

## Project Files

- `.xtctx/config.yaml`: project xtctx configuration
- `.xtctx/skills/<skill-id>/SKILL.md`: canonical local project skills
- `.xtctx/state/xtctx.db`: local handoff cache, never commit
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/xtctx.mdc`, `.github/copilot-instructions.md`: managed handoff instructions where applicable

Content outside `<!-- xtctx:begin -->` / `<!-- xtctx:end -->` fences is
preserved. Run `xtctx setup --repair` to replace stale or duplicated generated
blocks.

## Development

```bash
npm ci
npm --prefix landing ci
npm run verify:release
```

Useful focused checks:

```bash
npm test
npm run test:drift
npm run lint
npm run build
npm run demo:public
```

`npm run demo:public` creates synthetic Claude Code and Codex transcript stores
in a temporary project, starts the built MCP server, and calls the public
handoff tools. It does not scan private local transcript directories. See
[`docs/demo.md`](docs/demo.md).

## Orchestrator Integration

xtctx is supporting fabric, not an orchestrator. An external control plane can
call `xtctx_handoff_manifest` to obtain project-scoped handoff IDs and the
corresponding `xtctx_session_detail` calls, then retain its own task, branch,
ownership, and scheduling state. See
[`docs/orchestrator-integration.md`](docs/orchestrator-integration.md).

## Release

Release Please manages versions and changelog. GitHub Releases publish to npm
through OIDC trusted publishing.
