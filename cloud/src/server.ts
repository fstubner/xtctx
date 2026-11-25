import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CloudContext, DashboardAssets, UploadLimits } from "./types.js";
import { CLI_SCOPES, CLI_TOKEN_TTL_SECONDS, READ_TOKEN_TTL_SECONDS, mintToken } from "./auth/jwt.js";
import { DEFAULT_UPLOAD_LIMITS } from "./db/ingest.js";
import { createPool, runMigrations } from "./db/pool.js";
import { bumpTokenEpoch, upsertUser } from "./db/queries.js";
import { createEmbedderFromEnv } from "./embedder.js";
import { handleCloudRequest } from "./handler.js";
import { drainEmbeddingQueue, runWorkerLoop } from "./worker-loop.js";

function readOptional(directKey: string, fileKey: string): string | undefined {
  const file = process.env[fileKey]?.trim();
  if (file) return readFileSync(file, "utf8").trim();
  const val = process.env[directKey]?.trim();
  return val && val.length > 0 ? val : undefined;
}

function parsePositiveIntEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(raw);
}

function resolveUploadLimitsFromEnv(): UploadLimits {
  return {
    ...DEFAULT_UPLOAD_LIMITS,
    ...(parsePositiveIntEnv("MAX_UPLOAD_BODY_BYTES") ? { maxBodyBytes: parsePositiveIntEnv("MAX_UPLOAD_BODY_BYTES")! } : {}),
    ...(parsePositiveIntEnv("MAX_UPLOAD_MESSAGE_BYTES")
      ? { maxMessageBytes: parsePositiveIntEnv("MAX_UPLOAD_MESSAGE_BYTES")! }
      : {}),
  };
}

function resolveAssetPath(...candidates: string[]): string {
  for (const candidate of candidates) {
    const p = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL(candidates[0], import.meta.url));
}

