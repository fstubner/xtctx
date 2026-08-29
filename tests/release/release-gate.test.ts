import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Publishing to npm is irreversible — a version cannot be unpublished, only
 * deprecated — and every step before it is automatic: merging any PR opens a
 * release PR, which auto-merges itself, which cuts a release. The only thing
 * between a merge and the registry is that `publish` runs on manual dispatch
 * and nothing else.
 *
 * The first attempt at this gate put the brake somewhere else: release-please
 * marked releases as drafts, and `publish` fired on `release: published`, so a
 * draft published nothing. That worked, and broke the release process. GitHub's
 * `releases/latest` endpoint hides drafts, release-please reads it to find the
 * last release, so it saw the last pre-draft version forever, proposed a
 * release covering the entire history, auto-merge landed it, and the resulting
 * draft was invisible again. Fifty-four versions in an hour.
 *
 * So this asserts the shape that replaced it, and asserts the absence of the
 * one that failed. Both halves matter: an event trigger returning to this
 * workflow restores automatic publishing, and `draft` returning to the
 * release-please config restores the loop.
 */
describe("release gate", () => {
  it("publishes only on manual dispatch", async () => {
    // Normalized: a Windows checkout converts this file to CRLF, and the
    // line-anchored parsing below silently matches nothing against it.
    const publish = (
      await readFile(join(process.cwd(), ".github", "workflows", "publish.yml"), "utf-8")
    ).replace(/\r\n/g, "\n");

    // The trigger block must contain workflow_dispatch and nothing else. Any
    // event trigger here — `release`, `push`, `schedule` — publishes without a
    // person deciding to.
    const triggers = /\non:\n((?:[ \t]+.*\n|\n)*)/.exec(publish)?.[1] ?? "";
    const topLevel = triggers
      .split("\n")
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().replace(/:.*$/, ""));
    expect(topLevel).toEqual(["workflow_dispatch"]);

    // And the dispatch itself is confirmed, not a bare button.
    expect(publish).toMatch(/confirm/);
  });

  it("does not draft releases, which is what hid them from release-please", async () => {
    const config = JSON.parse(
      await readFile(join(process.cwd(), ".release-please-config.json"), "utf-8"),
    ) as { packages: Record<string, { draft?: boolean }> };

    expect(config.packages["."].draft).toBeUndefined();
  });
});
