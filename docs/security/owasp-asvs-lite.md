# OWASP ASVS Lite Checklist (xtctx)

This checklist is a lightweight baseline for release readiness. It is intentionally concise and mapped to practical controls in this repository.

Last reviewed: 2026-02-26

## Authentication

- [x] API token authentication is available for `/api/*` endpoints.
- [x] Token validation uses constant-time comparison.
- [x] Sensitive routes reject missing or invalid credentials with `401`.

## Access Control

- [x] `/health` is available without authentication for local diagnostics.
- [x] API auth is enforced only when a token is configured.
- [x] CORS is restricted to same-origin/localhost and explicit allowlist origins.

## Input and Output Handling

- [x] Request body size limits are enforced.
- [x] Error responses avoid leaking stack traces or internal details.
- [x] Static file routing does not override API paths.

## API and Web Security

- [x] Security headers are enabled via `helmet`.
- [x] `X-Powered-By` header is disabled.
- [x] Basic rate limiting is active for `/api/*`.
- [x] SPA fallback only applies to non-API, non-asset routes.

## Logging and Monitoring

- [x] Startup and shutdown lifecycle logs are emitted by runtime services.
- [x] Rate-limit and auth failures produce deterministic HTTP responses.
- [x] Operational runbook includes health and endpoint checks.

## Supply Chain and Release Security

- [x] CI validates tests, builds, and packaging.
- [x] Release publishing uses GitHub OIDC trusted publishing (no long-lived npm token).
- [x] npm publish includes provenance (`--provenance`).
- [x] Package contents are allowlisted via `files`.
