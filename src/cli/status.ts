import { existsSync } from "node:fs";
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
  if (status.embedding_error) {
    lines.push(`Search   semantic unavailable (keyword only): ${status.embedding_error}`);
  }
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
    const error = tool.last_error ? `; last scrape error: ${tool.last_error}` : "";
    lines.push(
      `  ${marker} ${tool.tool.padEnd(13)} ${tool.detected ? "detected" : "not detected"}; ` +
        `${tool.indexed_sessions} sessions; hook: ${hook}${error}`,
    );
    for (const note of storePathNotes(definition, tool.store_paths)) {
      lines.push(`      ${note}`);
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

  // Status always ends with one concrete next step, as ux-walkthrough.md
  // promises. Repairing wiring outranks indexing advice: a drifted managed
  // file or missing skill target is why an agent would see nothing at all.
  const needsRepair =
    !configPresent ||
    managed.some((file) => file.exists && (file.blockCount !== 1 || file.staleReferences.length > 0)) ||
    skills.selected.some((skill) => !skill.exists) ||
    // Only `missing` and `drift` are faults. `managed-block` and
    // `unsupported` are the normal, healthy states for tools that carry
    // skills inside their instruction file or not at all.
    skills.targets.some((target) => target.state === "missing" || target.state === "drift");

  lines.push("");
  if (needsRepair) {
    lines.push("Next     Wiring has drifted. Run: xtctx setup --repair");
  } else if (status.sessions === 0) {
    lines.push("Next     No sessions are indexed yet. Ask a configured agent to call xtctx_recent_sessions.");
  } else {
    lines.push("Next     Handoff is wired. Ask a configured agent to call xtctx_recent_sessions.");
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
/**
 * Notes about where a tool's transcripts are being read from.
 *
 * Two different situations look identical in the config file. A path that
 * differs from the default may be a deliberate override — `.xtctx/config.yaml`
 * is committable, so a cloned repo can legitimately point a scraper anywhere,
 * and those stay legal but visible. Or it may simply be stale: setup records
 * where the tool kept its data that day, and tools move. opencode turned out
 * to write to the XDG location on Windows rather than %APPDATA%, so every
 * project set up before that was fixed still points at a path that has never
 * existed, and reports "not detected" forever with a real store sitting
 * elsewhere.
 *
 * Nothing is rewritten here — a config file is the user's. But the stale case
 * is named, with the path that does exist and how to adopt it.
 */
export function storePathNotes(
  definition: (typeof SUPPORTED_TOOLS)[number] | undefined,
  storePaths: string[],
): string[] {
  if (!definition) {
    return [];
  }

  let resolved: string;
  try {
    resolved = definition.defaultStorePath();
  } catch {
    return [];
  }

  const notes: string[] = [];
  for (const path of storePaths) {
    if (normalizePath(path) === normalizePath(resolved)) {
      continue;
    }
    if (!existsSync(path) && existsSync(resolved)) {
      notes.push(
        `stale store path: ${path} does not exist, but ${definition.id} has a store at ` +
          `${resolved} — re-run 'xtctx setup --yes' to point at it`,
      );
      continue;
    }
    notes.push(`custom store path (not the ${definition.id} default): ${path}`);
  }

  return notes;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
