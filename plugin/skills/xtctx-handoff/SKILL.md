---
name: xtctx-handoff
description: Retrieve cross-tool handoff context with xtctx MCP when starting work in a project configured by xtctx. Use when switching AI coding tools, resuming work from another agent, or needing recent local transcript context.
---

# xtctx Handoff

Use the xtctx MCP tools to retrieve recent local transcript context for this project.

## Workflow

1. Call `xtctx_recent_sessions` to list recent sessions for the current project.
2. Call `xtctx_session_detail` with a relevant `session_ref` before continuing the work.
3. Call `xtctx_search_sessions` when keyword or semantic search is more useful than recency.
4. Use `xtctx_continuity_status` only for wiring, cache, and freshness diagnostics.

Raw transcript files remain authoritative. Do not invent a summary when raw detail is available.
