import type { AuthUser, CloudContext } from "./types.js";
import { SCOPE_ACCOUNT_DELETE, SCOPE_READ, SCOPE_SYNC_WRITE } from "./types.js";
import {
  READ_TOKEN_TTL_SECONDS,
  apiAudience,
  authenticateToken,
  bearerChallenge,
  isAllowedUser,
  mcpResource,
  mintToken,
  publicOrigin,
  publicUrlIsUnset,
  type VerifiedToken,
} from "./auth/jwt.js";
import { GITHUB_CALLBACK_PATH, handleDeviceCode, handleDevicePoll } from "./auth/github.js";
import {
  MCP_OAUTH_COOKIE,
  handleAuthorizationServerMetadata,
  handleAuthorize,
  handleMcpGithubCallback,
  handleOAuthRegister,
  handleOAuthToken,
  handleProtectedResourceMetadata,
} from "./auth/mcp-oauth.js";
import { cancelActiveSubscription, handleStripeWebhook, resolveHostedQuota } from "./billing.js";
import { handleCoverage } from "./coverage.js";
import { DASHBOARD_STATE_COOKIE, handleDashboard, handleDashboardCallback } from "./dashboard.js";
import { ingestUpload, parseUpload } from "./db/ingest.js";
import { bumpTokenEpoch, deleteUserData, getUserMessageCount } from "./db/queries.js";
import { LEGACY_VERSIONS, MODERN_VERSIONS, handleMcpPost } from "./mcp.js";
import { SERVER_VERSION } from "./version.js";

export const MAX_MCP_BODY_BYTES = 256 * 1024;
const uploadingUsers = new Set<string>();

export function allowedOrigins(ctx: Pick<CloudContext, "allowedOrigins">): string[] {
  return (ctx.allowedOrigins ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, ctx: CloudContext): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && allowedOrigins(ctx).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name";
  }
  return headers;
}

