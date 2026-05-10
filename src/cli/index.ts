#!/usr/bin/env node
import { Command } from "commander";
import { runHook } from "./hook.js";
import { runSetup } from "./setup.js";
import { runStatus } from "./status.js";
import { createProjectServices } from "../runtime/services.js";
import { startMcpServer } from "../mcp/server.js";
import { readXtctxPackage } from "../utils/package-info.js";

const { version: CLI_VERSION } = readXtctxPackage(import.meta.url);

export async function main(argv = process.argv): Promise<void> {
  if (shouldStartMcp(argv)) {
    const services = await createProjectServices(process.cwd());
    await startMcpServer({ sessions: services.sessions });
    return;
  }

  const program = new Command();

  program
    .name("xtctx")
    .description("Local cross-tool handoff for AI coding agents")
    .version(CLI_VERSION)
    .showHelpAfterError();

  program
    .command("setup")
    .argument("[projectPath]", "Project root to configure")
    .option("-p, --project <path>", "Project root to configure")
    .option("-y, --yes", "Apply setup without prompting", false)
    .option("--repair", "Remove legacy generated xtctx config before writing current setup", false)
    .description("Configure MCP, hooks, and managed handoff instructions")
    .action(
      async (
        projectPath: string | undefined,
        options: { project?: string; yes: boolean; repair: boolean },
      ) => {
        await runSetup({
          projectPath: options.project ?? projectPath,
          yes: options.yes,
          repair: options.repair,
        });
      },
    );

  program
    .command("status")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .description("Diagnose xtctx handoff wiring and local transcript index")
    .action(async (options: { project?: string }) => {
      await runStatus({ projectPath: options.project });
    });

  program
    .option("--hook <event>", "Internal hook event name")
    .option("--tool <tool>", "Tool invoking an internal hook")
    .option("-p, --project <path>", "Project root");

  program.action(async (options: { hook?: string; tool?: string; project?: string }) => {
    if (options.hook) {
      await runHook({
        event: options.hook,
        tool: options.tool,
        projectPath: options.project,
      });
      return;
    }

    program.outputHelp();
  });

  await program.parseAsync(argv);
}

function shouldStartMcp(argv: string[]): boolean {
  if (argv.length > 2) {
    return false;
  }

  if (process.env.XTCTX_NO_AUTO_MCP === "1") {
    return false;
  }

  return process.stdin.isTTY !== true && process.stdout.isTTY !== true;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
