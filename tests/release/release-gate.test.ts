import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Publishing to npm is irreversible — a version cannot be unpublished, only
 * deprecated — so what triggers a release is a safety property, not a
 * convenience.
 *
 * Two shapes have failed here. First, `publish` fired on `release: published`
 * while release-please marked releases as drafts, so a draft published
 * nothing. That worked and broke the release process: GitHub's
 * `releases/latest` endpoint hides drafts, release-please read it to find the
 * last release, so it saw the last pre-draft version forever, proposed a
 * release covering the entire history, auto-merge landed it, and the resulting
 * draft was invisible again. Fifty-four versions in an hour.
 *
 * Second, with drafts gone, merging any `fix:`/`feat:` PR opened a release PR
 * that another workflow auto-merged within seconds — so merging a change was
 * itself a release. Five versions went out between 09:34 and 16:58 on
 * 2026-08-30, none of them awaited. A per-day ceiling was tried and was the
 * wrong shape; the automatic path was removed instead.
 *
 * What replaced both: one manual `release` workflow that cuts and publishes,
 * and `publish` reachable on its own for a version tagged earlier. These tests
 * assert that shape and, more importantly, the absence of any way back to an
 * automatic one.
 */

const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");

/** Triggers that fire without a person deciding to. */
const AUTOMATIC_TRIGGERS = ["push", "pull_request", "pull_request_target", "release", "schedule", "repository_dispatch"];

async function readWorkflow(name: string): Promise<string> {
  // Normalized: a Windows checkout converts these to CRLF, and the
  // line-anchored parsing below silently matches nothing against it.
  return (await readFile(join(WORKFLOW_DIR, name), "utf-8")).replace(/\r\n/g, "\n");
}

function topLevelTriggers(workflow: string): string[] {
  const block = /\non:\n((?:[ \t]+.*\n|\n)*)/.exec(workflow)?.[1] ?? "";
  return block
    .split("\n")
    // Two-space indent identifies a trigger key; `#` excludes the comments
    // that sit at the same indent and would otherwise read as trigger names.
    .filter((line) => /^ {2}\S/.test(line) && !/^\s*#/.test(line))
    .map((line) => line.trim().replace(/:.*$/, ""));
}

describe("release gate", () => {
  it("publishes only when a person asks, directly or through the release workflow", async () => {
    const publish = await readWorkflow("publish.yml");
    const triggers = topLevelTriggers(publish);

    // `workflow_call` is how `release.yml` reuses this job rather than
    // duplicating the tag check, the verify gate and the OIDC publish. It adds
    // no automatic path of its own: a called workflow only runs when its
    // caller does, and the caller is manual.
    expect(triggers.sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    for (const trigger of AUTOMATIC_TRIGGERS) {
      expect(triggers, `publish.yml must not run on ${trigger}`).not.toContain(trigger);
    }

    // And the dispatch itself is confirmed, not a bare button.
    expect(publish).toMatch(/confirm/);
  });

  it("cuts a release only on manual dispatch", async () => {
    const release = await readWorkflow("release.yml");

    expect(topLevelTriggers(release)).toEqual(["workflow_dispatch"]);
    expect(release).toMatch(/confirm/);
  });

  it("has no workflow that creates a release or tag on an automatic trigger", async () => {
    // The broadest form of the guarantee: it does not matter what a future
    // workflow is called, only that nothing reaches `gh release create`,
    // `npm publish` or a tag push without someone starting it.
    const offenders: string[] = [];
    for (const file of await readdir(WORKFLOW_DIR)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const workflow = await readWorkflow(file);
      const cuts =
        /gh release create/.test(workflow) ||
        /npm publish/.test(workflow) ||
        /git push .*(--tags|"?\$TAG)/.test(workflow);
      if (!cuts) continue;

      const triggers = topLevelTriggers(workflow);
      if (triggers.some((trigger) => AUTOMATIC_TRIGGERS.includes(trigger))) {
        offenders.push(`${file} (${triggers.join(", ")})`);
      }
    }

    expect(offenders, "workflows that release on an automatic trigger").toEqual([]);
  });

  it("no longer carries the release-please config whose draft flag caused the loop", async () => {
    // Deleted with the automatic pipeline. Asserting its absence keeps the
    // 54-versions-in-an-hour failure from being reintroduced by restoring the
    // tooling without the reasoning.
    const entries = await readdir(process.cwd());
    expect(entries.filter((name) => name.startsWith(".release-please"))).toEqual([]);
  });
});
