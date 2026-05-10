export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_SEQ_TOKENS = 256;
const MAX_BATCH_SIZE = 32;

export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
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

  constructor(model = DEFAULT_EMBEDDING_MODEL) {
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

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) {
      return this.extractor;
    }

    const transformers = (await import("@huggingface/transformers")) as unknown as {
      pipeline: PipelineFactory;
    };
    const extractor = await transformers.pipeline("feature-extraction", this.model, {
      dtype: "fp32",
    });

    const tokenizer = (extractor as unknown as { tokenizer?: { model_max_length?: number } })
      .tokenizer;
    if (tokenizer) {
      tokenizer.model_max_length = MAX_SEQ_TOKENS;
    }

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
