import express from "express";
import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createConfigRouter } from "./routes/config.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createSearchRouter } from "./routes/search.js";
import { createSourcesRouter } from "./routes/sources.js";
import { createProjectServices } from "../runtime/services.js";

export interface ApiServerOptions {
  projectPath?: string;
  port?: number;
  webStaticDir?: string;
  security?: Partial<ApiSecurityOptions>;
}

export interface ApiSecurityOptions {
  apiToken: string | null;
  allowedOrigins: string[];
  allowLocalhostOrigins: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export interface ApiServerHandle {
  app: express.Express;
  server: ReturnType<typeof createServer>;
  port: number;
}

export async function createApiApp(
  projectPath?: string,
  options: Pick<ApiServerOptions, "webStaticDir" | "security"> = {},
): Promise<{
  app: express.Express;
  port: number;
}> {
  const services = await createProjectServices(projectPath);
  const webAssets = await resolveWebAssets(options.webStaticDir);
  const security = resolveSecurityOptions(services.webPort, {
    ...services.apiSecurity,
    ...(options.security ?? {}),
  });
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      // The bundled SPA currently relies on defaults that may evolve; keep CSP external for now.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(createCorsMiddleware(security));

  const apiLimiter = rateLimit({
    windowMs: security.rateLimitWindowMs,
    max: security.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests. Please retry shortly." });
    },
  });
  app.use("/api", apiLimiter);
  app.use("/api", createApiAuthMiddleware(security));

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
    security: options.security,
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

function createCorsMiddleware(security: ApiSecurityOptions): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (!origin) {
      next();
      return;
    }

    if (!isAllowedOrigin(origin, security)) {
      res.status(403).json({ error: "Origin not allowed." });
      return;
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Xtctx-Api-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

function createApiAuthMiddleware(security: ApiSecurityOptions): express.RequestHandler {
  return (req, res, next) => {
    if (!security.apiToken || req.method === "OPTIONS") {
      next();
      return;
    }

    const candidate = extractToken(req);
    if (!candidate || !safeTokenEqual(candidate, security.apiToken)) {
      res.setHeader("WWW-Authenticate", "Bearer realm=\"xtctx-api\"");
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    next();
  };
}

function extractToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  const tokenHeader = req.headers["x-xtctx-api-token"];
  if (typeof tokenHeader === "string") {
    return tokenHeader;
  }

  return null;
}

function safeTokenEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isAllowedOrigin(origin: string, security: ApiSecurityOptions): boolean {
  if (security.allowedOrigins.includes(origin)) {
    return true;
  }

  if (security.allowLocalhostOrigins) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  }

  return false;
}

function resolveSecurityOptions(
  port: number,
  overrides: Partial<ApiSecurityOptions> | undefined,
): ApiSecurityOptions {
  const envOrigins = splitCsv(process.env.XTCTX_ALLOWED_ORIGINS);
  const defaultOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedOrigins = dedupePaths([
    ...(overrides?.allowedOrigins ?? []),
    ...envOrigins,
    ...defaultOrigins,
  ]);
  const localhostOriginDefault = overrides?.allowLocalhostOrigins ?? true;
  const allowLocalhostOrigins = process.env.XTCTX_ALLOW_LOCALHOST_ORIGINS == null
    ? localhostOriginDefault
    : parseBoolean(process.env.XTCTX_ALLOW_LOCALHOST_ORIGINS, localhostOriginDefault);
  const apiToken = process.env.XTCTX_API_TOKEN == null
    ? normalizeToken(overrides?.apiToken ?? null)
    : normalizeToken(process.env.XTCTX_API_TOKEN);

  return {
    apiToken,
    allowedOrigins,
    allowLocalhostOrigins,
    rateLimitWindowMs: sanitizePositiveInt(
      process.env.XTCTX_RATE_LIMIT_WINDOW_MS ?? overrides?.rateLimitWindowMs,
      60_000,
    ),
    rateLimitMax: sanitizePositiveInt(
      process.env.XTCTX_RATE_LIMIT_MAX ?? overrides?.rateLimitMax,
      120,
    ),
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function normalizeToken(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const token = value.trim();
  return token.length > 0 ? token : null;
}

function sanitizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return fallback;
}
