import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { CloudContext } from "../../src/types.js";
import {
  PUBLIC_URL,
  call,
  createPgTestHarness,
  createTestContext,
  login,
  message,
  post,
  session,
  stubGitHub,
  upload,
} from "./pg-fixture.js";

const REDIRECT = "http://127.0.0.1:33418/callback";
const RESOURCE = `${PUBLIC_URL}/mcp`;

class CookieJar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(ctx: CloudContext) {
  const res = await call(ctx, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorizeFlow(
  ctx: CloudContext,
  clientId: string,
  githubId: number,
  options: { challenge?: string; method?: string; decision?: string } = {},
) {
  const jar = new CookieJar();
  const { challenge } = options.challenge ? { challenge: options.challenge } : pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "client-state",
    scope: "read",
    resource: RESOURCE,
    code_challenge: challenge,
    code_challenge_method: options.method ?? "S256",
  });
  const page = jar.take(await call(ctx, `/authorize?${params}`));
  if (page.status !== 200) return { landing: page.headers.get("Location"), page };
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

  const approved = jar.take(
    await call(ctx, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ handle, decision: options.decision ?? "approve" }).toString(),
    }),
  );
  expect(approved.status).toBe(302);
  const toGithub = new URL(approved.headers.get("Location")!);
  if (toGithub.origin !== "https://github.com") return { landing: toGithub.toString(), html };

  stubGitHub(githubId, `user${githubId}`);
  const back = await call(ctx, `/oauth/github/callback?code=gh-code&state=${toGithub.searchParams.get("state")}`, {
    headers: { Cookie: jar.header() },
  });
  vi.unstubAllGlobals();
  expect(back.status).toBe(302);
  return { landing: back.headers.get("Location")!, html, toGithub };
}

async function exchangeToken(ctx: CloudContext, form: Record<string, string>) {
  const res = await call(ctx, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function fullSignIn(ctx: CloudContext, githubId = 1) {
  const clientId = await registerClient(ctx);
  const { verifier, challenge } = pkce();
  const { landing } = await authorizeFlow(ctx, clientId, githubId, { challenge });
  const code = new URL(landing!).searchParams.get("code")!;
  const tokens = await exchangeToken(ctx, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(tokens.status).toBe(200);
  return { clientId, ...(tokens.body as { access_token: string; refresh_token: string; scope: string; expires_in: number }) };
}

const statusRpc = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "xtctx_cloud_status", arguments: {} },
});

let harness: Awaited<ReturnType<typeof createPgTestHarness>>;
let pool: Pool;

beforeAll(async () => {
  harness = await createPgTestHarness();
  pool = harness.pool;
});

beforeEach(async () => {
  await harness.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await harness?.close();
});

describe("Postgres-backed MCP OAuth 2.1", () => {
  it("serves OAuth discovery metadata and enforces PKCE S256 + consent escaping", async () => {
    const ctx = createTestContext(pool);

    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await call(ctx, p);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [PUBLIC_URL], scopes_supported: ["read"] });
    }
    const as = await call(ctx, "/.well-known/oauth-authorization-server");
    expect(await as.json()).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });

    const hostileReg = await call(ctx, "/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "<script>alert(1)</script>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }),
    });
    const hostileId = ((await hostileReg.json()) as { client_id: string }).client_id;
    const missingPkce = await call(
      ctx,
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: hostileId, redirect_uri: REDIRECT, state: "s" })}`,
    );
    expect(missingPkce.status).toBe(302);
    expect(new URL(missingPkce.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");

    const { challenge } = pkce();
    const consent = await call(
      ctx,
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: hostileId, redirect_uri: REDIRECT, state: "s", code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
    const html = await consent.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
  });

  it("supports Client ID Metadata Documents and handles Deny / allowlist rejection cleanly", async () => {
    const ctx = createTestContext(pool, { allowedGithubIds: "1" });
    const cimdUrl = "https://client.example/oauth/metadata.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url) === cimdUrl) {
          return Response.json({ client_id: cimdUrl, client_name: "Example Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const { challenge } = pkce();
    const page = await call(
      ctx,
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: cimdUrl, redirect_uri: REDIRECT, state: "s", resource: RESOURCE, code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Published by <strong>client.example</strong>");
    vi.unstubAllGlobals();

    const cid = await registerClient(ctx);
    const denied = await authorizeFlow(ctx, cid, 1, { decision: "deny" });
    expect(new URL(denied.landing!).searchParams.get("error")).toBe("access_denied");
    expect(new URL(denied.landing!).searchParams.get("iss")).toBe(PUBLIC_URL);

    const blocked = await authorizeFlow(ctx, cid, 99);
    expect(new URL(blocked.landing!).searchParams.get("error")).toBe("access_denied");
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n).toBe(0);
  });

  it("issues read-only /mcp tokens, enforces PKCE verifier, rotates refresh tokens, and revokes on logout/delete", async () => {
    const ctx = createTestContext(pool);
    const tokens = await fullSignIn(ctx, 1);
    expect(tokens.scope).toBe("read");
    expect(tokens.expires_in).toBeLessThanOrEqual(3600);

    // Read works on /mcp, write/delete refused on /api/*.
    expect((await call(ctx, "/mcp", { method: "POST", token: tokens.access_token, body: statusRpc })).status).toBe(200);
    expect((await call(ctx, "/api/stream", { method: "POST", token: tokens.access_token, body: "{}" })).status).toBe(401);
    expect((await call(ctx, "/api/me", { method: "DELETE", token: tokens.access_token })).status).toBe(401);

    // Refresh rotates and rejects reuse of consumed refresh token.
    const refreshed = await exchangeToken(ctx, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(
      (
        await exchangeToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: tokens.clientId,
        })
      ).status,
    ).toBe(400);

    // Logout revokes tokens immediately.
    const cli = await login(ctx, 1);
    expect((await call(ctx, "/auth/logout", { method: "POST", token: cli })).status).toBe(200);
    expect((await call(ctx, "/mcp", { method: "POST", token: String(refreshed.body.access_token), body: statusRpc })).status).toBe(401);
    expect(
      (
        await exchangeToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: String(refreshed.body.refresh_token),
          client_id: tokens.clientId,
        })
      ).status,
    ).toBe(400);

    // Re-check PKCE failure + cross-tenant MCP isolation.
    const cid = await registerClient(ctx);
    const { challenge } = pkce();
    const { landing } = await authorizeFlow(ctx, cid, 1, { challenge });
    const badPkce = await exchangeToken(ctx, {
      grant_type: "authorization_code",
      code: new URL(landing!).searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: cid,
      code_verifier: "wrong".repeat(10),
      resource: RESOURCE,
    });
    expect(badPkce.status).toBe(400);

    const alice = await login(ctx, 1);
    const bob = await login(ctx, 2);
    await post(ctx, alice, upload([session({}, [message(0, { content: "alice confidential" })])]));
    const bobRead = await call(ctx, "/mcp", {
      method: "POST",
      token: bob,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xtctx_cloud_session_detail", arguments: { session_ref: "github:1:claude-code:s1" } } }),
    });
    expect(await bobRead.text()).not.toContain("alice confidential");
  });
});
