import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * all-MiniLM-L6-v2's tokenizer has `model_max_length = 512`, but the common
 * sentence-transformers inference config truncates at 256. Attention is O(n²)
 * in sequence length, so unbounded inputs quickly overwhelm ONNX memory (we've
 * seen a single long conversation message drive a FusedMatMul allocation over
 * 80 GB on Windows). Cap at 256 tokens to match the upstream recipe.
 */
const MAX_SEQ_TOKENS = 256;

/**
 * Maximum number of texts to send through the model in a single forward pass.
 * Even with truncation, a large batch multiplies memory use. 32 is the typical
 * sentence-transformers default and stays well within CPU-onnx memory budgets.
 */
const MAX_BATCH_SIZE = 32;

/**
 * Shape of progress events emitted by @xenova/transformers during model load.
 * The library's .d.ts does not fully type the callback payload, so we mirror
 * the documented fields here.
 */
export interface EmbeddingProgressEvent {
  status: "initiate" | "download" | "progress" | "done" | "ready" | string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  task?: string;
  model?: string;
}

export type EmbeddingProgressCallback = (event: EmbeddingProgressEvent) => void;

export class EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private dimension = 384;

  async initialize(progressCallback?: EmbeddingProgressCallback): Promise<void> {
    this.extractor = await pipeline("feature-extraction", DEFAULT_MODEL, {
      progress_callback: progressCallback,
    });

    // The feature-extraction pipeline's _call destructures only pooling/
    // normalize/quantize/precision from its options and passes
    // `{padding: true, truncation: true}` to the tokenizer with NO
    // max_length override — so the tokenizer falls back to its
    // model_max_length (512 for all-MiniLM-L6-v2). We cap it here so every
    // call path (embed, embedBatch) gets the same tighter bound.
    const tokenizer = (this.extractor as unknown as { tokenizer?: { model_max_length?: number } })
      .tokenizer;
    if (tokenizer) {
      tokenizer.model_max_length = MAX_SEQ_TOKENS;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) {
      throw new Error("EmbeddingService not initialized");
    }

    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    const vector = Array.from(output.data as Float32Array);
    this.dimension = vector.length;
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.extractor) {
      throw new Error("EmbeddingService not initialized");
    }
    if (texts.length === 0) return [];

    // Sub-batch large inputs. Even with per-sequence truncation capped by
    // tokenizer.model_max_length, handing the model a large batch at once
    // multiplies peak memory (batch × seq² for attention). Process in chunks
    // of MAX_BATCH_SIZE so memory scales with chunk size, not total count.
    const results: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
      const slice = texts.slice(start, start + MAX_BATCH_SIZE);
      results.push(...(await this.embedChunk(slice)));
    }
    return results;
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    // Pass the chunk as an array so the model processes it in one forward
    // pass rather than N sequential calls. The pipeline's built-in
    // `truncation: true` combined with our tokenizer.model_max_length cap
    // keeps every sequence at <= MAX_SEQ_TOKENS, so the attention MatMul
    // size is bounded by (chunk_size × MAX_SEQ_TOKENS²).
    const output = await this.extractor!(texts, {
      pooling: "mean",
      normalize: true,
    });
    const flat = Array.from(output.data as Float32Array);
    const dim = flat.length / texts.length;
    this.dimension = dim;
    return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
  }

  getDimension(): number {
    return this.dimension;
  }
}
