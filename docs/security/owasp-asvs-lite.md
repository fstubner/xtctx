# OWASP ASVS Lite Checklist (xtctx)

This checklist is a lightweight baseline for release readiness. It is intentionally concise and mapped to practical controls in this repository.

## Authentication

- [ ] API token authentication is available for `/api/*` endpoints.
- [ ] Token validation uses constant-time comparison.
- [ ] Sensitive routes reject missing or invalid credentials with `401`.

## Access Control

- [ ] `/health` is available without authentication for local diagnostics.
- [ ] API auth is enforced only when a token is configured.
- [ ] CORS is restricted to same-origin/localhost and explicit allowlist origins.

## Input and Output Handling

- [ ] Request body size limits are enforced.
- [ ] Error responses avoid leaking stack traces or internal details.
- [ ] Static file routing does not override API paths.

## API and Web Security

- [ ] Security headers are enabled via `helmet`.
- [ ] `X-Powered-By` header is disabled.
- [ ] Basic rate limiting is active for `/api/*`.
- [ ] SPA fallback only applies to non-API, non-asset routes.

## Logging and Monitoring

- [ ] Startup and shutdown lifecycle logs are emitted by runtime services.
- [ ] Rate-limit and auth failures produce deterministic HTTP responses.
- [ ] Operational runbook includes health and endpoint checks.

## Supply Chain and Release Security

- [ ] CI validates tests, builds, and packaging.
- [ ] Release publishing uses GitHub OIDC trusted publishing (no long-lived npm token).
- [ ] npm publish includes provenance (`--provenance`).
- [ ] Package contents are allowlisted via `files`.
