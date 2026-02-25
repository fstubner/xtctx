# xtctx

Cross-tool context for AI coding agents.

xtctx indexes local conversation history, stores searchable context, exposes MCP tools, and provides API/Web surfaces for browsing project knowledge.

## Install

```bash
npm install
npm run build
```

## Run

Initialize a project:

```bash
npx xtctx init
```

Start runtime services:

```bash
npx xtctx serve
```

The web UI is served by `xtctx serve` at `/` on the configured web port.

Sync tool-native config outputs:

```bash
npx xtctx sync
```

Run ingestion manually:

```bash
npx xtctx ingest
npx xtctx ingest --full
```

## API Security Controls

- API binds to `127.0.0.1` only by default.
- CORS allows localhost/same-origin by default; additional origins can be set via `XTCTX_ALLOWED_ORIGINS`.
- Optional API token auth can be enabled with `XTCTX_API_TOKEN`.
- Basic API rate limiting is enabled for `/api/*`.

Example:

```bash
set XTCTX_API_TOKEN=my-local-token
set XTCTX_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:3232
set XTCTX_RATE_LIMIT_MAX=120
set XTCTX_RATE_LIMIT_WINDOW_MS=60000
xtctx serve
```

## Upgrade

1. Pull latest `main`/`dev`.
2. Run `npm install` and `npm --prefix web install`.
3. Rebuild with `npm run build` and `npm run build:bundle-web`.
4. Re-run `npx xtctx sync` to refresh managed tool configs.
5. Validate with `npm run verify:release`.

## Automated Release Flow

- Push merge commits to `main`.
- Release Please opens/updates a release PR with version bump and changelog updates.
- Merging that release PR creates a GitHub Release.
- Publishing the GitHub Release triggers npm publish via OIDC trusted publishing.

## Maintainer Release Runbook

### Quality gates before merge

1. Run `npm run verify:release`.
2. Run `npm pack --dry-run` and confirm `dist/web/index.html` is included.

### First release bootstrap (`v0.1.0`)

1. Merge release automation files to `main`.
2. Create and publish `v0.1.0` GitHub Release from current `main`.
3. Verify npm trusted publisher link for package `xtctx`.
4. After bootstrap, rely on Release Please for all next releases.

### Inspecting release PRs

1. Confirm expected semver bump.
2. Confirm generated changelog entries match merged commits.
3. Confirm `package.json` version and release notes look correct.

### Failed publish recovery

1. Fix workflow/auth issue (permissions, OIDC trust, or package metadata).
2. If publish fails after a release is created, do not try to reuse that version.
3. Merge a follow-up fix and let Release Please cut a new patch release.

### Post-release checks

1. `npx xtctx --help`
2. `npx xtctx serve` and verify:
   - `GET /`
   - `GET /health`
   - one `GET /api/*` endpoint

## Operator Runbook

If `xtctx serve` fails:

1. Check API health: `curl http://127.0.0.1:3232/health`.
2. Inspect `.xtctx/config.yaml` for invalid YAML or ports.
3. Ensure scraper paths exist or disable unavailable scrapers in `ingestion.scrapers`.
4. Check `.xtctx/state/` permissions.
5. Restart with logs visible: `npx xtctx serve --mcp-only` (for MCP isolation) or full `npx xtctx serve`.

If search returns no results:

1. Run `npx xtctx ingest --full`.
2. Confirm knowledge files exist under `.xtctx/knowledge/`.
3. Check source status endpoint: `GET /api/sources/status`.
