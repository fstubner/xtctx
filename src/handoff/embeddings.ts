export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-mpnet-base-v2";
/**
 * Weight precision to load the model at.
 *
 * `q8` quantizes the weights to 8-bit integers, which for this model is a
 * 110MB download against 416MB for `fp32`. Both were swept against the
 * ranking eval at their own best confidence threshold, since a comparison at
 * a fixed threshold measures the mismatch rather than the model:
 *
 *   q8     mrr 0.654  recall@5 0.933  top1 0.483   at 0.40
 *   fp32   mrr 0.702  recall@5 0.933  top1 0.533   at 0.45
 *
 * fp32 does rank better. It costs four times the download for it, on a tool
 * whose first run already makes an agent wait, and the recall the agent
 * actually reads back is identical — the difference is ordering within a
 * result set that the agent sees all of. Not worth 306MB.
 */
export const DEFAULT_EMBEDDING_DTYPE = "q8";
const MAX_SEQ_TOKENS = 256;
/** ~4 characters per token, the budget splitTextForEmbedding segments to. */
const MAX_SEQ_CHARS = MAX_SEQ_TOKENS * 4;
const MAX_BATCH_SIZE = 32;

export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /**
   * Whether the model is loaded and embedding would start immediately.
   *
   * Loading it means fetching and initialising a local model, which on a cold
   * cache is minutes — not something to do while an agent holds a tool call
   * open. Callers check this to decide whether to answer now by another route.
   */
  isReady?(): boolean;
  /** Begin loading the model without waiting for it. */
  warm?(): void;
}

type FeatureExtractionOutput = {
  data: Float32Array | Float64Array | number[];
};

type FeatureExtractionPipeline = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

type PipelineFactory = (
  task: "feature-extraction",
  model: string,
  options?: Record<string, unknown>,
) => Promise<FeatureExtractionPipeline>;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private extractor: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    model = DEFAULT_EMBEDDING_MODEL,
    private readonly dtype = DEFAULT_EMBEDDING_DTYPE,
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const extractor = await this.getExtractor();
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
      const batch = texts.slice(start, start + MAX_BATCH_SIZE);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      vectors.push(...splitBatchOutput(output, batch.length));
    }
    return vectors;
  }

  isReady(): boolean {
    return this.extractor !== null;
  }

  warm(): void {
    void this.getExtractor().catch(() => {
      // Warming is best-effort; the next real embed call reports the failure.
    });
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) {
      return this.extractor;
    }
    // Concurrent callers must not each start their own model load.
    if (this.loading) {
      return this.loading;
    }

    this.loading = this.loadExtractor().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadExtractor(): Promise<FeatureExtractionPipeline> {
    process.stderr.write(`xtctx: Initializing local embedding provider (${this.model})...\n`);

    const transformers = (await import("@huggingface/transformers")) as unknown as {
      pipeline: PipelineFactory;
    };
    const extractor = await transformers.pipeline("feature-extraction", this.model, {
      dtype: this.dtype,
    });

    // `model_max_length` is a getter with no setter in @huggingface/transformers,
    // so assigning it threw a TypeError on every embed call under ESM's strict
    // mode — semantic search failed for every user while hybrid mode silently
    // degraded to keyword-only. Callers segment input to MAX_SEQ_TOKENS via
    // splitTextForEmbedding before it reaches the model, and the model's own
    // 512-token limit is the backstop, so nothing needs to be set here.
    this.extractor = extractor;
    return extractor;
  }
}

function splitBatchOutput(
  output: FeatureExtractionOutput,
  batchSize: number,
): Float32Array[] {
  const flat = toFloat32Array(output.data);
  const dimension = flat.length / batchSize;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("Embedding model returned an unexpected output shape");
  }

  const vectors: Float32Array[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    vectors.push(flat.slice(index * dimension, (index + 1) * dimension));
  }
  return vectors;
}

function toFloat32Array(data: Float32Array | Float64Array | number[]): Float32Array {
  if (data instanceof Float32Array) {
    return data;
  }
  return Float32Array.from(data);
}

/**
 * Most segments any one window contributes to its vector.
 *
 * Windows are mean-pooled, so a window split into four hundred segments costs
 * four hundred embeddings to produce one averaged vector that represents
 * nothing in particular. Measured over this project's 1,770 windows: the
 * median is 4 segments and the 95th percentile 17, but the largest is 392 —
 * a single 400,899-character window.
 *
 * Sixteen keeps the whole distribution below the 95th percentile intact and
 * touches 5.9% of windows, removing about a fifth of the embedding work. It
 * is a cap on cost, not the main lever: segment *count* was never the
 * dominant term, segment *cost* is (~360ms each on mpnet against ~116ms on
 * MiniLM), so this trims the tail rather than solving the total.
 */
export const MAX_SEGMENTS_PER_UNIT = 16;

/**
 * Reduce a window's segments to at most `limit`, spread across its span.
 *
 * Evenly sampled rather than truncated: the opening 16KB of a 400KB window is
 * an arbitrary slice of it, while a spread still reflects how the window
 * begins, develops and ends — which is what a pooled vector is meant to
 * summarise. Order is preserved so pooling stays deterministic.
 */
export function capSegments(segments: string[], limit = MAX_SEGMENTS_PER_UNIT): string[] {
  if (segments.length <= limit) {
    return segments;
  }
  const step = segments.length / limit;
  const sampled: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    sampled.push(segments[Math.min(segments.length - 1, Math.floor(index * step))]);
  }
  return sampled;
}

/**
 * Split text into segments that fit the embedding model's sequence window
 * (~4 chars per token; the default 1000 chars stays under 256 tokens).
 * Splits on line boundaries; a single oversized line is hard-sliced.
 */
export function splitTextForEmbedding(text: string, maxChars = MAX_SEQ_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const segments: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > maxChars) {
      if (current) {
        segments.push(current);
        current = "";
      }
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
      continue;
    }

    if (!current) {
      current = line;
    } else if (current.length + 1 + line.length <= maxChars) {
      current = `${current}\n${line}`;
    } else {
      segments.push(current);
      current = line;
    }
  }
  if (current) {
    segments.push(current);
  }
  return segments;
}

/**
 * Mean-pool segment vectors into one unit vector, re-normalized to unit
 * length so cosine scores stay comparable with single-segment vectors.
 */
export function poolVectors(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 1) {
    return vectors[0];
  }

  const dimensions = vectors[0]?.length ?? 0;
  const pooled = new Float32Array(dimensions);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) {
      pooled[index] += vector[index];
    }
  }

  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    pooled[index] /= vectors.length;
    norm += pooled[index] * pooled[index];
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < dimensions; index += 1) {
      pooled[index] *= scale;
    }
  }
  return pooled;
}
