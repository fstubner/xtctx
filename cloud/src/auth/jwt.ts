import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthUser, CloudContext } from "../types.js";
import { SCOPE_ACCOUNT_DELETE, SCOPE_READ, SCOPE_SYNC_WRITE } from "../types.js";
import { getAccountState } from "../db/queries.js";
import { withSystemDb } from "../db/pool.js";

/** A CLI login lasts a month. */
export const CLI_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** A read-only token for pasting into an MCP client config. */
export const READ_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
/** Browser OAuth access tokens are short-lived and renewed with a refresh token. */
export const OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
/** Browser OAuth refresh token lifetime. */
export const OAUTH_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

/** What `xtctx login` gets: everything the CLI does. */
export const CLI_SCOPES = [SCOPE_READ, SCOPE_SYNC_WRITE, SCOPE_ACCOUNT_DELETE];
/** What the dashboard's Mint Sync Token button issues: sync + read only. */
export const DASHBOARD_SYNC_SCOPES = [SCOPE_READ, SCOPE_SYNC_WRITE];

export const PUBLIC_URL_PLACEHOLDER = "https://REPLACE-WITH-YOUR-WORKER-URL.invalid";

export function publicUrlIsUnset(ctx: Pick<CloudContext, "publicUrl">): boolean {
  return !ctx.publicUrl || ctx.publicUrl.includes("REPLACE-WITH");
}

export function publicOrigin(ctx: Pick<CloudContext, "publicUrl">): string {
  return new URL(ctx.publicUrl).origin;
}

/** The canonical MCP resource: what OAuth tokens and pasted tokens are bound to. */
export function mcpResource(ctx: Pick<CloudContext, "publicUrl">): string {
  return `${publicOrigin(ctx)}/mcp`;
}

/** The audience of tokens accepted by `/api/*`. */
export function apiAudience(ctx: Pick<CloudContext, "publicUrl">): string {
  return `${publicOrigin(ctx)}/api`;
}

function signHmac(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

export async function createJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds = CLI_TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlSeconds, iat: now })).toString("base64url");
  const signature = signHmac(`${header}.${body}`, secret).toString("base64url");
  return `${header}.${body}.${signature}`;
}

export async function mintToken(
  ctx: Pick<CloudContext, "publicUrl" | "jwtSecret">,
  claims: { userId: string; username: string; deviceId?: string; epoch: number; scopes: string[] },
  ttlSeconds: number,
): Promise<string> {
  const audiences = [mcpResource(ctx)];
  if (claims.scopes.includes(SCOPE_SYNC_WRITE) || claims.scopes.includes(SCOPE_ACCOUNT_DELETE)) {
    audiences.push(apiAudience(ctx));
  }
  return createJwt(
    {
      iss: publicOrigin(ctx),
      aud: audiences,
      sub: claims.userId,
      username: claims.username,
      device_id: claims.deviceId,
      ver: claims.epoch,
      scope: claims.scopes.join(" "),
    },
    ctx.jwtSecret!,
    ttlSeconds,
  );
}

export interface VerifiedToken extends AuthUser {
  epoch: number;
  scopes: string[];
  audiences: string[];
}

export async function verifyJwt(token: string, secret: string): Promise<VerifiedToken | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sigB64] = parts;

    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256") return null;

    const expectedB64 = Buffer.from(signHmac(`${headerB64}.${bodyB64}`, secret).toString("base64url"), "utf8");
    const actualB64 = Buffer.from(sigB64, "utf8");
    if (actualB64.length !== expectedB64.length || !timingSafeEqual(actualB64, expectedB64)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.scope !== "string" || !Array.isArray(payload.aud)) return null;
    if (typeof payload.ver !== "number") return null;

    return {
      userId: payload.sub,
      username: String(payload.username ?? ""),
      deviceId: typeof payload.device_id === "string" ? payload.device_id : undefined,
      epoch: payload.ver,
      scopes: payload.scope.split(" ").filter(Boolean),
      audiences: payload.aud.filter((a): a is string => typeof a === "string"),
    };
  } catch {
    return null;
  }
}

export function allowedGithubIds(ctx: Pick<CloudContext, "allowedGithubIds">): Set<string> {
  return new Set(
    (ctx.allowedGithubIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id)),
  );
}

export function isAllowedUser(ctx: Pick<CloudContext, "allowedGithubIds">, userId: string): boolean {
  const match = /^github:(\d+)$/.exec(userId);
  return match !== null && allowedGithubIds(ctx).has(match[1]);
}

export async function hasActiveAccess(
  ctx: Pick<CloudContext, "pool" | "allowedGithubIds" | "stripeSecretKey">,
  userId: string,
): Promise<boolean> {
  if (isAllowedUser(ctx, userId)) return true;
  if (!ctx.stripeSecretKey) return false;
  const sub = await withSystemDb(ctx, async (client) => {
    const res = await client.query<{ status: string }>(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [userId],
    );
    return res.rows[0] ?? null;
  }).catch(() => null);
  return Boolean(sub && (sub.status === "active" || sub.status === "trialing"));
}

export async function isAccountCurrent(
  ctx: Pick<CloudContext, "pool" | "allowedGithubIds" | "stripeSecretKey">,
  userId: string,
  epoch: number,
  options: { ignoreAllowlist?: boolean } = {},
): Promise<boolean> {
  if (!options.ignoreAllowlist && !(await hasActiveAccess(ctx, userId))) return false;
  const state = await getAccountState(ctx, userId);
  return state.exists && state.epoch === epoch;
}

export async function authenticateToken(
  request: Request,
  ctx: Pick<CloudContext, "pool" | "jwtSecret" | "allowedGithubIds" | "stripeSecretKey">,
  audience: string,
  options: { ignoreAllowlist?: boolean } = {},
): Promise<VerifiedToken | null> {
  if (!ctx.jwtSecret) return null;
  const header = request.headers.get("Authorization");
  const match = header ? /^Bearer[\t ]+(\S+)$/i.exec(header) : null;
  if (!match) return null;
  return verifyBearer(match[1], ctx, audience, options);
}

export async function verifyBearer(
  token: string,
  ctx: Pick<CloudContext, "pool" | "jwtSecret" | "allowedGithubIds" | "stripeSecretKey">,
  audience: string,
  options: { ignoreAllowlist?: boolean } = {},
): Promise<VerifiedToken | null> {
  if (!ctx.jwtSecret) return null;
  const verified = await verifyJwt(token, ctx.jwtSecret);
  if (!verified || !verified.audiences.includes(audience)) return null;
  if (!(await isAccountCurrent(ctx, verified.userId, verified.epoch, options))) return null;
  return verified;
}

export function bearerChallenge(
  ctx: Pick<CloudContext, "publicUrl">,
  options: { mcp?: boolean; error?: "invalid_token" | "insufficient_scope"; scope?: string[] } = {},
): string {
  const parts = [`Bearer realm="xtctx-cloud"`];
  if (options.mcp) parts.push(`resource_metadata="${publicOrigin(ctx)}/.well-known/oauth-protected-resource/mcp"`);
  if (options.error) parts.push(`error="${options.error}"`);
  if (options.scope?.length) parts.push(`scope="${options.scope.join(" ")}"`);
  return parts.join(", ");
}
