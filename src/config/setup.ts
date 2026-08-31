import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import {
  MARKERS,
  countManagedBlocks,
  matchLineEndings,
  removeManagedBlocks,
  stripMarkers,
} from "./managed-block.js";
import { stringify as stringifyYaml } from "yaml";
import {
  isGlobalOnlyMcpTool,
  syncToolMcpConfigs,
  type McpServerDefinition,
} from "./mcp-config.js";
import {
  renderSyncedSkillsBlock,
  syncProjectSkills,
  type ProjectSkillConfig,
  type SkillSelection,
} from "./skills.js";
import { SUPPORTED_TOOLS, type HookMode } from "../tools/sources.js";

export interface SetupOptions {
  projectPath?: string;
  yes?: boolean;
  repair?: boolean;
  homeDir?: string;
  selectedSkillIds?: string[];
  includeGlobalMcp?: boolean;
}

export interface SetupResult {
  projectRoot: string;
  configPath: string;
  writes: Array<{ path: string; kind: string; changed: boolean }>;
  warnings: string[];
  /** Hard failures (unreadable/unwritable configs); setup exits nonzero. */
  failures: string[];
}

export interface PlannedSetupWrite {
  path: string;
  kind: string;
}

interface MemoryTarget {
  tool: string;
  path: string;
  hookMode: HookMode;
  prelude?: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const result = await setupProject(options);
  printSetupResult(result);
  return result;
}

