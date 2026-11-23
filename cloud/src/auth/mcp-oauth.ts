import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CloudContext } from "../types.js";
import { SCOPE_READ } from "../types.js";
import { upsertUser } from "../db/queries.js";
import { withSystemDb } from "../db/pool.js";
import {
  GITHUB_CALLBACK_PATH,
  githubUserFromCode,
  randomVerifier,
  s256,
} from "./github.js";
import {
  OAUTH_ACCESS_TTL_SECONDS,
  OAUTH_REFRESH_TTL_SECONDS,
  hasActiveAccess,
  isAccountCurrent,
  mcpResource,
  mintToken,
  publicOrigin,
} from "./jwt.js";

const CONSENT_COOKIE = "xtctx_mcp_consent";
export const MCP_OAUTH_COOKIE = "xtctx_mcp_oauth";
const VALID_AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

interface OAuthClientInfo {
  clientId: string;
  clientName: string;
  clientDomain?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash?: string | null;
}

interface PendingConsentPayload {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
}

interface PendingGithubPayload extends PendingConsentPayload {
  verifier: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function cookieValue(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function formatCookie(name: string, value: string, path: string, secure: boolean, maxAge: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function htmlPage(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>html{color-scheme:light dark;--bg:#f5f6f8;--surface:#fff;--text:#192231;--muted:#536074;--line:#d7dce4;--accent:#245eb5;--on-accent:#fff;--warn-bg:#fff4e5;--warn-line:#f0c27b;--warn-text:#6c3b00}` +
      `@media(prefers-color-scheme:dark){html{--bg:#101318;--surface:#191e27;--text:#e7eaf0;--muted:#a9b2c3;--line:#394252;--accent:#8ab4ff;--on-accent:#101318;--warn-bg:#2a2011;--warn-line:#785319;--warn-text:#fbd38d}}` +
      `*{box-sizing:border-box}body{margin:0;padding:3rem 1rem;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,sans-serif}` +
      `.card{max-width:34rem;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1.75rem}` +
      `.brand{font-weight:750;letter-spacing:-.04em;font-size:1.15rem;display:flex;align-items:center;gap:.65rem;margin-bottom:1.1rem}` +
      `.brand span{font-size:.78rem;letter-spacing:0;font-weight:500;color:var(--muted);border-left:1px solid var(--line);padding-left:.65rem}` +
      `h1{font-size:1.45rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 .85rem}p{margin:.65rem 0}ul{margin:.5rem 0 .85rem;padding-left:1.25rem}` +
      `.warn{background:var(--warn-bg);color:var(--warn-text);border:1px solid var(--warn-line);padding:.7rem .9rem;border-radius:8px}` +
      `form{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:1.25rem}` +
      `button{font:inherit;font-weight:600;min-height:42px;padding:.55rem 1.2rem;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer}` +
      `button:hover{border-color:var(--accent)}button[value="approve"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}` +
      `button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}</style>` +
      `<main class="card"><div class="brand">xtctx <span>authorize</span></div>${body}</main>`,
    { status, headers },
  );
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function isPrivateOrDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^(fc|fd|fe80:)/i.test(h)
  ) {
    return true;
  }
  return false;
}

function validateRedirectUri(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.hash) return null;
    if (parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function oauthErrorRedirect(
  redirectUri: string,
  origin: string,
  errorCode: string,
  description: string,
  state: string | null,
): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", errorCode);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", origin);
  return target.toString();
}

export function handleProtectedResourceMetadata(ctx: CloudContext, cors: Record<string, string>): Response {
  const origin = publicOrigin(ctx);
  return Response.json(
    {
      resource: mcpResource(ctx),
      authorization_servers: [origin],
      scopes_supported: [SCOPE_READ],
      bearer_methods_supported: ["header"],
    },
    { status: 200, headers: { ...cors, "Cache-Control": "no-store" } },
  );
}

export function handleAuthorizationServerMetadata(ctx: CloudContext, cors: Record<string, string>): Response {
  const origin = publicOrigin(ctx);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      scopes_supported: [SCOPE_READ],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    },
    { status: 200, headers: { ...cors, "Cache-Control": "no-store" } },
  );
}

