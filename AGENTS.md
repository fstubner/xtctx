# AGENTS.md

Guidance for coding agents working in this repository.

## Project Scope

- `src/`: runtime code (CLI, API, MCP, ingestion, storage).
- `web/`: Vue web UI served by `xtctx serve`.
- `landing/`: static public landing site (deployed via GitHub Pages).
- `tests/`: unit/integration/security tests.
- `docs/`: plans and security documentation.

## Common Commands

```bash
npm ci
npm --prefix web ci
npm run verify:release
```

Serve locally:

```bash
npx xtctx init
npx xtctx ingest --full
npx xtctx serve
```

## Configuration Rules

- Prefer `.xtctx/config.yaml` for runtime configuration.
- Environment variables are override-only for explicit temporary use.
- Keep API security defaults aligned with config schema and tests.

## Change Rules

- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Add or update tests for behavior changes.
- Do not commit local runtime state (`.xtctx/.store`, `.xtctx/state`, `.claude`).

## Release Notes

- Release Please manages versions and changelog.
- Release PRs are auto-merge enabled after required checks pass.
