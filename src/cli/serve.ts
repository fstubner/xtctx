import { startApiServer } from "../api/server.js";
import { startMcpServer, type McpToolDependencies } from "../mcp/server.js";
import { createProjectServices } from "../runtime/services.js";

interface ServeOptions {
  projectPath?: string;
  mcpOnly?: boolean;
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);

  const dependencies: McpToolDependencies = {
    knowledge: services.knowledge,
    writer: services.knowledge,
    sessions: services.sessions,
    configs: services.configs,
  };

  if (!options.mcpOnly) {
    const api = await startApiServer({
      projectPath: services.projectRoot,
      port: services.webPort,
    });
    console.error(`xtctx serve: API server active on http://127.0.0.1:${api.port}`);
    console.error("xtctx serve: web UI should be started separately with `npm --prefix web run dev`.");
  }

  console.error(`xtctx serve: MCP stdio server active for project ${services.projectRoot}`);
  await startMcpServer(dependencies);
}
