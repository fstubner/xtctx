# Contributing to xtctx

Thanks for contributing.

## Development Setup

1. Install Node.js 24+.
2. Install dependencies:
   - `npm ci`
   - `npm --prefix site ci`
3. Build:
   - `npm run build`
   - `npm run site:build`

## Local Validation

Before opening a PR, run:

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
- `tests/`: scraper, setup, MCP, security, integration, and drift tests
- `site/`: the xtctx.com site, built on product-site-template (`npm run site:dev` to preview it)
- `docs/`: security docs and historical design notes

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
