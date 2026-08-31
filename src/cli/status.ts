import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectManagedFile, pathExists } from "../config/setup.js";
import { inspectMcpWiring } from "../config/mcp-config.js";
import { inspectSkillStatus } from "../config/skills.js";
import { createProjectServices, type ProjectServices } from "../runtime/services.js";
import { estimateVectorBacklog, formatDuration } from "../utils/duration.js";
import { readDriftLog, type DriftLogFile } from "../scrapers/drift-log.js";
import { SUPPORTED_TOOLS } from "../tools/sources.js";
import { readXtctxPackage } from "../utils/package-info.js";

export interface StatusOptions {
  projectPath?: string;
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());

  // A path that does not exist produced a full, plausible status report about
  // it — ending in "run xtctx setup" — so a typo'd `--project` answered
  // confidently about nothing. Diagnostics that cannot tell a mistyped path
  // from an unconfigured one are worse than no diagnostics.
  if (!existsSync(projectRoot)) {
    process.stderr.write(`No such directory: ${projectRoot}
`);
    process.exitCode = 1;
    return;
  }

  // Diagnostics do not configure. Running `status` on a project left a
  // database behind in one it had only been asked to look at.
  const services = await createProjectServices(projectRoot, { createIfMissing: false });
  try {
    process.stdout.write((await renderStatusBlock(services)) + "\n");
  } finally {
    await services.sessions.close().catch(() => {});
  }
}

export interface StatusRenderOptions {
  /**
   * Home directory to resolve global MCP configs against. Production uses the
   * real one; tests that configure a sandbox home must inspect that same home,
   * or every globally-scoped tool looks unwired.
   */
  homeDir?: string;
}

