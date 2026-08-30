---
name: xtctx-handoff
description: Retrieve cross-tool handoff context with the xtctx MCP tools. Use when switching AI coding tools, resuming work another agent started, or picking up a project without knowing what was last done in it. Works in any project the tools are available in; no xtctx setup is required.
---

# xtctx Handoff

Use the xtctx MCP tools to retrieve recent local transcript context for this project.

The project is resolved from the working directory, so these tools work whether
or not `xtctx setup` has been run here. If `xtctx_continuity_status` reports the
config as missing, that refers to managed instruction blocks and hooks — the
retrieval tools are unaffected and worth calling anyway.

## Workflow

1. Call `xtctx_recent_sessions` to list recent sessions for the current project.
2. Call `xtctx_session_detail` with a relevant `session_ref` before continuing the work.
3. Call `xtctx_search_sessions` when keyword or semantic search is more useful than recency.
4. Use `xtctx_continuity_status` only for wiring, cache, and freshness diagnostics.

The first call in a project with a large history builds the index and returns
with whatever has landed so far while the scan continues in the background. A
thin first result means the index is still filling, not that the history is
empty — call again rather than concluding there is nothing to recover.

Raw transcript files remain authoritative. Do not invent a summary when raw detail is available.
