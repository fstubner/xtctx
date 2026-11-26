import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import type { Pool } from "pg";
import type { CloudContext, Embedder } from "../../src/types.js";
import { CLI_SCOPES, mintToken } from "../../src/auth/jwt.js";
import { DEFAULT_UPLOAD_LIMITS } from "../../src/db/ingest.js";
import { createPool, runMigrations } from "../../src/db/pool.js";
import { upsertUser } from "../../src/db/queries.js";
import { handleCloudRequest } from "../../src/handler.js";

export const PUBLIC_URL = "https://mcp.test";
export const TEST_JWT_SECRET = "integration-test-secret-at-least-32-chars";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const DASHBOARD_DIR = fileURLToPath(new URL("../../src/dashboard/", import.meta.url));

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required to run cloud Postgres integration tests " +
        "(e.g. postgresql://xtctx:xtctx@127.0.0.1:5432/xtctx).",
    );
  }
  return url;
}

export async function createPgTestHarness(): Promise<{
  pool: Pool;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const pool = createPool(requireTestDatabaseUrl());
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xtctx_app') THEN
        CREATE ROLE xtctx_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
      EXECUTE format('GRANT xtctx_app TO %I', current_user);
    END
    $$;
  `);
  await runMigrations(pool, MIGRATIONS_DIR, "xtctx_app");

  const reset = async () => {
    await pool.query(
      `TRUNCATE users, token_epochs, oauth_clients, oauth_pending_auth, oauth_codes,
       oauth_refresh_tokens, devices, sessions, session_projects, messages,
       message_chunks, embedding_jobs, uploads, source_coverage,
       coverage_evidence, subscriptions RESTART IDENTITY CASCADE`,
    );
  };

  return {
    pool,
    reset,
    close: () => pool.end(),
  };
}

export function loadTestDashboardAssets() {
  return {
    html: readFileSync(resolve(DASHBOARD_DIR, "index.html"), "utf8"),
    css: readFileSync(resolve(DASHBOARD_DIR, "app.css"), "utf8"),
    js: readFileSync(resolve(DASHBOARD_DIR, "app.js"), "utf8"),
  };
}

export function deterministicEmbedder(model = "test/deterministic-384"): Embedder {
  const embedOne = (text: string): number[] => {
    const vec = new Array<number>(384).fill(0);
    const lower = text.toLowerCase();
    // Semantic concept buckets so semantically related strings score near 1.0 even with zero lexical overlap.
    if (/(auth|jwt|oauth|token|login|session)/.test(lower)) vec[0] += 10;
    if (/(orchid|flower|botany|petal|bloom)/.test(lower)) vec[1] += 10;
    if (/(telescope|star|galaxy|optics|lens)/.test(lower)) vec[2] += 10;
    if (/(postgres|pgvector|database|hnsw|sql)/.test(lower)) vec[3] += 10;
    for (let i = 0; i < lower.length; i++) {
      const code = lower.charCodeAt(i);
      vec[(code * 31 + i) % 380 + 4] += 1;
    }
    const norm = Math.hypot(...vec) || 1;
    return vec.map((v) => v / norm);
  };

  return {
    provider: "test",
    model,
    dimensions: 384,
    async embed(texts: string[]) {
      return texts.map(embedOne);
    },
  };
}

export function createTestContext(
  pool: Pool,
  overrides: Partial<CloudContext> = {},
): CloudContext {
  return {
    pool,
    appRole: "xtctx_app",
    embedder: null,
    publicUrl: PUBLIC_URL,
    jwtSecret: TEST_JWT_SECRET,
    githubClientId: "test-client",
    githubClientSecret: "test-secret",
    allowedGithubIds: "1,2",
    uploadLimits: { ...DEFAULT_UPLOAD_LIMITS },
    dashboardAssets: loadTestDashboardAssets(),
    ...overrides,
  };
}

export function call(
  ctx: CloudContext,
  path: string,
  init: RequestInit & { token?: string; base?: string } = {},
): Promise<Response> {
  const { token, base, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return handleCloudRequest(new Request(`${base ?? ctx.publicUrl}${path}`, { ...rest, headers }), ctx);
}

export function stubGitHub(
  id: number,
  loginName: string,
  options: { tokenError?: string; userStatus?: number } = {},
) {
  const seen: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      seen.push({ url: u, body: typeof init?.body === "string" ? init.body : undefined });
      if (u.includes("login/device/code")) {
        return Response.json({
          device_code: "dc",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      if (u.includes("oauth/access_token")) {
        return options.tokenError
          ? Response.json({ error: options.tokenError })
          : Response.json({ access_token: "gh-token" });
      }
      if (u.includes("api.github.com/user")) {
        return options.userStatus
          ? new Response("nope", { status: options.userStatus })
          : Response.json({ id, login: loginName, name: loginName });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  return seen;
}

export async function login(ctx: CloudContext, id: number, name = `user${id}`): Promise<string> {
  stubGitHub(id, name);
  const res = await call(ctx, "/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ device_code: "dc" }),
  });
  expect(res.status).toBe(200);
  vi.unstubAllGlobals();
  return ((await res.json()) as { token: string }).token;
}

export async function mintFixtureToken(
  ctx: CloudContext,
  id = "1",
  scopes = CLI_SCOPES,
  deviceId?: string,
): Promise<string> {
  const userId = `github:${id}`;
  const epoch = await upsertUser(ctx, userId, `user${id}`);
  return mintToken(ctx, { userId, username: `user${id}`, deviceId, epoch, scopes }, 3600);
}

export const hex = (n: number) => n.toString(16).padStart(16, "0");

export function message(i: number, over: Record<string, unknown> = {}) {
  return {
    id: hex(i),
    timestamp: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    role: "user",
    content: `message ${i}`,
    messageIndex: i,
    contentHash: `hash${i}`,
    metadataJson: "{}",
    ...over,
  };
}

export function session(over: Record<string, unknown> = {}, messages = [message(0)]) {
  return {
    tool: "claude-code",
    sourceSessionId: "s1",
    gitBranch: "main",
    gitCommit: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: "2026-10-01T00:01:00.000Z",
    preview: "hello",
    messages,
    ...over,
  };
}

export function upload(sessions: unknown[], over: Record<string, unknown> = {}) {
  return {
    device: { id: "laptop", name: "Laptop" },
    project: { repoUrl: "github.com/a/b", name: "b" },
    sessions,
    ...over,
  };
}

export function post(ctx: CloudContext, token: string, body: unknown) {
  return call(ctx, "/api/stream", { method: "POST", token, body: JSON.stringify(body) });
}

export async function rpc(
  ctx: CloudContext,
  token: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const res = await call(ctx, "/mcp", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function callTool(
  ctx: CloudContext,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { body } = await rpc(ctx, token, "tools/call", { name, arguments: args });
  return body;
}

export const toolText = (body: Record<string, unknown>) =>
  String(((body.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? "");
