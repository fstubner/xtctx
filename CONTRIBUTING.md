# Contributing to xtctx

Thanks for contributing.

## Development Setup

1. Install Node.js 20+.
2. Install dependencies:
   - `npm ci`
   - `npm --prefix web ci`
3. Build:
   - `npm run build`
   - `npm --prefix web run build`

## Local Validation

Before opening a PR, run:

- `npm test`
- `npm run test:security`
- `npm run security:checklist`
- `npm run test:integration`
- `npm run build`
- `npm --prefix web run build`
- `npm run smoke:cli`

Or run everything with:

- `npm run verify:release`

## Project Layout

- `src/`: core runtime, CLI, MCP, scrapers, API
- `tests/`: unit + integration tests
- `web/`: Vue web UI
- `.xtctx/`: project-local configs, skills, and knowledge conventions
- `docs/plans/`: design + implementation docs

## Pull Request Guidelines

1. Keep changes focused and atomic.
2. Add tests for behavior changes.
3. Update docs when CLI/API behavior changes.
4. Use conventional commits for release automation:
   - `feat: ...`
   - `fix: ...`
   - `docs: ...`
   - `test: ...`
   - `chore: ...`
5. Avoid unrelated formatting-only diffs.

## Coding Expectations

- TypeScript strictness is expected.
- Prefer explicit error handling for runtime services.
- Preserve CLI backward compatibility unless a breaking change is explicitly documented.
- Keep MCP tool responses stable and test-covered.

## Reporting Bugs

Open an issue with:

1. Reproduction steps
2. Expected vs actual behavior
3. Environment (`node -v`, OS, xtctx version)
4. Relevant logs

For security issues, do not open a public issue. See `SECURITY.md`.
