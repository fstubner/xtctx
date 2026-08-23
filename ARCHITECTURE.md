# xtctx — Architecture

One npm package, no services. Everything runs in the invoking process on the
developer's machine. `docs/architecture.md` describes module internals; this
document fixes the parts, the boundaries between them, and what each part is
allowed to trust.

## Parts

- **CLI** (`src/cli/`) — `setup`, `status`, `disconnect`, and the internal
  `--hook session-start` entry point. Bare `xtctx` on a non-TTY stdio pair
  starts the MCP server.
- **MCP server** (`src/mcp/`) — stdio JSON-RPC server exposing exactly five
  read-only tools. Spawned by coding agents via `npx -y xtctx`.
- **Scrapers** (`src/scrapers/`) — one per supported tool; read that tool's
  local transcript store and yield normalized conversation chunks,
  project-scoped and incremental. `AbstractScraper` is the documented
  third-party extension point.
- **Handoff index** (`src/handoff/`) — per-project SQLite database
  (`.xtctx/state/xtctx.db`, WAL, schema-versioned) holding sessions,
  messages, retrieval windows, FTS index, and embedding vectors. Refreshed
  on demand from the scrapers; fully derived, rebuilt from scratch on
  corruption or schema mismatch.
- **Drift log** (`src/scrapers/drift-log.ts`) — per-tool record of the
  places another tool's transcripts did not match what the scraper expected,
  summarised once per scan and kept in `.xtctx/state/<tool>-drift.json`.
  Warnings alone reach only the host agent's stderr, which nothing retains;
  `xtctx status` reads these files back. Bounded: 50 distinct surprises per
  tool, discards counted rather than silent.
- **Config writers** (`src/config/`) — setup/disconnect logic that edits
  other tools' config files (MCP config, managed instruction blocks,
  synced skills, the Claude Code hook in `.claude/settings.json`).
- **Landing site** (`landing/`) — static Astro site on GitHub Pages;
  no runtime relationship to the package.

## Boundaries

- **Scrapers → foreign stores:** read-only, always. SQLite stores open
  `readonly` + `fileMustExist`; JSONL stores are streamed. One unreadable
  file warns and is skipped; it never aborts the scrape cycle or advances
  the incremental cursor past unread content.
- **Project boundary:** every scraper filters to the current project root
  (encoded directory, session `cwd`/`directory` metadata, or
  `session.start` context). A session that cannot be attributed to a
  project is excluded under scoping — fail closed, with a warning.
- **Index ↔ MCP:** the MCP tools speak only to the `SessionService`
  interface; all SQL lives behind it, with bound parameters everywhere and
  clamped limits at both layers.
- **Config writers → other tools' files:** writes are atomic
  (temp + rename), merge under the tool's own root key, preserve unknown
  keys, preserve the file's line endings, and refuse to rewrite files they
  cannot parse (JSONC comments included) rather than clobber them. JSON is
  re-serialised, so formatting is normalised even though content is not.
  Managed markdown blocks touch nothing outside their markers — including the
  tail of the file, which is why setup does not trim it and removal gives back
  exactly the separator it added.
- **Process boundary:** the MCP server writes logs to stderr only — stdout
  is the JSON-RPC transport. The session-start hook fails open: it must
  never break a host agent's startup.
- **The session-start hook never scans.** It runs before the user's first
  turn, so its cost is added to every agent startup, and a scan of every
  transcript store on the machine takes seconds even bounded. It reads the
  index as it already stands (`listIndexedSessions`) and names the most
  recent session — a pointer to raw detail, not a summary of it. Slightly
  stale context instantly beats fresh context late.

## Trust

- **Transcript content is untrusted input end to end.** It comes from other
  processes' files, may be adversarial (a poisoned repo produces poisoned
  transcripts), and is ultimately fed to an LLM. The scraper layer treats it
  as data (no eval, no dynamic paths derived from it); the MCP layer fences
  message bodies, labels them untrusted, truncates oversized payloads, and
  redacts local paths from error text.
- **Tool arguments from the connected agent are untrusted.** Validated and
  clamped at the handler boundary; `session_ref` is only ever a bound SQL
  parameter, never a path.
- **`.xtctx/config.yaml` is semi-trusted.** It is repo-committable, so a
  cloned repo can point `storePath` anywhere on disk. Store paths are used
  read-only, but treat overrides in a foreign repo as a risk surface.
- **The index is trusted derived state, not a source of truth.** Anything
  wrong with it is resolved by deletion and re-scrape (`setup --repair`,
  or automatically on open failure / schema mismatch).
- **The registry and npm supply chain** are trusted at install time; CI
  pins action SHAs and publishes via OIDC with provenance, no long-lived
  tokens.
