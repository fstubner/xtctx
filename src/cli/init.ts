import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface InitOptions {
  projectPath?: string;
  force?: boolean;
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

1. Call \`xtctx_search\` with a summary query of the active task before making changes.
2. Call \`xtctx_project_knowledge\` with \`type: all\` for prior decisions, fixes, and insights.
3. Optionally call \`xtctx_recent_sessions\` and \`xtctx_session_detail\` when session data is available.

## During Implementation

1. Use \`xtctx_search\` first at \`depth: summary\`, then drill into \`detail\` only as needed.
2. Use \`xtctx_list_configs\` and \`xtctx_get_config\` to load shared project rules.
3. Use \`xtctx_tool_preferences\` for tool-specific behavior before acting.

## Writeback Rules

1. Save major architecture choices with \`xtctx_save_decision\`.
2. Save recurring failures and verified fixes with \`xtctx_save_error_solution\`.
3. Save durable learnings with \`xtctx_save_insight\`.
4. Save recurring project Q&A with \`xtctx_save_faq\`.
5. Keep records short, concrete, and tied to files, commands, and rationale.
`;

export async function runInit(options: InitOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const knowledgeDir = join(xtctxDir, "knowledge");
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

  await mkdir(xtctxDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await mkdir(join(knowledgeDir, "decisions"), { recursive: true });
  await mkdir(join(knowledgeDir, "errors"), { recursive: true });
  await mkdir(join(knowledgeDir, "insights"), { recursive: true });
  await mkdir(join(knowledgeDir, "conventions"), { recursive: true });
  await mkdir(join(knowledgeDir, "gotchas"), { recursive: true });
  await mkdir(join(knowledgeDir, "faqs"), { recursive: true });
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

  console.log(`Initialized xtctx in ${xtctxDir}`);
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