export async function setupProject(options: SetupOptions = {}): Promise<SetupResult> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const stateDir = join(xtctxDir, "state");
  const configPath = join(xtctxDir, "config.yaml");
  const writes: SetupResult["writes"] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  if (options.repair) {
    await rm(join(xtctxDir, ".store"), { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(join(xtctxDir, "tool-config"), { recursive: true, force: true });
  }

  await mkdir(stateDir, { recursive: true });

  const skillSync = await syncProjectSkills({
    projectRoot,
    configPath,
    selectedSkillIds: options.selectedSkillIds,
    homeDir: options.homeDir,
  });
  writes.push(...skillSync.writes);
  warnings.push(...skillSync.warnings);

  writes.push({
    path: configPath,
    kind: "config",
    changed: await writeIfChanged(
      configPath,
      renderProjectConfig(projectRoot, skillSync.config),
      projectRoot,
    ),
  });

  // The index holds raw transcript text from every configured tool, so
  // committing it would publish conversation content. config.yaml and
  // skills/ are project config and stay committable.
  writes.push({
    path: join(xtctxDir, ".gitignore"),
    kind: "gitignore",
    changed: await writeIfChanged(
      join(xtctxDir, ".gitignore"),
      ["# Local transcript index — never commit (holds raw conversation text).", "state/", ""].join("\n"),
      projectRoot,
    ),
  });

  const serverDefinition = await xtctxServerDefinition(projectRoot);
  const mcpSummary = await syncToolMcpConfigs(
    projectRoot,
    [serverDefinition],
    supportedMcpTools(options.includeGlobalMcp),
    options.homeDir ? { homeDir: options.homeDir } : {},
  );

  for (const file of mcpSummary.results) {
    writes.push({
      path: file.path,
      kind: `mcp:${file.tool}`,
      changed: file.updated || file.created,
    });
    if (file.failed && file.warning) {
      failures.push(file.warning);
    } else if (file.warning) {
      warnings.push(file.warning);
    }
    // Antigravity has no per-project MCP config, so wiring it edits a file
    // shared by every project on the machine. `disconnect` says so when it
    // removes the entry; setup said nothing when it added one, which is the
    // half that needs consent.
    if (file.tool === "antigravity" && file.scope === "global" && (file.updated || file.created)) {
      warnings.push(
        `Antigravity MCP config is app-level: ${file.path} applies to every project for this user account, not just this one.`,
      );
    }
  }

  for (const target of memoryTargets(projectRoot)) {
    const block = renderManagedBlock({
      projectRoot,
      tool: target.tool,
      hookMode: target.hookMode,
      serverDefinition,
      skills: skillSync.selected,
    });
    writes.push({
      path: target.path,
      kind: `memory:${target.tool}`,
      changed: await upsertManagedBlock(target.path, block, projectRoot, target.prelude),
    });
  }

  writes.push({
    path: join(projectRoot, ".claude", "settings.json"),
    kind: "hook:claude-code",
    changed: await installClaudeHook(projectRoot),
  });

  return { projectRoot, configPath, writes, warnings, failures };
}

export function describeSetupPlan(
  projectPath?: string,
  selectedSkillIds: string[] = ["xtctx-handoff"],
  includeGlobalMcp = false,
): {
  projectRoot: string;
  writes: PlannedSetupWrite[];
} {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const skillIds = [...new Set(["xtctx-handoff", ...selectedSkillIds])];
  const writes: PlannedSetupWrite[] = [
    { path: join(projectRoot, ".xtctx", "config.yaml"), kind: "config" },
    { path: join(projectRoot, ".xtctx", ".gitignore"), kind: "gitignore" },
    { path: join(projectRoot, ".mcp.json"), kind: "mcp:claude-code" },
    { path: join(projectRoot, ".cursor", "mcp.json"), kind: "mcp:cursor" },
    { path: join(projectRoot, ".vscode", "mcp.json"), kind: "mcp:copilot" },
    { path: join(projectRoot, ".codex", "config.toml"), kind: "mcp:codex" },
    { path: join(projectRoot, "opencode.json"), kind: "mcp:opencode" },
    { path: join(projectRoot, "AGENTS.md"), kind: "memory:codex/opencode" },
    { path: join(projectRoot, "CLAUDE.md"), kind: "memory:claude-code" },
    { path: join(projectRoot, "GEMINI.md"), kind: "memory:antigravity" },
    { path: join(projectRoot, ".cursor", "rules", "xtctx.mdc"), kind: "memory:cursor" },
    { path: join(projectRoot, ".github", "copilot-instructions.md"), kind: "memory:copilot" },
    { path: join(projectRoot, ".claude", "settings.json"), kind: "hook:claude-code" },
  ];

  for (const skillId of skillIds) {
    writes.push(
      { path: join(projectRoot, ".xtctx", "skills", skillId, "SKILL.md"), kind: `skill-source:${skillId}` },
      { path: join(projectRoot, ".claude", "skills", skillId, "SKILL.md"), kind: `skill:claude-code:${skillId}` },
      { path: join(projectRoot, ".cursor", "rules", "xtctx-skills", `${skillId}.mdc`), kind: `skill:cursor:${skillId}` },
      {
        path: join(projectRoot, ".github", "instructions", `xtctx-${skillId}.instructions.md`),
        kind: `skill:copilot:${skillId}`,
      },
    );
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    writes.push({
      path: join(home, ".gemini", "antigravity", "mcp_config.json"),
      kind: "mcp:antigravity",
    });
  }
  if (includeGlobalMcp && home) {
    writes.push({ path: join(home, ".copilot", "mcp-config.json"), kind: "mcp:copilot-cli" });
  }

  return { projectRoot, writes };
}

function supportedMcpTools(includeGlobalMcp = false): string[] {
  return SUPPORTED_TOOLS
    .filter((tool) => {
      if (!isGlobalOnlyMcpTool(tool.id)) {
        return true;
      }
      // Antigravity only has app-level MCP config; always wire it on setup.
      if (tool.id === "antigravity") {
        return true;
      }
      return includeGlobalMcp;
    })
    .map((tool) => tool.id);
}


export async function inspectManagedFile(filePath: string): Promise<{
  exists: boolean;
  blockCount: number;
  staleReferences: string[];
}> {
  const content = await readUtf8IfExists(filePath);
  if (content === null) {
    return { exists: false, blockCount: 0, staleReferences: [] };
  }

  return {
    exists: true,
    blockCount: countManagedBlocks(content),
    staleReferences: findStaleReferences(content),
  };
}

/** Path, relative to the project root, that this package's `bin` points at. */
const SELF_HOSTED_ENTRY = "./dist/src/cli/index.js";

/**
 * Rewrite a path inside the project root to a `./`-relative one, and pass
 * anything else through unchanged (`-y`, `xtctx`, a path outside the project).
 * Used only for text that gets committed; see the call site.
 */
function portablePath(arg: string, projectRoot: string): string {
  // Absolute first, and it is not a shortcut. Every path this needs to rewrite
  // is built with `join(projectRoot, …)`, so anything relative is a flag or a
  // package name. Without this test `relative()` resolves a bare `-y` against
  // the *process cwd*, and `cd project && npx -y xtctx setup` — the documented
  // way to run it — made the cwd the project root and turned the flag into
  // `./-y`. The block then advertised `npx ./-y ./xtctx`, a command that does
  // not exist, and its contents depended on which directory setup was run
  // from, so re-running churned a committed file.
  if (!isAbsolute(arg)) {
    return arg;
  }

  const rel = relative(projectRoot, arg);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return arg;
  }
  return `./${rel.split(sep).join("/")}`;
}

