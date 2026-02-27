import { relative, resolve } from "node:path";
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
}
