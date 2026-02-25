import { relative, resolve } from "node:path";
import { syncToolConfigs } from "../config/sync.js";

export interface SyncOptions {
  projectPath?: string;
}

export async function runSync(options: SyncOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const result = await syncToolConfigs(projectRoot);

  console.log(
    `Synced tool configs in ${projectRoot} (updated: ${result.updated}, created: ${result.created}, unchanged: ${result.unchanged})`,
  );

  for (const file of result.files.filter((entry) => entry.updated)) {
    const changeType = file.created ? "created" : "updated";
    const displayPath = relative(projectRoot, file.path) || ".";
    console.log(`- ${changeType}: ${displayPath}`);
  }
}