export async function renderStatusBlock(
  services: ProjectServices,
  options: StatusRenderOptions = {},
): Promise<string> {
  const { version } = readXtctxPackage(import.meta.url);
  const status = await services.sessions.getStatus();
  const skills = await inspectSkillStatus(services.projectRoot, services.configPath);
  const configPresent = await pathExists(services.configPath);
  const enabledTools = SUPPORTED_TOOLS.map((tool) => tool.id).filter(
    (id) => services.config.tools?.[id]?.enabled !== false,
  );
  // Only tools actually installed here can be "broken": a global config for
  // a tool the user does not have is absent for a good reason, and nagging
  // about it every run is the crying-wolf failure this command exists to avoid.
  const detectedTools = new Set(status.tools.filter((tool) => tool.detected).map((tool) => tool.tool));
  const mcpWiring = configPresent ? await inspectMcpWiring(services.projectRoot, "xtctx", enabledTools, options.homeDir ? { homeDir: options.homeDir } : {}) : [];
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
  if (services.config.error) {
    // Loud, and immediately under the path it refers to: nothing is being
    // scanned at all while this holds, which is otherwise invisible — the
    // tools below would simply report zero sessions each.
    lines.push(`         UNREADABLE: ${services.config.error}`);
    lines.push(`         No transcripts are being read until this is fixed.`);
  }
  lines.push(`Index    ${services.dbPath}`);
  lines.push(`MCP      npx -y xtctx`);
  const scanTook = formatDuration(status.last_scan_ms);
  lines.push(
    `Scan     ${status.last_scan_at ?? "never"}${scanTook ? ` (took ${scanTook})` : ""}`,
  );
  if (status.embedding_error) {
    lines.push(`Search   semantic unavailable (keyword only): ${status.embedding_error}`);
  }
  lines.push(
    `Data     ${status.sessions} sessions, ${status.messages} messages, ` +
      `${status.retrieval_units} retrieval windows, ${status.vectorized_units} vectorized`,
  );
  // A backlog is only meaningful as a duration: "1762 windows left" says
  // nothing until it says "about 30 seconds".
  const backlog = estimateVectorBacklog(
    status.retrieval_units,
    status.vectorized_units,
    status.vector_ms_per_unit,
  );
  if (backlog.remaining > 0) {
    const rate = status.vector_ms_per_unit ? `${status.vector_ms_per_unit}ms/window` : "rate unknown";
    lines.push(
      `Embed    ${backlog.remaining} windows outstanding, ${rate}` +
        `${backlog.eta ? `, about ${backlog.eta} of embedding left` : ""}`,
    );
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
    for (const note of storePathNotes(definition, tool.store_paths)) {
      lines.push(`      ${note}`);
    }
  }

  const drift = (
    await Promise.all(
      status.tools.map(async (tool) => ({
        tool: tool.tool,
        log: await readDriftLog(services.stateDir, tool.tool),
      })),
    )
  ).filter((entry): entry is { tool: string; log: DriftLogFile } => (entry.log?.surprises.length ?? 0) > 0);

  if (drift.length > 0) {
    lines.push("");
    // Named for what it means rather than what the code calls it: these are
    // the places another tool's transcripts did not look the way this reader
    // expected, which is the first sign a tool has changed its format.
    lines.push("Format surprises:");
    for (const { tool, log } of drift) {
      const kinds = plural(log.surprises.length, "kind");
      // `droppedSurprises` counts what the last write discarded, so it is only
      // ever about that write — not a running total of everything ever lost.
      const dropped =
        log.droppedSurprises > 0 ? `, ${log.droppedSurprises} dropped at the ceiling` : "";
      lines.push(`  ${tool.padEnd(13)} ${kinds}${dropped}`);
      for (const entry of log.surprises.slice(0, 3)) {
        lines.push(`      ${entry.surprise}`);
        // The entry's own last sighting, not the file's write time: with the
        // whole-file timestamp a surprise that stopped months ago read exactly
        // like one still happening. And "sightings" rather than "records",
        // because the count accumulates across scans — a re-scan of the same
        // file raises it without a single new transcript record.
        lines.push(`        ${plural(entry.records, "sighting")}, last seen ${entry.lastSeen}`);
        lines.push(`        first at ${entry.firstLocation}`);
      }
      if (log.surprises.length > 3) {
        lines.push(`      ... and ${log.surprises.length - 3} more in ${tool}-drift.json`);
      }
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

  if (mcpWiring.length > 0) {
    lines.push("");
    lines.push("MCP wiring:");
    for (const entry of mcpWiring) {
      const scope = entry.scope === "global" ? " (global config)" : "";
      const detail = entry.detail ? ` — ${entry.detail}` : "";
      lines.push(
        `  ${(entry.wired ? "wired" : "not wired").padEnd(12)} ${entry.tool.padEnd(13)} ${entry.path}${scope}${detail}`,
      );
    }
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
  // A project that was never set up has not "drifted" — there is nothing to
  // repair, and telling a first-time user to run a repair command reads as
  // though something is already broken. Never configured and configured-then-
  // damaged are different states and get different advice.
  const needsRepair =
    configPresent &&
    // A tool that is enabled but has no xtctx entry in its own MCP config is
    // the most complete way to be broken: the agent simply never sees xtctx.
    // Status reported nothing at all for this, so deleting `.mcp.json` left it
    // saying everything was fine.
    // A config that was never written is not drift: `setup` only writes some
    // global configs when asked (`--global-mcp`), so demanding one would tell
    // a correctly-set-up project to repair itself forever. A config that
    // exists but has lost its entry is the real thing.
    (mcpWiring.some(
      (entry) => !entry.wired && entry.configExists && detectedTools.has(entry.tool),
    ) ||
      managed.some((file) => file.exists && (file.blockCount !== 1 || file.staleReferences.length > 0)) ||
    skills.selected.some((skill) => !skill.exists) ||
    // Only `missing` and `drift` are faults. `managed-block` and
    // `unsupported` are the normal, healthy states for tools that carry
    // skills inside their instruction file or not at all.
    skills.targets.some((target) => target.state === "missing" || target.state === "drift"));

  lines.push("");
  if (!configPresent) {
    lines.push("Next     This project is not set up yet. Run: xtctx setup");
  } else if (needsRepair) {
    lines.push("Next     Wiring has drifted. Run: xtctx setup --repair");
  } else if (status.sessions === 0) {
    lines.push("Next     No sessions are indexed yet. Ask a configured agent to call xtctx_recent_sessions.");
  } else {
    lines.push("Next     Handoff is wired. Ask a configured agent to call xtctx_recent_sessions.");
  }

  return lines.join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  homeDir: string = process.env.USERPROFILE ?? process.env.HOME ?? "",
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

    // One note per path, whatever is wrong with it.
    //
    // An override is legal by design — a cloned repo can legitimately point a
    // scraper anywhere — but not every override is equal. One inside your home
    // is a tool keeping data somewhere unusual. One outside it arrived from
    // somewhere, and `.xtctx/config.yaml` is committable, so a clone can carry
    // one and nothing would otherwise say so.
    //
    // It is a qualifier on the note rather than a note of its own: where a
    // path points and whether it resolves are independent facts, and emitting
    // them separately doubled the count callers read as "problems with this
    // path". Saying both in one line keeps the actionable half — the store
    // that does exist, and how to adopt it — attached to the warning.
    const suffix =
      homeDir && !isInsideDir(path, homeDir)
        ? " — WARNING: this is outside your home directory; xtctx will read " +
          "transcripts from there. If you did not set it, check .xtctx/config.yaml " +
          "(it is committable, so a cloned repo can carry one)"
        : "";

    if (!existsSync(path) && existsSync(resolved)) {
      notes.push(
        `stale store path: ${path} does not exist, but ${definition.id} has a store at ` +
          `${resolved} — re-run 'xtctx setup --yes' to point at it${suffix}`,
      );
      continue;
    }
    notes.push(`custom store path (not the ${definition.id} default): ${path}${suffix}`);
  }

  return notes;
}

function isInsideDir(candidate: string, root: string): boolean {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  return c === r || c.startsWith(`${r}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
