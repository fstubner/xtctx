import { join, resolve } from "node:path";
import { inspectManagedFile, pathExists } from "../config/setup.js";
import { createProjectServices, type ProjectServices } from "../runtime/services.js";
import { SUPPORTED_TOOLS } from "../tools/sources.js";
import { readXtctxPackage } from "../utils/package-info.js";

export interface StatusOptions {
  projectPath?: string;
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  process.stdout.write((await renderStatusBlock(services)) + "\n");
}

export async function renderStatusBlock(services: ProjectServices): Promise<string> {
  const { version } = readXtctxPackage(import.meta.url);
  const status = await services.sessions.getStatus();
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
  lines.push("");
  lines.push("Tools:");

  for (const tool of status.tools) {
    const definition = SUPPORTED_TOOLS.find((item) => item.id === tool.tool);
    const hook = definition?.hookMode ?? "mcp-only";
    const marker = tool.detected ? "+" : "-";
    lines.push(
      `  ${marker} ${tool.tool.padEnd(13)} ${tool.detected ? "detected" : "not detected"}; ` +
        `${tool.indexed_sessions} sessions; hook: ${hook}`,
    );
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
    { label: "gemini", path: join(projectRoot, "GEMINI.md") },
    { label: "cursor", path: join(projectRoot, ".cursor", "rules", "xtctx.mdc") },
    { label: "copilot", path: join(projectRoot, ".github", "copilot-instructions.md") },
  ];
}
