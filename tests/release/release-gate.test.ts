import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Publishing to npm is irreversible — a version cannot be unpublished, only
 * deprecated — and every step before it is automatic: merging any PR opens a
 * release PR, which auto-merges itself, which cuts a release. The only thing
 * standing between a merge and the registry is that release-please marks the
 * GitHub release a draft and `publish` fires on `release: published`.
 *
 * Both halves are needed and neither is self-evident from reading one file.
 * Dropping `draft`, or widening the publish trigger to tag pushes, silently
 * restores continuous publishing — which is how four versions went out on
 * 2026-08-28 and two on 2026-08-27, none of them a decision anyone made. The
 * gap would be invisible until versions were already on npm.
 */
describe("release gate", () => {
  it("drafts the release and publishes only when a human publishes it", async () => {
    const config = JSON.parse(
      await readFile(join(process.cwd(), ".release-please-config.json"), "utf-8"),
    ) as { packages: Record<string, { draft?: boolean }> };
    const publish = await readFile(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf-8",
    );

    expect(config.packages["."].draft).toBe(true);

    // `release: published` does not fire for a draft; a tag-push trigger
    // would, which is why its absence is asserted rather than assumed.
    expect(publish).toMatch(/on:\s*\n\s*release:\s*\n\s*types:\s*\n\s*-\s*published/);
    expect(publish).not.toMatch(/^\s*push:/m);
  });
});
