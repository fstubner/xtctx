import type { CloudContext, DashboardAssets } from "./types.js";
import { SCOPE_READ, SCOPE_SYNC_WRITE } from "./types.js";
import {
  CLI_TOKEN_TTL_SECONDS,
  DASHBOARD_SYNC_SCOPES,
  createJwt,
  hasActiveAccess,
  isAllowedUser,
  mcpResource,
  mintToken,
  publicOrigin,
  verifyBearer,
  verifyJwt,
} from "./auth/jwt.js";
import {
  GITHUB_CALLBACK_PATH,
  githubUserFromCode,
  randomVerifier,
  s256,
} from "./auth/github.js";
import {
  deleteSession,
  deleteUserData,
  getAccountState,
  getDashboardMessages,
  getDashboardSessions,
  getDashboardTextPage,
  getOverviewRollups,
  getUploadStatus,
  upsertUser,
} from "./db/queries.js";
import { searchMessages } from "./db/search.js";
import {
  cancelActiveSubscription,
  createCheckoutSession,
  createPortalSession,
  getSubscriptionState,
} from "./billing.js";

const COOKIE = "xtctx_dashboard";
export const DASHBOARD_STATE_COOKIE = "xtctx_dashboard_oauth";

const SEC_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...SEC_HEADERS, ...extra } });

