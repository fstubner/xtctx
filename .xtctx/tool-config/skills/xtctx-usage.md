# xtctx-usage

Use this workflow when xtctx tools are available through MCP.

## Session Start

1. Call `xtctx_search` with a summary query of the active task before making changes.
2. Call `xtctx_project_knowledge` with `type: all` for prior decisions, fixes, and insights.
3. Optionally call `xtctx_recent_sessions` and `xtctx_session_detail` when session data is available.

## During Implementation

1. Use `xtctx_search` first at `depth: summary`, then drill into `detail` only as needed.
2. Use `xtctx_list_configs` and `xtctx_get_config` to load shared project rules.
3. Use `xtctx_tool_preferences` for tool-specific behavior before acting.

## Writeback Rules

1. Save major architecture choices with `xtctx_save_decision`.
2. Save recurring failures and verified fixes with `xtctx_save_error_solution`.
3. Save durable learnings with `xtctx_save_insight`.
4. Keep records short, concrete, and tied to files, commands, and rationale.

## Response Quality

1. Include source/session references when citing context.
2. If no useful context exists, state that clearly and proceed with local evidence.
