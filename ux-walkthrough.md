# xtctx — UX Walkthrough

## Primary job

A developer working in one AI coding tool switches to another and wants the
new tool to know what just happened. Concretely: after working in Codex,
open Claude Code in the same project and have it retrieve the Codex session's
content through xtctx without any manual export.

## Steps

1. **Wire the project once.** `npx -y xtctx setup` in the project root.
   Interactive runs show the full write plan and ask; `--yes` applies it
   non-interactively. Setup writes the MCP entry for each detected tool,
   managed instruction blocks (CLAUDE.md / AGENTS.md / GEMINI.md / rules),
   synced skills, and the Claude Code SessionStart hook in
   `.claude/settings.json`. Re-running is idempotent.
2. **Check the wiring.** `xtctx status` shows config, index counts,
   per-tool detection, last scrape errors (if any), and skill-sync drift,
   ending with a concrete "Next" hint.
3. **Work normally.** No daemon runs; nothing happens until an agent asks.
4. **Hand off.** In the next tool, the agent calls `xtctx_recent_sessions`
   → picks a `session_ref` → `xtctx_session_detail` for raw messages, or
   `xtctx_search_sessions` for keyword/semantic search. Indexing happens
   lazily inside these calls. Orchestrators use `xtctx_handoff_manifest`
   for stable refs.
5. **Leave cleanly.** `xtctx disconnect <tool>` (or `--all`) shows its plan,
   asks (or `--yes`), removes MCP entries, managed blocks, synced skills,
   and hooks — transcript data and user content stay.

## States

- **Empty (fresh project):** status reports `0 sessions` and says exactly
  what to do next ("Ask a configured agent to call xtctx_recent_sessions").
  MCP tools return "No matching sessions found." rather than errors.
- **Tool not installed:** listed as `not detected`; setup still writes its
  project config so the tool works if installed later.
- **Store unreadable / scraper failing:** the scrape error is recorded and
  surfaced in `status` and `xtctx_continuity_status` (`last scrape error:`),
  while other tools keep indexing. The cursor never skips past unread
  content.
- **Corrupt index:** rebuilt automatically from transcripts on next use;
  `setup --repair` forces the same reset.
- **Unparsable/commented user config:** left byte-identical; setup reports
  a warning (comments) or a structured failure with exit code 1 (invalid),
  never a clobber.
- **Non-interactive without `--yes`:** setup/disconnect refuse rather than
  guess. Bare `xtctx` with piped stdio starts the MCP server by design;
  `XTCTX_NO_AUTO_MCP=1` opts out.
- **Hook failure:** the session-start hook prints nothing and exits 0 —
  a broken index never breaks the host agent's startup.
