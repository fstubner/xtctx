# Smoke test rewrite — pending

The previous `cross-tool-pickup.smoke.test.ts` (449 LOC) and its
`helpers.ts` (590 LOC) exercised the cross-tool pickup flow by seeding
fixture conversation files, ingesting them, and calling
`xtctx_search` over MCP to verify recall.

Both tests were deleted as part of the handoff-scope pivot because:

1. `xtctx_search` is gone (durable retrieval moved to construct's lane).
2. The recall mechanism is now the brief injected into each tool's
   memory file by `xtctx serve`'s sync tick, not an MCP query.

A rewritten smoke suite would assert:

- Seed a Cursor session at T-1m → run `xtctx serve` startup → assert
  `CLAUDE.md` contains a `## Last session in another tool` section
  with a Cursor brief.
- Seed sessions in multiple tools → assert each destination tool's
  managed block contains a brief from a *different* tool (no
  self-referential briefs).
- Call `xtctx_last_session_brief` over MCP → assert response matches
  what's in the memory file.
- Stale-window: seed a session 8 days ago → assert no brief renders.
- Idempotent sync: run twice → assert managed block is byte-stable.

Tracking issue: open after PR for handoff-pivot Step 6+7 lands.
