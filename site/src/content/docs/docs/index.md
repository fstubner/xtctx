---
title: Overview
description: What xtctx does and does not do, which agents it supports, and where its files live.
---

xtctx indexes the transcripts that AI coding agents write on your machine and serves them over MCP. An agent in a project can list recent sessions from every supported agent and read their messages.

## What xtctx does not do

- **Summaries or memory.** xtctx writes no summaries and keeps no memory of its own. The index stores the raw messages in order, and the transcripts stay the source of truth.
- **Background services.** There is no daemon, API server, dashboard or watcher. Each agent starts the MCP server when it needs it, and the server stops when the agent does.
- **Uploads.** Search runs on your machine. Transcript text only leaves it if a project turns on a remote embedding endpoint or [cloud sync](/docs/commands/#cloud-sync), which goes to a server you deploy yourself.

## Supported agents

- Claude Code
- Codex
- Cursor
- GitHub Copilot in VS Code
- GitHub Copilot CLI
- Google Antigravity
- opencode

`xtctx status` shows how each agent is connected: with a startup hook (`executable`, Claude Code only), through its instruction file (`instruction-only`), or through MCP alone (`mcp-only`).

## Files

In each project:

| File | What it holds |
| --- | --- |
| `.xtctx/config.yaml` | Project settings. |
| `.xtctx/skills/<id>/SKILL.md` | Project skills, copied to each agent by setup. |
| `.xtctx/state/xtctx.db` | The index. Setup keeps it out of git with `.xtctx/.gitignore`. |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/xtctx.mdc`, `.github/copilot-instructions.md` | An xtctx section in each agent's instruction file. |

xtctx only edits between `<!-- xtctx:begin -->` and `<!-- xtctx:end -->` in an instruction file, and leaves the rest of the file unchanged.

On the machine, in `~/.xtctx/`:

- `embeddings/`: the local model, after `xtctx embeddings enable`.
- `device.json`: which device embeds fastest.
- `credentials.json`, `cloud-projects.json` and `sync/`: your cloud sync login, the projects that upload, and upload progress. Only there if you use cloud sync.

:::caution
The index holds your raw conversations. Don't commit it.

It can also be the only copy of older sessions. Claude Code deletes transcripts after 30 days by default (its `cleanupPeriodDays` setting), but xtctx keeps what it indexed. Back it up with `xtctx export`.
:::

## Next

| To | See |
| --- | --- |
| Install xtctx and set up a project | [Installation](/docs/install/) |
| Look up a command, option or MCP tool | [Commands](/docs/commands/) |
