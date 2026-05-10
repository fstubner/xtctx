# OWASP ASVS Lite Checklist (xtctx)

This checklist is a lightweight baseline for release readiness. xtctx is a
local CLI/MCP tool; it does not expose an HTTP surface in the current handoff
design.

Last reviewed: 2026-05-10

## Local-Only Execution

- [x] No local HTTP service is shipped in the runtime package.
- [x] MCP uses stdio transport by default.
- [x] The generated MCP command is `npx -y xtctx`.
- [x] Local transcript source files remain authoritative; `.xtctx/state/xtctx.db` is rebuildable cache state.

## Input and Output Handling

- [x] MCP handlers validate required parameters.
- [x] Session detail responses return raw local transcript messages rather than generated claims.
- [x] Setup repairs generated managed blocks while preserving user-authored text outside fences.
- [x] Stale generated references to removed tools are detected by tests.

## File Safety

- [x] Setup writes only known project/user integration files.
- [x] Existing MCP config keys outside xtctx-owned server entries are preserved.
- [x] Generated state paths are excluded from commit guidance.

## Supply Chain and Release Security

- [x] CI validates lint, tests, builds, packaging, drift checks, and security checks.
- [x] Root production dependency audit is part of the release verification path.
- [x] Release publishing uses GitHub OIDC trusted publishing.
- [x] npm publish includes provenance.
- [x] Package contents are allowlisted via `files`.
