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

  it("embeds long texts and large batches without ONNX memory blowup", async () => {
    // Regression: a single long LLM-response-sized string combined with a
    // moderately large batch previously drove ONNX into an 80+ GB MatMul
    // allocation on Windows because the feature-extraction pipeline fell
    // back to the tokenizer's 512-token default and no sub-batching was
    // applied. With the cap + sub-batching, this must stay bounded.
    const service = new EmbeddingService();
    await service.initialize();

    const longResponse = "lorem ipsum dolor sit amet consectetur ".repeat(400);
    const batch = [
      "short user question",
      longResponse,
      ...Array.from({ length: 60 }, (_, i) => `short message ${i}`),
      longResponse,
    ];

    const vectors = await service.embedBatch(batch);

    expect(vectors.length).toBe(batch.length);
    expect(vectors.every((v) => v.length > 0)).toBe(true);
    // All vectors share the same dimension (finite values, not NaN/Infinity).
    const dim = vectors[0].length;
    expect(vectors.every((v) => v.length === dim)).toBe(true);
    expect(vectors.every((v) => v.every((x) => Number.isFinite(x)))).toBe(true);
  }, 120_000);

  it("invokes the progress callback when a callback is supplied", async () => {
    // Regression: `xtctx ingest` looked hung on first run because nothing was
    // wired to the transformers `progress_callback`. We just need to confirm
    // the callback is reached — fine-grained event shape is out of scope.
    const service = new EmbeddingService();
    const events: Array<{ status: string }> = [];

    await service.initialize((event) => {
      events.push({ status: event.status });
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.status === "ready" || e.status === "initiate"))
      .toBe(true);
  }, 120_000);
});

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}
