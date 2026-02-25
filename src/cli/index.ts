#!/usr/bin/env node
import { Command } from "commander";
import { runIngest } from "./ingest.js";
import { runInit } from "./init.js";
import { runServe } from "./serve.js";
import { runSync } from "./sync.js";

const CLI_VERSION = "0.1.0";

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("xtctx")
    .description("Cross-tool context for AI coding agents")
    .version(CLI_VERSION);

  program
    .command("init")
    .argument("[projectPath]", "Project root to initialize")
    .option("-f, --force", "Overwrite existing xtctx config files", false)
    .description("Scaffold .xtctx in the target project")
    .action(async (projectPath: string | undefined, options: { force: boolean }) => {
      await runInit({ projectPath, force: options.force });
    });

  program
    .command("serve")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("--mcp-only", "Only start MCP server (skip ingestion/web notices)", false)
    .description("Start xtctx services (currently MCP server)")
    .action(async (options: { project?: string; mcpOnly: boolean }) => {
      await runServe({
        projectPath: options.project,
        mcpOnly: options.mcpOnly,
      });
    });

  program
    .command("sync")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .description("Generate tool-native config files from shared config")
    .action(async (options: { project?: string }) => {
      await runSync({ projectPath: options.project });
    });

  program
    .command("ingest")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("--full", "Run a full re-sync instead of incremental", false)
    .description("Manually trigger ingestion")
    .action(async (options: { project?: string; full: boolean }) => {
      await runIngest({
        projectPath: options.project,
        full: options.full,
      });
    });

  await program.parseAsync(argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
