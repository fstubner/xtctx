# xtctx — Product Contract

## Purpose

Local cross-tool handoff for AI coding agents. Developers who switch between
Claude Code, Codex, Cursor, Copilot, Antigravity, opencode, and Copilot CLI
lose conversational context at every switch. xtctx indexes each tool's local
transcript store into a per-project SQLite index and serves it back — to any
of those tools — through a small read-only MCP server, so the next agent can
pick up where the last one left off.

Raw local transcripts are authoritative. xtctx never summarizes, never
persists derived "memory", and never sends transcript content anywhere; the
index is derived data that can always be deleted and rebuilt.

## Users

- **Primary:** individual developers who use two or more AI coding tools in
  the same project and want the next tool to know what the previous one did.
- **Secondary:** orchestrators (scripts or agents driving several coding
  tools) that need stable session references and raw-detail pointers —
  served by `xtctx_handoff_manifest`.

Single-user, single-machine. There is no team, sync, or server component.

## Success

- After `xtctx setup`, an agent in any configured tool can call
  `xtctx_recent_sessions` and retrieve real transcript content from a
  *different* tool's session in the same project, without manual export.
- Setup is reversible: `xtctx disconnect` removes xtctx's management without
  deleting transcript data. Markdown and other prose files come back
  byte-for-byte outside the managed block, trailing whitespace and blank lines
  included. JSON configs keep every key and value the user had, but are
  re-serialised, so their original formatting is not preserved; and an MCP
  config file that setup created may be left behind holding an empty server
  map.
- Only the current project's sessions are ever indexed or served — content
  from other projects on the machine never crosses the project boundary.
- The demo smoke (`npm run demo:public`) proves the loop end-to-end against
  synthetic data on every release.

## MVP

- Scrapers for the seven supported tools, project-scoped, incremental, and
  tolerant of upstream schema drift (warn, never silently drop).
- One per-project SQLite index (`.xtctx/state/xtctx.db`) with keyword (FTS5)
  and semantic (local MiniLM embeddings) search over chronological windows.
- Five read-only MCP tools: recent sessions, session detail, search,
  continuity status, handoff manifest.
- CLI: `setup` (wire MCP config, managed instruction blocks, skills, and the
  Claude Code SessionStart hook), `status`, `disconnect`.

Out of scope (deliberately, and documented everywhere the product speaks):
no daemon, no API server, no dashboard, no generated summaries or briefs,
no durable memory, no write-back tools, no cloud anything.

## Constraints

- Node ≥ 24, distributed via npm (`npx -y xtctx`); no install step beyond
  what a coding agent's MCP config can express.
- Transcript stores belong to other tools: all reads are read-only
  (`readonly` + `fileMustExist` for SQLite stores) and must survive those
  tools changing their formats — drift is detected by tests, committed format
  fingerprints and an upstream release watch, with an on-demand canary against
  the real CLIs, and degrades with warnings rather than silent data loss.
- Config files written during setup belong to other tools too: writes are
  atomic, merge-preserving, and never clobber unparsable user content.
- Transcript content handed to a model is untrusted data; the MCP layer
  fences it and never grows write capabilities.
- Everything runs local, and nothing is ever sent off the machine. Two
  network dependencies exist, both narrow: the one-time embedding-model
  download from Hugging Face, and loopback-only HTTPS calls to Antigravity's
  local language server (127.0.0.1, exact-PID + CSRF matched; certificate
  verification is off because the server is self-signed).
