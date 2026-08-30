/**
 * `writeFileAtomic` writes files owned by other tools, and some of them are
 * executable surfaces — `.claude/settings.json` holds hook commands Claude
 * Code runs. The directory it writes into is derived from the project root,
 * and a cloned repo can commit `.claude` as a symlink pointing anywhere, so
 * without a containment check `xtctx setup` writes through it.
 *
 * `mkdir -p` follows symlinked directories and will happily build the rest of
 * the subtree on the far side, so the escape needs no privilege beyond the
 * ability to commit a symlink.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "@xtctx/utils/atomic-file";

/**
 * Link a directory, using whatever the platform allows.
 *
 * Plain directory symlinks need developer mode or elevation on Windows, but
 * junctions need neither and redirect writes identically — so falling back to
 * one is what keeps this suite testing the actual escape there rather than
 * skipping and going green regardless. A test that cannot fail is worth less
 * than no test.
 */
async function linkDir(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, "dir");
  } catch {
    await symlink(target, linkPath, "junction");
  }
}

describe("writeFileAtomic containment", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-atomic-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked parent directory", async () => {
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });

    // The shape a hostile repo ships: `.claude` committed as a symlink.
    await linkDir(outside, join(project, ".claude"));

    await expect(
      writeFileAtomic(join(project, ".claude", "settings.json"), '{"hooks":"pwned"}', {
        containWithin: project,
      }),
    ).rejects.toThrow();

    // Nothing may land on the far side of the link.
    await expect(lstat(join(outside, "settings.json"))).rejects.toThrow();
  });

  it("refuses when the target path itself is a symlink pointing outside", async () => {
    const project = join(root, "project2");
    const outside = join(root, "outside2");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "victim.md"), "original", "utf-8");

    // A file symlink still needs privilege on Windows; where it is refused
    // the equivalent escape is covered by the junction cases above.
    try {
      await symlink(join(outside, "victim.md"), join(project, "CLAUDE.md"), "file");
    } catch {
      return;
    }

    await expect(
      writeFileAtomic(join(project, "CLAUDE.md"), "clobbered", { containWithin: project }),
    ).rejects.toThrow();

    expect(await readFile(join(outside, "victim.md"), "utf-8")).toBe("original");
  });

  it("still writes normally inside the project, including new subdirectories", async () => {
    // The guard must not break the ordinary path: setup creates nested
    // directories like .claude/skills/<id>/ on a clean checkout.
    const project = join(root, "project3");
    await mkdir(project, { recursive: true });

    const target = join(project, ".claude", "skills", "demo", "SKILL.md");
    await writeFileAtomic(target, "hello", { containWithin: project });

    expect(await readFile(target, "utf-8")).toBe("hello");
  });

  it("writes without a containment root, preserving existing callers", async () => {
    const target = join(root, "plain", "file.md");
    await writeFileAtomic(target, "hi");
    expect(await readFile(target, "utf-8")).toBe("hi");
  });

  it("leaves no temp file behind when it refuses", async () => {
    const project = join(root, "project4");
    const outside = join(root, "outside4");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });

    await linkDir(outside, join(project, ".cursor"));

    await expect(
      writeFileAtomic(join(project, ".cursor", "rules.mdc"), "x", { containWithin: project }),
    ).rejects.toThrow();

    await expect(lstat(join(outside, "rules.mdc.xtctx-tmp"))).rejects.toThrow();
  });
});
