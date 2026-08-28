# Releasing xtctx

## Forward path

1. Merge conventional-commit PRs into `main`.
2. `release-please` opens/updates a release PR (requires the
   `RELEASE_PLEASE_TOKEN` secret — the workflow fails loudly without it).
3. `auto-merge-release-pr` enables auto-merge on that PR; it merges once the
   required checks pass. Branch protection on `main` must list the `ci`
   workflow as a required check — auto-merge is only as safe as that setting.
4. Merging tags the version and creates a GitHub Release **as a draft**.
   Nothing reaches npm yet: `publish` triggers on `release: published`, and a
   draft is not published.
5. Publishing that draft — by hand, when a release is actually wanted —
   triggers `publish`: `verify:release` → `npm publish --provenance` (OIDC
   trusted publishing, no long-lived token) → a `post-publish-smoke` job
   installs the published version from the registry and runs
   `--help`/`--version` against it.

A release is **not done** until `post-publish-smoke` is green.

### Why step 5 is manual

Steps 1-4 are fully automatic, so every merge to `main` used to reach npm on
its own. Four versions shipped on 2026-08-28 and two on 2026-08-27, none of
them because anyone decided to release — the pipeline simply had no point at
which a person chose. Drafting the release puts that choice back without
giving up any of the automation before it.

The consequence is that versions accumulate as drafts, one per merge, and
publishing the newest skips the ones beneath it. That is expected: npm version
numbers may have gaps, and the older drafts can be deleted unpublished. If
that bookkeeping ever outweighs the benefit, the alternative is to stop
auto-merging the release PR instead, so the versions never get cut at all.

## Rollback

npm does not allow republishing a yanked version, so rollback means pointing
users at a known-good version and marking the bad one:

```bash
npm deprecate xtctx@<bad-version> "Broken release, use <good-version> instead"
```

```bash
npm dist-tag add xtctx@<good-version> latest
```

Both commands require an npm account with publish access to `xtctx` (OIDC
covers CI publishes only). After rolling back, revert or fix forward on
`main`; the next release supersedes the deprecation.

If the bad release also wrote broken config via `setup`, users recover with
`npx -y xtctx@latest setup --repair --yes` (rebuilds `.xtctx/state`, including
the transcript index, which is derived data).

## Post-release checklist

- [ ] `post-publish-smoke` job is green on the publish run
- [ ] `npx -y xtctx@latest --version` prints the new version
- [ ] `npm run demo:public` passes against the released build
- [ ] Landing site footer shows the new version (synced by release-please;
      see `landing/src/data/site.ts`)

## Watching for upstream format drift

xtctx reads transcript files that seven other tools write, so the risk that
matters between releases is one of those tools changing its on-disk shape.
Three signals cover it, cheapest first:

**Nightly, free — `upstream-watch`.** Checks npm for releases of the tracked
tools against `.github/upstream-versions.json` and opens one issue when a
version moves. It never claims anything is broken; it marks the moment a
format *could* have changed, which is the only time checking is worth doing.
Deduped across all issue states, so a release is reported once.

**On demand, free — `npm run capture:formats`.** Fingerprints the real stores
on your machine and diffs them against `tests/drift/fingerprints/`. Records
field names and types only, never transcript content, so the output is safe to
commit. Run it after updating a tool and using it once:

```bash
npm run capture:formats            # report the diff
npm run capture:formats -- --write # accept the new shape
```

**On demand, costs API credit — the `drift-canary` workflow.** Runs the real
CLIs against real stores and asserts the scrapers still produce chunks. The
strongest signal and the only one that proves the scraper works end to end.
Dispatch it manually when `upstream-watch` fires; it is one short prompt per
tool. Without `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` configured it exits 78
and reports that it was skipped rather than filing a false drift issue.

After confirming a new version is fine, record it in
`.github/upstream-versions.json` so the watch stops reporting it.
