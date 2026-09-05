#!/usr/bin/env node
import { Command } from "commander";
import { runDisconnect } from "./disconnect.js";
import { runHook } from "./hook.js";
import { runScan } from "./scan.js";
import { runSetup } from "./setup.js";
import { runStatus } from "./status.js";
import { createProjectServices } from "../runtime/services.js";
import { startMcpServer } from "../mcp/server.js";
import type { SessionService } from "../handoff/types.js";
import { readXtctxPackage } from "../utils/package-info.js";

const { version: CLI_VERSION } = readXtctxPackage(import.meta.url);

export async function main(argv = process.argv): Promise<void> {
  if (shouldStartMcp(argv)) {
    const services = await createProjectServices(process.cwd());
    // Nobody opted this directory in. Say so instead of scanning every
    // transcript store on the machine to return an empty result that reads
    // like a configured project with no history.
    const unconfiguredProjectRoot = services.config.present ? undefined : services.projectRoot;
    let closed = false;
    const shutdown = (exit: boolean) => {
      if (closed) return;
      closed = true;

      // `close()` waits for any in-flight scan to settle, which is right while
      // the server is serving — it stops a scan writing into a closed handle.
      // It is wrong once the client has gone: a scan of every transcript store
      // on the machine takes over a minute, and the server sat there for 84
      // seconds after stdin closed. A host that spawns a server per session
      // accumulates those.
      //
      // So give the clean close a moment, then leave. Nothing is lost by not
      // waiting: the index is derived data, every chunk is committed as it is
      // written, and an unfinished scan simply resumes on the next run.
      const graceMs = 2_000;
      const timer = setTimeout(() => {
        if (exit) process.exit(0);
      }, graceMs);
      timer.unref?.();

      void services.sessions
        .close()
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          if (exit) process.exit(0);
        });
    };
    process.once("SIGINT", () => shutdown(true));
    process.once("SIGTERM", () => shutdown(true));
    // Exit once the transport closes, rather than waiting for the event loop
    // to drain. The client is gone, so there is nothing left to serve, and the
    // server otherwise sat there for 84 seconds while a scan finished. An MCP
    // host that spawns a server per session accumulates those.
    //
    // Nothing is lost by leaving before a scan finishes: the index is derived
    // data, every chunk is committed as it is written, and a scraper's cursor
    // only advances once its loop completes, so interrupted work is re-read
    // rather than skipped.
    //
    // A tool call still in flight when stdin closes may go unanswered — the
    // grace window above is enough for ordinary calls, not for one waiting on
    // a scan. The client has closed its side by then, so nothing is listening.
    await startMcpServer(
      { sessions: services.sessions, unconfiguredProjectRoot },
      () => shutdown(true),
    );

    // Warm the index now rather than on the first tool call. The host starts
    // this process at session start and keeps it for the session, so a scan
    // begun here is finished by the time the next session's hook reads the
    // index — which is what turns "Last scan: never" into a pointer at the
    // other tool's work. Not awaited, and never for an unconfigured project:
    // the scan writes an index.
    //
    // Every start, with no freshness gate. There was one — skip if a scan
    // finished in the last five minutes — and it failed the case this exists
    // for: Codex starts this server too, so its own session start stamped the
    // index a few seconds in, before Codex had written anything, and the
    // Claude Code session that followed trusted the stamp and skipped. Two
    // sessions in a row saw the stale stamp and no Codex session. A finish
    // time says nothing about what another tool wrote afterwards. The
    // incremental scan this costs measured 9.7s in the background against a
    // 19GB Codex store, and the cursor design keeps it from re-reading.
    if (!unconfiguredProjectRoot && !services.config.error) {
      void warmIndex(services.sessions);
    }
    return;
  }

  const program = new Command();

  program
    .name("xtctx")
    .description(
      [
        "Local cross-tool handoff for AI coding agents",
        "",
        "Run with no command and non-interactive stdio and xtctx starts its MCP",
        "server over stdio. Set XTCTX_NO_AUTO_MCP=1 to print this help instead,",
        "which is what you want when scripting xtctx from a pipe.",
      ].join("\n"),
    )
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
    .command("scan")
    .option("-p, --project <path>", "Project root (defaults to cwd)")
    .option(
      "--embed",
      "Also embed every window, so semantic search covers the whole history (slow: hours on a large one)",
      false,
    )
    .description("Scan the enabled transcript stores into this project's index, then exit")
    .action(async (options: { project?: string; embed?: boolean }) => {
      const globalOptions = program.opts<{ project?: string }>();
      await runScan({
        projectPath: options.project ?? globalOptions.project,
        embed: options.embed,
      });
    });

  program
    .command("disconnect")
    .argument("[tool]", "Tool to stop managing for this project")
    .option("--all", "Disconnect xtctx from all supported tools", false)
    .option(
      "--global-mcp",
      "Also remove xtctx from the machine-global Antigravity and Copilot CLI MCP configs",
      false,
    )
    .option("-p, --project <path>", "Project root")
    .option("-y, --yes", "Apply disconnect without prompting", false)
    .description("Remove xtctx management from a tool without deleting transcript data")
    .action(
      async (
        tool: string | undefined,
        options: { all: boolean; globalMcp: boolean; project?: string; yes: boolean },
      ) => {
        const globalOptions = program.opts<{ project?: string }>();
        await runDisconnect({
          tool,
          all: options.all,
          globalMcp: options.globalMcp,
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

/**
 * Start a scan and let it run.
 *
 * `listRecentSessions` is the read that starts a scan; its result is not
 * wanted here, and the budget it waits on is short. A failure is not the
 * server's problem to report at startup: the same scan runs again on the
 * first call, where its error is recorded against the tool.
 */
async function warmIndex(sessions: SessionService): Promise<void> {
  try {
    await sessions.listRecentSessions(1);
  } catch {
    // Deliberately silent; see above.
  }
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
