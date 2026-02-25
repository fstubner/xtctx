import express from "express";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createConfigRouter } from "./routes/config.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createSearchRouter } from "./routes/search.js";
import { createSourcesRouter } from "./routes/sources.js";
import { createProjectServices } from "../runtime/services.js";

export interface ApiServerOptions {
  projectPath?: string;
  port?: number;
}

export interface ApiServerHandle {
  app: express.Express;
  server: ReturnType<typeof createServer>;
  port: number;
}

export async function createApiApp(projectPath?: string): Promise<{
  app: express.Express;
  port: number;
}> {
  const services = await createProjectServices(projectPath);
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "xtctx-api",
      projectRoot: services.projectRoot,
    });
  });

  const knowledgeRecords = async () => services.knowledge.listAll();

  app.use("/api/search", createSearchRouter({ knowledgeRecords }));
  app.use("/api/knowledge", createKnowledgeRouter(services.knowledge));
  app.use(
    "/api/sources",
    createSourcesRouter({
      projectRoot: services.projectRoot,
      knowledgeDir: services.knowledgeDir,
      stateDir: services.stateDir,
      sessions: services.sessions,
      knowledgeRecords,
    }),
  );
  app.use("/api/config", createConfigRouter(services.configs));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  });

  return { app, port: services.webPort };
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<ApiServerHandle> {
  const { app, port: defaultPort } = await createApiApp(options.projectPath);
  const port = options.port ?? defaultPort;
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { app, server, port };
}

async function runFromCli(): Promise<void> {
  const handle = await startApiServer();
  console.log(`xtctx API listening on http://127.0.0.1:${handle.port}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";

if (import.meta.url === invokedPath) {
  runFromCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
