import { startApiServer } from "../api/server.js";
import { startMcpServer, type McpToolDependencies } from "../mcp/server.js";
import { createIngestionRuntime } from "../runtime/ingestion.js";
import { createProjectServices } from "../runtime/services.js";

interface ServeOptions {
  projectPath?: string;
  mcpOnly?: boolean;
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);
  const runtime = await createIngestionRuntime(services);
  let apiHandle: Awaited<ReturnType<typeof startApiServer>> | null = null;

  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    await runtime.daemon.stop();
    if (apiHandle) {
      await closeHttpServer(apiHandle.server);
      apiHandle = null;
    }
  };

  const handleSignal = (signal: string) => {
    console.error(`xtctx serve: received ${signal}, shutting down.`);
    void cleanup().finally(() => {
      process.exit(0);
    });
  };

  const sigintHandler = () => handleSignal("SIGINT");
  const sigtermHandler = () => handleSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  const dependencies: McpToolDependencies = {
    search: runtime.search,
    knowledge: services.knowledge,
    writer: services.knowledge,
    sessions: services.sessions,
    configs: services.configs,
  };

  try {
    if (!options.mcpOnly) {
      await runtime.daemon.start();
      apiHandle = await startApiServer({
        projectPath: services.projectRoot,
        port: services.webPort,
      });
      console.error(`xtctx serve: API server active on http://127.0.0.1:${apiHandle.port}`);
      console.error("xtctx serve: web UI should be started separately with `npm --prefix web run dev`.");
      console.error(
        `xtctx serve: ingestion daemon active (poll ${services.ingestion.pollIntervalMs}ms).`,
      );
    }

    console.error(`xtctx serve: MCP stdio server active for project ${services.projectRoot}`);
    await startMcpServer(dependencies);
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    await cleanup();
  }
}

async function closeHttpServer(server: { close: (cb: (error?: Error | null) => void) => void }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
