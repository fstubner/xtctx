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

Start web UI (separate terminal):

```bash
npm --prefix web run dev
```

Sync tool-native config outputs:

```bash
npx xtctx sync
```

Run ingestion manually:

```bash
npx xtctx ingest
npx xtctx ingest --full
```

## Upgrade

1. Pull latest `main`/`dev`.
2. Run `npm install` and `npm --prefix web install`.
3. Rebuild with `npm run build` and `npm --prefix web run build`.
4. Re-run `npx xtctx sync` to refresh managed tool configs.
5. Validate with `npm run verify:release`.

## Release Checklist

1. Confirm `npm test`, `npm run build`, and `npm --prefix web run build` pass.
2. Confirm CLI bin smoke check: `npm run smoke:cli`.
3. Confirm integration checks: `npm run test:integration`.
4. Verify package contents: `npm pack --dry-run`.
5. Tag and publish according to your release process.

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