/**
 * True when the project being set up is the xtctx package itself.
 *
 * Setting xtctx up inside its own repo is the one case where `npx -y xtctx`
 * is actively wrong. npx resolves the *local* package, and installing it runs
 * `prepare` — which is `npm run build`, which begins by deleting `dist/`. The
 * SessionStart hook therefore wiped the very file the MCP server config points
 * at, and a client spawning the server in that window got "Connection closed".
 * It also meant the hook ran whatever npx had cached rather than the working
 * tree, so a developer could be debugging output no longer in their source.
 *
 * What the branch decides is which code gets configured to run: as an MCP
 * server, as a SessionStart hook command, and — through Antigravity — in a
 * *machine-global* config that outlives the project setup ran in. So the
 * question it answers is a trust question, and `package.json` cannot answer
 * it. Name and `bin` are just strings in a file, and every file in a cloned
 * repository is attacker-controlled; a hostile checkout that copied them
 * nominated its own `dist/src/cli/index.js` and xtctx wired it up.
 *
 * The authenticating step is the third check: the built entry point has to be
 * the file this process is *already executing*. That grants no new trust —
 * the operator ran this code to get here — while a checkout merely claiming
 * the name grants all of it. It also happens to be the precise condition the
 * npx problem needs, since running from `dist/` is what someone developing
 * xtctx does.
 *
 * Fails closed: anything unresolvable picks npx, which is always safe.
 */
async function isSelfHostedProject(projectRoot: string): Promise<boolean> {
  const pkg = await readJsonIfExists(join(projectRoot, "package.json"));
  if (!isRecord(pkg) || pkg.name !== "xtctx") {
    return false;
  }
  const bin = pkg.bin;
  if (!(isRecord(bin) && typeof bin.xtctx === "string" && bin.xtctx.includes("cli/index.js"))) {
    return false;
  }

  return runningFromProject(projectRoot);
}

/**
 * True when the CLI file this process is running is the project's own built
 * entry point.
 *
 * Compared through `realpath` because the ways of invoking it differ by a
 * symlink: `node ./dist/src/cli/index.js` names it directly, while a
 * `node_modules/.bin/xtctx` shim points at the same file under another name.
 */
async function runningFromProject(projectRoot: string): Promise<boolean> {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    const [running, built] = await Promise.all([
      realpath(resolve(entry)),
      realpath(join(projectRoot, "dist", "src", "cli", "index.js")),
    ]);
    return running === built;
  } catch {
    // Either path is missing — most often a repo whose `dist/` has not been
    // built. Nothing to authenticate against, so use npx.
    return false;
  }
}

