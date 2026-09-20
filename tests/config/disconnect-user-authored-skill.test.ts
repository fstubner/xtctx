/**
 * `disconnect` must not delete a skill file the user wrote.
 *
 * Setup offers skills it discovers in the project, and one of the places it
 * looks is `.claude/skills/` -- which is also where the claude-code sync
 * target is written. For that tool the two are the same path, so selecting
 * your own pre-existing project skill at setup made disconnect delete the
 * original.
 *
 * A content hash cannot tell these apart: the synced copy is byte-identical
 * to the canonical one precisely because xtctx copied it from there. What
 * distinguishes them is provenance, which `.xtctx/config.yaml` already
 * records as `skills.selected.<id>.source`.
 *
 * PRODUCT.md: "Setup is reversible: `xtctx disconnect` removes xtctx's
 * management without deleting transcript data."
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeSyncedSkillsForTools } from "@xtctx/config/skills";

let projectRoot: string;

const USER_SKILL = `---
name: my-own-skill
description: A skill the user wrote themselves, long before xtctx existed.
---

# My own skill

Do the thing the way this team does it.
`;

async function writeSkill(root: string, dir: string, id: string, body: string): Promise<string> {
  const path = join(root, ...dir.split("/"), id, "SKILL.md");
  await mkdir(join(root, ...dir.split("/"), id), { recursive: true });
  await writeFile(path, body, "utf-8");
  return path;
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "xtctx-skill-disconnect-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("removeSyncedSkillsForTools", () => {
  it("keeps a claude-code skill whose sync target is where the user authored it", async () => {
    const authored = await writeSkill(projectRoot, ".claude/skills", "my-own-skill", USER_SKILL);
    // Setup copies a selected skill into the canonical store and records where
    // it came from.
    await writeSkill(projectRoot, ".xtctx/skills", "my-own-skill", USER_SKILL);
    await mkdir(join(projectRoot, ".xtctx"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      [
        "skills:",
        "  selected:",
        "    my-own-skill:",
        "      hash: sha256:whatever",
        "      source: .claude/skills/my-own-skill/SKILL.md",
        "",
      ].join("\n"),
      "utf-8",
    );

    await removeSyncedSkillsForTools(projectRoot, ["claude-code"]);

    expect(await readFile(authored, "utf-8")).toBe(USER_SKILL);
  });

  it("still removes a skill xtctx put there itself", async () => {
    const synced = await writeSkill(projectRoot, ".claude/skills", "xtctx-handoff", USER_SKILL);
    await writeSkill(projectRoot, ".xtctx/skills", "xtctx-handoff", USER_SKILL);
    await mkdir(join(projectRoot, ".xtctx"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      [
        "skills:",
        "  selected:",
        "    xtctx-handoff:",
        "      hash: sha256:whatever",
        "      source: <built-in>",
        "",
      ].join("\n"),
      "utf-8",
    );

    const writes = await removeSyncedSkillsForTools(projectRoot, ["claude-code"]);

    await expect(readFile(synced, "utf-8")).rejects.toThrow();
    expect(writes.some((write) => write.changed)).toBe(true);
  });
});
