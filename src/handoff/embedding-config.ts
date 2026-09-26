import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";
import { OpenAiEmbeddingProvider } from "./openai-embeddings.js";
import { NullEmbeddingProvider } from "./null-embeddings.js";
import { MIN_CONFIDENT_COSINE, MIN_SEMANTIC_COSINE } from "./ranking.js";
import type { EmbeddingConfig } from "../types/config.js";

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Where the user, not the project, says which embedding endpoints xtctx may
 * send transcript text to: a comma-separated list of origins.
 */
export const TRUSTED_ENDPOINTS_ENV = "XTCTX_TRUSTED_EMBEDDING_ENDPOINTS";

export function defaultEmbeddingConfig(): EmbeddingConfig {
  return {
    provider: "local",
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minSemanticCosine: MIN_SEMANTIC_COSINE,
    minConfidentCosine: MIN_CONFIDENT_COSINE,
  };
}

/**
 * Parse the optional `embedding:` block from `.xtctx/config.yaml`.
 *
 * Throws on a literal `apiKey` (the file is committable), an unknown
 * provider, an incomplete openai-compatible block, or an endpoint the user
 * has not trusted (see assertTrustedEndpoint). Missing block → local
 * defaults; never inferred from environment alone.
 */
export function parseEmbeddingConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig {
  if (input === undefined || input === null) {
    return defaultEmbeddingConfig();
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("embedding: expected a mapping");
  }

  const raw = input as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(raw, "apiKey")) {
    // `.xtctx/config.yaml` is committed with the project. A key written into
    // it would publish the credential to everyone who clones the repository.
    throw new Error(
      "embedding.apiKey is not allowed: .xtctx/config.yaml is committable — " +
        "set embedding.apiKeyEnv to the name of an environment variable instead",
    );
  }

  const defaults = defaultEmbeddingConfig();
  const providerRaw = raw.provider === undefined ? "local" : raw.provider;
  if (providerRaw !== "local" && providerRaw !== "openai-compatible") {
    throw new Error(
      `embedding.provider must be "local" or "openai-compatible", got ${JSON.stringify(providerRaw)}`,
    );
  }

  const config: EmbeddingConfig = {
    provider: providerRaw,
    batchSize: readPositiveInt(raw.batchSize, defaults.batchSize, "embedding.batchSize"),
    timeoutMs: readPositiveInt(raw.timeoutMs, defaults.timeoutMs, "embedding.timeoutMs"),
    minSemanticCosine: readFiniteNumber(
      raw.minSemanticCosine,
      defaults.minSemanticCosine,
      "embedding.minSemanticCosine",
    ),
    minConfidentCosine: readFiniteNumber(
      raw.minConfidentCosine,
      defaults.minConfidentCosine,
      "embedding.minConfidentCosine",
    ),
  };

  if (typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim().length > 0) {
    config.apiKeyEnv = raw.apiKeyEnv.trim();
  } else if (raw.apiKeyEnv !== undefined) {
    throw new Error("embedding.apiKeyEnv must be a non-empty string when set");
  }

  if (providerRaw === "openai-compatible") {
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.trim().length === 0) {
      throw new Error('embedding.baseUrl is required when provider is "openai-compatible"');
    }
    if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
      throw new Error('embedding.model is required when provider is "openai-compatible"');
    }
    config.baseUrl = raw.baseUrl.trim();
    config.model = raw.model.trim();
    assertTrustedEndpoint(config.baseUrl, config.apiKeyEnv, env);
  }

  return config;
}

/**
 * Refuse an endpoint the user has not trusted outside the repository.
 *
 * `.xtctx/config.yaml` is committed with the project, so whoever wrote the
 * repository chose `baseUrl` and `apiKeyEnv`. Honoured as written, a cloned
 * repo could send the user's transcript text to any host, with the value of
 * any environment variable it named -- a GitHub token, say -- as the Bearer
 * key, as soon as an agent searched in it. The plugin makes xtctx live in
 * every repository, so no setup step stands in between.
 *
 * A loopback endpoint with no key is allowed as it is: a local model server,
 * the case the feature was written for. Anything else -- a remote host, or
 * any config that names a key -- must have its origin listed in
 * XTCTX_TRUSTED_EMBEDDING_ENDPOINTS, which lives in the user's environment
 * next to the key itself, where a repository cannot set it.
 */
function assertTrustedEndpoint(
  baseUrl: string,
  apiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`embedding.baseUrl is not a valid URL: ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`embedding.baseUrl must be http or https, got ${url.protocol}`);
  }
  if (isLoopback(url.hostname) && apiKeyEnv === undefined) {
    return;
  }
  const trusted = (env[TRUSTED_ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      try {
        return [new URL(entry).origin];
      } catch {
        return [];
      }
    });
  if (trusted.includes(url.origin)) {
    return;
  }
  throw new Error(
    `embedding endpoint ${url.origin} is not trusted: this project's config asks xtctx to send ` +
      `transcript text there${apiKeyEnv ? ` with the value of ${apiKeyEnv} as its key` : ""}. ` +
      `If you set this up, add ${TRUSTED_ENDPOINTS_ENV}=${url.origin} to the environment your ` +
      "agents start from; a repository cannot set that for you.",
  );
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  /** Calibrated execution provider, if this machine has been calibrated. */
  device?: string,
): EmbeddingProvider {
  if (process.env.XTCTX_DISABLE_EMBEDDINGS === "1") {
    return new NullEmbeddingProvider();
  }
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl || !config.model) {
      // parseEmbeddingConfig already requires these; defend the type.
      throw new Error("openai-compatible embedding config is missing baseUrl or model");
    }
    return new OpenAiEmbeddingProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      batchSize: config.batchSize,
      timeoutMs: config.timeoutMs,
    });
  }
  return new TransformersEmbeddingProvider(DEFAULT_EMBEDDING_MODEL, undefined, device);
}

function readPositiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(value);
}

function readFiniteNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}