function cookieValue(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function stateCookie(value: string, secure: boolean, maxAge: number): string {
  return `${DASHBOARD_STATE_COOKIE}=${value}; Path=${GITHUB_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function sessionCookie(value: string, secure: boolean, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function parseIntParam(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error("invalid_argument");
  return Number(raw);
}

export async function handleDashboardCallback(request: Request, ctx: CloudContext): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const clear = stateCookie("", secure, 0);
  const fail = (code: string, status = 400) => json({ error: code }, status, { "Set-Cookie": clear });

  if (!ctx.githubClientId || !ctx.githubClientSecret) {
    return fail("github_sign_in_not_configured", 503);
  }
  const binding = cookieValue(request, DASHBOARD_STATE_COOKIE);
  if (!binding || binding.length > 4096) return fail("invalid_login_state");

  const verified = await verifyJwt(binding, ctx.jwtSecret!);
  if (
    !verified ||
    !verified.audiences.includes(`${url.origin}/dashboard/login`) ||
    !verified.scopes.includes("dashboard:login")
  ) {
    return fail("invalid_login_state");
  }

  const data = JSON.parse(Buffer.from(binding.split(".")[1], "base64url").toString("utf8")) as {
    state: string;
    verifier: string;
    iss: string;
  };
  if (
    data.iss !== url.origin ||
    typeof data.state !== "string" ||
    url.searchParams.get("state") !== data.state ||
    typeof data.verifier !== "string"
  ) {
    return fail("invalid_login_state");
  }

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code || code.length > 1000) {
    return fail("github_sign_in_cancelled");
  }

  const github = await githubUserFromCode(ctx, code, data.verifier).catch(() => null);
  if (!github) return fail("github_sign_in_failed", 401);

  const userId = `github:${github.id}`;
  if (!isAllowedUser(ctx, userId) && !ctx.stripeSecretKey) {
    return fail("account_not_allowed", 403);
  }

  const epoch = await upsertUser(ctx, userId, github.login);
  const session = await mintToken(
    ctx,
    { userId, username: github.login, epoch, scopes: [SCOPE_READ] },
    3600,
  );

  const out = new Headers({ ...SEC_HEADERS, Location: `${url.origin}/dashboard` });
  out.append("Set-Cookie", clear);
  out.append("Set-Cookie", sessionCookie(session, secure, 3600));
  return new Response(null, { status: 302, headers: out });
}

export async function handleDashboard(
  request: Request,
  ctx: CloudContext,
  assets: DashboardAssets,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const secure = url.protocol === "https:";

  if (url.origin !== publicOrigin(ctx)) return json({ error: "invalid_origin" }, 400);
  if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) {
    return json({ error: "origin_not_allowed" }, 403);
  }
  if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
    return json({ error: "origin_required" }, 403);
  }

  if (
    request.method === "GET" &&
    ["/dashboard", "/dashboard/", "/dashboard/app.css", "/dashboard/app.js"].includes(path)
  ) {
    const type = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "text/html";
    const body = type === "text/css" ? assets.css : type === "text/javascript" ? assets.js : assets.html;
    return new Response(body, {
      headers: { ...SEC_HEADERS, "Content-Type": `${type}; charset=utf-8` },
    });
  }

  if (path === "/dashboard/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", secure, 0) });
  }

  if (path === "/dashboard/login" && request.method === "POST") {
    if (!ctx.githubClientId || !ctx.githubClientSecret) {
      return json({ error: "github_sign_in_not_configured" }, 503);
    }
    const state = `dash.${randomVerifier()}`;
    const verifier = randomVerifier();
    const binding = await createJwt(
      {
        iss: url.origin,
        sub: "dashboard-login",
        username: "",
        ver: 0,
        scope: "dashboard:login",
        aud: [`${url.origin}/dashboard/login`],
        state,
        verifier,
      },
      ctx.jwtSecret!,
      600,
    );
    const github = new URL("https://github.com/login/oauth/authorize");
    github.searchParams.set("client_id", ctx.githubClientId);
    github.searchParams.set("redirect_uri", `${url.origin}${GITHUB_CALLBACK_PATH}`);
    github.searchParams.set("scope", "read:user");
    github.searchParams.set("state", state);
    github.searchParams.set("code_challenge", s256(verifier));
    github.searchParams.set("code_challenge_method", "S256");
    github.searchParams.set("allow_signup", "false");
    return json({ authorize_url: github.toString() }, 200, {
      "Set-Cookie": stateCookie(binding, secure, 600),
    });
  }

  if (path === GITHUB_CALLBACK_PATH && request.method === "GET") {
    return handleDashboardCallback(request, ctx);
  }

  if (!path.startsWith("/dashboard/api/")) {
    return json({ error: "not_found" }, 404);
  }

  const isPostRoute =
    path === "/dashboard/api/billing/checkout" ||
    path === "/dashboard/api/billing/portal" ||
    path === "/dashboard/api/tokens";
  const isDeleteRoute = path === "/dashboard/api/sessions" || path === "/dashboard/api/account";

  if (isPostRoute && request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }
  if (path === "/dashboard/api/account" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, { Allow: "DELETE" });
  }
  if (!isPostRoute && !(isDeleteRoute && request.method === "DELETE") && request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, { Allow: isDeleteRoute ? "GET, DELETE" : "GET" });
  }

  const token = cookieValue(request, COOKIE);
  const user = token
    ? await verifyBearer(token, ctx, mcpResource(ctx), {
        ignoreAllowlist: Boolean(ctx.stripeSecretKey) || path === "/dashboard/api/account",
      })
    : null;
  if (!user?.scopes.includes(SCOPE_READ)) {
    return json({ error: "sign_in_required" }, 401);
  }

  const allowWithoutSubscription =
    path === "/dashboard/api/overview" ||
    path === "/dashboard/api/billing/checkout" ||
    path === "/dashboard/api/billing/portal" ||
    path === "/dashboard/api/account";
  if (!allowWithoutSubscription && !(await hasActiveAccess(ctx, user.userId))) {
    return json({ error: "subscription_required" }, 402);
  }

  try {
    if (path === "/dashboard/api/account" && request.method === "DELETE") {
      if (request.headers.get("origin") !== url.origin) return json({ error: "origin_required" }, 403);
      const cancel = await cancelActiveSubscription(ctx, user.userId);
      if (!cancel.ok) return json({ error: cancel.error }, cancel.status);
      await deleteUserData(ctx, user.userId);
      return json(
        { deleted: true, subscription_canceled: cancel.canceled },
        200,
        { "Set-Cookie": sessionCookie("", secure, 0) },
      );
    }

    if (path === "/dashboard/api/billing/checkout") {
      const result = await createCheckoutSession(ctx, { userId: user.userId, username: user.username });
      return "error" in result ? json({ error: result.error }, result.status) : json(result);
    }

    if (path === "/dashboard/api/billing/portal") {
      const result = await createPortalSession(ctx, user.userId);
      return "error" in result ? json({ error: result.error }, result.status) : json(result);
    }

    if (path === "/dashboard/api/tokens") {
      const state = await getAccountState(ctx, user.userId);
      const epoch = state.exists ? state.epoch : await upsertUser(ctx, user.userId, user.username);
      const minted = await mintToken(
        ctx,
        { userId: user.userId, username: user.username, epoch, scopes: DASHBOARD_SYNC_SCOPES },
        CLI_TOKEN_TTL_SECONDS,
      );
      return json({
        token: minted,
        scopes: DASHBOARD_SYNC_SCOPES,
        expires_in: CLI_TOKEN_TTL_SECONDS,
      });
    }

    if (path === "/dashboard/api/sessions" && request.method === "DELETE") {
      if (request.headers.get("origin") !== url.origin) return json({ error: "origin_required" }, 403);
      const ref = url.searchParams.get("session");
      if (!ref || ref.length > 1000) return json({ error: "invalid_session" }, 400);
      const deleted = await deleteSession(ctx, user.userId, ref);
      if (!deleted) return json({ error: "not_found" }, 404);
      return json({ deleted: true, session_ref: ref });
    }

    const repo = url.searchParams.get("repo") || undefined;
    const tool = url.searchParams.get("tool") || undefined;
    if ((repo && repo.length > 512) || (tool && !/^[a-z0-9-]{1,40}$/.test(tool))) {
      return json({ error: "invalid_filter" }, 400);
    }

    if (path === "/dashboard/api/overview") {
      const rollups = await getOverviewRollups(ctx, user.userId);
      return json({
        ...rollups,
        username: user.username,
        billing: await getSubscriptionState(ctx, user.userId),
        uploads: await getUploadStatus(ctx, user.userId),
        coverage: {
          account_wide: "unverified",
          browser_receipts: "not_reported",
          original_attachments: "unverified",
        },
        search_available: true,
        semantic_search_available: Boolean(ctx.embedder),
      });
    }

    if (path === "/dashboard/api/sessions") {
      const offset = parseIntParam(url, "offset", 0, 10_000_000);
      return json(await getDashboardSessions(ctx, user.userId, { repo, tool, offset }));
    }

    if (path === "/dashboard/api/messages") {
      const ref = url.searchParams.get("session");
      if (!ref || ref.length > 1000) return json({ error: "invalid_session" }, 400);
      const offset = parseIntParam(url, "offset", 0, 10_000_000);
      const focus = url.searchParams.get("focus");
      if (focus && focus.length > 1500) return json({ error: "invalid_message" }, 400);
      const result = await getDashboardMessages(ctx, user.userId, { sessionRef: ref, offset, focus });
      if (result.notFound) return json({ error: "not_found" }, 404);
      return json({ session: result.session, messages: result.messages, next: result.next });
    }

    if (path === "/dashboard/api/text") {
      const id = url.searchParams.get("id");
      if (!id || id.length > 1500) return json({ error: "invalid_message" }, 400);
      const offset = parseIntParam(url, "offset", 0, 100_000_000);
      const page = await getDashboardTextPage(ctx, user.userId, { messageId: id, offset });
      if (!page) return json({ error: "not_found" }, 404);
      return json(page);
    }

    if (path === "/dashboard/api/search") {
      const query = url.searchParams.get("q")?.trim();
      const mode = url.searchParams.get("mode") ?? "hybrid";
      if (!query || query.length > 1000 || !["keyword", "semantic", "hybrid"].includes(mode)) {
        return json({ error: "invalid_search" }, 400);
      }
      try {
        return json(await searchMessages(ctx, user.userId, { query, mode, repoUrl: repo, limit: 25 }));
      } catch {
        return json({ error: "search_unavailable" }, 503);
      }
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    const isArg = err instanceof Error && err.message === "invalid_argument";
    return json({ error: isArg ? "invalid_argument" : "request_failed" }, isArg ? 400 : 500);
  }
}