export async function handleOAuthRegister(rawBody: string | null, ctx: CloudContext): Promise<Response> {
  if (rawBody === null) {
    return Response.json({ error: "invalid_client_metadata", error_description: "Request body too large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  const redirectUris: string[] = [];
  for (const uri of body.redirect_uris) {
    if (typeof uri !== "string") {
      return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
    }
    const valid = validateRedirectUri(uri);
    if (!valid) {
      return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
    }
    redirectUris.push(valid);
  }

  const rawName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "MCP Client";
  const clientName = rawName.slice(0, 200);
  const authMethod =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (!VALID_AUTH_METHODS.has(authMethod)) {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }

  const clientId = `client_${randomBytes(16).toString("hex")}`;
  const clientSecret = authMethod === "none" ? undefined : randomBytes(32).toString("base64url");
  const secretHash = clientSecret ? sha256Hex(clientSecret) : null;

  await withSystemDb(ctx, async (client) => {
    await client.query(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [clientId, secretHash, clientName, JSON.stringify(redirectUris), authMethod],
    );
  });

  return Response.json(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

async function resolveOAuthClient(ctx: CloudContext, clientId: string): Promise<OAuthClientInfo | null> {
  if (clientId.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || isPrivateOrDisallowedHost(url.hostname)) {
      return null;
    }
    const res = await fetch(url.toString(), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (!res?.ok) return null;
    const text = await res.text().catch(() => "");
    if (!text || text.length > 64 * 1024) return null;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris: string[] = [];
    for (const uri of doc.redirect_uris) {
      if (typeof uri !== "string") return null;
      const valid = validateRedirectUri(uri);
      if (!valid) return null;
      redirectUris.push(valid);
    }
    if (redirectUris.length === 0) return null;
    return {
      clientId,
      clientName: typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 200) : url.hostname,
      clientDomain: url.hostname,
      redirectUris,
      tokenEndpointAuthMethod:
        typeof doc.token_endpoint_auth_method === "string" && VALID_AUTH_METHODS.has(doc.token_endpoint_auth_method)
          ? doc.token_endpoint_auth_method
          : "none",
    };
  }

  return withSystemDb(ctx, async (client) => {
    const res = await client.query<{
      client_id: string;
      client_secret_hash: string | null;
      client_name: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
    }>(
      `SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method
       FROM oauth_clients
       WHERE client_id = $1`,
      [clientId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: Array.isArray(row.redirect_uris) ? row.redirect_uris : [],
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      clientSecretHash: row.client_secret_hash,
    };
  });
}

function renderConsentPage(client: OAuthClientInfo, redirectUri: string, handle: string): string {
  const name = escapeHtml(client.clientName);
  const parsed = new URL(redirectUri);
  const who = client.clientDomain
    ? `Published by <strong>${escapeHtml(client.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopbackWarn = isLoopbackHost(parsed.hostname)
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return `<h1>Allow ${name} to read your xtctx cloud?</h1>
<p>${who} Access will be sent to <strong>${escapeHtml(parsed.host)}</strong>.</p>
${loopbackWarn}
<p>It will be able to:</p>
<ul><li><strong>read</strong>: list and read the transcripts uploaded to your xtctx cloud account, from every device and project.</li></ul>
<p>It will not be able to upload, change or delete anything. You sign in with GitHub next.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
}

export async function handleAuthorize(request: Request, ctx: CloudContext): Promise<Response> {
  if (!ctx.githubClientId || !ctx.githubClientSecret) {
    return htmlPage("Not available", "<h1>Browser sign-in is not configured on this server.</h1>", 503);
  }
  const origin = publicOrigin(ctx);
  const secure = origin.startsWith("https:");

  if (request.method === "GET") {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUriRaw = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
    const resource = url.searchParams.get("resource") ?? mcpResource(ctx);

    if (!clientId) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Missing client_id.</p>", 400);
    }
    const client = await resolveOAuthClient(ctx, clientId);
    if (!client) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>This app could not be verified.</p>", 400);
    }

    const validatedRedirect = validateRedirectUri(redirectUriRaw);
    if (!validatedRedirect || !client.redirectUris.includes(validatedRedirect)) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Invalid redirect_uri.</p>", 400);
    }

    if (responseType !== "code") {
      return Response.redirect(
        oauthErrorRedirect(validatedRedirect, origin, "unsupported_response_type", "response_type=code is required", state),
        302,
      );
    }

    if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      return Response.redirect(
        oauthErrorRedirect(validatedRedirect, origin, "invalid_request", "PKCE with code_challenge_method=S256 is required", state),
        302,
      );
    }

    if (resource !== mcpResource(ctx)) {
      return Response.redirect(
        oauthErrorRedirect(validatedRedirect, origin, "invalid_target", "Unsupported resource parameter", state),
        302,
      );
    }

    const handle = randomVerifier();
    const cookieSecret = randomVerifier();
    const payload: PendingConsentPayload = {
      clientId: client.clientId,
      redirectUri: validatedRedirect,
      state,
      codeChallenge,
      resource,
    };

    await withSystemDb(ctx, async (dbClient) => {
      await dbClient.query("DELETE FROM oauth_pending_auth WHERE expires_at <= now()");
      await dbClient.query(
        `INSERT INTO oauth_pending_auth (id, kind, cookie_hash, payload, expires_at)
         VALUES ($1, 'consent', $2, $3::jsonb, now() + interval '10 minutes')`,
        [handle, sha256Hex(cookieSecret), JSON.stringify(payload)],
      );
    });

    const headers = new Headers();
    headers.set("Set-Cookie", formatCookie(CONSENT_COOKIE, cookieSecret, "/authorize", secure, 600));
    return htmlPage(`Authorize ${client.clientName}`, renderConsentPage(client, validatedRedirect, handle), 200, headers);
  }

  if (request.method === "POST") {
    const formText = await request.text();
    if (formText.length > 16 * 1024) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Request too large.</p>", 413);
    }
    const form = new URLSearchParams(formText);
    const handle = form.get("handle") ?? "";
    const decision = form.get("decision") ?? "";
    const presentedCookie = cookieValue(request, CONSENT_COOKIE) ?? "";

    if (!handle || !presentedCookie) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Expired or invalid consent session.</p>", 400);
    }

    const pending = await withSystemDb(ctx, async (dbClient) => {
      const res = await dbClient.query<{ cookie_hash: string; payload: PendingConsentPayload }>(
        `DELETE FROM oauth_pending_auth
         WHERE id = $1 AND kind = 'consent' AND expires_at > now()
         RETURNING cookie_hash, payload`,
        [handle],
      );
      return res.rows[0] ?? null;
    });

    if (!pending || !constantTimeEqualHex(pending.cookie_hash, sha256Hex(presentedCookie))) {
      return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Expired or invalid consent session.</p>", 400);
    }

    const headers = new Headers();
    headers.append("Set-Cookie", formatCookie(CONSENT_COOKIE, "", "/authorize", secure, 0));

    if (decision !== "approve") {
      headers.set(
        "Location",
        oauthErrorRedirect(
          pending.payload.redirectUri,
          origin,
          "access_denied",
          "The user denied the authorization request",
          pending.payload.state,
        ),
      );
      return new Response(null, { status: 302, headers });
    }

    const verifier = randomVerifier();
    const ghState = `mcp.${randomVerifier()}`;
    const ghCookieSecret = randomVerifier();
    const ghPayload: PendingGithubPayload = { ...pending.payload, verifier };

    await withSystemDb(ctx, async (dbClient) => {
      await dbClient.query(
        `INSERT INTO oauth_pending_auth (id, kind, cookie_hash, payload, expires_at)
         VALUES ($1, 'mcp_github', $2, $3::jsonb, now() + interval '10 minutes')`,
        [ghState, sha256Hex(ghCookieSecret), JSON.stringify(ghPayload)],
      );
    });

    const github = new URL("https://github.com/login/oauth/authorize");
    github.searchParams.set("client_id", ctx.githubClientId);
    github.searchParams.set("redirect_uri", `${origin}${GITHUB_CALLBACK_PATH}`);
    github.searchParams.set("scope", "read:user");
    github.searchParams.set("state", ghState);
    github.searchParams.set("code_challenge", s256(verifier));
    github.searchParams.set("code_challenge_method", "S256");
    github.searchParams.set("allow_signup", "false");

    headers.append("Set-Cookie", formatCookie(MCP_OAUTH_COOKIE, ghCookieSecret, GITHUB_CALLBACK_PATH, secure, 600));
    headers.set("Location", github.toString());
    return new Response(null, { status: 302, headers });
  }

  return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
}

