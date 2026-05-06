import { startApiServer } from "../api/server.js";
import { renderStatusBlock } from "./status.js";
import { syncToolHooks } from "../config/hooks.js";
import { loadEffectiveContinuityPolicy } from "../config/policy.js";
import { syncToolConfigs } from "../config/sync.js";
import { getToolContinuityStatuses } from "../config/sync.js";
import { startMcpServer, type McpToolDependencies } from "../mcp/server.js";
import { createIngestionRuntime } from "../runtime/ingestion.js";
import { createProjectServices } from "../runtime/services.js";
import { errorMessage } from "../utils/errors.js";
import { withRetry } from "../utils/retry.js";
import {
  closeHttpServer,
  ShutdownCoordinator,
  type ShutdownError,
} from "../utils/shutdown.js";

interface ServeOptions {
  projectPath?: string;
  mcpOnly?: boolean;
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);
  await runAutoSync(services.projectRoot, "startup");
  const runtime = await createIngestionRuntime(services);
  // Capture a stable handle to the session service so the periodic
  // reconcile tick can pull fresh recent sessions for handoff briefs.
  const fetchRecentSessions = () => services.sessions.listRecentSessions(20);

  let apiHandle: Awaited<ReturnType<typeof startApiServer>> | null = null;
  let syncInterval: NodeJS.Timeout | null = null;
  const shutdown = new ShutdownCoordinator();

  shutdown.register("api-server", async () => {
    if (apiHandle) {
      await closeHttpServer(apiHandle.server);
      apiHandle = null;
    }
  });
  shutdown.register("ingestion-daemon", async () => {
    await runtime.daemon.stop();
  });
  shutdown.register("continuity-sync", async () => {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  });

  shutdown.installSignalHandlers((signal) => {
    console.error(`xtctx serve: received ${signal}, shutting down.`);
    void shutdown.run(`signal:${signal}`).then((result) => {
      reportShutdownErrors(result.errors);
    }).finally(() => {
      process.exit(0);
    });
  });

  const dependencies: McpToolDependencies = {
    sessions: services.sessions,
    configs: services.configs,
    continuity: {
      effectivePolicy: async () => loadEffectiveContinuityPolicy(services.projectRoot),
      toolStatuses: async () => getToolContinuityStatuses(services.projectRoot),
    },
  };

  try {
    if (!options.mcpOnly) {
      syncInterval = setInterval(() => {
        void runAutoSync(services.projectRoot, "reconcile", fetchRecentSessions);
      }, Math.max(15_000, services.ingestion.pollIntervalMs));

      await withRetry(
        async () => {
          await runtime.daemon.start();
        },
        {
          attempts: 3,
          minDelayMs: 250,
          maxDelayMs: 2_000,
          onRetry: (error, attempt, delayMs) => {
            console.error(
              `xtctx serve: ingestion startup failed (attempt ${attempt}). Retrying in ${delayMs}ms: ${errorMessage(error)}`,
            );
          },
        },
      );

      apiHandle = await withRetry(
        async () =>
          startApiServer({
            projectPath: services.projectRoot,
            port: services.webPort,
          }),
        {
          attempts: 3,
          minDelayMs: 250,
          maxDelayMs: 2_000,
          onRetry: (error, attempt, delayMs) => {
            console.error(
              `xtctx serve: API startup failed (attempt ${attempt}). Retrying in ${delayMs}ms: ${errorMessage(error)}`,
            );
          },
        },
      );
      await waitForApiReadiness(apiHandle.port);
      const status = await renderStatusBlock({
        services,
        port: apiHandle.port,
      });
      process.stderr.write(status + "\n");
      console.error("Press Ctrl+C to stop.");
    }

    console.error(`xtctx serve: MCP stdio server active for project ${services.projectRoot}`);
    await startMcpServer(dependencies);
  } finally {
    shutdown.removeSignalHandlers();
    const result = await shutdown.run("serve-exit");
    reportShutdownErrors(result.errors);
  }
}

async function waitForApiReadiness(port: number): Promise<void> {
  await withRetry(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) {
        throw new Error(`health endpoint returned ${response.status}`);
      }

      const payload = (await response.json()) as { ok?: boolean };
      if (!payload.ok) {
        throw new Error("health endpoint did not report ok=true");
      }
    },
    {
      attempts: 5,
      minDelayMs: 100,
      maxDelayMs: 1_000,
    },
  );
}

function reportShutdownErrors(errors: ShutdownError[]): void {
  for (const error of errors) {
    console.error(
      `xtctx serve: shutdown step '${error.name}' failed: ${errorMessage(error.error)}`,
    );
  }
}

async function runAutoSync(
  projectRoot: string,
  reason: "startup" | "reconcile",
  sessionsProvider?: () => Promise<import("../mcp/tools/sessions.js").SessionSummary[]>,
): Promise<void> {
  try {
    // Fetch recent sessions on each tick so the handoff brief in every
    // tool's managed memory file is fresh. Empty list at startup (the
    // ingestion daemon hasn't started yet) → brief renders as nothing
    // → section is skipped → managed block is unchanged from when no
    // sessions existed. The reconcile tick passes the live session
    // service so briefs update as new conversations are scraped.
    const sessions = sessionsProvider ? await sessionsProvider() : [];
    const result = await syncToolConfigs(projectRoot, sessions);
    const updates = result.updated + result.created;
    if (updates > 0 || result.warnings.length > 0 || reason === "startup") {
      console.error(
        `xtctx serve: continuity ${reason} sync complete (updated: ${result.updated}, created: ${result.created}, unchanged: ${result.unchanged}).`,
      );
    }

    for (const warning of result.warnings) {
      console.error(`xtctx serve: continuity warning: ${warning}`);
    }

    if (reason === "startup") {
      const hookResults = await syncToolHooks(projectRoot);
      for (const hook of hookResults) {
        if (hook.created) {
          console.error(`xtctx serve: created hook ${hook.tool}: ${hook.path}`);
        }
        if (hook.warning) {
          console.error(`xtctx serve: hook warning (${hook.tool}): ${hook.warning}`);
        }
      }
    }
  } catch (error) {
    console.error(`xtctx serve: continuity ${reason} sync failed: ${errorMessage(error)}`);
  }
}
