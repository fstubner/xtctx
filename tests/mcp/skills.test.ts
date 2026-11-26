import { describe, expect, it } from "vitest";
import { createSkillUsageHandler } from "@xtctx/mcp/tools/skills";
import type { SessionService, SkillUsageQueryOptions, SkillUsageStat } from "@xtctx/handoff/types";

class MockSessionService implements Pick<SessionService, "getSkillUsage"> {
  constructor(private readonly stats: SkillUsageStat[] = []) {}

  async getSkillUsage(options?: SkillUsageQueryOptions): Promise<SkillUsageStat[]> {
    let filtered = [...this.stats];
    if (options?.tool) {
      filtered = filtered.filter((s) => s.by_tool[options.tool!] !== undefined);
    }
    if (options?.skill) {
      filtered = filtered.filter((s) => s.skill.toLowerCase() === options.skill!.toLowerCase());
    }
    return filtered;
  }
}

describe("MCP xtctx_skill_usage handler", () => {
  const sampleStats: SkillUsageStat[] = [
    {
      skill: "agent-skills:product-build",
      total_count: 5,
      last_used_at: "2026-11-01T12:00:00.000Z",
      by_tool: { "claude-code": 3, antigravity: 2 },
      session_count: 3,
    },
    {
      skill: "superpowers:system-architecture",
      total_count: 2,
      last_used_at: "2026-10-31T08:00:00.000Z",
      by_tool: { codex: 2 },
      session_count: 1,
    },
  ];

  it("returns formatted markdown by default", async () => {
    const handler = createSkillUsageHandler(new MockSessionService(sampleStats));
    const result = (await handler({})) as string;

    expect(result).toContain("## Skill Telemetry");
    expect(result).toContain("Total Invocations: 7 across 2 skills");
    expect(result).toContain("| agent-skills:product-build | 5 | 3 | 2026-11-01T12:00:00.000Z | claude-code: 3, antigravity: 2 |");
    expect(result).toContain("| superpowers:system-architecture | 2 | 1 | 2026-10-31T08:00:00.000Z | codex: 2 |");
  });

  it("returns json when requested", async () => {
    const handler = createSkillUsageHandler(new MockSessionService(sampleStats));
    const result = (await handler({ format: "json" })) as Record<string, unknown>;

    expect(result.total_skills).toBe(2);
    expect(result.total_invocations).toBe(7);
    expect(result.skills).toEqual(sampleStats);
  });

  it("handles empty results in markdown and json", async () => {
    const handler = createSkillUsageHandler(new MockSessionService([]));
    const mdResult = await handler({});
    expect(mdResult).toBe("No skill usage recorded for the specified criteria.");

    const jsonResult = (await handler({ format: "json" })) as Record<string, unknown>;
    expect(jsonResult.total_skills).toBe(0);
    expect(jsonResult.total_invocations).toBe(0);
    expect(jsonResult.skills).toEqual([]);
  });

  it("passes tool and skill filters", async () => {
    const handler = createSkillUsageHandler(new MockSessionService(sampleStats));
    const result = (await handler({ tool: "codex", format: "json" })) as {
      total_skills: number;
      skills: SkillUsageStat[];
    };

    expect(result.total_skills).toBe(1);
    expect(result.skills[0].skill).toBe("superpowers:system-architecture");
  });
});
