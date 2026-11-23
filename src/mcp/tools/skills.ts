import type { SessionService } from "../../handoff/types.js";
import { inlineSafe } from "../../utils/untrusted-text.js";

interface SkillUsageParams {
  days?: number;
  tool?: string;
  skill?: string;
  format?: "markdown" | "json";
}

export function createSkillUsageHandler(service: Pick<SessionService, "getSkillUsage">) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as SkillUsageParams;
    if (typeof service.getSkillUsage !== "function") {
      throw new Error("Skill usage telemetry is not supported by this index.");
    }
    const stats = await service.getSkillUsage({
      days: params.days,
      tool: params.tool,
      skill: params.skill,
    });

    if (params.format === "json") {
      const totalInvocations = stats.reduce((acc, s) => acc + s.total_count, 0);
      return {
        total_skills: stats.length,
        total_invocations: totalInvocations,
        filter: {
          days: params.days ?? null,
          tool: params.tool ?? null,
          skill: params.skill ?? null,
        },
        skills: stats,
      };
    }

    if (stats.length === 0) {
      return "No skill usage recorded for the specified criteria.";
    }

    const totalInvocations = stats.reduce((acc, s) => acc + s.total_count, 0);
    const filterParts: string[] = [];
    if (params.days) filterParts.push(`last ${params.days} days`);
    if (params.tool) filterParts.push(`tool: ${params.tool}`);
    if (params.skill) filterParts.push(`skill: ${params.skill}`);
    const filterDesc = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

    const lines = [
      `## Skill Telemetry${filterDesc}`,
      "",
      `Total Invocations: ${totalInvocations} across ${stats.length} skills`,
      "",
      "| Skill | Uses | Sessions | Last Used | By Agent |",
      "|---|---|---|---|---|",
    ];

    for (const stat of stats) {
      const byAgent = Object.entries(stat.by_tool)
        .map(([tool, count]) => `${inlineSafe(tool)}: ${count}`)
        .join(", ");
      lines.push(
        `| ${inlineSafe(stat.skill)} | ${stat.total_count} | ${stat.session_count} | ${inlineSafe(stat.last_used_at)} | ${byAgent} |`,
      );
    }

    return lines.join("\n");
  };
}
