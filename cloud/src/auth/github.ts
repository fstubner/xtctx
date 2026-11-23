import { createHash, randomBytes } from "node:crypto";
import type { CloudContext } from "../types.js";
import { upsertUser } from "../db/queries.js";
import {
  CLI_SCOPES,
  CLI_TOKEN_TTL_SECONDS,
  hasActiveAccess,
  mintToken,
  publicOrigin,
} from "./jwt.js";

export const GITHUB_CALLBACK_PATH = "/oauth/github/callback";

export interface GitHubUser {
  id: number;
  login: string;
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function randomVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export async function githubUser(accessToken: string): Promise<GitHubUser | null> {
  const res = await fetch("https://api.github.com/user", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "xtctx-cloud",
      Accept: "application/vnd.github+json",
    },
  });
  const user = (await res.json().catch(() => ({}))) as Partial<GitHubUser>;
  if (!res.ok || typeof user.id !== "number" || typeof user.login !== "string" || !user.login) return null;
  return { id: user.id, login: user.login };
}

export async function githubUserFromCode(
  ctx: Pick<CloudContext, "publicUrl" | "githubClientId" | "githubClientSecret">,
  code: string,
  verifier: string,
): Promise<GitHubUser | null> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: ctx.githubClientId,
      client_secret: ctx.githubClientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: `${publicOrigin(ctx)}${GITHUB_CALLBACK_PATH}`,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) return null;
  return githubUser(token.access_token);
}

export async function handleDeviceCode(
  ctx: Pick<CloudContext, "githubClientId">,
  cors: Record<string, string>,
): Promise<Response> {
  const ghRes = await fetch("https://github.com/login/device/code", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: ctx.githubClientId, scope: "read:user" }),
  }).catch(() => null);
  if (!ghRes) {
    return Response.json({ error: "github_unavailable" }, { status: 502, headers: cors });
  }
  const body = await ghRes.json().catch(() => ({ error: "github_unavailable" }));
  return Response.json(body, { status: ghRes.ok ? 200 : 502, headers: cors });
}

export async function handleDevicePoll(
  rawBody: string | null,
  ctx: CloudContext,
  cors: Record<string, string>,
): Promise<Response> {
  if (rawBody === null) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
  }

  const deviceCode = (parsed as { device_code?: unknown } | null)?.device_code;
  if (typeof deviceCode !== "string" || !deviceCode) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
  }

  const ghRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: ctx.githubClientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  }).catch(() => null);
  if (!ghRes) {
    return Response.json({ error: "github_unavailable" }, { status: 502, headers: cors });
  }

  const data = (await ghRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };
  if (!data.access_token) {
    return Response.json(
      { error: data.error ?? "github_error", ...(data.interval ? { interval: data.interval } : {}) },
      { status: 400, headers: cors },
    );
  }

  const ghUser = await githubUser(data.access_token).catch(() => null);
  if (!ghUser) {
    return Response.json({ error: "github_user_unavailable" }, { status: 502, headers: cors });
  }

  const userId = `github:${ghUser.id}`;
  if (!(await hasActiveAccess(ctx, userId))) {
    const detail = ctx.stripeSecretKey
      ? "No active subscription for this GitHub account. Sign in at /dashboard to start a trial or manage billing."
      : "This GitHub account is not on this server's allowlist.";
    return Response.json({ error: "not_allowed", detail }, { status: 403, headers: cors });
  }

  const epoch = await upsertUser(ctx, userId, ghUser.login);
  const token = await mintToken(
    ctx,
    { userId, username: ghUser.login, epoch, scopes: CLI_SCOPES },
    CLI_TOKEN_TTL_SECONDS,
  );
  return Response.json(
    { token, scope: CLI_SCOPES.join(" "), user: { id: userId, username: ghUser.login } },
    { status: 200, headers: cors },
  );
}
