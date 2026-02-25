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
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimension(): number {
    return this.dimension;
  }
}
