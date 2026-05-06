#!/usr/bin/env node
import { Command } from "commander";
import { runCompact } from "./compact.js";
import { runContext, runContextRecent } from "./context.js";
import { runIngest } from "./ingest.js";
import { runInit } from "./init.js";
import { runOnboard } from "./onboard.js";
import { runServe } from "./serve.js";
import { runStatus } from "./status.js";
import { runSync } from "./sync.js";
import { readXtctxPackage } from "../utils/package-info.js";

const { version: CLI_VERSION } = readXtctxPackage(import.meta.url);

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
    .command("onboard")
    .argument("[projectPath]", "Project root (defaults to cwd)")
    .option("-y, --yes", "Accept all defaults non-interactively (CI / scripted setup)", false)
    .option("--no-detect", "Skip tool auto-detection, enable all 7 tools instead")
    .description("Interactive first-run wizard: detect tools, choose scope, write shared.yaml")
    .action(async (projectPath: string | undefined, options: { yes: boolean; detect: boolean }) => {
      // commander turns `--no-detect` into `options.detect = false`.
      await runOnboard({
        projectPath,
        yes: options.yes,
        noDetect: options.detect === false,
      });
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
    .option("--diff", "Show what would change without writing", false)
    .description("Generate tool-native config files from shared config")
    .action(async (options: { project?: string; diff: boolean }) => {
      await runSync({ projectPath: options.project, diff: options.diff });
    });

  program
    .command("status")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .description("Print a one-screen runtime summary (works without serve)")
    .action(async (options: { project?: string }) => {
      await runStatus({ projectPath: options.project });
    });

  const contextCmd = program
    .command("context")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("-t, --tool <name>", "Filter context for a specific tool")
    .option("-s, --sections <list>", "Comma-separated sections: sessions,nudge", (v) =>
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

  contextCmd
    .command("recent")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option("-t, --tool <name>", "Filter to a specific tool")
    .option("-l, --limit <n>", "Max sessions to show", (v) => Number(v), 10)
    .option("--watch", "Re-render every 2s, exit on Ctrl+C", false)
    .description("List recent sessions across tools")
    .action(async (options: { project?: string; tool?: string; limit: number; watch: boolean }) => {
      await runContextRecent({
        projectPath: options.project,
        tool: options.tool,
        limit: options.limit,
        watch: options.watch,
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
