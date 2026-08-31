import type { EmbeddingProvider } from "./embeddings.js";

/**
 * An embedding provider that never loads a model.
 *
 * Every search already degrades to keyword when semantic embeddings are
 * unavailable — that path is real, and reported. This makes it explicit and
 * free, for callers that want the index without the model behind it.
 *
 * It exists for the test suite. Vitest fans out across workers, and a provider
 * constructed by default meant several of them initialising a ~100MB ONNX
 * model at once; that exhausted memory, ONNX raised `bad allocation`, and the
 * worker died mid-file. The visible symptom was not an embedding failure but
 * an unrelated test failing, a different one each run, and a run-to-run
 * difference in how many tests completed at all.
 *
 * `isReady` is true so nothing waits for a load that will never happen, and
 * `embedBatch` refuses rather than returning zero vectors, which would be
 * indistinguishable from a real embedding of empty text and would quietly
 * poison a similarity ranking.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly model = "null";

  async embed(_text: string): Promise<Float32Array> {
    throw new Error("embeddings are disabled (XTCTX_DISABLE_EMBEDDINGS)");
  }

  async embedBatch(_texts: string[]): Promise<Float32Array[]> {
    throw new Error("embeddings are disabled (XTCTX_DISABLE_EMBEDDINGS)");
  }

  isReady(): boolean {
    return true;
  }

  warm(): void {
    // Nothing to warm.
  }
}