export async function xtctxServerDefinition(projectRoot?: string): Promise<McpServerDefinition> {
  if (projectRoot && (await isSelfHostedProject(projectRoot))) {
    return {
      name: "xtctx",
      // Absolute: an MCP client's cwd when it spawns a server is not
      // guaranteed to be the project root, unlike a Claude Code hook's.
      command: "node",
      args: [join(projectRoot, "dist", "src", "cli", "index.js")],
      transport: "stdio",
    };
  }

  return {
    name: "xtctx",
    command: "npx",
    args: ["-y", "xtctx"],
    transport: "stdio",
  };
}

function renderProjectConfig(projectRoot: string, skills: ProjectSkillConfig): string {
  const config = {
    project: {
      root: projectRoot,
    },
    handoff: {
      mode: "raw-transcript-pointer",
      indexing: "on-demand",
      summaries: false,
    },
    mcp: {
      command: "npx",
      args: ["-y", "xtctx"],
    },
    skills,
    // `storePath` is deliberately not written. It is optional at read time —
    // absent means "use this tool's default for this machine" — and setup was
    // writing exactly that default, so the field carried no information while
    // baking an absolute home path, including the OS username, into a file
    // meant to be committable. It also broke portability: a cloned repo
    // pointed every scraper at the original author's home directory. Set it by
    // hand to override a store that is not in its usual place.
    tools: Object.fromEntries(
      SUPPORTED_TOOLS.map((tool) => [
        tool.id,
        {
          enabled: true,
          hook: tool.hookMode,
        },
      ]),
    ),
  };

  return stringifyYaml(config);
}

function memoryTargets(projectRoot: string): MemoryTarget[] {
  return [
    {
      tool: "codex",
      path: join(projectRoot, "AGENTS.md"),
      hookMode: "instruction-only",
    },
    {
      tool: "claude-code",
      path: join(projectRoot, "CLAUDE.md"),
      hookMode: "executable",
    },
    {
      tool: "antigravity",
      path: join(projectRoot, "GEMINI.md"),
      hookMode: "instruction-only",
    },
    {
      tool: "cursor",
      path: join(projectRoot, ".cursor", "rules", "xtctx.mdc"),
      hookMode: "instruction-only",
      prelude:
        "---\ndescription: xtctx cross-tool handoff\nglobs: \"**/*\"\nalwaysApply: true\n---\n\n",
    },
    {
      tool: "copilot",
      path: join(projectRoot, ".github", "copilot-instructions.md"),
      hookMode: "instruction-only",
    },
  ];
}

function renderManagedBlock(input: {
  projectRoot: string;
  tool: string;
  hookMode: HookMode;
  serverDefinition: McpServerDefinition;
  skills: SkillSelection[];
}): string {
  // Relative to the project root, never absolute. The MCP config needs an
  // absolute path (a client's cwd when spawning a server is not guaranteed)
  // and is gitignored, so a machine-specific path there is harmless. This
  // block is written into CLAUDE.md / AGENTS.md / GEMINI.md, which are
  // committed — an absolute path here lands in everyone else's checkout
  // pointing at a directory that exists on exactly one machine.
  const command = [
    input.serverDefinition.command,
    ...(input.serverDefinition.args ?? []).map((arg) => portablePath(arg, input.projectRoot)),
  ].join(" ");
  return [
    MARKERS.begin,
    "Generated by xtctx setup. Do not edit inside this block.",
    "",
    "# xtctx Handoff",
    "",
    `Tool: ${input.tool}`,
    // Stripped, not raw: a path containing the end marker (legal on POSIX)
    // would terminate the block early, leaving its tail as debris in the
    // user's file plus a stale marker that breaks every later run.
    `Project root: ${stripMarkers(input.projectRoot)}`,
    `Integration mode: ${input.hookMode}`,
    "",
    "xtctx is configured for cross-tool handoff in this project.",
    "Do not rely on this block for a generated summary; raw local transcripts are authoritative.",
    "",
    "## Session Retrieval",
    "- Call `xtctx_recent_sessions` to list recent local sessions.",
    "- Call `xtctx_session_detail` with a `session_ref` for the raw transcript messages.",
    "- Call `xtctx_search_sessions` only when you need semantic or keyword search across chronological transcript windows.",
    "- Use `xtctx_continuity_status` for wiring and freshness diagnostics.",
    "- External orchestrators can call `xtctx_handoff_manifest` for stable session references and raw-detail pointers; it does not persist task state.",
    "",
    ...renderSyncedSkillsBlock(input.skills),
    "## MCP",
    `- Command: \`${command}\``,
    "- Transport: stdio",
    "",
    "## Notes",
    "- Indexing is on-demand from MCP recent, detail, and search calls.",
    "- There is no xtctx daemon, API server, dashboard, durable memory, or generated brief.",
    "- Content outside this managed block is preserved.",
    MARKERS.end,
    "",
  ].join("\n");
}

