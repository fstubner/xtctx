import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillDefinitions, syncToolSkills } from "@xtctx/config/skills";

describe("loadSkillDefinitions", () => {
  let configRoot = "";

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), "xtctx-skills-"));
    await mkdir(join(configRoot, "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(configRoot, { recursive: true, force: true });
  });

  it("loads skill name and content from .md files", async () => {
    await writeFile(
      join(configRoot, "skills", "my-skill.md"),
      "# My Skill\n\nDo something useful.",
      "utf-8",
    );

    const skills = await loadSkillDefinitions(configRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].content).toContain("Do something useful.");
  });

  it("returns empty array when skills directory is missing", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "xtctx-skills-empty-"));
    try {
      const skills = await loadSkillDefinitions(emptyRoot);
      expect(skills).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("loads multiple skills", async () => {
    await writeFile(join(configRoot, "skills", "alpha.md"), "Alpha content", "utf-8");
    await writeFile(join(configRoot, "skills", "beta.yaml"), "Beta content", "utf-8");

    const skills = await loadSkillDefinitions(configRoot);
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("syncToolSkills", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-skill-sync-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("writes Claude Code native skill file with frontmatter", async () => {
    const skills = [{ name: "test-skill", content: "# Test\n\nInstructions here." }];
    const result = await syncToolSkills(projectDir, skills, ["claude"]);

    expect(result.skills_loaded).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);

    const skillPath = join(projectDir, ".claude", "skills", "test-skill", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("name: test-skill");
    expect(content).toContain("Instructions here.");
  });

  it("writes Cursor native skill file as .mdc with frontmatter", async () => {
    const skills = [{ name: "my-skill", content: "Cursor skill content." }];
    const result = await syncToolSkills(projectDir, skills, ["cursor"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);

    const skillPath = join(projectDir, ".cursor", "rules", "xtctx-skill-my-skill.mdc");
    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("Cursor skill content.");
  });

  it("skips tools without native skill support", async () => {
    const skills = [{ name: "foo", content: "content" }];
    const result = await syncToolSkills(projectDir, skills, ["codex", "copilot", "gemini"]);

    expect(result.results).toHaveLength(0);
  });

  it("is idempotent — second sync skips unchanged files", async () => {
    const skills = [{ name: "stable", content: "Stable content." }];
    await syncToolSkills(projectDir, skills, ["claude"]);
    const second = await syncToolSkills(projectDir, skills, ["claude"]);

    expect(second.results[0].skipped).toBe(true);
    expect(second.results[0].updated).toBe(false);
  });
});
