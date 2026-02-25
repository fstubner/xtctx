import express from "express";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConfigRouter } from "./routes/config.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createSearchRouter } from "./routes/search.js";
import { createSourcesRouter } from "./routes/sources.js";
import { createProjectServices } from "../runtime/services.js";

export interface ApiServerOptions {
  projectPath?: string;
  port?: number;
  webStaticDir?: string;
}

export interface ApiServerHandle {
  app: express.Express;
  server: ReturnType<typeof createServer>;
  port: number;
}

export async function createApiApp(
  projectPath?: string,
  options: Pick<ApiServerOptions, "webStaticDir"> = {},
): Promise<{
  app: express.Express;
  port: number;
}> {
  const services = await createProjectServices(projectPath);
  const webAssets = await resolveWebAssets(options.webStaticDir);
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
  if (webAssets) {
    app.use(express.static(webAssets.root, { index: false }));

    app.get("/", (_req, res) => {
      res.sendFile(webAssets.indexFile);
    });

    app.get("/{*path}", (req, res, next) => {
      if (req.path === "/health" || req.path === "/api" || req.path.startsWith("/api/")) {
        next();
        return;
      }

      if (extname(req.path)) {
        next();
        return;
      }

      res.sendFile(webAssets.indexFile);
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  });

  return { app, port: services.webPort };
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<ApiServerHandle> {
  const { app, port: defaultPort } = await createApiApp(options.projectPath, {
    webStaticDir: options.webStaticDir,
  });
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

interface WebAssets {
  root: string;
  indexFile: string;
}

async function resolveWebAssets(webStaticDir?: string): Promise<WebAssets | null> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = dedupePaths([
    webStaticDir,
    resolve(moduleDir, "..", "..", "web"),
    resolve(moduleDir, "..", "..", "..", "dist", "web"),
    resolve(moduleDir, "..", "..", "..", "web", "dist"),
  ]);

  for (const candidate of candidates) {
    const indexFile = join(candidate, "index.html");
    if (await isFile(indexFile)) {
      return { root: candidate, indexFile };
    }
  }

  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch {
    return false;
  }
}

function dedupePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((entry): entry is string => Boolean(entry)))];
}
