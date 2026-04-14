import { join, relative, resolve } from "node:path";
import { syncToolHooks } from "../config/hooks.js";
import { loadMcpServerDefinitions, syncToolMcpConfigs } from "../config/mcp-config.js";
import { loadSkillDefinitions, syncToolSkills } from "../config/skills.js";
import { syncToolConfigs } from "../config/sync.js";

export interface SyncOptions {
  projectPath?: string;
}

export async function runSync(options: SyncOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const result = await syncToolConfigs(projectRoot);

  console.log(
    `Synced tool continuity in ${projectRoot} (updated: ${result.updated}, created: ${result.created}, unchanged: ${result.unchanged})`,
  );

  for (const tool of result.tools) {
    console.log(`- ${tool.tool}: ${tool.state} (${tool.scope})`);
    if (tool.warnings.length > 0) {
      for (const warning of tool.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
  }

  for (const file of result.files.filter((entry) => entry.updated || entry.created)) {
    const changeType = file.created ? "created" : "updated";
    const displayPath = relative(projectRoot, file.path) || ".";
    console.log(`  ${file.tool}: ${changeType} ${displayPath}`);
  }

  if (result.warnings.length > 0) {
    console.log("\nSync warnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  // Phase 2: Generate executable hook files (e.g. .claude/hooks.json, .cursor/rules/)
  const hookResults = await syncToolHooks(projectRoot);
  const hookChanges = hookResults.filter((h) => h.updated || h.created);
  if (hookChanges.length > 0) {
    console.log("\nHook files:");
    for (const hook of hookChanges) {
      const changeType = hook.created ? "created" : "updated";
      const displayPath = relative(projectRoot, hook.path) || ".";
      console.log(`  ${hook.tool}: ${changeType} ${displayPath}`);
    }
  }

  for (const hook of hookResults) {
    if (hook.warning) {
      console.log(`  hook warning (${hook.tool}): ${hook.warning}`);
    }
  }

  // Phase 3: Translate skill content into tool-native formats
  const configRoot = join(projectRoot, ".xtctx", "tool-config");
  const enabledTools = result.tools
    .filter((t) => t.enabled)
    .map((t) => t.tool);

  const skills = await loadSkillDefinitions(configRoot);
  if (skills.length > 0) {
    const skillResults = await syncToolSkills(projectRoot, skills, enabledTools);
    const skillChanges = skillResults.results.filter((s) => s.updated || s.created);
    if (skillChanges.length > 0) {
      console.log("\nSkill files:");
      for (const skill of skillChanges) {
        const changeType = skill.created ? "created" : "updated";
        const displayPath = relative(projectRoot, skill.path) || ".";
        console.log(`  ${skill.tool}: ${changeType} ${displayPath}`);
      }
    }
    for (const skill of skillResults.results) {
      if (skill.warning) {
        console.log(`  skill warning (${skill.tool}): ${skill.warning}`);
      }
    }
  }

  // Phase 4: Write MCP server configs into tool-native formats
  const mcpServers = await loadMcpServerDefinitions(configRoot);
  if (mcpServers.length > 0) {
    const mcpResults = await syncToolMcpConfigs(projectRoot, mcpServers, enabledTools);
    const mcpChanges = mcpResults.results.filter((m) => m.updated || m.created);
    if (mcpChanges.length > 0) {
      console.log("\nMCP config files:");
      for (const mcp of mcpChanges) {
        const changeType = mcp.created ? "created" : "updated";
        const displayPath = relative(projectRoot, mcp.path) || ".";
        console.log(`  ${mcp.tool}: ${changeType} ${displayPath}`);
      }
    }
    for (const mcp of mcpResults.results) {
      if (mcp.warning) {
        console.log(`  mcp warning (${mcp.tool}): ${mcp.warning}`);
      }
    }
  }
}