export async function handleMcpGithubCallback(request: Request, ctx: CloudContext): Promise<Response> {
  if (!ctx.githubClientId || !ctx.githubClientSecret) {
    return htmlPage("Not available", "<h1>Browser sign-in is not configured on this server.</h1>", 503);
  }
  const url = new URL(request.url);
  const origin = publicOrigin(ctx);
  const secure = origin.startsWith("https:");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const presentedCookie = cookieValue(request, MCP_OAUTH_COOKIE) ?? "";

  const headers = new Headers();
  headers.set("Set-Cookie", formatCookie(MCP_OAUTH_COOKIE, "", GITHUB_CALLBACK_PATH, secure, 0));

  if (!state || !presentedCookie) {
    return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Missing or expired sign-in state.</p>", 400, headers);
  }

  const pending = await withSystemDb(ctx, async (dbClient) => {
    const res = await dbClient.query<{ cookie_hash: string; payload: PendingGithubPayload }>(
      `DELETE FROM oauth_pending_auth
       WHERE id = $1 AND kind = 'mcp_github' AND expires_at > now()
       RETURNING cookie_hash, payload`,
      [state],
    );
    return res.rows[0] ?? null;
  });

  if (!pending || !constantTimeEqualHex(pending.cookie_hash, sha256Hex(presentedCookie))) {
    return htmlPage("Sign-in failed", "<h1>Sign-in failed</h1><p>Invalid sign-in state.</p>", 400, headers);
  }

  const fail = (description: string) => {
    headers.set(
      "Location",
      oauthErrorRedirect(pending.payload.redirectUri, origin, "access_denied", description, pending.payload.state),
    );
    return new Response(null, { status: 302, headers });
  };

  if (url.searchParams.get("error") || !code) {
    return fail("GitHub sign-in was cancelled");
  }

  const ghUser = await githubUserFromCode(ctx, code, pending.payload.verifier).catch(() => null);
  if (!ghUser) {
    return fail("GitHub sign-in failed");
  }

  const userId = `github:${ghUser.id}`;
  if (!(await hasActiveAccess(ctx, userId))) {
    return fail("This GitHub account is not allowed on this server");
  }

  const epoch = await upsertUser(ctx, userId, ghUser.login);
  const authCode = randomVerifier();

  await withSystemDb(ctx, async (dbClient) => {
    await dbClient.query(
      `INSERT INTO oauth_codes (
         code_hash, client_id, user_id, username, epoch, redirect_uri,
         code_challenge, resource, scope, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '5 minutes')`,
      [
        sha256Hex(authCode),
        pending.payload.clientId,
        userId,
        ghUser.login,
        epoch,
        pending.payload.redirectUri,
        pending.payload.codeChallenge,
        pending.payload.resource,
        SCOPE_READ,
      ],
    );
  });

  const redirect = new URL(pending.payload.redirectUri);
  redirect.searchParams.set("code", authCode);
  redirect.searchParams.set("iss", origin);
  if (pending.payload.state) redirect.searchParams.set("state", pending.payload.state);
  headers.set("Location", redirect.toString());
  return new Response(null, { status: 302, headers });
}

