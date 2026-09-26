import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { pathExists, writeIfChanged } from "./file-io.js";
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
  /** `created` is set where the writer knows it; see `runSetup` for the rest. */
  writes: Array<{ path: string; kind: string; changed: boolean; created?: boolean }>;
  warnings: string[];
  /** Hard failures (unreadable/unwritable configs); setup exits nonzero. */
  failures: string[];
}

interface PlannedSetupWrite {
  path: string;
  kind: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  // Which of the planned files existed before, so the report can say
  // "created" rather than "updated" for a file that was not there. Setup said
  // "updated" for all eighteen files in a fresh project, which reads as though
  // it had edited things the user already had.
  const plan = describeSetupPlan(options.projectPath, options.selectedSkillIds, options.includeGlobalMcp);
  const existedBefore = new Set<string>();
  await Promise.all(
    plan.writes.map(async (write) => {
      if (await pathExists(write.path)) existedBefore.add(write.path);
    }),
  );
  const result = await setupProject(options);
  printSetupResult(result, existedBefore);
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

  // `--repair` removes what older versions left in `.xtctx/` and nothing else.
  //
  // It used to delete `state/` too, and `status` told anyone with a drifted
  // skill copy to run it. `state/` holds the index, and the index keeps
  // sessions whose transcripts are gone: Claude Code deletes transcripts after
  // 30 days by default, so for anything older the index is the only copy. A
  // repair that follows status's own advice must not be the thing that loses
  // that history. Nothing `--repair` was for needs it either: every managed
  // block, skill copy and MCP entry is rewritten by a plain `setup`.
  if (options.repair) {
    await rm(join(xtctxDir, ".store"), { recursive: true, force: true });
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
      created: file.created,
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

  const claudeHook = await installClaudeHook(projectRoot);
  if (claudeHook.failure) {
    failures.push(claudeHook.failure);
  }
  writes.push({
    path: join(projectRoot, ".claude", "settings.json"),
    kind: "hook:claude-code",
    changed: claudeHook.changed,
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

function printSetupResult(result: SetupResult, existedBefore: Set<string>): void {
  // Paths inside the project are relative to the Project line above them;
  // anything outside it -- a global MCP config -- stays absolute, because that
  // is the part a reader needs to notice.
  const show = (path: string): string => {
    const rel = relative(result.projectRoot, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  };
  const outcome = (write: SetupResult["writes"][number]): "created" | "updated" | "ok" =>
    !write.changed ? "ok" : (write.created ?? !existedBefore.has(write.path)) ? "created" : "updated";
  const counts = { created: 0, updated: 0, ok: 0 };
  for (const write of result.writes) counts[outcome(write)] += 1;

  process.stdout.write(
    `xtctx setup complete: ${counts.created} created, ${counts.updated} updated, ${counts.ok} unchanged\n`,
  );
  process.stdout.write(`Project: ${result.projectRoot}\n`);
  for (const write of result.writes) {
    process.stdout.write(`  ${outcome(write).padEnd(8)} ${displayKind(write.kind).padEnd(34)} ${show(write.path)}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`  warning  ${warning}\n`);
  }
  for (const failure of result.failures) {
    process.stdout.write(`  error    ${failure}\n`);
  }

  if (result.failures.length === 0) {
    printCoverageNote(result);
    printNextSteps();
  }
}

/**
 * The write's kind as a reader should see it. Internally the managed
 * instruction blocks are `memory:` writes, a name left from before the pivot;
 * printed, it told users xtctx keeps a memory, which is the one thing the
 * product says it does not do.
 */
function displayKind(kind: string): string {
  return kind.startsWith("memory:") ? `instructions:${kind.slice("memory:".length)}` : kind;
}

/**
 * Why a project that uses one agent just gained config for seven.
 *
 * Setup wires every supported tool regardless of what is installed — measured
 * in a clean environment with zero tools detected, that is eighteen files and
 * eleven new top-level entries in the repository, including `GEMINI.md` and
 * `opencode.json` for tools the user may never have heard of. The plan is
 * shown and confirmed before any of it is written, so nothing is sneaked in,
 * but the *reason* was nowhere and a first-time user reads it as the tool
 * making a mess.
 *
 * The behaviour is deliberate and stays. Detection reads a tool's transcript
 * store, which does not exist until that tool has been used, so wiring only
 * what is detected would silently skip a tool the user installs tomorrow — and
 * a silently unwired tool is a worse failure than a file they did not want,
 * because nothing reports it. The instruction files are also read by whoever
 * opens the repository next, which includes a teammate on a different agent.
 *
 * So it is said out loud instead, with the command that undoes any of it.
 */
function printCoverageNote(result: SetupResult): void {
  // Counted from what was written rather than assumed. This said "All 7
  // supported tools were wired" while Copilot CLI, whose only MCP config is
  // machine-wide, is written only with `--global-mcp`.
  const mcpWired = new Set(
    result.writes.filter((write) => write.kind.startsWith("mcp:")).map((write) => write.kind.slice(4)),
  );
  const unwired = SUPPORTED_TOOLS.filter((tool) => !mcpWired.has(tool.id)).map((tool) => tool.id);
  const headline =
    unwired.length === 0
      ? `All ${SUPPORTED_TOOLS.length} supported tools were wired`
      : `${SUPPORTED_TOOLS.length - unwired.length} of ${SUPPORTED_TOOLS.length} supported tools were wired`;
  const skipped =
    unwired.length === 0
      ? ""
      : unwired.includes("copilot-cli") && unwired.length === 1
        ? "  Copilot CLI was not: its only MCP config is machine-wide, so it is\n" +
          "  written only with `xtctx setup --global-mcp`.\n"
        : `  Not wired: ${unwired.join(", ")}.\n`;
  process.stdout.write(
    `\n  ${headline}, including any not installed here:\n` +
      "  a tool's config only exists once it has been used, so wiring what is\n" +
      "  detected today would skip whatever you install tomorrow. The instruction\n" +
      "  files are also read by whichever agent opens this repo next.\n" +
      skipped +
      "  Remove any you do not want with `xtctx disconnect <tool>`.\n",
  );
}

/**
 * What to do now that setup has written eighteen files.
 *
 * Setup used to end on the last path it wrote, and the two things a user
 * needs next are both invisible from that.
 *
 * The first is the restart. MCP clients read their config when they launch, so
 * an agent that was already open when setup ran has no xtctx tools — and the
 * natural next move after running setup is to go back to the agent already
 * open and ask it something. It answers that it cannot see any xtctx tools,
 * which reads as a broken install rather than a stale process.
 *
 * The second is that there is nothing to see yet. Nothing is indexed until an
 * agent calls a tool, so `xtctx status` immediately after setup reports
 * `Scan never` and `0 sessions` — the shape of a failure, and the natural
 * thing to run next to check whether setup worked.
 */
function printNextSteps(): void {
  process.stdout.write(
    [
      "",
      "Next:",
      "  1. Restart any agent that was already open — MCP clients read their",
      "     config at launch, so a running one cannot see xtctx yet.",
      "  2. Ask it for recent context, or have it call `xtctx_recent_sessions`.",
      "",
      "  Nothing is indexed until then, so `xtctx status` will report",
      "  `Scan never` and `0 sessions` until an agent has called a tool once.",
      "",
    ].join("\n"),
  );
}
