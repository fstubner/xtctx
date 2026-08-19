import { join, resolve } from "node:path";
import { inspectManagedFile, pathExists } from "../config/setup.js";
import { inspectSkillStatus } from "../config/skills.js";
import { createProjectServices, type ProjectServices } from "../runtime/services.js";
import { SUPPORTED_TOOLS } from "../tools/sources.js";
import { readXtctxPackage } from "../utils/package-info.js";

export interface StatusOptions {
  projectPath?: string;
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  try {
    process.stdout.write((await renderStatusBlock(services)) + "\n");
  } finally {
    await services.sessions.close().catch(() => {});
  }
}

export async function renderStatusBlock(services: ProjectServices): Promise<string> {
  const { version } = readXtctxPackage(import.meta.url);
  const status = await services.sessions.getStatus();
  const skills = await inspectSkillStatus(services.projectRoot, services.configPath);
  const configPresent = await pathExists(services.configPath);
  const managed = await Promise.all(
    managedTargets(services.projectRoot).map(async (target) => ({
      ...target,
      ...(await inspectManagedFile(target.path)),
    })),
  );

  const lines: string[] = [];
  lines.push(`xtctx ${version} - handoff status`);
  lines.push("");
  lines.push(`Project  ${services.projectRoot}`);
  lines.push(`Config   ${configPresent ? services.configPath : "missing (run xtctx setup)"}`);
  lines.push(`Index    ${services.dbPath}`);
  lines.push(`MCP      npx -y xtctx`);
  lines.push(`Scan     ${status.last_scan_at ?? "never"}`);
  lines.push(
    `Data     ${status.sessions} sessions, ${status.messages} messages, ` +
      `${status.retrieval_units} retrieval windows, ${status.vectorized_units} vectorized`,
  );
  if (status.last_scan_at === null && status.sessions === 0) {
    lines.push("Next     No sessions are indexed yet. Ask a configured agent to call xtctx_recent_sessions.");
  }
  lines.push("");
  lines.push("Tools:");

  for (const tool of status.tools) {
    const definition = SUPPORTED_TOOLS.find((item) => item.id === tool.tool);
    const hook = definition?.hookMode ?? "mcp-only";
    const marker = tool.detected ? "+" : "-";
    const error = tool.last_error ? `; last scrape error: ${tool.last_error}` : "";
    lines.push(
      `  ${marker} ${tool.tool.padEnd(13)} ${tool.detected ? "detected" : "not detected"}; ` +
        `${tool.indexed_sessions} sessions; hook: ${hook}${error}`,
    );
    // `.xtctx/config.yaml` is committable, so a cloned repo can point a
    // scraper at any directory on disk. Overrides stay legal but visible.
    const custom = customStorePaths(definition, tool.store_paths);
    for (const path of custom) {
      lines.push(`      custom store path (not the ${tool.tool} default): ${path}`);
    }
  }

  lines.push("");
  lines.push("Skills:");
  lines.push(`  Source ${skills.sourceDir}`);
  for (const skill of skills.selected) {
    const marker = skill.exists ? "ok" : "missing";
    const hash = skill.hash ? ` ${skill.hash.slice(0, 18)}` : "";
    lines.push(`  ${marker.padEnd(8)} ${skill.id}${hash}`);
  }
  for (const target of skills.targets) {
    const skillPart = target.skillId ? ` ${target.skillId}` : "";
    const pathPart = target.path ? ` ${target.path}` : "";
    lines.push(`  ${target.state.padEnd(13)} ${target.tool} ${target.mode}${skillPart}${pathPart}`);
  }

  lines.push("");
  lines.push("Managed files:");
  for (const file of managed) {
    const state = !file.exists
      ? "missing"
      : file.blockCount === 1 && file.staleReferences.length === 0
        ? "ok"
        : "needs repair";
    const details = [];
    if (file.blockCount !== 1) {
      details.push(`${file.blockCount} xtctx blocks`);
    }
    if (file.staleReferences.length > 0) {
      details.push(`stale: ${file.staleReferences.join(", ")}`);
    }
    lines.push(`  ${state.padEnd(12)} ${file.label} ${file.path}${details.length ? ` (${details.join("; ")})` : ""}`);
  }

  return lines.join("\n");
}

function managedTargets(projectRoot: string): Array<{ label: string; path: string }> {
  return [
    { label: "codex/opencode", path: join(projectRoot, "AGENTS.md") },
    { label: "claude-code", path: join(projectRoot, "CLAUDE.md") },
    { label: "antigravity", path: join(projectRoot, "GEMINI.md") },
    { label: "cursor", path: join(projectRoot, ".cursor", "rules", "xtctx.mdc") },
    { label: "copilot", path: join(projectRoot, ".github", "copilot-instructions.md") },
  ];
}

/** Store paths that differ from the tool's built-in default location. */
function customStorePaths(
  definition: (typeof SUPPORTED_TOOLS)[number] | undefined,
  storePaths: string[],
): string[] {
  if (!definition) {
    return [];
  }

  let fallback: string;
  try {
    fallback = normalizePath(definition.defaultStorePath());
  } catch {
    return [];
  }

  return storePaths.filter((path) => normalizePath(path) !== fallback);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
