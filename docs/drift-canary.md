# Drift canary

## What this is

xtctx scrapes conversation history from AI coding tools (Claude Code, Codex,
Gemini, Copilot, Cursor). Our unit tests verify the scrapers against synthetic
fixtures that *we* wrote, which proves they work against our interpretation of
each tool's storage — but not against the tool itself. If Claude Code (or any
other upstream tool) changes its on-disk format, the fixtures stay "correct"
and nothing alerts. The drift canary closes that gap: it runs the real tool
CLI against a scripted prompt, lets it write its actual session, then runs
xtctx's scraper against that storage and asserts the scraper still produces
usable chunks. It is the only thing that catches upstream drift.

## Running locally

Build first so the canary can load the compiled scrapers from `dist/`:

```
npm run build
```

Then run the canary for a single tool, with the matching API key exported:

```
ANTHROPIC_API_KEY=sk-ant-... node scripts/drift-canary.mjs --tool claude-code
OPENAI_API_KEY=sk-...        node scripts/drift-canary.mjs --tool codex
GEMINI_API_KEY=...           node scripts/drift-canary.mjs --tool gemini
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

The workflow `.github/workflows/drift-canary.yml` runs:

- Nightly at 03:00 UTC.
- On manual `workflow_dispatch` (optionally scoped to a single tool).

It's a matrix with one job per tool (`fail-fast: false`) so one broken scraper
doesn't mask the others. Deliberately **not** part of `ci.yml` — this is a
nightly drift signal, not a per-PR gate.

### Required GitHub Secrets

| Secret              | Used by          |
| ------------------- | ---------------- |
| `ANTHROPIC_API_KEY` | claude-code job  |
| `OPENAI_API_KEY`    | codex job        |
| `GEMINI_API_KEY`    | gemini job       |

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
  rename or format change.
- **"<tool> ran but did not create \<path\>"** — the tool moved its storage
  location. Update the scraper's root path and the canary's invocation.
- **"<tool> CLI --help no longer advertises \<flag\>"** — the invocation flag
  itself has drifted. Update the canary to use the new flag, and consider
  whether the tool's new behaviour needs matching scraper changes.
- **Missing credentials** — the script exits with a clear "set X to run this
  canary" message before attempting anything.

When fixing drift: update the scraper, add a regression fixture in
`tests/scrapers/` that pins the new on-disk shape, and re-run the canary
locally.

## Not covered (yet)

The first version of the canary covers only the three CLI tools. Two tools are
tracked for follow-up because they need more machinery than a scripted shell
invocation:

- **GitHub Copilot** — ships as a VSCode extension; there is no plain CLI that
  writes the same session format the scraper reads. Automating it in CI means
  installing VSCode headless, loading the extension, signing in, and driving
  it through its command palette. Doable, but meaningfully more surface area
  than the three CLI tools.
- **Cursor** — Electron GUI only. No headless mode that persists to the same
  storage the scraper reads. Automating it means driving the full Electron
  app in a virtual display, which is brittle and not worth it as a first
  pass.

For both, the existing synthetic-fixture tests still catch regressions in the
scraper itself; they just don't catch upstream drift. That's an explicit
known gap.
