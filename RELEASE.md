# Releasing xtctx

## Forward path

1. Merge conventional-commit PRs into `main`.
2. `release-please` opens/updates a release PR (requires the
   `RELEASE_PLEASE_TOKEN` secret — the workflow fails loudly without it).
3. `auto-merge-release-pr` enables auto-merge on that PR; it merges once the
   required checks pass. Branch protection on `main` must list the `ci`
   workflow as a required check — auto-merge is only as safe as that setting.
4. Merging creates a GitHub Release, which triggers `publish`:
   `verify:release` → `npm publish --provenance` (OIDC trusted publishing,
   no long-lived token) → a `post-publish-smoke` job installs the published
   version from the registry and runs `--help`/`--version` against it.

A release is **not done** until `post-publish-smoke` is green.

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
