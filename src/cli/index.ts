#!/usr/bin/env node
import { Command } from "commander";
import { runDisconnect } from "./disconnect.js";
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
    .option("--global-mcp", "Also configure Copilot CLI global MCP (Antigravity MCP is always configured)", false)
    .description("Configure MCP, hooks, managed handoff instructions, and synced skills")
    .action(
      async (
        projectPath: string | undefined,
        options: { project?: string; yes: boolean; repair: boolean; globalMcp: boolean },
      ) => {
        const globalOptions = program.opts<{ project?: string }>();
        await runSetup({
          projectPath: options.project ?? globalOptions.project ?? projectPath,
          yes: options.yes,
          repair: options.repair,
          includeGlobalMcp: options.globalMcp,
        });
      },
    );

  program
    .command("status")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .description("Diagnose xtctx handoff wiring and local transcript index")
    .action(async (options: { project?: string }) => {
      const globalOptions = program.opts<{ project?: string }>();
      await runStatus({ projectPath: options.project ?? globalOptions.project });
    });

  program
    .command("disconnect")
    .argument("[tool]", "Tool to stop managing for this project")
    .option("--all", "Disconnect xtctx from all supported tools", false)
    .option("-p, --project <path>", "Project root")
    .option("-y, --yes", "Apply disconnect without prompting", false)
    .description("Remove xtctx management from a tool without deleting transcript data")
    .action(
      async (
        tool: string | undefined,
        options: { all: boolean; project?: string; yes: boolean },
      ) => {
        const globalOptions = program.opts<{ project?: string }>();
        await runDisconnect({
          tool,
          all: options.all,
          projectPath: options.project ?? globalOptions.project,
          yes: options.yes,
        });
      },
    );

  program
    .option("--hook <event>", "Internal hook event name")
    .option("--tool <tool>", "Tool invoking an internal hook")
    .option("-p, --project <path>", "Project root");

  program.action(async () => {
    const options = program.opts<{ hook?: string; tool?: string; project?: string }>();
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