/**
 * Substring identifying an xtctx SessionStart hook, whatever invokes it.
 *
 * Deliberately does NOT include "xtctx": the self-hosted form runs
 * `node ./dist/src/cli/index.js`, which contains no such token. Keeping the
 * old marker would have made setup append a second hook on every run and left
 * disconnect unable to remove either — so the marker has to identify the flag,
 * not the launcher. It is only ever matched against SessionStart hook
 * commands, which bounds how broad this is.
 *
 * Exported because disconnect needs the identical rule; it previously carried
 * its own hardcoded copy, which is exactly how the two drift apart.
 */
export const CLAUDE_HOOK_MARKER = "--hook session-start";

// Claude Code runs hooks with cwd = project root, so the command stays
// path-independent — no shell-quoted absolute path to get injection wrong.
const CLAUDE_HOOK_COMMAND = "npx -y xtctx --hook session-start --tool claude-code";

/**
 * In its own repo, run the built entry point rather than going through npx.
 * See `isSelfHostedProject`: npx there rebuilds the package mid-session and
 * deletes the file the MCP server is configured to run.
 */
async function claudeHookCommand(projectRoot: string): Promise<string> {
  return (await isSelfHostedProject(projectRoot))
    ? `node ${SELF_HOSTED_ENTRY} --hook session-start --tool claude-code`
    : CLAUDE_HOOK_COMMAND;
}

async function installClaudeHook(projectRoot: string): Promise<boolean> {
  // Claude Code reads hooks from .claude/settings.json (matcher-group shape).
  // Earlier xtctx versions wrote a flat array to .claude/hooks.json, which
  // Claude Code never loads — migrate those entries out.
  const legacyChanged = await removeLegacyClaudeHook(
    join(projectRoot, ".claude", "hooks.json"),
    projectRoot,
  );

  const settingsPath = join(projectRoot, ".claude", "settings.json");
  const existing = await readJsonIfExists(settingsPath);
  const root = isRecord(existing) ? existing : {};
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const alreadyInstalled = sessionStart.some(
    (group) =>
      isRecord(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (hook) =>
          isRecord(hook) &&
          typeof hook.command === "string" &&
          hook.command.includes(CLAUDE_HOOK_MARKER),
      ),
  );

  if (alreadyInstalled) {
    return legacyChanged;
  }

  hooks.SessionStart = [
    ...sessionStart,
    { hooks: [{ type: "command", command: await claudeHookCommand(projectRoot) }] },
  ];
  root.hooks = hooks;
  const changed = await writeIfChanged(
    settingsPath,
    JSON.stringify(root, null, 2) + "\n",
    projectRoot,
  );
  return changed || legacyChanged;
}

