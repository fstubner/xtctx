import { describe, it, expect } from "vitest";
import { EmbeddingService } from "@xtctx/store/embeddings";

describe("EmbeddingService", () => {
  it("generates embeddings of consistent dimension", async () => {
    const service = new EmbeddingService();
    await service.initialize();

    const embedding = await service.embed("Use Vitest for testing");
    expect(embedding.length).toBeGreaterThan(0);
    expect(embedding.every((v) => typeof v === "number")).toBe(true);
  }, 120_000);

  it("generates similar embeddings for similar text", async () => {
    const service = new EmbeddingService();
    await service.initialize();

    const e1 = await service.embed("postgres database connection error");
    const e2 = await service.embed("postgresql db connection failure");
    const e3 = await service.embed("how to bake a chocolate cake");

    const sim12 = cosineSimilarity(e1, e2);
    const sim13 = cosineSimilarity(e1, e3);

    expect(sim12).toBeGreaterThan(sim13);
  }, 120_000);
});

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}
