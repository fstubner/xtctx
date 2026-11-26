# Contributing to xtctx

Thanks for contributing.

## Development Setup

1. Install Node.js 24+.
2. Install dependencies:
   - `npm ci`
   - `npm --prefix site ci`
   - `npm --prefix cloud ci`
3. Build:
   - `npm run build`
   - `npm run site:build`

## Local Validation

Before pushing or opening a PR, run `npm run ci:local`. This runs the same
portable, checks and semantic lanes that hosted CI runs. A single lane is useful
while iterating (`npm run ci:local -- --lane portable`), but is not the full gate.

To run the full `cloud/` Postgres + `pgvector` integration tests locally in the semantic
lane, start `pgvector/pgvector:pg17` (e.g., `docker compose -f cloud/docker-compose.yml up -d postgres`)
and set `TEST_DATABASE_URL=postgresql://xtctx:xtctx@127.0.0.1:5432/xtctx`. Without it,
`ci:local` still runs the `cloud/` unit semantic checks (`test:semantic`).
On Windows, release-script fixtures use Git for Windows Bash; `XTCTX_TEST_BASH`
can select its executable explicitly. The System32 WSL launcher is not suitable.
Hosted CI additionally covers Linux, macOS and Windows. Local CI never publishes,
deploys, pushes or touches production services. Dependency audits and the existing
retrieval eval may need network access and an embedding-model cache.

The individual checks remain available:

- `npm run lint`
- `npm test`
- `npm run test:security`
- `npm run security:checklist`
- `npm run test:integration`
- `npm run test:drift`
- `npm run build`
- `npm run site:check`
- `npm run smoke:cli`

Or run everything with:

- `npm run verify:release`

## Project Layout

- `src/`: CLI, MCP, setup/status, local handoff index, and transcript scrapers
- `cloud/`: optional Node 24 + PostgreSQL 17 (`pgvector`) sync server, MCP OAuth 2.1, dashboard, and async worker
- `browser-extension/`: optional Chrome extension for web chat history capture
- `tests/`: scraper, setup, MCP, security, integration, and drift tests
- `site/`: the xtctx.com site, built on product-site-template (`npm run site:dev` to preview it)
- `docs/`: security docs and design notes

## Pull Request Guidelines

1. Keep changes focused and atomic.
2. Add tests for behavior changes.
3. Update docs when CLI or MCP behavior changes.
4. Use conventional commits. Nothing reads the prefix — release notes come
   from GitHub's own generator over the commit range — but a reader scanning
   the log does:
   - `feat: ...`
   - `fix: ...`
   - `docs: ...`
   - `test: ...`
   - `chore: ...`
5. Avoid unrelated formatting-only diffs.

## Coding Expectations

- TypeScript strictness is expected.
- Prefer explicit error handling for local file and transcript parsing.
- Breaking changes are allowed while the project is pre-1.0, but they must be reflected in README, setup/status behavior, and tests.
- Keep MCP tool responses stable and test-covered.
- Keep site changes accessible: `npm --prefix site run check:contrast` and `npm --prefix site run test:a11y` measure the rendered pages.

## Reporting Bugs

Open an issue with:

1. Reproduction steps
2. Expected vs actual behavior
3. Environment (`node -v`, OS, xtctx version)
4. Relevant logs

For security issues, do not open a public issue. See `SECURITY.md`.
