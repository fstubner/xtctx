import type { Embedder } from "./types.js";
import { scrubNullToSpace } from "./redact.js";

export const DEFAULT_CLOUD_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const CLOUD_EMBEDDING_DIMENSIONS = 384;
const LOCAL_MAX_BATCH_SIZE = 16;

export interface TextChunk {
  start: number;
  text: string;
}

/**
 * Split message content into overlapping windows while preserving the exact UTF-16
 * start offset into the original message for lossless excerpt hydration.
 */
export function chunkText(text: string, maxChars = 1024, overlap = 160): TextChunk[] {
  if (!text || scrubNullToSpace(text).trim().length === 0) return [];
  const size = Math.max(64, maxChars);
  const ov = Math.max(0, Math.min(overlap, size - 1));
  const step = size - ov;
  const chunks: TextChunk[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + size);
    const slice = scrubNullToSpace(text.slice(start, end)).trim();
    if (slice.length > 0) {
      chunks.push({ start, text: slice });
    }
    if (end >= text.length) break;
  }
  return chunks;
}

type FeatureOutput = { data: Float32Array | Float64Array | number[] };
type FeatureExtractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureOutput>;

function splitVectors(output: FeatureOutput, batchSize: number, expectedDims: number): number[][] {
  const raw = output.data;
  const flat = raw instanceof Float32Array ? raw : Float32Array.from(raw);
  const dim = flat.length / batchSize;
  if (!Number.isInteger(dim) || dim !== expectedDims) {
    throw new Error(`Expected ${expectedDims}-dim embeddings, got ${dim}`);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < batchSize; i++) {
    vectors.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

export class LocalTransformersEmbedder implements Embedder {
  readonly provider = "local";
  readonly model: string;
  readonly dimensions = CLOUD_EMBEDDING_DIMENSIONS;
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(model = DEFAULT_CLOUD_EMBEDDING_MODEL) {
    this.model = model;
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import("@huggingface/transformers");
      const pipe = (await mod.pipeline("feature-extraction", this.model, {
        dtype: "fp32",
      })) as unknown as FeatureExtractor;
      this.extractor = pipe;
      return pipe;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += LOCAL_MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + LOCAL_MAX_BATCH_SIZE);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      out.push(...splitVectors(output, batch.length, this.dimensions));
    }
    return out;
  }
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly provider = "openai";
  readonly model: string;
  readonly dimensions = CLOUD_EMBEDDING_DIMENSIONS;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly sendDimensions: boolean;

  constructor(options: { apiUrl: string; apiKey?: string; model?: string; sendDimensions?: boolean }) {
    const url = new URL(options.apiUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("EMBEDDING_API_URL must use http or https");
    }
    const base = url.toString().replace(/\/+$/, "");
    this.endpoint = base.endsWith("/embeddings")
      ? base
      : base.endsWith("/v1")
        ? `${base}/embeddings`
        : `${base}/v1/embeddings`;
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || "text-embedding-3-small";
    this.sendDimensions = options.sendDimensions ?? true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.sendDimensions ? { dimensions: this.dimensions } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Embedding HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
    };
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error("Embedding response count mismatch");
    }
    const sorted = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];
    for (const item of sorted) {
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== this.dimensions ||
        !item.embedding.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        throw new Error(`Expected ${this.dimensions}-dim finite vector from embedding endpoint`);
      }
      vectors.push(item.embedding as number[]);
    }
    return vectors;
  }
}

export function createEmbedderFromEnv(env: Record<string, string | undefined>): Embedder | null {
  const provider = (env.EMBEDDING_PROVIDER ?? "local").trim().toLowerCase();
  if (provider === "none" || provider === "off" || provider === "disabled") {
    return null;
  }
  if (provider === "openai") {
    const apiUrl = env.EMBEDDING_API_URL?.trim();
    if (!apiUrl) {
      throw new Error("EMBEDDING_API_URL is required when EMBEDDING_PROVIDER=openai");
    }
    const rawSendDims = (env.EMBEDDING_SEND_DIMENSIONS ?? "true").trim().toLowerCase();
    const sendDimensions = !["0", "false", "no"].includes(rawSendDims);
    return new OpenAICompatibleEmbedder({
      apiUrl,
      apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
      model: env.EMBEDDING_MODEL?.trim() || undefined,
      sendDimensions,
    });
  }
  if (provider === "local") {
    return new LocalTransformersEmbedder(env.EMBEDDING_MODEL?.trim() || DEFAULT_CLOUD_EMBEDDING_MODEL);
  }
  throw new Error(`Unsupported EMBEDDING_PROVIDER '${provider}' (expected local, openai, or none)`);
}
