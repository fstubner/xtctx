#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { runCompact } from "./compact.js";
import { runContext } from "./context.js";
import { runIngest } from "./ingest.js";
import { runInit } from "./init.js";
import { runServe } from "./serve.js";
import { runSync } from "./sync.js";

const require = createRequire(import.meta.url);
// Resolve repo-root package.json from both source (src/cli/, ../../) and compiled (dist/src/cli/, ../../../) locations.
const loadPackageJson = (): { version: string } => {
  try {
    return require("../../package.json") as { version: string };
  } catch {
    return require("../../../package.json") as { version: string };
  }
};
const { version: CLI_VERSION } = loadPackageJson();

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
    .command("context")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("-t, --tool <name>", "Filter context for a specific tool")
    .option("-s, --sections <list>", "Comma-separated sections: sessions,knowledge,nudge", (v) =>
      v.split(",").map((s) => s.trim()),
    )
    .description("Output session context for hook injection (stdout)")
    .action(async (options: { project?: string; tool?: string; sections?: string[] }) => {
      await runContext({
        projectPath: options.project,
        tool: options.tool,
        sections: options.sections,
      });
    });

  program
    .command("compact")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("--full", "Run full compaction instead of incremental (last 24h)", false)
    .description("Run conversation compaction (rule-based or LLM-assisted)")
    .action(async (options: { project?: string; full: boolean }) => {
      await runCompact({
        projectPath: options.project,
        full: options.full,
      });
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
