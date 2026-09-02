# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Landing Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-landing.yml)
[![Release](https://github.com/fstubner/xtctx/actions/workflows/release.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/release.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx is local cross-tool handoff for AI coding agents.

It indexes the transcript files your local coding agents already write, and
exposes them over MCP so the next tool you open can find recent sessions and
read the raw messages. It does not run a daemon, host an API, generate
summaries, or maintain durable project memory.

Retrieval needs no per-project setup: point any tool at the MCP server and it
resolves the project from the working directory. `xtctx setup` is the upgrade
that puts the context in front of the agent whether it asks or not.

The intended user is a solo developer who switches between local coding agents
and wants the next agent to recover recent context without a pasted recap.

## Install

Two routes, and they answer different questions.

The **plugin** is the smaller commitment: it registers the MCP server and the
handoff skill, and writes nothing into your project. Retrieval works
immediately — the tools resolve the project from the working directory, so an
unconfigured project still returns its sessions and their raw messages. What
you are relying on is the agent choosing to call a tool, which the skill
prompts it to do.

**`setup`** writes managed blocks into the instruction files each tool already
reads (`CLAUDE.md`, `AGENTS.md`, Cursor rules, and so on), so the next agent
receives the handoff without deciding to ask for it. It also installs the
Claude Code SessionStart hook, wires MCP per tool, and translates the skill
into each tool's native format.

| | Plugin | `setup` |
|---|---|---|
| MCP tools | yes | yes |
| Handoff skill | yes | yes |
| Retrieval in an unconfigured project | yes | yes |
| Context without the agent asking | no | yes |
| SessionStart hook (Claude Code) | no | yes |
| Writes into your project | no | yes |
| Tool coverage | six with a plugin format | every supported tool |

Start with the plugin. Add `setup` in projects where you want the handoff to
be automatic rather than opt-in; the two compose, and running both is the
normal end state.

```bash
npx -y xtctx setup
```

As a plugin, from the marketplace this repository publishes:

```bash
claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx
```

```bash
codex plugin marketplace add fstubner/xtctx && codex plugin add xtctx@xtctx
```

```bash
copilot plugin marketplace add fstubner/xtctx && copilot plugin install xtctx@xtctx
```

```bash
agy plugin install https://github.com/fstubner/xtctx
```

Cursor registers the marketplace from its agent CLI, then installs from
`/plugins` in an interactive session:

```bash
cursor-agent plugin marketplace add https://github.com/fstubner/xtctx
```

VS Code reads the same package but has no CLI route: its plugin management
lives in the Chat view, behind the `chat.plugins.enabled` setting. opencode
has no plugin format yet, so `setup` is the only route there.

Either route registers the same MCP server (`npx -y xtctx`) and the same
handoff skill. Because the plugin writes no project config, `xtctx status`
reports a plugin-only project as `Config missing (run xtctx setup)` — that
line describes the managed blocks and hooks, not the MCP tools, which work
regardless.

One thing to expect on the plugin route: the first call in a project with a
large transcript history builds the index from scratch and can run for
minutes. Calls return within a refresh budget with whatever has landed so
far, and the scan keeps going in the background, so the counts fill in over
the first few calls rather than all at once.

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
supported tool. Antigravity and Copilot CLI keep one MCP config for every
project on the machine, so a project disconnect leaves those two files alone;
pass `--global-mcp` (as with `setup`) to remove xtctx from them as well.

`xtctx scan` reads every enabled transcript store into the project's index and
exits. The MCP server does the same thing on its own every time it starts, so
the session after another tool's work starts with that work already indexed.
The scan is incremental and runs in the background; against a 19 GB Codex
store it measured under ten seconds.

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
  tests and format fingerprints exist to catch parser breakage, but `xtctx status`
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

Nothing is released by merging. Cutting a release is one manual action: run the
**release** workflow, choose `patch`/`minor`/`major`, and type `release` to
confirm. It runs `verify:release` first, then bumps the version, writes the
CHANGELOG entry from GitHub's generated notes, commits, tags, creates the
GitHub release, and publishes to npm.

Untick `publish_npm` to cut a release without publishing. To publish a version
that was tagged earlier, run the **publish** workflow on its own against that
tag — it verifies the checked-out commit really carries the tag for the version
in `package.json`, so a branch tip cannot be published by mistake.

This replaced an automatic pipeline. Every `fix:`/`feat:` merge opened a release
PR that a second workflow auto-merged within seconds, so merging any change at
all cut a release: five versions went out between 09:34 and 16:58 on
2026-08-30, none awaited, none soaked. A per-day ceiling was tried first and was
the wrong shape — capping unwanted releases still leaves them unwanted.

Releases are published rather than drafted, deliberately, and `publish.yml` has
no `release: published` trigger. It had one once, with releases drafted so
nothing published itself, and that broke outright: GitHub's `releases/latest`
endpoint hides drafts, the release tooling read that endpoint to find the last
release, so it saw a pre-draft version forever and proposed a release covering
the entire history. It cut 54 versions in an hour.
