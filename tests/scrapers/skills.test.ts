import { describe, expect, it } from "vitest";
import { extractSkillsFromText, extractSkillsFromToolCalls } from "../../src/scrapers/skills.js";

describe("extractSkills", () => {
  it("extracts skill name from SKILL.md file paths", () => {
    const text = 'Reading C:\\Users\\Felix\\.agents\\skills\\product-acceptance\\SKILL.md for guidance';
    expect(extractSkillsFromText(text)).toEqual(["product-acceptance"]);
  });

  it("extracts multiple distinct skills from text", () => {
    const text = 'Checked /repo/skills/engineering-assessment/SKILL.md and .claude/skills/code-smells/SKILL.md';
    expect(extractSkillsFromText(text)).toEqual(["code-smells", "engineering-assessment"]);
  });

  it("ignores builtin / generic directories without skill name", () => {
    const text = 'cat /skills/SKILL.md';
    expect(extractSkillsFromText(text)).toBeUndefined();
  });

  it("extracts from first-class Skill tool call", () => {
    const calls = [
      { name: "Skill", input: { skill: "product-build" } },
    ];
    expect(extractSkillsFromToolCalls(calls)).toEqual(["product-build"]);
  });

  it("extracts from file read tool calls", () => {
    const calls = [
      { name: "read_file", args: { Path: "H:/projects/private/needs-work/agent-skills/skills/testing-strategy/SKILL.md" } },
      { name: "Read", input: { file_path: "C:\\Users\\test\\.cursor\\skills\\data-modeling\\SKILL.md" } },
    ];
    expect(extractSkillsFromToolCalls(calls)).toEqual(["data-modeling", "testing-strategy"]);
  });

  it("returns undefined when no skills are present", () => {
    expect(extractSkillsFromText("plain conversation without skills")).toBeUndefined();
    expect(extractSkillsFromToolCalls([{ name: "read_file", args: { Path: "src/main.rs" } }])).toBeUndefined();
  });
});
