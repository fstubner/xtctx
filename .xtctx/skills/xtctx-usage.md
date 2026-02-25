# xtctx-usage

Use this workflow when xtctx tools are available through MCP.

## Session Start

1. Call `xtctx_recent_sessions` with `limit: 3`.
2. If a relevant prior thread appears, call `xtctx_session_detail` for that `session_ref`.
3. Call `xtctx_search` with a summary query of the user task before making changes.

## During Implementation

1. Use `xtctx_search` to retrieve prior decisions, fixes, and conventions.
2. If needed, call `xtctx_project_knowledge` with `type: all` and an optional query.
3. Use `xtctx_list_configs` and `xtctx_get_config` to load portable project rules.
4. Use `xtctx_tool_preferences` for tool-specific behavior before acting.

## Writeback Rules

1. Save major architecture choices with `xtctx_save_decision`.
2. Save recurring failures and verified fixes with `xtctx_save_error_solution`.
3. Save durable learnings with `xtctx_save_insight`.
4. Keep records short, concrete, and tied to files, commands, and rationale.

## Response Quality

1. Prefer `depth: summary` on first search; drill into `detail` only when needed.
2. Include source/session references when citing context.
3. If no useful context exists, state that clearly and proceed with local evidence.
