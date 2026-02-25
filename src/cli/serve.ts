import { startApiServer } from "../api/server.js";
import { startMcpServer, type McpToolDependencies } from "../mcp/server.js";
import { createIngestionRuntime } from "../runtime/ingestion.js";
import { createProjectServices } from "../runtime/services.js";
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
  const runtime = await createIngestionRuntime(services);
  let apiHandle: Awaited<ReturnType<typeof startApiServer>> | null = null;
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

  shutdown.installSignalHandlers((signal) => {
    console.error(`xtctx serve: received ${signal}, shutting down.`);
    void shutdown.run(`signal:${signal}`).then((result) => {
      reportShutdownErrors(result.errors);
    }).finally(() => {
      process.exit(0);
    });
  });

  const dependencies: McpToolDependencies = {
    search: runtime.search,
    knowledge: services.knowledge,
    writer: services.knowledge,
    sessions: services.sessions,
    configs: services.configs,
  };

  try {
    if (!options.mcpOnly) {
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
      console.error(`xtctx serve: API server active on http://127.0.0.1:${apiHandle.port}`);
      console.error(`xtctx serve: web UI available at http://127.0.0.1:${apiHandle.port}/`);
      console.error(
        `xtctx serve: ingestion daemon active (poll ${services.ingestion.pollIntervalMs}ms).`,
      );
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