function loadDashboardAssets(): DashboardAssets {
  const dir = resolveAssetPath("./dashboard/", "./src/dashboard/", "../src/dashboard/");
  return {
    html: readFileSync(resolve(dir, "index.html"), "utf8"),
    css: readFileSync(resolve(dir, "app.css"), "utf8"),
    js: readFileSync(resolve(dir, "app.js"), "utf8"),
  };
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const databaseUrl = readOptional("DATABASE_URL", "DATABASE_URL_FILE");
  if (!databaseUrl) throw new Error("DATABASE_URL (or DATABASE_URL_FILE) is required");
  const appRole = process.env.DATABASE_APP_ROLE?.trim() || undefined;
  const migrationsDir = resolveAssetPath("./migrations/", "../migrations/");
  const pool = createPool(databaseUrl);

  try {
    await runMigrations(pool, migrationsDir, appRole);

    if (command === "migrate") {
      console.log("PostgreSQL migrations complete");
      return;
    }

    if (command === "worker") {
      const embedder = createEmbedderFromEnv(process.env);
      if (!embedder) {
        console.log(JSON.stringify({ event: "worker_disabled", reason: "EMBEDDING_PROVIDER=none" }));
        return;
      }
      const ac = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => ac.abort());
      }
      if (process.argv.slice(3).includes("--once")) {
        const processed = await drainEmbeddingQueue({ pool, embedder, signal: ac.signal });
        console.log(JSON.stringify({ event: "worker_once_complete", provider: embedder.provider, model: embedder.model, processed }));
        return;
      }
      const pollMs = parsePositiveIntEnv("EMBEDDING_POLL_MS") ?? 2000;
      console.log(JSON.stringify({ event: "worker_started", provider: embedder.provider, model: embedder.model }));
      await runWorkerLoop({ pool, embedder, pollMs, signal: ac.signal });
      return;
    }

    const publicUrl = new URL(process.env.PUBLIC_URL ?? "http://localhost:8788");
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
      throw new Error("PUBLIC_URL must be an origin");
    }
    if (
      publicUrl.protocol !== "https:" &&
      !(publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname))
    ) {
      throw new Error("PUBLIC_URL requires HTTPS outside localhost");
    }

    const jwtSecret = readOptional("JWT_SECRET", "JWT_SECRET_FILE") ?? "";
    if (jwtSecret.length < 32) {
      throw new Error("JWT_SECRET (or JWT_SECRET_FILE) must contain at least 32 characters");
    }

    const stripeKey = readOptional("STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY_FILE");
    const stripeWebhook = readOptional("STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_FILE");
    const stripePrice = process.env.STRIPE_PRICE_ID?.trim() || undefined;
    const hostedQuota = parsePositiveIntEnv("HOSTED_MESSAGE_QUOTA");

    const ids = (process.env.ALLOWED_GITHUB_IDS ?? "").trim();
    if (ids.length > 0 && !/^\d+(,\d+)*$/.test(ids)) {
      throw new Error("ALLOWED_GITHUB_IDS must contain comma-separated numeric account IDs");
    }
    if (!ids && !stripeKey) {
      throw new Error("ALLOWED_GITHUB_IDS or STRIPE_SECRET_KEY is required");
    }

    const ctx: CloudContext = {
      pool,
      appRole,
      embedder: createEmbedderFromEnv(process.env),
      embedOnUpload: ["1", "true", "yes"].includes((process.env.EMBED_ON_UPLOAD ?? "").trim().toLowerCase()),
      publicUrl: publicUrl.origin,
      jwtSecret,
      githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
      githubClientSecret: readOptional("GITHUB_CLIENT_SECRET", "GITHUB_CLIENT_SECRET_FILE"),
      allowedGithubIds: ids || undefined,
      allowedOrigins: process.env.ALLOWED_ORIGINS?.trim() || undefined,
      stripeSecretKey: stripeKey,
      stripeWebhookSecret: stripeWebhook,
      stripePriceId: stripePrice,
      hostedMessageQuota: hostedQuota,
      uploadLimits: resolveUploadLimitsFromEnv(),
      dashboardAssets: command === "serve" ? loadDashboardAssets() : undefined,
    };

    if (command === "token" || command === "revoke") {
      const options = process.argv.slice(3);
      const get = (name: string) => {
        const i = options.indexOf(name);
        return i < 0 ? undefined : options[i + 1];
      };
      const id = get("--user-id");
      if (!id || !/^\d+$/.test(id) || (ids && !ids.split(",").includes(id))) {
        throw new Error("Select a valid numeric (and allowlisted if configured) --user-id");
      }
      const userId = `github:${id}`;
      if (command === "revoke") {
        await bumpTokenEpoch(ctx, userId);
        console.log("Account tokens revoked");
      } else {
        const role = get("--role");
        if (!role || !["reader", "uploader"].includes(role)) {
          throw new Error("--role must be reader or uploader");
        }
        const output = get("--output");
        if (!output) {
          throw new Error("--output is required; tokens are never printed");
        }
        const username = get("--username") ?? id;
        const epoch = await upsertUser(ctx, userId, username);
        const token = await mintToken(
          ctx,
          { userId, username, epoch, scopes: role === "reader" ? ["read"] : CLI_SCOPES },
          role === "reader" ? READ_TOKEN_TTL_SECONDS : CLI_TOKEN_TTL_SECONDS,
        );
        const resolved = resolve(output);
        mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
        writeFileSync(resolved, `${token}\n`, { mode: 0o600, flag: "wx" });
        chmodSync(resolved, 0o600);
        console.log("Scoped token saved to the requested file");
      }
      return;
    }

    if (command !== "serve") {
      throw new Error("Expected serve, worker, migrate, token, or revoke");
    }

    const host = process.env.HOST?.trim() || "127.0.0.1";
    const port = Number(process.env.PORT ?? 8788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid PORT");
    }

    const RATE_WINDOW_MS = 60_000;
    const MAX_REQUESTS_PER_CLIENT = 600;
    const MAX_REQUESTS_GLOBAL = 6_000;
    const MAX_RATE_CLIENTS = 10_000;
    let globalRequests = 0;
    let globalWindowStart = Date.now();
    const clientCounters = new Map<string, { count: number; windowStart: number }>();

    const clientKey = (req: import("node:http").IncomingMessage): string => {
      const xff = req.headers["x-forwarded-for"];
      const firstHop =
        typeof xff === "string"
          ? xff.split(",")[0]?.trim()
          : Array.isArray(xff)
            ? xff[0]?.split(",")[0]?.trim()
            : undefined;
      const xri = typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : undefined;
      return firstHop || xri || req.socket.remoteAddress || "unknown";
    };

    const server = createServer(async (req, res) => {
      try {
        const now = Date.now();
        if (now - globalWindowStart > RATE_WINDOW_MS) {
          globalWindowStart = now;
          globalRequests = 0;
        }
        if (++globalRequests > MAX_REQUESTS_GLOBAL) {
          res.writeHead(429, { "retry-after": "60" }).end();
          return;
        }
        const key = clientKey(req);
        let entry = clientCounters.get(key);
        if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
          if (!entry && clientCounters.size >= MAX_RATE_CLIENTS) {
            for (const [k, v] of clientCounters) {
              if (now - v.windowStart > RATE_WINDOW_MS) clientCounters.delete(k);
            }
            if (clientCounters.size >= MAX_RATE_CLIENTS) {
              const oldest = clientCounters.keys().next().value;
              if (oldest !== undefined) clientCounters.delete(oldest);
            }
          }
          entry = { count: 0, windowStart: now };
          clientCounters.set(key, entry);
        }
        if (++entry.count > MAX_REQUESTS_PER_CLIENT) {
          res.writeHead(429, { "retry-after": "60" }).end();
          return;
        }

        const reqHost = req.headers.host;
        if (
          reqHost !== publicUrl.host &&
          reqHost !== `127.0.0.1:${port}` &&
          reqHost !== `localhost:${port}`
        ) {
          res.writeHead(400).end();
          return;
        }

        const url = new URL(req.url ?? "/", publicUrl.origin);
        if (url.origin !== publicUrl.origin) {
          res.writeHead(400).end();
          return;
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }
        const init: RequestInit & { duplex?: string } = { method: req.method, headers };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = Readable.toWeb(req) as NonNullable<RequestInit["body"]>;
          init.duplex = "half";
        }

        const response = await handleCloudRequest(new Request(url, init), ctx);
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of response.headers.entries()) {
          if (k.toLowerCase() === "set-cookie") continue;
          outHeaders[k] = v;
        }
        const setCookies = response.headers.getSetCookie();
        if (setCookies.length > 0) outHeaders["set-cookie"] = setCookies;

        res.writeHead(response.status, outHeaders);
        if (!response.body) {
          res.end();
          return;
        }
        const stream = Readable.fromWeb(response.body as never);
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      } catch (err) {
        console.error(JSON.stringify({ event: "request_failed", type: err instanceof Error ? err.name : "Error" }));
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal_error"}');
      }
    });

    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.maxHeadersCount = 100;
    server.maxConnections = 128;

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        console.log(JSON.stringify({ event: "listening", host, port }));
      });
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          server.close(() => resolveListen());
          setTimeout(() => process.exit(1), 10_000).unref();
        });
      }
    });
  } finally {
    await pool.end();
  }
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  runCli().catch((err) => {
    console.error(JSON.stringify({ event: "server_fatal", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
