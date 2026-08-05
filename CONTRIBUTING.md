# Contributing to xtctx

Thanks for contributing.

## Development Setup

1. Install Node.js 24+.
2. Install dependencies:
   - `npm ci`
   - `npm --prefix landing ci`
3. Build:
   - `npm run build`
   - `npm --prefix landing run build`

## Local Validation

Before opening a PR, run:

- `npm run lint`
- `npm test`
- `npm run test:security`
- `npm run security:checklist`
- `npm run test:integration`
- `npm run test:drift`
- `npm run build`
- `npm --prefix landing run build`
- `npm run smoke:cli`

Or run everything with:

- `npm run verify:release`

## Project Layout

- `src/`: CLI, MCP, setup/status, local handoff index, and transcript scrapers
- `tests/`: scraper, setup, MCP, security, integration, and drift tests
- `landing/`: Astro public landing site
- `docs/`: security docs and historical design notes

## Pull Request Guidelines

1. Keep changes focused and atomic.
2. Add tests for behavior changes.
3. Update docs when CLI or MCP behavior changes.
4. Use conventional commits for release automation:
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
- Keep landing changes accessible.

## Reporting Bugs

Open an issue with:

1. Reproduction steps
2. Expected vs actual behavior
3. Environment (`node -v`, OS, xtctx version)
4. Relevant logs

For security issues, do not open a public issue. See `SECURITY.md`.
