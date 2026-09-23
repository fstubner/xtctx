/**
 * Segments go to the model sixteen at a time.
 *
 * Sixteen was measured on the real path — `xtctx scan --embed` over this
 * project's own index — at 107.8ms per window, against 542.9 at 128. A
 * benchmark on uniform-length segments had recommended 128, reproducibly; it
 * would have been a 5x regression, because a batch is padded to its longest
 * member and real segments vary in length. See `MAX_BATCH_SIZE`.
 *
 * Changing it back survived the whole suite in a mutation sweep, so this pins
 * the behaviour. It is deliberately a speed bump rather than a principle: if a
 * new real-path measurement says otherwise, change both, and say why.
 */
import { describe, expect, it } from "vitest";
import { TransformersEmbeddingProvider, type PipelineFactory } from "@xtctx/handoff/embeddings";

describe("embedding batch width", () => {
  it("sends segments to the model sixteen at a time", async () => {
    const batches: number[] = [];
    const factory: PipelineFactory = async () => async (input) => {
      const count = Array.isArray(input) ? input.length : 1;
      batches.push(count);
      return { data: new Float32Array(count * 2).fill(0.5) };
    };
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);

    await provider.embedBatch(Array.from({ length: 40 }, (_, index) => `segment ${index}`));

    expect(batches).toEqual([16, 16, 8]);
  });
});
