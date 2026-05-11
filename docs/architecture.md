# xtctx Architecture

xtctx has one job: reliable local handoff between AI coding tools.

Humans run `xtctx setup` and `xtctx status`. Agents use MCP tools to discover
recent local transcript or handoff-artifact sessions and retrieve raw local
detail on demand. xtctx does not run a background service, web UI,
generated-summary pipeline, or durable memory writeback layer.

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

## Setup

`xtctx setup` writes:

- `.xtctx/config.yaml`
- native MCP config using command `npx` and args `["-y", "xtctx"]`
- managed instruction blocks for supported tools
- executable startup hooks only for tools that actually support them

Managed blocks contain stable retrieval instructions, not generated narrative
summaries.

## Retrieval

The MCP surface is intentionally small:

- `xtctx_recent_sessions`
- `xtctx_session_detail`
- `xtctx_search_sessions`
- `xtctx_continuity_status`

`xtctx_recent_sessions` and `xtctx_session_detail` lazily scan local transcript
or artifact stores before returning. `xtctx_search_sessions` searches
chronological transcript windows stored in SQLite.

Semantic search uses local embeddings over sliding windows of raw transcript
turns. Each embedded window includes the session reference, message range, turn
order, message index, role, timestamp, and raw message content. Retrieval ranks
semantic similarity together with keyword, recency, and continuity signals, then
returns the matched message range so the agent can drill into the raw session.

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
