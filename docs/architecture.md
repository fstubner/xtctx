# xtctx Architecture

xtctx has one job: reliable local handoff between AI coding tools.

Humans run `xtctx setup` and `xtctx status`. Agents use MCP tools to discover
recent local transcript or handoff-artifact sessions and retrieve raw local
detail on demand. xtctx does not run a background service, web UI,
generated-summary pipeline, or durable memory writeback layer.

The architecture is intentionally scoped to one local developer switching
between coding tools. Shared team memory, cloud sync, telemetry, and hosted
retrieval are outside the product surface.

## Runtime Shape

```text
tool transcript/artifact stores
        |
        v
scrapers -> .xtctx/state/xtctx.db -> MCP tools
                                   -> setup/status diagnostics
```

`.xtctx/state/xtctx.db` is a rebuildable cache. Raw transcript files and
tool-authored handoff artifacts remain authoritative.

Antigravity is the exception to simple file parsing: its `.pb` conversation
files are treated as encrypted/private implementation detail. When Antigravity
is running, xtctx queries the local language-server API for full conversation
steps; when it is not running, xtctx falls back to readable `brain` artifacts.
Setup always writes Antigravity app-level MCP config and a managed `GEMINI.md`
instruction block (Antigravity CLI keeps project-memory compatibility with
that file).

## Setup

`xtctx setup` writes:

- `.xtctx/config.yaml`
- native MCP config using command `npx` and args `["-y", "xtctx"]`
- managed instruction blocks for supported tools
- executable startup hooks only for tools that actually support them
- `.xtctx/skills/<skill-id>/SKILL.md` canonical project skills
- generated skill targets for tools with verified native or adapter surfaces

Managed blocks contain stable retrieval instructions, not generated narrative
summaries.

Interactive setup inventories compatible skills from connected tools and lets
the user select which project skills to sync. Non-interactive setup syncs only
the built-in `xtctx-handoff` skill plus any skills already selected in
`.xtctx/config.yaml`.

## Retrieval

The MCP surface is intentionally small:

- `xtctx_recent_sessions`
- `xtctx_session_detail`
- `xtctx_search_sessions`
- `xtctx_continuity_status`
- `xtctx_handoff_manifest`

`xtctx_recent_sessions` and `xtctx_session_detail` lazily scan local transcript
or artifact stores before returning. `xtctx_search_sessions` searches
chronological transcript windows stored in SQLite. `xtctx_handoff_manifest`
returns a read-only orchestrator envelope with stable session refs and
raw-detail pointers; it does not persist task state.

Startup hooks are lightweight handoff openers. They do not update the local
index unless a future hook explicitly calls a bounded scan path.

Semantic search uses local embeddings over sliding windows of raw transcript
turns. Each embedded window includes the session reference, message range, turn
order, message index, role, timestamp, and raw message content. Retrieval ranks
semantic similarity together with keyword, recency, and continuity signals, then
returns the matched message range so the agent can drill into the raw session.
Vector creation is lazy; if the embedding provider is unavailable during hybrid
search, xtctx falls back to keyword retrieval.

## Storage

The SQLite cache stores:

- transcript sessions
- transcript messages
- FTS rows for keyword search
- chronological retrieval windows
- local embedding vectors as BLOBs
- setup/status metadata

There is no required external database. Existing cache state can be deleted and
rebuilt from source transcripts.

## Drift And Limits

Tool transcript stores are private implementation details of the upstream tools.
Each scraper tolerates known benign changes, warns on surprising record shapes,
and is covered by fixture, mutation, and drift-canary tests. `xtctx status`
reports what was actually detected and indexed on the current machine.

Antigravity conversation stores are private implementation details. The
scraper reads full conversation steps from the local Antigravity language
server when it is available, and otherwise falls back to readable handoff
artifacts.
