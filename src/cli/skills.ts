import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectServices } from "../runtime/services.js";

export interface SkillsOptions {
  projectPath?: string;
  agent?: string;
  days?: number;
  skill?: string;
  json?: boolean;
}

export async function runSkills(options: SkillsOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());

  if (!existsSync(projectRoot)) {
    process.stderr.write(`No such directory: ${projectRoot}\n`);
    process.exitCode = 1;
    return;
  }

  const services = await createProjectServices(projectRoot, { createIfMissing: false });
  try {
    if (!services.config.present) {
      process.stderr.write(
        `xtctx is not configured in ${projectRoot}. Run 'xtctx setup' first.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (typeof services.sessions.getSkillUsage !== "function") {
      process.stderr.write("Skill usage is not supported by this index.\n");
      process.exitCode = 1;
      return;
    }

    const stats = await services.sessions.getSkillUsage({
      days: options.days,
      tool: options.agent,
      skill: options.skill,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
      return;
    }

    if (stats.length === 0) {
      process.stdout.write("No skill usage found for the specified criteria.\n");
      return;
    }

    const totalInvocations = stats.reduce((acc, s) => acc + s.total_count, 0);
    const filterParts: string[] = [];
    if (options.days) filterParts.push(`last ${options.days} days`);
    if (options.agent) filterParts.push(`agent: ${options.agent}`);
    if (options.skill) filterParts.push(`skill: ${options.skill}`);
    const filterDesc = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

    process.stdout.write(`\nSkill Usage Telemetry${filterDesc}\n`);
    process.stdout.write(`Total Invocations: ${totalInvocations} across ${stats.length} skills\n\n`);

    const colSkill = Math.max(28, ...stats.map((s) => s.skill.length));
    const colUses = 6;
    const colSessions = 10;
    const colLastUsed = 22;

    const header =
      "SKILL".padEnd(colSkill) +
      " " +
      "USES".padStart(colUses) +
      " " +
      "SESSIONS".padStart(colSessions) +
      " " +
      "LAST USED".padEnd(colLastUsed) +
      " " +
      "BY AGENT";
    process.stdout.write(`${header}\n`);
    process.stdout.write(`${"-".repeat(header.length + 15)}\n`);

    for (const stat of stats) {
      const byAgent = Object.entries(stat.by_tool)
        .map(([agent, count]) => `${agent}: ${count}`)
        .join(", ");
      const formattedDate = stat.last_used_at.slice(0, 19).replace("T", " ");
      const row =
        stat.skill.padEnd(colSkill) +
        " " +
        String(stat.total_count).padStart(colUses) +
        " " +
        String(stat.session_count).padStart(colSessions) +
        " " +
        formattedDate.padEnd(colLastUsed) +
        " " +
        byAgent;
      process.stdout.write(`${row}\n`);
    }
    process.stdout.write("\n");
  } finally {
    await services.sessions.close().catch(() => {});
  }
}
