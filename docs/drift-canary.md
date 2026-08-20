# Drift canary

## What this is

xtctx scrapes conversation history from AI coding tools (Claude Code, Codex,
Copilot, Cursor, Antigravity, and others). Our unit tests verify the scrapers
against synthetic fixtures that *we* wrote, which proves they work against our
interpretation of each tool's storage — but not against the tool itself. If
Claude Code (or any other upstream tool) changes its on-disk format, the
fixtures stay "correct" and nothing alerts. The drift canary closes that gap
for tools with a scriptable CLI: it runs the real tool against a scripted
prompt, lets it write its actual session, then runs xtctx's scraper against
that storage and asserts the scraper still produces usable chunks.

## Running locally

Build first so the canary can load the compiled scrapers from `dist/`:

```
npm run build
```

Then run the canary for a single tool, with the matching API key exported:

```
ANTHROPIC_API_KEY=sk-ant-... node scripts/drift-canary.mjs --tool claude-code
OPENAI_API_KEY=sk-...        node scripts/drift-canary.mjs --tool codex
```

On success you get a one-liner like:

```
[claude-code] OK 3 chunks scraped (1 user, 2 assistant), latency 3.4s
```

Useful flags:

- `--keep-temp` — don't delete the sandbox `HOME` on exit (inspect what the
  tool actually wrote).
- `--timeout-ms <n>` — override the 120s default.
- `--help` — full usage.

Each run uses a fresh temp directory as `HOME`, so your real tool state is
never touched and consecutive runs don't leak state.

## CI

The workflow `.github/workflows/drift-canary.yml` runs on manual
`workflow_dispatch` only, optionally scoped to a single tool.

**Manual, not nightly, because every run spends real API credits.** It used to
run at 03:00 UTC whether or not anything upstream had changed, which paid for a
signal that only matters after a tool ships a release. The nightly watching is
now done for free by `upstream-watch` (see `RELEASE.md`), which files an issue
when a tracked tool releases; this canary is the stronger check a human reaches
for once that issue exists.

It's a matrix with one job per tool (`fail-fast: false`) so one broken scraper
doesn't mask the others. Deliberately **not** part of `ci.yml` — real-API
dependencies must not gate PRs.

### Required GitHub Secrets

| Secret              | Used by          |
| ------------------- | ---------------- |
| `ANTHROPIC_API_KEY` | claude-code job  |
| `OPENAI_API_KEY`    | codex job        |

On failure during a scheduled run the workflow opens (or comments on, if one
is already open) a single issue per tool titled
`drift: <tool> scraper may be broken` with the canary's stderr attached.

## Interpreting failures

If the canary fails in one of these ways, here's what it usually means:

- **"expected ≥1 user chunk… got 0"** — the tool wrote something to disk, but
  the scraper didn't recognise anything as a user turn. The tool's event
  schema or role naming has probably changed. Diff the freshly-written session
  file (use `--keep-temp` to inspect) against `src/scrapers/<tool>.ts`.
- **"expected ≥1 assistant chunk… got 0"** — same idea, assistant side.
- **"no chunk has a timestamp within the last 10 minutes"** — the scraper is
  finding chunks, but their timestamps are wrong. Likely a timestamp-field
  rename or unit change (seconds vs milliseconds).
- **Invoker errors** (`CLI not found`, missing API key, timeout) — environment
  or tool install problems, not scraper drift.

## Scope note

Live canaries currently cover Claude Code and Codex. Antigravity retrieval is
covered by unit/fixture tests plus optional language-server querying; a live
Antigravity canary is future work.
