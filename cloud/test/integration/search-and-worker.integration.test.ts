import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { searchMessages } from "../../src/db/search.js";
import { processEmbeddingBatch } from "../../src/worker-loop.js";
import {
  createPgTestHarness,
  createTestContext,
  deterministicEmbedder,
  message,
  mintFixtureToken,
  post,
  session,
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

describe("PostgreSQL FTS, pgvector 0.8 halfvec HNSW, and SKIP LOCKED worker", () => {
  it("indexes lexical search across embedded NUL bytes and respects tenant boundaries", async () => {
    const ctx = createTestContext(pool);
    const alice = await mintFixtureToken(ctx, "1");
    const bob = await mintFixtureToken(ctx, "2");

    await post(ctx, alice, upload([session({}, [message(0, { content: "before\0orchid telescope" })])]));
    await post(ctx, bob, upload([session({}, [message(0, { content: "orchid private secret" })])]));

    const aliceHit = await searchMessages(ctx, "github:1", { query: "orchid", mode: "keyword", limit: 10 });
    expect(aliceHit.effective_mode).toBe("keyword");
    expect(aliceHit.matches).toHaveLength(1);
    expect(aliceHit.matches[0].excerpt).toContain("orchid telescope");

    const forbidden = await searchMessages(ctx, "github:1", { query: "private", mode: "keyword", limit: 10 });
    expect(forbidden.matches).toHaveLength(0);

    // Hybrid falls back explicitly to keyword when embedder is disabled.
    const hybridNoEmbed = await searchMessages(ctx, "github:1", { query: "orchid", mode: "hybrid", limit: 10 });
    expect(hybridNoEmbed.effective_mode).toBe("keyword");
    expect(hybridNoEmbed.semantic_ready).toBe(false);
    expect(hybridNoEmbed.fallback).toContain("Semantic index not ready");
    await expect(searchMessages(ctx, "github:1", { query: "orchid", mode: "semantic", limit: 10 })).rejects.toThrow(
      "not configured",
    );
  });

  it("drains embedding_jobs via SKIP LOCKED and serves pgvector 0.8 halfvec hybrid search + coverage", async () => {
    const embedder = deterministicEmbedder();
    const ctx = createTestContext(pool, { embedder });
    const alice = await mintFixtureToken(ctx, "1");
    const bob = await mintFixtureToken(ctx, "2");

    await post(
      ctx,
      alice,
      upload(
        [
          session({ sourceSessionId: "s-auth" }, [
            message(0, { content: "Configured oauth bearer token login flow" }),
          ]),
          session({ sourceSessionId: "s-botany" }, [
            message(1, { content: "Observed rare orchid petal bloom" }),
          ]),
        ],
        { project: { repoUrl: "github.com/owner/app", name: "app" } },
      ),
    );
    await post(
      ctx,
      bob,
      upload([session({ sourceSessionId: "s-bob" }, [message(0, { content: "jwt session secret for bob only" })])]),
    );

    expect((await pool.query("SELECT COUNT(*)::int AS n FROM embedding_jobs")).rows[0].n).toBe(3);

    // Partial coverage before worker drains everything: process 1 job at a time.
    expect(await processEmbeddingBatch(pool, embedder, { batchSize: 1 })).toBe(1);
    expect(await processEmbeddingBatch(pool, embedder, { batchSize: 1 })).toBe(1);
    expect(await processEmbeddingBatch(pool, embedder, { batchSize: 1 })).toBe(1);
    expect(await processEmbeddingBatch(pool, embedder, { batchSize: 1 })).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM embedding_jobs")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM message_chunks")).rows[0].n).toBe(3);

    // Semantic query ("jwt session") has ZERO lexical overlap with s-auth ("oauth bearer token login"),
    // yet matches via semantic concept bucket & pgvector halfvec cosine distance, without leaking bob's row.
    const sem = await searchMessages(ctx, "github:1", {
      query: "jwt session",
      mode: "semantic",
      repoUrl: "github.com/owner/app",
      limit: 5,
    });
    expect(sem.effective_mode).toBe("semantic");
    expect(sem.semantic_ready).toBe(true);
    expect(sem.coverage).toEqual({
      indexed_messages: 2,
      total_messages: 2,
      partial: false,
      update_tracking: "postgres-queue",
    });
    expect(sem.matches[0].session_ref).toBe("github:1:claude-code:s-auth");
    expect(sem.matches.every((m) => m.session_ref.startsWith("github:1:"))).toBe(true);

    // Wrong project yields 0 matches under iterative HNSW scan + repo filter.
    const emptyProj = await searchMessages(ctx, "github:1", {
      query: "jwt session",
      mode: "semantic",
      repoUrl: "github.com/other/repo",
      limit: 5,
    });
    expect(emptyProj.matches).toHaveLength(0);

    // Updating a message re-enqueues it cleanly and invalidates stale chunks until re-embedded.
    await post(
      ctx,
      alice,
      upload(
        [session({ sourceSessionId: "s-auth" }, [message(0, { content: "Replaced with postgresql hnsw index discussion" })])],
        { project: { repoUrl: "github.com/owner/app", name: "app" } },
      ),
    );
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM embedding_jobs")).rows[0].n).toBe(1);
    const partial = await searchMessages(ctx, "github:1", { query: "postgresql", mode: "hybrid", limit: 5 });
    expect(partial.effective_mode).toBe("hybrid");
    expect(partial.coverage?.partial).toBe(true);
    expect(partial.coverage?.indexed_messages).toBe(1);
    expect(partial.coverage?.total_messages).toBe(2);

    // Drain replacement job -> full coverage restored.
    expect(await processEmbeddingBatch(pool, embedder, { batchSize: 10 })).toBe(1);
    const complete = await searchMessages(ctx, "github:1", { query: "postgresql", mode: "hybrid", limit: 5 });
    expect(complete.coverage?.partial).toBe(false);
    expect(complete.matches[0].excerpt).toContain("postgresql hnsw");
  });

  it("handles worker embedding errors with backoff and falls back cleanly in hybrid mode", async () => {
    const failingEmbedder = {
      provider: "test",
      model: "broken-model",
      dimensions: 384,
      async embed() {
        throw new Error("internal GPU driver boom");
      },
    };
    const ctx = createTestContext(pool, { embedder: failingEmbedder });
    const token = await mintFixtureToken(ctx, "1");
    await post(ctx, token, upload([session({}, [message(0, { content: "orchid telescope milestone" })])]));

    expect(await processEmbeddingBatch(pool, failingEmbedder, { batchSize: 4 })).toBe(1);
    const jobRow = (await pool.query("SELECT attempts, last_error FROM embedding_jobs")).rows[0];
    expect(jobRow.attempts).toBe(1);
    expect(jobRow.last_error).toContain("internal GPU driver boom");

    const hybridFallback = await searchMessages(ctx, "github:1", { query: "orchid", mode: "hybrid", limit: 5 });
    expect(hybridFallback.effective_mode).toBe("keyword");
    expect(hybridFallback.fallback).toBe("Semantic worker unavailable; lexical results only");

    await expect(searchMessages(ctx, "github:1", { query: "orchid", mode: "semantic", limit: 5 })).rejects.toThrow(
      "Semantic search unavailable",
    );
  });
});
