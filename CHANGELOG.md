# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

Notes are written by hand under `## [Unreleased]` as work merges. The `release`
workflow moves that text under the new version's heading when a release is cut,
and the same text becomes the GitHub release notes. Internal-only work
(refactors, tests, CI, routine dependency bumps) is left out; the git history
has it.

Older entries are grouped, one heading per run of versions, where several were
cut close together: the individual headings carried nothing a reader could use.
Each group lists the versions it covers and says which of them reached npm.

## [Unreleased]

### Fixed

- **Tool calls no longer wait behind a scan.** A scan could still hold the
  server for most of its run: about three-quarters of it while building
  search windows for one long session, and seconds at a time while writing to
  a busy disk. Windows are now built in small batches, and the disk flushes
  happen on a background thread.

## [0.22.1](https://github.com/fstubner/xtctx/releases/tag/xtctx-v0.22.1) (2026-10-03)

xtctx no longer points at any hosted sync service. Cloud sync stays available
for people who deploy their own Worker.

### Changed

- **Cloud sync is self-hosted only.** There is no default sync server any
  more. `xtctx login` without `--sync-url` or `XTCTX_SYNC_URL` exits 1 with a
  message pointing at `docs/cloud-sync.md` and `cloud/README.md`, and contacts
  nothing. `XTCTX_TOKEN` with no URL fails the same way. (#411)
- The Worker config in the repository ships with placeholders. A deployment's
  own values go in a git-ignored `cloud/wrangler.local.toml`, copied from
  `wrangler.local.example.toml`; until `PUBLIC_URL` is set the Worker answers
  `500 server_misconfigured` on every route except `/health`.

### Removed

- The hosted Worker that served `sync.xtctx.com` and `mcp.xtctx.com` during
  0.22.0, and every default pointing at those addresses.

## [0.22.0](https://github.com/fstubner/xtctx/releases/tag/xtctx-v0.22.0) (2026-10-03)

The first release on npm since 0.19.0, so it carries everything from the
unpublished 0.20.0 to 0.21.8 (below) plus five weeks of audit work. The themes:
one project's sessions never reach another project, the index is no longer
deleted or silently damaged, semantic search is optional and the default
install is a tenth of the size, scans of large histories are much faster, and
there is an opt-in cloud sync.

### Added

- **`xtctx export` and `xtctx import`** back up and restore the index, which
  can be the only copy of a session once Claude Code deletes its transcript
  (after 30 days by default). `xtctx status` now says how many sessions exist
  only in the index. (#403)
- **Optional semantic search.** `xtctx embeddings enable` installs the local
  model on demand (it asks first; `--yes` for scripts and agents) and
  `xtctx embeddings disable` removes it, leaving your index alone. Until you
  enable it, search is keyword-only and works fully. A project can instead
  point at an OpenAI-compatible embeddings endpoint, with nothing installed
  locally. (#389, #403)
- **`xtctx scan`**, and `xtctx scan --embed`, an uncapped pass that builds
  vectors for a whole history with progress reporting; it resumes if
  interrupted. Searches only vectorise a few windows per call, which on a real
  history would take hundreds of searches to cover. (#322, #359)
- **A literal search mode** (`mode: "literal"`) that matches text straight in
  the transcript stores without the index, so it answers before the first scan
  finishes and finds exact strings the index has not reached. It never widens
  the project boundary, and says when it stopped at its limit rather than
  presenting a partial pass as complete. (#343)
- **Opt-in cloud sync** (`xtctx login`, `xtctx sync enable`, `xtctx sync
  status`, `xtctx logout`) against a Worker you deploy from `cloud/`, with
  OAuth sign-in for MCP clients. Nothing is uploaded unless you both log in and
  opt a project in, no absolute paths or hostnames are sent, and there is no
  background daemon: the MCP server uploads while an agent runs. (#404; this
  release pointed at a hosted default, which 0.22.1 removed.)
- The MCP tools now answer usefully in a project that was never set up: they
  name the project, say what has and has not happened, and give the command to
  offer (`npx -y xtctx setup --yes`) instead of replying "No matching sessions
  found." (#315, #399)
- A partial answer now names the tools it has not read yet (for example
  "codex is not in this list yet"), so an agent knows to ask again. (#317)
- Search matches carry an offset that `xtctx_session_detail` actually
  accepts. The old `Match 5987-2108` range was not an offset and could land
  weeks from the match. (#368)

### Changed

- **A much smaller default install.** The local embedding runtime is no longer
  a dependency: an `npx` install went from 550 MB to 55 MB. (#403)
- **Scans of large histories are much faster.** Codex, Claude Code and Copilot
  CLI transcripts are resumed from a byte offset rather than re-read (a Codex
  store of 18 GB scanned in 1.3 s instead of 34 s), search no longer loads
  whole windows into memory just to show a preview, and a Cursor scan that
  took 18.4 s takes 1.0 s. (#298, #302, #303, #403)
- The MCP server starts a background scan when it starts, so a session begun
  right after another tool worked in the repo sees that work. `disconnect` no
  longer empties the machine-wide Antigravity and Copilot CLI configs for
  every other project. (#322, #323)
- Setup grants the five (read-only) xtctx tools by name, under both the plain
  and the plugin server name. Before this, an agent calling them in a
  non-interactive session got "permission not granted" and fell back to
  grepping transcripts by hand. (#316, #326)
- Generated configs pin `xtctx@<version>`, and the managed instruction block
  is eight lines with no project path. `setup` reports `created`, `updated` or
  `unchanged` per file; `status` shows project-relative paths, collapses format
  surprises to one line (detail under `--verbose`), and reports the MCP command
  your configs actually name instead of a fixed string. (#358, #388, #403)
- The Claude Code session-start hook takes the transcript location from the
  tool instead of re-deriving Claude Code's path encoding, which also makes
  `CLAUDE_CONFIG_DIR` work. (#300)
- Releases are cut by one manual workflow; nothing is released by merging.
  (#296)

### Fixed

- **Project isolation.** Several paths served one project's transcripts to
  another: Antigravity matching a project by bare substring, or by a foreign
  path ending in the project's path; a trailing `..` counting as inside the
  project; search, recent sessions and status ignoring the project (so a copied
  `.xtctx/` served the sibling's sessions); and a committed
  `.xtctx/config.yaml` or hook payload being able to point a scraper at another
  project's transcript store. All are closed, and text taken from transcripts
  is labelled as untrusted wherever it is shown to an agent. (#293, #297,
  #308, #310, #311, #314, #360, #370)
- **A repository cannot aim embeddings at a host.** A committed config could
  name any embedding endpoint and any environment variable as its key. Only
  loopback or endpoints you list in `XTCTX_TRUSTED_EMBEDDING_ENDPOINTS` are
  used, and the key comes only from `XTCTX_EMBEDDING_API_KEY`. (#389)
- **The index is no longer deleted.** `setup --repair` no longer removes it, and
  an index that fails to open is set aside rather than deleted. Only a
  genuinely corrupt or older-schema index is set aside; a newer one is left in
  place. Sessions in a set-aside index are carried forward on upgrade. (#388, #389,
  #403)
- **No more lost or doubled rows.** Several agents scanning at once no longer
  drop rows; an interrupted scan no longer leaves messages unsearchable; a
  forced re-read no longer leaves the replaced rows behind; and a renamed
  project directory no longer makes its whole history vanish. (#295, #313,
  #374, #403)
- **Setup and disconnect no longer destroy files you wrote**: an unparsable
  `.claude/settings.json`, TOML with comments, an unparsable
  `.xtctx/config.yaml`, a frontmatter-only `CLAUDE.md`, and a stray marker that
  swallowed text up to the next block. (#367, #380, #383)
- **Sessions read correctly.** Claude Code tool results were indexed as the
  user speaking and its tool calls dropped; Codex's current human turns were
  dropped entirely (15,169 against 41 read in one real store); Copilot, Cursor
  and opencode attribution and tool calls were wrong; Claude Code projects with
  `_` or `.` in the folder name found no sessions; VS Code and Cursor folders
  opened through WSL were invisible; Antigravity dropped steps with no
  timestamp. (#357, #371, #375, #383, #403)
- Oversized Codex records are reported rather than dropped in silence, while
  the harmless `compacted` ones no longer raise a format warning on every
  scan. (#301, #355)
- Format warnings could be lost when two processes wrote them at once. (#304,
  #345)
- Dependency advisories were cleared (including `fast-uri`, `qs` and
  `devalue`). (#324, #398, #405)

## [0.20.0 – 0.21.8] (tagged 2026-08-29 – 2026-08-31, never published to npm)

Fifteen tags that got GitHub Releases but never reached npm, which stayed on
0.19.0 until 0.22.0. Everything here reached users in 0.22.0. They exist
because an automated release pipeline cut a version on every merge: it read
GitHub's "latest release", could not see drafts, and kept proposing a release
of the whole history, running its own version counter past 0.70 (those numbers
were never tagged). The pipeline was replaced by one manual workflow. (#201,
#265, #296)

### Added

- **xtctx as an installable plugin**: Claude Code, Codex, Copilot CLI, Cursor,
  VS Code and Antigravity can install it (a marketplace entry, `xtctx@xtctx`,
  serves the first four). `setup` remains the route for opencode. (0.20.0,
  #202, #219)
- Installable straight from git (`npx -y github:fstubner/xtctx`) so current
  `main` can be tried without a publish. (0.20.0, #255)
- `status` reports how long the last scan took and how much embedding is left.
  (0.21.0, #275)

### Changed

- Back to the smaller MiniLM embedding model, which indexes about three times
  faster than the mpnet model from 0.19.0, and a cap on how many segments one
  window contributes to its vector. (0.21.1, 0.21.2, #276, #278)
- Setup and the README present the plugin as the entry point and `setup` as
  the upgrade. (0.21.7, #287)

### Fixed

- Plans written by Claude Code (`plan_file_reference` attachments) are indexed
  instead of dropped. (0.20.0, #246)
- Hybrid search no longer hides everything that has not yet been vectorized:
  with 8 of 1,770 windows vectorized it could reach under 1% of the history.
  (0.20.5, #272)
- Antigravity reports when it can only serve its summary artifacts instead of
  transcripts. (0.20.4, #269)
- Security: prototype pollution, a write escape and injection paths closed.
  (0.21.5, #283)
- Session roll-ups a killed scan never reached are repaired on the next scan.
  (0.21.6, #285)
- `disconnect` does nothing in a project that was never configured, and
  `setup` no longer routes xtctx through `npx` inside xtctx's own repo.
  (0.21.8, #290, #292)

## [0.19.0](https://github.com/fstubner/xtctx/releases/tag/xtctx-v0.19.0) (2026-08-28)

The last version on npm before 0.22.0.

### Changed

- The embedding model is now quantized mpnet (a 110 MB download), which ranks
  better than MiniLM on the project's retrieval eval (recall@5 0.933 against
  0.850). It indexes more slowly, which is why 0.21.2 went back. (#199)

## [0.18.0 – 0.18.9] (2026-08-23 – 2026-08-28)

Search ranking tuned against a measured eval, and the Antigravity reader
extended.

Versions: 0.18.0, 0.18.1, 0.18.2, 0.18.3, 0.18.4, 0.18.5, 0.18.6, 0.18.7,
0.18.8, 0.18.9 (all on npm).

### Added

- Antigravity: ask-question answers (including which option was chosen),
  subagent prompts, and MCP tool calls and their errors are now indexed.
  (0.18.0, #169)

### Changed

- Hybrid search weights rebalanced (it ranked worse than keyword alone),
  keyword rank decays linearly rather than reciprocally, and the semantic
  confidence threshold was retuned. (0.18.6, 0.18.8, 0.18.9, #191, #195, #197)

### Fixed

- Cross-project leak: Antigravity attributed a conversation to any project
  that shared a directory name. (0.18.5, #182)
- A degraded Antigravity scan (language server timing out) is reported instead
  of losing the session silently, and the cursor no longer advances past what
  was not read. (0.18.2, #174)
- An unreadable Cursor `globalStorage` no longer fails the whole Cursor scrape.
  (0.18.4, #180)
- Fixes from independent acceptance review rounds 7 and 8, including lost
  format warnings when several writers raced on Windows and VS Code `.jsonl`
  chat sessions yielding nothing. (0.18.1, 0.18.3, #171, #178)

## [0.16.0 – 0.17.0] (all on 2026-08-23)

Versions: 0.16.0, 0.16.1, 0.17.0 (all on npm).

### Added

- Format-drift warnings are kept after the scan that found them and shown by
  `status`, bounded so one malformed store cannot flood them. The Antigravity
  reader reports format drift too. (0.16.0, 0.17.0, #163, #167)

### Fixed

- Nine findings from the sixth acceptance round, including `disconnect --all`
  removing the `.gitignore` that keeps the transcript index out of the
  repository. (0.16.1, #165)

## [0.14.0 – 0.15.10] (2026-08-21 – 2026-08-23)

Handoff context at the start of a session, and a run of reviewer-found fixes.

Versions: 0.14.0, 0.14.1, 0.14.2, 0.14.3, 0.14.4, 0.14.5, 0.14.6, 0.14.7,
0.14.8, 0.15.0, 0.15.1, 0.15.2, 0.15.3, 0.15.4, 0.15.5, 0.15.6, 0.15.7,
0.15.8, 0.15.9, 0.15.10 (all on npm).

### Added

- Sessions carry the git branch and commit they actually ran on, taken from the
  transcript (not from git today), shown in results and usable as
  `branch_filter`. (0.14.0, #123)
- The session-start hook names the most recent session (tool, branch, last
  activity, opening line) instead of saying context exists somewhere. It reads
  the index without scanning, so it adds under a second to startup. (0.14.0,
  #123)

### Changed

- A first tool call no longer takes 18-50 seconds (scans are bounded and
  continue in the background), the first semantic search no longer blocks while
  vectorising the whole corpus, and a partial answer says so. Reported semantic
  scores are the real cosine rather than a rescaled 1.0. (0.14.0, #122)
- Antigravity sessions belonging to other projects are skipped without being
  fetched. (0.14.1, #126)

### Fixed

- `setup` no longer deletes the comments in a hand-written TOML config;
  `disconnect` no longer deletes empty directories above the project and loses
  no bytes when a file holds two managed blocks; search ignores stop-words that
  matched everything. (0.14.4, 0.15.6, 0.15.7, #132, #153, #155)
- Fewer false format-drift reports for Claude Code's bookkeeping records.
  (0.14.2, 0.14.5)

## [0.12.0 – 0.13.1] (all on 2026-08-20)

Versions: 0.12.0, 0.13.0, 0.13.1 (all on npm).

### Added

- Format-drift watching without API spend: a nightly check of upstream tool
  releases, and fingerprints of the real transcript formats including
  Antigravity's store layout. (0.12.0, 0.13.0, #119)

### Fixed

- opencode sessions were invisible because xtctx looked in the wrong default
  location; they are read now. (0.13.0, #117)
- Antigravity sessions written after its move from `.pb` to SQLite store files
  were never enumerated. (0.13.1, #120)

## [0.11.2 – 0.11.7] (2026-08-19 – 2026-08-20)

A hardening pass across the rewritten product.

Versions: 0.11.3, 0.11.4, 0.11.5, 0.11.6, 0.11.7 (on npm); 0.11.2 was tagged
but not published.

### Fixed

- Safer config writes (other tools' files are written carefully, and
  `disconnect` reports accurately and preserves line endings), a crash-safe
  index that is cheaper to refresh, a repaired embedding pipeline, and a
  requirement of real evidence before a semantic match is shown. (0.11.2)
- Untrusted transcript text is fenced in MCP output, tool arguments are
  validated, and reported paths are redacted. (0.11.2)
- Sessions are attributed by working directory rather than by name for
  Antigravity and Claude Code, current Copilot CLI events are parsed, a corrupt
  opencode store is reported instead of read as empty, and the project root is
  resolved through symlinks. (0.11.2, 0.11.3)
- Semantic scores are rescaled per query so relevance outranks recency.
  (0.11.7)

## [0.11.0 – 0.11.1] (both on 2026-08-05)

The rewrite. xtctx stopped being a daemon with a knowledge store and became a
local handoff tool: `setup`, `status`, `disconnect`, skill sync and five
read-only MCP tools (including `xtctx_handoff_manifest`) that let one coding
tool pick up another's session. Google support is Antigravity only; Gemini CLI
was removed. 0.11.1 fixed the public demo smoke check. Of the two, only 0.11.1
reached npm (0.11.0 was tagged only), which is how npm left 0.3.2. (#69)

## Before 0.11 (the original design)

Versions 0.1.0 to 0.10.0 (2026-02-25 to 2026-05-07) described a different
product: a long-running daemon with a YAML-backed knowledge store, LanceDB
vector search, a local API server and a web UI, MCP tools for searching and
saving knowledge, config sync into each tool's rules file, and scrapers for
Claude Code, Cursor, Codex, Copilot, Gemini CLI and later opencode. It also
gained a nightly drift canary and an `xtctx onboard` wizard. The 0.11.0 rewrite
replaced all of it, and none of that surface exists now. Of these versions only
0.3.2 was ever published to npm; the rest were not.
