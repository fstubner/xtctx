import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudContext } from "../../src/types.js";
import { createPool } from "../../src/db/pool.js";
import { formatHalfVecLiteral, reciprocalRankFusion } from "../../src/db/search.js";
import { chunkText, createEmbedderFromEnv } from "../../src/embedder.js";
import { ERR, MCP_TOOLS, handleMcpPost, processMessage } from "../../src/mcp.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chunkText & reciprocalRankFusion", () => {
  it("chunks overlapping text while preserving UTF-16 offsets across embedded NUL", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \0 \n ")).toEqual([]);

    const prefix = "a".repeat(1020);
    const tail = "\0orchid telescope milestone";
    const full = prefix + tail;
    const chunks = chunkText(full, 1024, 160);
    expect(chunks.length).toBe(2);
    expect(chunks[0].start).toBe(0);
    expect(chunks[1].start).toBe(864);
    expect(chunks[1].text).not.toContain("\0");
    expect(full.slice(chunks[1].start)).toContain("orchid telescope");
  });

  it("fuses ranked lists deterministically without double-counting duplicates within one list", () => {
    const fused = reciprocalRankFusion(
      [
        [{ message_id: "a" }, { message_id: "b" }, { message_id: "a" }],
        [{ message_id: "b" }, { message_id: "c" }],
      ],
      2,
    );
    expect(fused.map((m) => m.message_id)).toEqual(["b", "a"]);

    const tied = reciprocalRankFusion([[{ message_id: "z" }], [{ message_id: "a" }]], 2);
    expect(tied.map((m) => m.message_id)).toEqual(["a", "z"]);
  });

  it("validates halfvec literals", () => {
    expect(formatHalfVecLiteral([0.1, -0.2, 0.3])).toBe("[0.1,-0.2,0.3]");
    expect(() => formatHalfVecLiteral([])).toThrow();
    expect(() => formatHalfVecLiteral([0.1, Number.NaN])).toThrow();
  });
});

describe("createEmbedderFromEnv", () => {
  it("supports none, local defaults, and validates openai responses", async () => {
    expect(createEmbedderFromEnv({ EMBEDDING_PROVIDER: "none" })).toBeNull();
    expect(createEmbedderFromEnv({})).toMatchObject({
      provider: "local",
      model: "Xenova/bge-small-en-v1.5",
      dimensions: 384,
    });
    expect(() => createEmbedderFromEnv({ EMBEDDING_PROVIDER: "openai" })).toThrow("EMBEDDING_API_URL");
    expect(() => createEmbedderFromEnv({ EMBEDDING_PROVIDER: "bogus" })).toThrow();

    const vec = Array.from({ length: 384 }, (_, i) => i * 0.001);
    const vec2 = Array.from({ length: 384 }, (_, i) => 1 - i * 0.001);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://embed.example.test/v1/embeddings");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer key-1" });
        return Response.json({
          data: [
            { index: 1, embedding: vec2 },
            { index: 0, embedding: vec },
          ],
        });
      }),
    );

    const openai = createEmbedderFromEnv({
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_API_URL: "https://embed.example.test",
      EMBEDDING_API_KEY: "key-1",
      EMBEDDING_MODEL: "custom-model",
    })!;
    expect(await openai.embed(["first", "second"])).toEqual([vec, vec2]);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] })));
    await expect(openai.embed(["wrong-dim"])).rejects.toThrow("384-dim");
  });
});

describe("MCP protocol handling", () => {
  const ctx: CloudContext = {
    pool: createPool("postgresql://unused:unused@127.0.0.1:5432/unused"),
    embedder: null,
    publicUrl: "https://mcp.test",
    githubClientId: "cid",
    uploadLimits: {
      maxBodyBytes: 1024,
      maxMessageBytes: 512,
      maxMetadataBytes: 256,
      maxSessionsPerRequest: 10,
      maxMessagesPerRequest: 100,
    },
  };
  const user = { userId: "github:1", username: "alice" };
  const MODERN = "2026-07-28";
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  it("handles modern 2026-07-28 discovery, tools/list caching hints, and header mismatches", async () => {
    const discover = await processMessage(
      ctx,
      user,
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta } },
      new Headers({ "MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover" }),
    );
    expect(discover.status).toBe(200);
    expect(discover.body?.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MODERN],
      cacheScope: "public",
    });

    const list = await processMessage(
      ctx,
      user,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta } },
      new Headers({ "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" }),
    );
    expect((list.body?.result as { tools: typeof MCP_TOOLS }).tools.map((t) => t.name)).toEqual([
      "xtctx_cloud_recent_sessions",
      "xtctx_cloud_session_detail",
      "xtctx_cloud_status",
      "xtctx_cloud_search_sessions",
    ]);

    const badHeader = await processMessage(
      ctx,
      user,
      { jsonrpc: "2.0", id: 3, method: "ping", params: { _meta: modernMeta } },
      new Headers({ "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "ping" }),
    );
    expect(badHeader.status).toBe(400);
    expect((badHeader.body?.error as { code: number }).code).toBe(ERR.headerMismatch);

    const unknownMethod = await processMessage(
      ctx,
      user,
      { jsonrpc: "2.0", id: 4, method: "prompts/list", params: { _meta: modernMeta } },
      new Headers({ "MCP-Protocol-Version": MODERN, "Mcp-Method": "prompts/list" }),
    );
    expect(unknownMethod.status).toBe(404);
    expect((unknownMethod.body?.error as { code: number }).code).toBe(ERR.methodNotFound);
  });

  it("supports legacy initialize negotiation and refuses JSON-RPC batches", async () => {
    const init = await processMessage(ctx, user, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.body?.result).toMatchObject({ protocolVersion: "2025-06-18" });

    const batchRes = await handleMcpPost(ctx, user, new Request("https://mcp.test/mcp", { method: "POST" }), "[{}]");
    expect(batchRes.status).toBe(400);
    expect(((await batchRes.json()) as { error: { code: number } }).error.code).toBe(ERR.invalidRequest);
  });
});
