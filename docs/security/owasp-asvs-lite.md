# OWASP ASVS Lite Checklist (xtctx)

This checklist is a lightweight baseline for release readiness. xtctx is a
local CLI/MCP tool; it does not expose an HTTP surface in the current handoff
design.

Last reviewed: 2026-08-31

## What the last review consisted of

Recorded because a date on its own says only that someone looked, not at what.

Most controls now carry a `verified-by:` citation naming the tests that back
them. `security:checklist` fails if a cited path stops existing, so a citation
cannot outlive its test — though nothing can check that a test *proves* the
control it is cited for, and that judgement remains a human one.

No count is given here. It was stated as "eight" and was silently wrong within
a week, which is the same defect as a stale citation wearing a different hat:
a number nothing recomputes. The script prints the real one on every run.

Two failure modes have now been observed in this file and are worth naming,
because both read as a passing control. A citation can name a test that does
not assert the property (a control about `files` cited a test that never reads
it). And a control can state a *property* where the risk lives in the *paths*
— "index reads are scoped" was written while two of six read paths were not,
and "a resumed scan cannot inherit a boundary decision" while one of two
resuming scrapers still could. Prefer wording that enumerates.

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
- [x] Every value an MCP tool prints outside the fence is neutralised: `session_ref`, `git_branch`, `git_commit`, `source_path`, `preview` and the match previews in the sessions tools; `handoff_id`, `session_ref`, `correlation_id` and `missing_session_refs` in the manifest; `source_pointer` in message detail. The fence protects message bodies only, so anything on a heading or a `- Field:` line can forge a line unless scrubbed. Earlier versions of this control named two of those fields. <!-- verified-by: tests/mcp/source-field-safety.test.ts -->
- [x] Setup repairs generated managed blocks while preserving user-authored text outside fences. <!-- verified-by: tests/config/managed-block.test.ts -->
- [x] Stale generated references to removed tools are detected by tests. <!-- verified-by: tests/security/surface.test.ts -->

- [x] A project re-adopts its own indexed history after its directory is renamed or moved, rather than filtering it out permanently. The reverse direction of the scoping rule, and the one no test covered: the existing case was a symlink, where both spellings resolve to one directory and the stored root already matches. <!-- verified-by: tests/handoff/project-root-scoping.test.ts -->
- [x] The session-start hook will not let its stdin payload choose which project it acts on; the host's own working directory decides, and the payload's store location is used only when it agrees. Checked by spawning the built binary, because the defect was in the wiring rather than in the comparison — a unit test of the check itself passed while it compared a value with itself. <!-- verified-by: tests/smoke/hook-payload.smoke.test.ts -->

## File Safety

- [x] Setup writes only known project/user integration files. <!-- verified-by: tests/utils/atomic-file.test.ts, tests/config/setup.test.ts -->
- [x] Existing MCP config keys outside xtctx-owned server entries are preserved. <!-- verified-by: tests/config/mcp-config.test.ts, tests/config/toml-comments.test.ts -->
- [x] Generated state paths are excluded from commit guidance.
- [x] Every index read path — both list paths, lookup by ref, message detail, keyword search, vector search — and the status counts are scoped to the project root the rows were recorded against. The first version of this control was written while both search queries were still unscoped: it named the property and not the paths, and the paths were where it was false. Defence in depth regardless — a row mis-attributed on the way in carries this project's root and is not caught here. <!-- verified-by: tests/handoff/project-root-scoping.test.ts -->
- [x] A `storePath` naming a workspace database directly is scoped like one found by walking, so a committed config cannot nominate another project's store. <!-- verified-by: tests/scrapers/attribution-boundaries.test.ts -->
- [x] Path mentions used for attribution are bounded on both sides, so a foreign path ending with this project's path does not match. <!-- verified-by: tests/scrapers/attribution-boundaries.test.ts, tests/utils/project-boundary.test.ts -->
- [x] No resuming scraper persists a trusting boundary decision it did not make. Both that record cursors are covered: codex fails closed when the project is scoped and undecided, and copilot-cli now does the same rather than defaulting to accept — and its emit guard refuses anything that is not an explicit match, not merely an undecided one. The first version of this control cited the codex test alone while copilot-cli still defaulted to trust. <!-- verified-by: tests/scrapers/codex-boundary-resume.test.ts, tests/scrapers/copilot-cli-resume-boundary.test.ts -->
- [x] State writes under `.xtctx/` go through the atomic helper, so no write lands at a predictable temp path. <!-- verified-by: tests/scrapers/state-write-safety.test.ts, tests/utils/atomic-file.test.ts -->
- [x] A `storePath` redirecting transcript reads outside the home directory is reported rather than silent. Accepted risk, not eliminated: `.xtctx/config.yaml` is committable by design, so a cloned repo can carry one, and the redirect still takes effect — what changed is that status names the affected tools. <!-- verified-by: tests/handoff/store-redirect.test.ts -->
- [x] Whether a checkout's own build is configured to run is decided by what this process is already executing, not by that checkout's `package.json`. <!-- verified-by: tests/config/self-hosted-setup.test.ts -->

## Supply Chain and Release Security

- [x] CI validates lint, tests, builds, packaging, drift checks, and security checks.
- [x] Root production dependency audit is part of the release verification path.
- [x] Release publishing uses GitHub OIDC trusted publishing. Read from `.github/workflows/publish.yml`; the cited test asserted the trigger shape rather than the publish mechanism, so the citation was removed rather than left implying more than it checked.
- [x] Releases are cut only from `main`, so a tag cannot be created on an unreviewed branch and then satisfy the publish workflow's tag check. <!-- verified-by: tests/release/release-gate.test.ts -->
- [x] npm publish includes provenance.
- [x] Package contents are allowlisted via `files` in `package.json`. Unverified by test: the cited one checked plugin manifests, not this, and a citation that does not assert the property is weaker evidence than none because it reads as though it does.