function extractClientAuth(request: Request, form: URLSearchParams): { clientId?: string; clientSecret?: string } {
  const auth = request.headers.get("Authorization");
  if (auth && /^Basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, idx)),
        clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
      };
    }
  }
  return {
    clientId: form.get("client_id") ?? undefined,
    clientSecret: form.get("client_secret") ?? undefined,
  };
}

export async function handleOAuthToken(request: Request, ctx: CloudContext): Promise<Response> {
  const rawBody = await request.text();
  if (rawBody.length > 16 * 1024) {
    return Response.json({ error: "invalid_request" }, { status: 413 });
  }
  const form = new URLSearchParams(rawBody);
  const grantType = form.get("grant_type") ?? "";
  const { clientId, clientSecret } = extractClientAuth(request, form);

  const tokenError = (error: string, description: string, status = 400) =>
    Response.json(
      { error, error_description: description },
      { status, headers: { "Cache-Control": "no-store" } },
    );

  if (clientId && !clientId.startsWith("https://")) {
    const client = await resolveOAuthClient(ctx, clientId);
    if (client && client.tokenEndpointAuthMethod !== "none" && client.clientSecretHash) {
      if (!clientSecret || !constantTimeEqualHex(client.clientSecretHash, sha256Hex(clientSecret))) {
        return tokenError("invalid_client", "Invalid client credentials", 401);
      }
    }
  }

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const resource = form.get("resource");
    if (!code || !redirectUri || !verifier || !clientId) {
      return tokenError("invalid_request", "Missing required authorization_code parameters");
    }

    const row = await withSystemDb(ctx, async (dbClient) => {
      const res = await dbClient.query<{
        client_id: string;
        user_id: string;
        username: string;
        epoch: number;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        scope: string;
      }>(
        `UPDATE oauth_codes
         SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING client_id, user_id, username, epoch, redirect_uri, code_challenge, resource, scope`,
        [sha256Hex(code)],
      );
      return res.rows[0] ?? null;
    });

    if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return tokenError("invalid_grant", "Invalid or expired authorization code");
    }
    if (resource && resource !== row.resource) {
      return tokenError("invalid_target", "Requested resource does not match authorization grant");
    }
    if (!constantTimeEqualHex(s256(verifier), row.code_challenge)) {
      return tokenError("invalid_grant", "PKCE verification failed");
    }
    if (!(await isAccountCurrent(ctx, row.user_id, Number(row.epoch)))) {
      return tokenError("invalid_grant", "Account session is no longer active");
    }

    const refreshToken = randomVerifier();
    await withSystemDb(ctx, async (dbClient) => {
      await dbClient.query(
        `INSERT INTO oauth_refresh_tokens (
           token_hash, client_id, user_id, username, epoch, resource, scope, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 * interval '1 second'))`,
        [
          sha256Hex(refreshToken),
          row.client_id,
          row.user_id,
          row.username,
          Number(row.epoch),
          row.resource,
          SCOPE_READ,
          OAUTH_REFRESH_TTL_SECONDS,
        ],
      );
    });

    const accessToken = await mintToken(
      ctx,
      { userId: row.user_id, username: row.username, epoch: Number(row.epoch), scopes: [SCOPE_READ] },
      OAUTH_ACCESS_TTL_SECONDS,
    );

    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: OAUTH_ACCESS_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: SCOPE_READ,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (grantType === "refresh_token") {
    const presentedRefresh = form.get("refresh_token") ?? "";
    if (!presentedRefresh) {
      return tokenError("invalid_request", "Missing refresh_token");
    }

    const row = await withSystemDb(ctx, async (dbClient) => {
      const res = await dbClient.query<{
        client_id: string;
        user_id: string;
        username: string;
        epoch: number;
        resource: string;
        scope: string;
      }>(
        `UPDATE oauth_refresh_tokens
         SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         RETURNING client_id, user_id, username, epoch, resource, scope`,
        [sha256Hex(presentedRefresh)],
      );
      return res.rows[0] ?? null;
    });

    if (!row || (clientId && row.client_id !== clientId)) {
      return tokenError("invalid_grant", "Invalid or revoked refresh token");
    }
    if (!(await isAccountCurrent(ctx, row.user_id, Number(row.epoch)))) {
      return tokenError("invalid_grant", "Account session is no longer active");
    }

    const nextRefresh = randomVerifier();
    await withSystemDb(ctx, async (dbClient) => {
      await dbClient.query(
        `INSERT INTO oauth_refresh_tokens (
           token_hash, client_id, user_id, username, epoch, resource, scope, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 * interval '1 second'))`,
        [
          sha256Hex(nextRefresh),
          row.client_id,
          row.user_id,
          row.username,
          Number(row.epoch),
          row.resource,
          SCOPE_READ,
          OAUTH_REFRESH_TTL_SECONDS,
        ],
      );
    });

    const accessToken = await mintToken(
      ctx,
      { userId: row.user_id, username: row.username, epoch: Number(row.epoch), scopes: [SCOPE_READ] },
      OAUTH_ACCESS_TTL_SECONDS,
    );

    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: OAUTH_ACCESS_TTL_SECONDS,
        refresh_token: nextRefresh,
        scope: SCOPE_READ,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  return tokenError("unsupported_grant_type", "Expected authorization_code or refresh_token");
}
