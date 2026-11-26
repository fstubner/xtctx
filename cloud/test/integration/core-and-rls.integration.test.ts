import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SCOPE_ACCOUNT_DELETE, SCOPE_READ, SCOPE_SYNC_WRITE } from "../../src/types.js";
import { PUBLIC_URL_PLACEHOLDER, createJwt, mintToken } from "../../src/auth/jwt.js";
import { withUserDb } from "../../src/db/pool.js";
import { bumpTokenEpoch, getRecentSessions, getUploadStatus, upsertUser } from "../../src/db/queries.js";
import { SERVER_VERSION } from "../../src/version.js";
import {
  TEST_JWT_SECRET,
  call,
  callTool,
  createPgTestHarness,
  createTestContext,
  login,
  message,
  mintFixtureToken,
  post,
  session,
  stubGitHub,
  toolText,
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

describe("PostgreSQL Row-Level Security enforcement", () => {
  it("enforces tenant isolation in Postgres itself even on unfiltered queries under NOBYPASSRLS role", async () => {
    const ctx = createTestContext(pool);
    const aliceToken = await mintFixtureToken(ctx, "1");
    const bobToken = await mintFixtureToken(ctx, "2");

    expect(
      (await post(ctx, aliceToken, upload([session({}, [message(0, { content: "alice private secret" })])]))).status,
    ).toBe(200);
    expect(
      (await post(ctx, bobToken, upload([session({}, [message(0, { content: "bob own text" })])]))).status,
    ).toBe(200);

    // Unfiltered SELECT inside withUserDb('github:2') sees ONLY github:2 rows via RLS policy.
    const bobVisibleIds = await withUserDb(ctx, "github:2", async (client) => {
      const res = await client.query<{ user_id: string }>("SELECT user_id FROM messages");
      return res.rows.map((r) => r.user_id);
    });
    expect(bobVisibleIds).toEqual(["github:2"]);

    // Attempting to INSERT a row claiming another tenant's user_id fails with SQLSTATE 42501.
    await expect(
      withUserDb(ctx, "github:2", async (client) => {
        await client.query(
          "INSERT INTO devices (id, user_id, device_name, last_seen_at, created_at) VALUES ('evil', 'github:1', 'evil', now(), now())",
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("server configuration, health, CORS, and allowlist", () => {
  it("refuses unconfigured JWT_SECRET or placeholder PUBLIC_URL with 503 while keeping /health working", async () => {
    const noSecret = createTestContext(pool, { jwtSecret: undefined });
    const forged = await createJwt({ sub: "github:1", username: "x", ver: 0 }, TEST_JWT_SECRET);
    for (const path of ["/api/stream", "/mcp", "/auth/device/code", "/authorize"]) {
      const res = await call(noSecret, path, {
        method: path === "/authorize" ? "GET" : "POST",
        token: forged,
        body: path === "/authorize" ? undefined : "{}",
      });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: "server_misconfigured" });
    }
    const health = await call(noSecret, "/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("X-Xtctx-Server-Version")).toBe(SERVER_VERSION);

    const placeholder = createTestContext(pool, { publicUrl: PUBLIC_URL_PLACEHOLDER });
    expect((await call(placeholder, "/mcp", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await call(placeholder, "/health")).status).toBe(200);
  });

  it("enforces configured ALLOWED_ORIGINS CORS and refuses unlisted browser origins with 403", async () => {
    const extOrigin = "chrome-extension://abcdefghijklmnop";
    const ctx = createTestContext(pool, { allowedOrigins: extOrigin });
    const token = await mintFixtureToken(ctx, "1");

    const health = await call(ctx, "/health", { headers: { Origin: extOrigin } });
    expect(health.status).toBe(200);
    expect(health.headers.get("Access-Control-Allow-Origin")).toBe(extOrigin);

    const preflight = await call(ctx, "/api/stream", { method: "OPTIONS", headers: { Origin: extOrigin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(extOrigin);

    const uploaded = await call(ctx, "/api/stream", {
      method: "POST",
      token,
      headers: { Origin: extOrigin },
      body: JSON.stringify(upload([session()])),
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers.get("Access-Control-Allow-Origin")).toBe(extOrigin);

    expect((await call(ctx, "/health", { headers: { Origin: "https://evil.test" } })).status).toBe(403);
  });

  it("refuses unlisted GitHub accounts and stops access immediately when removed from allowlist", async () => {
    const ctx = createTestContext(pool, { allowedGithubIds: "1" });
    stubGitHub(99, "mallory");
    const denied = await call(ctx, "/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: "dc" }),
    });
    expect(denied.status).toBe(403);
    expect(await pool.query("SELECT COUNT(*)::int AS n FROM users")).toMatchObject({ rows: [{ n: 0 }] });

    vi.unstubAllGlobals();
    const token = await login(ctx, 1);
    expect(
      (await call(ctx, "/mcp", { method: "POST", token, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })).status,
    ).toBe(200);

    ctx.allowedGithubIds = "2";
    expect(
      (await call(ctx, "/mcp", { method: "POST", token, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })).status,
    ).toBe(401);
  });
});

describe("ingest, keepIds, session_projects, NUL/Unicode preservation, and revocation", () => {
  it("supports idempotent replay, keepIds pruning, and session_projects parent/child lookups without duplicating messages", async () => {
    const ctx = createTestContext(pool);
    const token = await mintFixtureToken(ctx, "1");

    const body = upload([session({}, [message(0), message(1), message(2)])], {
      project: { repoUrl: "github.com/owner/child", name: "child" },
    });
    for (let i = 0; i < 2; i++) {
      const res = await post(ctx, token, body);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessions: Array<{ messageCount: number }> }).sessions[0].messageCount).toBe(3);
    }

    // Associate same session_ref with parent workspace without duplicating messages.
    expect(
      (await post(ctx, token, upload([session({}, [])], { project: { repoUrl: "local:workspace", name: "workspace" } }))).status,
    ).toBe(200);

    expect(await getRecentSessions(ctx, "github:1", { repoUrl: "github.com/owner/child", limit: 10 })).toHaveLength(1);
    expect(await getRecentSessions(ctx, "github:1", { repoUrl: "local:workspace", limit: 10 })).toHaveLength(1);
    expect(await getRecentSessions(ctx, "github:2", { repoUrl: "github.com/owner/child", limit: 10 })).toHaveLength(0);
    expect((await getUploadStatus(ctx, "github:1")).map((u) => u.sessions)).toEqual([1, 1]);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM messages")).rows[0].n).toBe(3);

    // Prune deleted message and replace edited message via keepIds.
    const replaced = message(9, { messageIndex: 1, content: "message 1 edited" });
    const prunedRes = await post(ctx, token, upload([session({ keepIds: [message(0).id, replaced.id] }, [replaced])]));
    expect(((await prunedRes.json()) as { sessions: Array<{ messageCount: number }> }).sessions[0].messageCount).toBe(2);
    const ordered = await pool.query("SELECT content_bytes FROM messages ORDER BY message_index ASC");
    expect(ordered.rows.map((r) => Buffer.from(r.content_bytes).toString("utf8"))).toEqual([
      "message 0",
      "message 1 edited",
    ]);
  });

  it("preserves embedded NUL bytes and surrogate-pair Unicode across upload, MCP, and dashboard paging", async () => {
    const ctx = createTestContext(pool);
    const token = await mintFixtureToken(ctx, "1");
    const content = `${"猫😀".repeat(4000)}\0after-tail Ω`;
    expect((await post(ctx, token, upload([session({}, [message(0, { content })])]))).status).toBe(200);

    const detail = await callTool(ctx, token, "xtctx_cloud_session_detail", {
      session_ref: "github:1:claude-code:s1",
      format: "json",
    });
    expect(JSON.parse(toolText(detail)).messages[0].content).toBe(content);

    const epoch = await upsertUser(ctx, "github:1", "user1");
    const dashCookie = `xtctx_dashboard=${await mintToken(ctx, { userId: "github:1", username: "user1", epoch, scopes: [SCOPE_READ] }, 300)}`;
    const firstPage = (await (
      await call(ctx, "/dashboard/api/messages?session=github:1:claude-code:s1", {
        headers: { Cookie: dashCookie },
      })
    ).json()) as { messages: Array<{ id: string; content: string; content_chars: number }> };
    expect([...firstPage.messages[0].content]).toHaveLength(8000);
    expect(firstPage.messages[0].content_chars).toBe([...content].length);

    const tail = (await (
      await call(ctx, `/dashboard/api/text?${new URLSearchParams({ id: firstPage.messages[0].id, offset: "8000" })}`, {
        headers: { Cookie: dashCookie },
      })
    ).json()) as { content: string; next: null };
    expect(firstPage.messages[0].content + tail.content).toBe(content);
    expect(tail.next).toBeNull();
  });

  it("enforces scope checks, logout revocation, and durable token_epochs across DELETE /api/me + re-login", async () => {
    const ctx = createTestContext(pool);
    const readSyncOnly = await mintFixtureToken(ctx, "1", [SCOPE_READ, SCOPE_SYNC_WRITE]);
    expect((await call(ctx, "/api/me", { method: "DELETE", token: readSyncOnly })).status).toBe(403);

    const oldToken = await login(ctx, 1);
    expect((await post(ctx, oldToken, upload([session()]))).status).toBe(200);
    expect((await call(ctx, "/api/me", { method: "DELETE", token: oldToken })).status).toBe(200);

    expect((await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE id = 'github:1'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM messages WHERE user_id = 'github:1'")).rows[0].n).toBe(0);
    // Epoch row MUST survive user deletion so old JWT remains permanently dead even after re-login.
    expect((await pool.query("SELECT epoch FROM token_epochs WHERE user_id = 'github:1'")).rows[0].epoch).toBe(1);

    const freshToken = await login(ctx, 1);
    expect((await call(ctx, "/mcp", { method: "POST", token: oldToken, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status).toBe(401);
    expect((await call(ctx, "/mcp", { method: "POST", token: freshToken, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status).toBe(200);

    await bumpTokenEpoch(ctx, "github:1");
    expect((await call(ctx, "/mcp", { method: "POST", token: freshToken, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status).toBe(401);
  });

  it("handles v1/v2 coverage clocks idempotently and removes them on account deletion", async () => {
    const ctx = createTestContext(pool);
    const collector = await mintFixtureToken(ctx, "1", [SCOPE_READ, SCOPE_SYNC_WRITE, SCOPE_ACCOUNT_DELETE], "collector-a");

    const v1 = {
      source: "hermes-main",
      device_name: "agentbox",
      observed_at: "2026-06-01T12:00:00.000Z",
      status: "partial",
      discovered_sessions: 10,
      indexed_sessions: 8,
      indexed_messages: 25,
      excluded_records: 2,
      notes: "ok",
    };
    expect((await call(ctx, "/api/coverage", { method: "POST", token: collector, body: JSON.stringify(v1) })).status).toBe(200);
    // Stale retry must NOT overwrite newer receipt.
    expect(
      (
        await call(ctx, "/api/coverage", {
          method: "POST",
          token: collector,
          body: JSON.stringify({ ...v1, observed_at: "2020-01-01T00:00:00.000Z", indexed_messages: 0 }),
        })
      ).status,
    ).toBe(200);
    expect((await pool.query("SELECT indexed_messages::int AS m FROM source_coverage")).rows[0].m).toBe(25);

    const v2 = {
      version: 2,
      source: "gemini-web",
      scope: `scope-${"a".repeat(64)}`,
      device_name: "workstation",
      evidence: [{ kind: "inventory", checked_at: "2026-02-01T00:00:00.000Z", state: "not_checked" }],
    };
    expect((await call(ctx, "/api/coverage", { method: "POST", token: collector, body: JSON.stringify(v2) })).status).toBe(200);
    // Duplicate checked_at must NOT overwrite existing evidence (WHERE excluded.checked_at > existing).
    expect(
      (
        await call(ctx, "/api/coverage", {
          method: "POST",
          token: collector,
          body: JSON.stringify({ ...v2, evidence: [{ ...v2.evidence[0], state: "detected" }] }),
        })
      ).status,
    ).toBe(200);
    expect(JSON.parse((await pool.query("SELECT evidence_json FROM coverage_evidence")).rows[0].evidence_json).state).toBe("not_checked");

    // Account deletion cleans both tables.
    expect((await call(ctx, "/api/me", { method: "DELETE", token: collector })).status).toBe(200);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM source_coverage")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM coverage_evidence")).rows[0].n).toBe(0);
  });
});
