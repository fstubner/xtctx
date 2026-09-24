/**
 * A project's copy of the built-in skill can go stale, and status has to say so.
 *
 * Setup copies `builtInHandoffSkill()` into `.xtctx/skills/` once. Everything
 * after that compares the SYNCED targets against that copy — so a project set
 * up before the text changed keeps the old wording, every target agrees with
 * it, and `xtctx status` reports `ok`.
 *
 * That is not hypothetical. The skill told agents "no xtctx setup is required"
 * and that the retrieval tools were "worth calling anyway" in an unconfigured
 * project, while the server refuses all five tools there. The text was
 * corrected at the source; every project already set up kept the old one, with
 * nothing reporting it.
 *
 * The skill is instructions to an agent, so a stale copy is an instruction to
 * keep calling tools that will not answer.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_SKILL_ID, builtInHandoffSkill, inspectSkillStatus } from "@xtctx/config/skills";

let projectRoot = "";
let configPath = "";

async function writeCanonicalSkill(content: string): Promise<void> {
  const dir = join(projectRoot, ".xtctx", "skills", BUILT_IN_SKILL_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "xtctx-stale-skill-"));
  configPath = join(projectRoot, ".xtctx", "config.yaml");
  await mkdir(join(projectRoot, ".xtctx"), { recursive: true });
  await writeFile(
    configPath,
    ["skills:", "  selected:", `    ${BUILT_IN_SKILL_ID}:`, "      hash: sha256:whatever", ""].join("\n"),
    "utf-8",
  );
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("inspectSkillStatus", () => {
  it("flags a built-in skill whose copy predates this version", async () => {
    // The exact wording that shipped before the correction.
    await writeCanonicalSkill(
      builtInHandoffSkill().replace(
        "# xtctx Handoff",
        "# xtctx Handoff\n\nno xtctx setup is required.",
      ),
    );

    const status = await inspectSkillStatus(projectRoot, configPath);
    const builtIn = status.selected.find((skill) => skill.id === BUILT_IN_SKILL_ID);

    expect(builtIn?.exists).toBe(true);
    expect(builtIn?.staleBuiltIn).toBe(true);
  });

  it("says nothing when the copy matches what this version ships", async () => {
    await writeCanonicalSkill(builtInHandoffSkill());

    const status = await inspectSkillStatus(projectRoot, configPath);
    const builtIn = status.selected.find((skill) => skill.id === BUILT_IN_SKILL_ID);

    expect(builtIn?.exists).toBe(true);
    expect(builtIn?.staleBuiltIn).toBeUndefined();
  });

  it("does not claim staleness for a skill that is not the built-in one", async () => {
    // A user's own skill is theirs; differing from the built-in text is what
    // it is supposed to do.
    const dir = join(projectRoot, ".xtctx", "skills", "my-own-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: my-own-skill\n---\n\n# Mine\n", "utf-8");
    await writeFile(
      configPath,
      ["skills:", "  selected:", "    my-own-skill:", "      hash: sha256:whatever", ""].join("\n"),
      "utf-8",
    );

    const status = await inspectSkillStatus(projectRoot, configPath);
    const own = status.selected.find((skill) => skill.id === "my-own-skill");

    expect(own?.exists).toBe(true);
    expect(own?.staleBuiltIn).toBeUndefined();
  });
});
