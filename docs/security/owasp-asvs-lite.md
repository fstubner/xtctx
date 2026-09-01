# OWASP ASVS Lite Checklist (xtctx)

This checklist is a lightweight baseline for release readiness. xtctx is a
local CLI/MCP tool; it does not expose an HTTP surface in the current handoff
design.

Last reviewed: 2026-08-31

## What the last review consisted of

Recorded because a date on its own says only that someone looked, not at what.

Eight controls now carry a `verified-by:` citation naming the tests that back
them. `security:checklist` fails if a cited path stops existing, so a citation
cannot outlive its test — though nothing can check that a test proves the
control it is cited for, and that judgement remains a human one.

Checked directly during this review rather than by test: no `src/api` remains
and nothing in `src/` calls `listen()` or `createServer()`, so no HTTP service
is shipped; `package.json` `files` is `["dist", "README.md", "LICENSE",
"CHANGELOG.md"]`.

Two controls were wrong and were corrected rather than re-ticked:

- **MCP handlers validate required parameters** was false. `xtctx_handoff_manifest`
  passed `tool_filter` and `branch_filter` straight through while the other four
  tools refused a bare string where an array belongs, so asking for one tool
  silently returned every tool. Fixed in #297; the validator is now shared.
- **The generated MCP command** claim did not mention that a checkout of xtctx
  itself gets the local `dist` entry point, which is a deliberate exception and
  is now stated.

Still resting on reading rather than execution: the claims about transcript
files remaining authoritative, session detail returning raw messages rather
than generated ones, and generated state paths being excluded from commit
guidance. Those are design statements about intent, and a checklist is the
right place for them precisely because no test can hold them.

## Local-Only Execution

- [x] No local HTTP service is shipped in the runtime package.
- [x] MCP uses stdio transport by default. <!-- verified-by: tests/mcp/server.test.ts -->
- [x] The generated MCP command is `npx -y xtctx`, except in a checkout of xtctx itself, where setup writes the local `dist` entry point instead. <!-- verified-by: tests/config/self-hosted-setup.test.ts -->
- [x] Local transcript source files remain authoritative; `.xtctx/state/xtctx.db` is rebuildable cache state.

## Input and Output Handling

- [x] MCP handlers validate required parameters. <!-- verified-by: tests/mcp/hardening.test.ts, tests/mcp/manifest.test.ts -->
- [x] Session detail responses return raw local transcript messages rather than generated claims.
- [x] Setup repairs generated managed blocks while preserving user-authored text outside fences. <!-- verified-by: tests/config/managed-block.test.ts -->
- [x] Stale generated references to removed tools are detected by tests. <!-- verified-by: tests/security/surface.test.ts -->

## File Safety

- [x] Setup writes only known project/user integration files. <!-- verified-by: tests/utils/atomic-file.test.ts, tests/config/setup.test.ts -->
- [x] Existing MCP config keys outside xtctx-owned server entries are preserved. <!-- verified-by: tests/config/mcp-config.test.ts, tests/config/toml-comments.test.ts -->
- [x] Generated state paths are excluded from commit guidance.
- [x] Index reads are scoped to the project root the rows were recorded against, so an index that outlives its project does not serve the old path's conversations. Defence in depth only: a row mis-attributed on the way in carries this project's root. <!-- verified-by: tests/handoff/project-root-scoping.test.ts -->
- [x] A `storePath` naming a workspace database directly is scoped like one found by walking, so a committed config cannot nominate another project's store. <!-- verified-by: tests/scrapers/attribution-boundaries.test.ts -->
- [x] Path mentions used for attribution are bounded on both sides, so a foreign path ending with this project's path does not match. <!-- verified-by: tests/scrapers/attribution-boundaries.test.ts, tests/utils/project-boundary.test.ts -->
- [x] A resumed scan cannot inherit a boundary decision made before a refused record. <!-- verified-by: tests/scrapers/codex-boundary-resume.test.ts -->
- [x] State writes under `.xtctx/` go through the atomic helper, so no write lands at a predictable temp path. <!-- verified-by: tests/scrapers/state-write-safety.test.ts, tests/utils/atomic-file.test.ts -->
- [x] A `storePath` redirecting transcript reads outside the home directory is reported rather than silent. Accepted risk, not eliminated: `.xtctx/config.yaml` is committable by design, so a cloned repo can carry one, and the redirect still takes effect — what changed is that status names the affected tools. <!-- verified-by: tests/handoff/store-redirect.test.ts -->
- [x] Whether a checkout's own build is configured to run is decided by what this process is already executing, not by that checkout's `package.json`. <!-- verified-by: tests/config/self-hosted-setup.test.ts -->

## Supply Chain and Release Security

- [x] CI validates lint, tests, builds, packaging, drift checks, and security checks.
- [x] Root production dependency audit is part of the release verification path.
- [x] Release publishing uses GitHub OIDC trusted publishing. <!-- verified-by: tests/release/release-gate.test.ts -->
- [x] Releases are cut only from `main`, so a tag cannot be created on an unreviewed branch and then satisfy the publish workflow's tag check. <!-- verified-by: tests/release/release-gate.test.ts -->
- [x] npm publish includes provenance.
- [x] Package contents are allowlisted via `files`. <!-- verified-by: tests/release/plugin-package.test.ts -->
