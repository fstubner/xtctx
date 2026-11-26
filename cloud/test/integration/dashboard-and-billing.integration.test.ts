import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import * as jwtMod from "../../src/auth/jwt.js";
import { upsertUser } from "../../src/db/queries.js";
import {
  call,
  createPgTestHarness,
  createTestContext,
  message,
  mintFixtureToken,
  post,
  session,
  stubGitHub,
  upload,
} from "./pg-fixture.js";

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

async function dashboardCookie(ctx: ReturnType<typeof createTestContext>, id = "1"): Promise<string> {
  const epoch = await upsertUser(ctx, `github:${id}`, `user${id}`);
  const tok = await jwtMod.mintToken(ctx, { userId: `github:${id}`, username: `user${id}`, epoch, scopes: ["read"] }, 300);
  return `xtctx_dashboard=${tok}`;
}

describe("dashboard GitHub auth, assets, projects/skills, and session delete", () => {
  it("enforces security headers on dashboard HTML/CSS/JS and authenticates via shared /oauth/github/callback", async () => {
    const ctx = createTestContext(pool);
    const htmlRes = await call(ctx, "/dashboard");
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(htmlRes.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(htmlRes.headers.get("Cache-Control")).toContain("no-store");
    expect(htmlRes.headers.get("X-Frame-Options")).toBe("DENY");

    stubGitHub(1, "user1");
    const loginRes = await call(ctx, "/dashboard/login", { method: "POST", headers: { Origin: ctx.publicUrl } });
    expect(loginRes.status).toBe(200);
    const { authorize_url } = (await loginRes.json()) as { authorize_url: string };
    const authUrl = new URL(authorize_url);
    expect(authUrl.searchParams.get("state")?.startsWith("dash.")).toBe(true);
    const binding = loginRes.headers.get("set-cookie")!.split(";")[0];

    const cb = await call(
      ctx,
      `/oauth/github/callback?${new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "gh-code" })}`,
      { headers: { Cookie: binding } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe(`${ctx.publicUrl}/dashboard`);
    const dashCookie = cb.headers.get("set-cookie")!.match(/(?:^|, )xtctx_dashboard=([^;]+)/)![0].replace(/^, /, "");
    expect((await call(ctx, "/dashboard/api/overview", { headers: { Cookie: dashCookie } })).status).toBe(200);
  });

  it("computes GIN-backed projects and skills rollups and enforces single-session delete isolation", async () => {
    const ctx = createTestContext(pool);
    const t1 = await mintFixtureToken(ctx, "1");
    const t2 = await mintFixtureToken(ctx, "2");

    await post(
      ctx,
      t1,
      upload(
        [
          session({ tool: "claude-code", sourceSessionId: "c1" }, [
            message(0, { content: "use xtctx", metadataJson: JSON.stringify({ skill: "xtctx-handoff", skills: ["plan-review"] }) }),
          ]),
          session({ tool: "github", sourceSessionId: "pr-10" }, [
            message(0, { content: "PR #10", metadataJson: JSON.stringify({ skill: "xtctx-handoff" }) }),
          ]),
        ],
        { project: { repoUrl: "github.com/owner/app", name: "app" } },
      ),
    );

    const c1 = await dashboardCookie(ctx, "1");
    const c2 = await dashboardCookie(ctx, "2");
    const overview = (await (
      await call(ctx, "/dashboard/api/overview", { headers: { Cookie: c1 } })
    ).json()) as {
      projects: Array<{ repo_url: string; sessions: number; messages: number; github_items: number }>;
      skills: Array<{ name: string; count: number }>;
    };
    expect(overview.projects).toHaveLength(1);
    expect(overview.projects[0]).toMatchObject({ repo_url: "github.com/owner/app", sessions: 2, messages: 2, github_items: 1 });
    expect(overview.skills).toEqual([
      { name: "xtctx-handoff", count: 2 },
      { name: "plan-review", count: 1 },
    ]);

    const ref = "github:1:claude-code:c1";
    expect((await call(ctx, `/dashboard/api/sessions?session=${encodeURIComponent(ref)}`, { method: "DELETE", headers: { Cookie: c1 } })).status).toBe(403);
    expect((await call(ctx, `/dashboard/api/sessions?session=${encodeURIComponent(ref)}`, { method: "DELETE", headers: { Cookie: c2, Origin: ctx.publicUrl } })).status).toBe(404);
    expect((await call(ctx, `/dashboard/api/sessions?session=${encodeURIComponent(ref)}`, { method: "DELETE", headers: { Cookie: c1, Origin: ctx.publicUrl } })).status).toBe(200);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM messages WHERE session_ref = $1", [ref])).rows[0].n).toBe(0);
  });
});

describe("Stripe billing webhooks, quota gates, and fail-closed deletion", () => {
  it("gates access by webhook subscription state, mints read+sync tokens, and blocks over-quota batches atomically", async () => {
    const whSecret = "whsec_integration_secret";
    const ctx = createTestContext(pool, {
      stripeSecretKey: "sk_test_fake",
      stripeWebhookSecret: whSecret,
      stripePriceId: "price_test_123",
      hostedMessageQuota: 2,
      allowedGithubIds: "1",
    });

    const sign = (body: string) => {
      const ts = Math.floor(Date.now() / 1000);
      return `t=${ts},v1=${createHmac("sha256", whSecret).update(`${ts}.${body}`).digest("hex")}`;
    };

    const paidCookie = await dashboardCookie(ctx, "999");
    expect((await call(ctx, "/dashboard/api/sessions", { headers: { Cookie: paidCookie } })).status).toBe(402);

    const badWh = await call(ctx, "/api/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(badWh.status).toBe(400);

    const activateBody = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_999",
          customer: "cus_999",
          status: "active",
          current_period_end: 1900000000,
          metadata: { user_id: "github:999" },
          items: { data: [{ price: { id: "price_test_123" } }] },
        },
      },
    });
    expect(
      (
        await call(ctx, "/api/stripe/webhook", {
          method: "POST",
          headers: { "Stripe-Signature": sign(activateBody) },
          body: activateBody,
        })
      ).status,
    ).toBe(200);

    expect((await call(ctx, "/dashboard/api/sessions", { headers: { Cookie: paidCookie } })).status).toBe(200);

    // Dashboard-minted sync token must carry read + sync:write only (not account:delete).
    const mintRes = await call(ctx, "/dashboard/api/tokens", {
      method: "POST",
      headers: { Cookie: paidCookie, Origin: ctx.publicUrl },
    });
    const minted = (await mintRes.json()) as { token: string; scopes: string[] };
    expect(minted.scopes).toEqual(["read", "sync:write"]);
    expect((await call(ctx, "/api/me", { method: "DELETE", token: minted.token })).status).toBe(403);

    // 1 message fits quota=2; next batch of 2 messages (1+2=3 > 2) fails atomically with 402.
    expect((await post(ctx, minted.token, upload([session({ sourceSessionId: "q1" }, [message(0)])]))).status).toBe(200);
    const over = await post(ctx, minted.token, upload([session({ sourceSessionId: "q2" }, [message(0), message(1)])]));
    expect(over.status).toBe(402);
    expect(await over.json()).toMatchObject({ error: "quota_exceeded", quota: 2, current: 1, incoming: 2 });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = 'github:999'")).rows[0].n).toBe(1);

    // Fail closed when Stripe subscription cancellation fails; once Stripe succeeds, delete wipes data.
    let failCancel = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (init?.method === "DELETE" && String(input).endsWith("/v1/subscriptions/sub_999")) {
          return failCancel ? new Response("stripe down", { status: 500 }) : Response.json({ id: "sub_999", status: "canceled" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    expect(
      (
        await call(ctx, "/dashboard/api/account", {
          method: "DELETE",
          headers: { Cookie: paidCookie, Origin: ctx.publicUrl },
        })
      ).status,
    ).toBe(502);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = 'github:999'")).rows[0].n).toBe(1);

    failCancel = false;
    const deleted = await call(ctx, "/dashboard/api/account", {
      method: "DELETE",
      headers: { Cookie: paidCookie, Origin: ctx.publicUrl },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, subscription_canceled: true });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE id = 'github:999'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = 'github:999'")).rows[0].n).toBe(0);
  });
});
