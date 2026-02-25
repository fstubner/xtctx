export interface RetryOptions {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<
  Omit<RetryOptions, "shouldRetry" | "onRetry">
> = {
  attempts: 3,
  minDelayMs: 250,
  maxDelayMs: 2_000,
  factor: 2,
  jitterMs: 50,
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_OPTIONS.attempts);
  const minDelayMs = Math.max(0, options.minDelayMs ?? DEFAULT_OPTIONS.minDelayMs);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs);
  const factor = Math.max(1, options.factor ?? DEFAULT_OPTIONS.factor);
  const jitterMs = Math.max(0, options.jitterMs ?? DEFAULT_OPTIONS.jitterMs);

  let currentDelay = minDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry = options.shouldRetry ? options.shouldRetry(error, attempt) : true;
      const isLastAttempt = attempt >= attempts;

      if (!shouldRetry || isLastAttempt) {
        throw error;
      }

      const delayMs = Math.min(
        maxDelayMs,
        currentDelay + randomJitter(jitterMs),
      );
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
      currentDelay = Math.min(maxDelayMs, Math.floor(currentDelay * factor) || minDelayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomJitter(max: number): number {
  if (max <= 0) {
    return 0;
  }

  return Math.floor(Math.random() * (max + 1));
}
