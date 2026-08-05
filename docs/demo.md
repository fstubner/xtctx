# Public demo smoke

`npm run demo:public` proves the public handoff path without reading private
transcripts. The script creates a temporary project, writes synthetic Claude
Code and Codex transcript fixtures, runs the same setup routine used by
`xtctx setup`, points the temporary config at the fake stores, and calls the
built MCP server over stdio.

Run it after building the package:

```bash
npm run build
npm run demo:public
```

Expected output:

```text
xtctx public demo smoke passed
tools: xtctx_continuity_status, xtctx_recent_sessions, xtctx_search_sessions, xtctx_session_detail
sessions: 2, messages: 4
search match: codex:demo-codex-session
data: synthetic temp transcripts only
```

The demo disables every tool except the synthetic Claude Code and Codex stores
inside the temporary config. It does not scan your real local transcript
directories. Set `XTCTX_DEMO_KEEP=1` to keep the temporary project for manual
inspection.