async function removeLegacyClaudeHook(hooksPath: string, projectRoot: string): Promise<boolean> {
  const existing = await readJsonIfExists(hooksPath);
  if (!isRecord(existing) || !isRecord(existing.hooks)) {
    return false;
  }

  const hooks = existing.hooks;
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const kept = sessionStart.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        typeof entry.command === "string" &&
        entry.command.includes(CLAUDE_HOOK_MARKER)
      ),
  );
  if (kept.length === sessionStart.length) {
    return false;
  }

  const otherHookKeys = Object.keys(hooks).filter((key) => key !== "SessionStart");
  const otherRootKeys = Object.keys(existing).filter((key) => key !== "hooks");
  if (kept.length === 0 && otherHookKeys.length === 0 && otherRootKeys.length === 0) {
    // The file held nothing but the entry we wrote; remove it entirely.
    await rm(hooksPath, { force: true });
    return true;
  }

  hooks.SessionStart = kept;
  return writeIfChanged(hooksPath, JSON.stringify(existing, null, 2) + "\n", projectRoot);
}

async function upsertManagedBlock(
  filePath: string,
  block: string,
  containWithin: string,
  prelude = "",
): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  // Deliberately not trimmed. Trimming the tail here silently edited the
  // user's file: blank lines at EOF vanished, and two trailing spaces on the
  // last line — a markdown hard break — were destroyed. The separator below is
  // exactly what removal takes back, so the round trip is byte-for-byte.
  const repaired = existing ? removeManagedBlocks(existing) : "";
  // A file that already opens with YAML frontmatter keeps it — prepending
  // the prelude again would produce a second, invalid frontmatter block.
  const hasFrontmatter = repaired.startsWith("---");
  const prefix =
    prelude && !hasFrontmatter && !repaired.startsWith(prelude.trimEnd()) ? prelude : "";
  const separator = repaired.length > 0 ? "\n\n" : "";
  const content = `${prefix}${repaired}${separator}${block}`;
  return writeIfChanged(filePath, content, containWithin);
}

function findStaleReferences(content: string): string[] {
  const stale: Array<{ label: string; pattern: RegExp }> = [
    { label: "xtctx serve", pattern: /\bxtctx\s+serve\b/ },
    { label: "xtctx_search", pattern: /\bxtctx_search\b/ },
    { label: "xtctx_project_knowledge", pattern: /\bxtctx_project_knowledge\b/ },
    { label: "xtctx_save_decision", pattern: /\bxtctx_save_decision\b/ },
    { label: "xtctx_save_error_solution", pattern: /\bxtctx_save_error_solution\b/ },
    { label: "xtctx_save_faq", pattern: /\bxtctx_save_faq\b/ },
    { label: "xtctx_last_session_brief", pattern: /\bxtctx_last_session_brief\b/ },
  ];
  return stale.filter((value) => value.pattern.test(content)).map((value) => value.label);
}

/**
 * `containWithin` is passed by every caller rather than defaulted, because the
 * correct root differs per write: project files belong to the project root,
 * user-level files to the home directory. A default here would silently apply
 * one caller's root to another's file.
 */
async function writeIfChanged(
  filePath: string,
  content: string,
  containWithin: string,
): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  // Preserve the existing file's dominant line endings instead of silently
  // converting a CRLF-authored file to LF.
  const finalContent = matchLineEndings(content, existing);
  if (existing !== null && existing === finalContent) {
    return false;
  }

  await writeFileAtomic(filePath, finalContent, { containWithin });
  return true;
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  const raw = await readUtf8IfExists(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function printSetupResult(result: SetupResult): void {
  const changed = result.writes.filter((write) => write.changed).length;
  process.stdout.write(`xtctx setup complete (${changed} changed, ${result.writes.length - changed} unchanged)\n`);
  process.stdout.write(`Project: ${result.projectRoot}\n`);
  for (const write of result.writes) {
    const marker = write.changed ? "updated" : "ok";
    process.stdout.write(`  ${marker.padEnd(7)} ${write.kind} ${write.path}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`  warning ${warning}\n`);
  }
  for (const failure of result.failures) {
    process.stdout.write(`  error   ${failure}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
