import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface InitOptions {
  projectPath?: string;
  force?: boolean;
  /**
   * Suppress the "Initialized xtctx in <path>" stdout line.  Set when
   * runInit is being driven from a richer UI (e.g. the onboard wizard's
   * spinner) so it doesn't leak a raw console.log mid-render.
   */
  silent?: boolean;
}

const DEFAULT_CONFIG_YAML = `version: "1"
project:
  name: ""
  root: "."
ingestion:
  scrapers: []
  watchPaths: []
  pollIntervalMs: 30000
  excludePatterns:
    - node_modules/**
    - dist/**
compaction:
  strategy: rule-based
  sessionBoundaryMinutes: 30
search:
  defaultMode: hybrid
  defaultDepth: summary
  defaultLimit: 10
domainTags: {}
web:
  port: 3232
api:
  security:
    token: ""
    allowedOrigins: []
    allowLocalhostOrigins: false
    rateLimitWindowMs: 60000
    rateLimitMax: 120
`;

const DEFAULT_TOOL_CONFIG_YAML = `defaults:
  sync_enabled: true
  categories_enabled:
    - context_feed
    - skills
    - commands
    - agents
    - mcp_servers
    - slash_commands
    - whitelist_policy
  scope: project
tools:
  claude:
    enabled: true
    scope: project
    categories: {}
    preferences: {}
  cursor:
    enabled: true
    scope: project
    categories: {}
    preferences: {}
  codex:
    enabled: true
    scope: project
    categories: {}
    preferences: {}
  copilot:
    enabled: true
    scope: project
    categories: {}
    preferences: {}
  gemini:
    enabled: true
    scope: project
    categories: {}
    preferences: {}
policy:
  whitelist:
    allowed_patterns: []
    denied_patterns: []
    advisory_level: warn
`;

const DEFAULT_XTCTX_USAGE_SKILL = `# xtctx-usage

Use this workflow when xtctx tools are available through MCP.

## Session Start

1. Read the managed block in this file (between \`<!-- xtctx:begin -->\` and
   \`<!-- xtctx:end -->\` markers, or per-tool variants). It already contains
   a brief of the most-recent session in another tool when one exists.
2. If you need more than the brief, call \`xtctx_recent_sessions\` to list
   recent work across all supported AI coding tools.
3. Call \`xtctx_session_detail\` to drill into the full transcript of any
   session listed by step 2.
4. Use \`xtctx_last_session_brief\` if you want the brief programmatically
   (same content as the managed block) — useful for confirming freshness
   or pulling JSON.

## During Implementation

1. Use \`xtctx_list_configs\` and \`xtctx_get_config\` to load shared project
   rules (skills, commands, agents).
2. Use \`xtctx_tool_preferences\` to pick up tool-specific behavior before
   acting.
3. Use \`xtctx_continuity_status\` and \`xtctx_effective_policy\` if you need
   to inspect or troubleshoot the per-tool sync state.

## Durable knowledge (out of scope for xtctx)

xtctx is **handoff-scope only** — it remembers the last few days of project
context to make tool-switching seamless. For project-lifetime knowledge
(architectural decisions that should outlive the hot-state window, durable
fix archives, multi-agent shared memory), use \`construct\` if it's installed,
or hand-edit \`AGENTS.md\` / \`CLAUDE.md\` outside the managed block — anything
outside the fences is preserved verbatim.
`;

export async function runInit(options: InitOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const configFile = join(xtctxDir, "config.yaml");
  const toolConfigDir = join(xtctxDir, "tool-config");
  const toolSkillsDir = join(toolConfigDir, "skills");
  const toolCommandsDir = join(toolConfigDir, "commands");
  const toolAgentsDir = join(toolConfigDir, "agents");
  const toolMcpServersDir = join(toolConfigDir, "mcp-servers");
  const toolSlashCommandsDir = join(toolConfigDir, "slash-commands");
  const toolConfigFile = join(toolConfigDir, "shared.yaml");
  const xtctxUsageSkillFile = join(toolSkillsDir, "xtctx-usage.md");
  const stateDir = join(xtctxDir, "state");

  // Knowledge folder mkdirs are gone with the handoff-scope pivot — xtctx
  // no longer stores durable structured records. The handoff brief lives
  // inside each tool's managed memory block, not in `.xtctx/knowledge/`.
  // For project-lifetime knowledge, see `construct`.
  await mkdir(xtctxDir, { recursive: true });
  await mkdir(toolConfigDir, { recursive: true });
  await mkdir(toolSkillsDir, { recursive: true });
  await mkdir(toolCommandsDir, { recursive: true });
  await mkdir(toolAgentsDir, { recursive: true });
  await mkdir(toolMcpServersDir, { recursive: true });
  await mkdir(toolSlashCommandsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await writeIfMissing(configFile, DEFAULT_CONFIG_YAML, options.force ?? false);
  await writeIfMissing(toolConfigFile, DEFAULT_TOOL_CONFIG_YAML, options.force ?? false);
  await writeIfMissing(xtctxUsageSkillFile, DEFAULT_XTCTX_USAGE_SKILL, options.force ?? false);

  if (!options.silent) {
    console.log(`Initialized xtctx in ${xtctxDir}`);
  }
}

async function writeIfMissing(
  filePath: string,
  content: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    try {
      await readFile(filePath, "utf-8");
      return;
    } catch {
      // File missing, continue with write.
    }
  }

  await writeFile(filePath, content, "utf-8");
}
