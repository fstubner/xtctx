import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { writeIfChanged } from "./file-io.js";
import { installClaudeHook } from "./claude-settings.js";
import { memoryTargets, renderManagedBlock, upsertManagedBlock } from "./instruction-blocks.js";
import { publishedServerDefinition, xtctxServerDefinition } from "./server-definition.js";
import { isGlobalOnlyMcpTool, syncToolMcpConfigs } from "./mcp-config.js";
import { syncProjectSkills, type ProjectSkillConfig } from "./skills.js";
import { SUPPORTED_TOOLS } from "../tools/sources.js";

// Setup decides what a configured project looks like; the modules it calls own
// the individual surfaces. Re-exported so callers and tests keep one import
// path for "setup": the managed instruction files live in
// `instruction-blocks.ts`, the Claude Code hook and permissions in
// `claude-settings.ts`, and which xtctx entry point gets wired up in
// `server-definition.ts`.
export { inspectManagedFile } from "./instruction-blocks.js";
export { CLAUDE_HOOK_MARKER } from "./claude-settings.js";
export { xtctxServerDefinition } from "./server-definition.js";
export { pathExists } from "./file-io.js";

interface SetupOptions {
  projectPath?: string;
  yes?: boolean;
  repair?: boolean;
  homeDir?: string;
  selectedSkillIds?: string[];
  includeGlobalMcp?: boolean;
}

interface SetupResult {
  projectRoot: string;
  configPath: string;
  writes: Array<{ path: string; kind: string; changed: boolean }>;
  warnings: string[];
  /** Hard failures (unreadable/unwritable configs); setup exits nonzero. */
  failures: string[];
}

interface PlannedSetupWrite {
  path: string;
  kind: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const result = await setupProject(options);
  printSetupResult(result);
  return result;
}

/** @internal Reached only by tests and `scripts/public-demo-smoke.mjs`. */
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
  // Antigravity and Copilot CLI have no project-scoped config: what gets
  // written there applies to every directory for this user account. Pointing
  // that at a checkout's `dist/` breaks for the seconds of every rebuild and
  // permanently if the repo moves — so global scope always names the
  // published package, even when this project is xtctx itself.
  const globalServerDefinition = publishedServerDefinition();
  const mcpSummary = await syncToolMcpConfigs(
    projectRoot,
    [serverDefinition],
    supportedMcpTools(options.includeGlobalMcp),
    {
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      globalServers: [globalServerDefinition],
    },
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

  // The half setup cannot do. Claude Code ignores `permissions.allow` outright
  // in a workspace the user has not trusted, so the grants written above are
  // inert until someone accepts the trust dialog. Trusting a directory is a
  // security decision that belongs to the person, not to an installer — but
  // saying nothing left a headless agent with tool calls refused and no
  // explanation, which is how this was found.
  warnings.push(
    "Claude Code applies the tool permissions written to .claude/settings.json " +
      "only in a workspace you have trusted. Open this project in Claude Code " +
      "once and accept the trust prompt; until then its xtctx tool calls are " +
      "refused, silently in non-interactive runs.",
  );

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
