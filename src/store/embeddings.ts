import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

export class EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private dimension = 384;

  async initialize(): Promise<void> {
    this.extractor = await pipeline("feature-extraction", DEFAULT_MODEL);
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
    if (texts.length === 1) return [await this.embed(texts[0])];

    // Pass the full array to the pipeline so the model processes the batch
    // in one forward pass rather than N sequential calls.
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    const flat = Array.from(output.data as Float32Array);
    const dim = flat.length / texts.length;
    this.dimension = dim;
    return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
  }

  getDimension(): number {
    return this.dimension;
  }
}