export async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function withVersionHeader(res: Response): Response {
  try {
    res.headers.set("X-Xtctx-Server-Version", SERVER_VERSION);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set("X-Xtctx-Server-Version", SERVER_VERSION);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

export async function handleCloudRequest(request: Request, ctx: CloudContext): Promise<Response> {
  try {
    return withVersionHeader(await routeCloudRequest(request, ctx));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "unhandled_request_error",
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return withVersionHeader(Response.json({ error: "internal_error" }, { status: 500 }));
  }
}

async function routeCloudRequest(request: Request, ctx: CloudContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/stripe/webhook") {
    return handleStripeWebhook(request, ctx);
  }

  const origin = request.headers.get("Origin");
  if (origin && !publicUrlIsUnset(ctx) && origin !== publicOrigin(ctx) && !allowedOrigins(ctx).includes(origin)) {
    return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  }

  const cors = corsHeaders(request, ctx);
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...cors, ...extra } });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/health" || url.pathname === "/") {
    return json({
      status: "ok",
      service: "xtctx-cloud",
      version: SERVER_VERSION,
      mcp: {
        supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS.filter((v) => v !== "2024-11-05")],
        endpoints: { streamableHttp: "/mcp" },
      },
    });
  }

  if (publicUrlIsUnset(ctx) || !ctx.jwtSecret || (!ctx.allowedGithubIds && !ctx.stripeSecretKey)) {
    return json({ error: "server_misconfigured" }, 503);
  }

  if (url.origin !== publicOrigin(ctx)) {
    return json({ error: "invalid_origin" }, 400);
  }

  // OAuth 2.1 metadata, registration, consent, token, and shared GitHub callback endpoints.
  if (
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp") &&
    request.method === "GET"
  ) {
    return handleProtectedResourceMetadata(ctx, cors);
  }
  if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
    return handleAuthorizationServerMetadata(ctx, cors);
  }
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    return handleOAuthRegister(await readBodyCapped(request, 16_384), ctx);
  }
  if (url.pathname === "/authorize") {
    return handleAuthorize(request, ctx);
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return handleOAuthToken(request, ctx);
  }
  if (url.pathname === GITHUB_CALLBACK_PATH && request.method === "GET") {
    const stateParam = url.searchParams.get("state") ?? "";
    const cookieHeader = request.headers.get("cookie") ?? "";
    if (stateParam.startsWith("dash.") || cookieHeader.includes(`${DASHBOARD_STATE_COOKIE}=`)) {
      return handleDashboardCallback(request, ctx);
    }
    if (stateParam.startsWith("mcp.") || cookieHeader.includes(`${MCP_OAUTH_COOKIE}=`)) {
      return handleMcpGithubCallback(request, ctx);
    }
    return json({ error: "invalid_login_state" }, 400);
  }

  if ((url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) && ctx.dashboardAssets) {
    return handleDashboard(request, ctx, ctx.dashboardAssets);
  }

  if (url.pathname === "/auth/device/code" && request.method === "POST") {
    return handleDeviceCode(ctx, cors);
  }
  if (url.pathname === "/auth/device/poll" && request.method === "POST") {
    return handleDevicePoll(await readBodyCapped(request, 4096), ctx, cors);
  }

  if (url.pathname === "/api/coverage") {
    return handleCoverage(request, ctx);
  }

  const requireToken = async (
    audience: string,
    scope: string,
    options: { mcp?: boolean; ignoreAllowlist?: boolean } = {},
  ): Promise<VerifiedToken | Response> => {
    const verified = await authenticateToken(request, ctx, audience, options);
    if (!verified) {
      return json({ error: "unauthorized" }, 401, {
        "WWW-Authenticate": bearerChallenge(ctx, { mcp: options.mcp, error: "invalid_token" }),
      });
    }
    if (!verified.scopes.includes(scope)) {
      return json({ error: "insufficient_scope", scope }, 403, {
        "WWW-Authenticate": bearerChallenge(ctx, {
          mcp: options.mcp,
          error: "insufficient_scope",
          scope: [scope],
        }),
      });
    }
    return verified;
  };
  const asUser = (v: VerifiedToken): AuthUser => ({
    userId: v.userId,
    username: v.username,
    deviceId: v.deviceId,
  });

  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { ...cors, Allow: "POST" } });
    }
    const auth = await requireToken(mcpResource(ctx), SCOPE_READ, { mcp: true });
    if (auth instanceof Response) return auth;
    const body = await readBodyCapped(request, MAX_MCP_BODY_BYTES);
    if (body === null) return json({ error: "body_too_large" }, 413);
    const response = await handleMcpPost(ctx, asUser(auth), request, body);
    const mergedHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) mergedHeaders.set(k, v);
    return new Response(response.body, { status: response.status, headers: mergedHeaders });
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const auth = await requireToken(apiAudience(ctx), SCOPE_READ, { ignoreAllowlist: true });
    if (auth instanceof Response) return auth;
    await bumpTokenEpoch(ctx, auth.userId);
    return json({ success: true });
  }

  if (url.pathname === "/api/me" && request.method === "DELETE") {
    const auth = await requireToken(apiAudience(ctx), SCOPE_ACCOUNT_DELETE, { ignoreAllowlist: true });
    if (auth instanceof Response) return auth;
    const cancel = await cancelActiveSubscription(ctx, auth.userId);
    if (!cancel.ok) return json({ error: cancel.error }, cancel.status);
    await deleteUserData(ctx, auth.userId);
    return json({ success: true });
  }

  if (url.pathname === "/api/tokens" && request.method === "POST") {
    const auth = await requireToken(apiAudience(ctx), SCOPE_SYNC_WRITE);
    if (auth instanceof Response) return auth;
    const token = await mintToken(
      ctx,
      { userId: auth.userId, username: auth.username, epoch: auth.epoch, scopes: [SCOPE_READ] },
      READ_TOKEN_TTL_SECONDS,
    );
    return json({
      token,
      scope: SCOPE_READ,
      mcp_url: mcpResource(ctx),
      expires_at: new Date(Date.now() + READ_TOKEN_TTL_SECONDS * 1000).toISOString(),
    });
  }

  if (url.pathname === "/api/sync-capabilities" && request.method === "GET") {
    const auth = await requireToken(apiAudience(ctx), SCOPE_SYNC_WRITE);
    if (auth instanceof Response) return auth;
    return json({ protocol: 1, limits: ctx.uploadLimits });
  }

  if (url.pathname === "/api/stream" && request.method === "POST") {
    const auth = await requireToken(apiAudience(ctx), SCOPE_SYNC_WRITE);
    if (auth instanceof Response) return auth;

    if (uploadingUsers.has(auth.userId)) {
      return json({ error: "upload_busy" }, 429, { "Retry-After": "2" });
    }
    uploadingUsers.add(auth.userId);
    try {
      const rawBody = await readBodyCapped(request, ctx.uploadLimits.maxBodyBytes);
      if (rawBody === null) {
        return json({ error: "body_too_large", limit: ctx.uploadLimits.maxBodyBytes }, 413);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawBody);
      } catch {
        return json({ error: "invalid_request", detail: "body is not JSON" }, 400);
      }

      const parsed = parseUpload(raw, ctx.uploadLimits);
      if (!parsed.ok) return json(parsed.error, parsed.status);

      const incoming = parsed.body.sessions.reduce((n, s) => n + s.messages.length, 0);
      if (!isAllowedUser(ctx, auth.userId)) {
        const current = await getUserMessageCount(ctx, auth.userId);
        const quota = resolveHostedQuota(ctx);
        if (current >= quota || (incoming > 0 && current + incoming > quota)) {
          return json({ error: "quota_exceeded", quota, current, incoming }, 402);
        }
      }

      try {
        return json(await ingestUpload(ctx, asUser(auth), parsed.body, request.headers.get("X-Xtctx-Client")));
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "ingest_failed",
            userId: auth.userId,
            bytes: rawBody.length,
            sessions: parsed.body.sessions.length,
            messages: incoming,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return json({ error: "internal_error" }, 500);
      }
    } finally {
      uploadingUsers.delete(auth.userId);
    }
  }

  return json({ error: "not_found" }, 404);
}
