# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Landing Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml)
[![Release Please](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/release-please.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx is local cross-tool handoff for AI coding agents.

It configures your project so the next tool you open can find recent local
transcript sessions and retrieve the raw messages through MCP. It does not run
a daemon, host an API, generate summaries, or maintain durable project memory.

## Workflow

```bash
npx -y xtctx setup
npx -y xtctx status
```

`xtctx setup` detects supported tools, installs MCP config with `npx -y xtctx`,
installs real hooks where a tool supports them, and writes managed instruction
blocks that point agents to the MCP retrieval tools.

`xtctx status` reports actual handoff state: config, MCP command, local SQLite
index, detected transcript stores, hook mode, managed-block drift, and stale
generated references.

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
- Gemini CLI
- Google Antigravity
- opencode
- GitHub Copilot CLI

Each tool has a scraper for local handoff storage. Antigravity support reads
its readable `brain` artifacts because its conversation `.pb` files are not
treated as a stable public transcript format. Some tools have native MCP config
or executable startup hooks; others receive MCP config plus managed instructions
only. `xtctx status` labels the real mode for each integration.

## Project Files

- `.xtctx/config.yaml`: project xtctx configuration
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
```

## Release

Release Please manages versions and changelog. GitHub Releases publish to npm
through OIDC trusted publishing.
