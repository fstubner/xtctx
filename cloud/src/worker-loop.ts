import type { Pool } from "pg";
import type { Embedder } from "./types.js";
import { chunkText } from "./embedder.js";
import { withSystemDb } from "./db/pool.js";
import { formatHalfVecLiteral } from "./db/search.js";

interface ClaimedJob {
  message_id: string;
  user_id: string;
  content_sha256: string;
  attempts: number;
  session_ref: string;
  content_bytes: Buffer;
}

/**
 * Claim and embed up to `batchSize` pending jobs using `FOR UPDATE SKIP LOCKED`.
 * Transactions wrap only the lease claim and final chunk commit so model inference
 * never holds database locks open.
 */
export async function processEmbeddingBatch(
  pool: Pool,
  embedder: Embedder,
  options: { batchSize?: number; maxAttempts?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 16;
  const maxAttempts = options.maxAttempts ?? 8;

  const jobs = await withSystemDb({ pool }, async (client) => {
    const res = await client.query<ClaimedJob>(
      `WITH claimed AS (
         SELECT message_id
         FROM embedding_jobs
         WHERE next_attempt_at <= now()
           AND attempts < $2
         ORDER BY next_attempt_at ASC, updated_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       leased AS (
         UPDATE embedding_jobs ej
         SET attempts = ej.attempts + 1,
             next_attempt_at = now() + interval '5 minutes',
             updated_at = now()
         FROM claimed
         WHERE ej.message_id = claimed.message_id
         RETURNING ej.message_id, ej.user_id, ej.content_sha256, ej.attempts
       )
       SELECT l.message_id, l.user_id, l.content_sha256, l.attempts,
              m.session_ref, m.content_bytes
       FROM leased l
       JOIN messages m ON m.id = l.message_id`,
      [batchSize, maxAttempts],
    );
    return res.rows;
  });

  if (jobs.length === 0) return 0;

  for (const job of jobs) {
    const text = Buffer.from(job.content_bytes).toString("utf8");
    const chunks = chunkText(text);
    let vectors: number[][] = [];
    try {
      if (chunks.length > 0) {
        vectors = await embedder.embed(chunks.map((c) => c.text));
        if (vectors.length !== chunks.length) {
          throw new Error(`Expected ${chunks.length} vectors, received ${vectors.length}`);
        }
      }
    } catch (err) {
      const errorMsg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const backoffSec = Math.min(3600, 15 * 2 ** Math.max(0, Number(job.attempts) - 1));
      await withSystemDb({ pool }, async (client) => {
        await client.query(
          `UPDATE embedding_jobs
           SET last_error = $2,
               next_attempt_at = now() + ($3 * interval '1 second'),
               updated_at = now()
           WHERE message_id = $1 AND content_sha256 = $4`,
          [job.message_id, errorMsg, backoffSec, job.content_sha256],
        );
      });
      continue;
    }

    await withSystemDb({ pool }, async (client) => {
      const current = await client.query<{ content_sha256: string }>(
        "SELECT content_sha256 FROM messages WHERE id = $1 FOR SHARE",
        [job.message_id],
      );
      const live = current.rows[0];
      if (!live) {
        await client.query("DELETE FROM embedding_jobs WHERE message_id = $1", [job.message_id]);
        return;
      }
      if (live.content_sha256 !== job.content_sha256) {
        await client.query(
          `UPDATE embedding_jobs
           SET content_sha256 = $2,
               attempts = 0,
               next_attempt_at = now(),
               last_error = NULL,
               updated_at = now()
           WHERE message_id = $1`,
          [job.message_id, live.content_sha256],
        );
        return;
      }

      await client.query(
        "DELETE FROM message_chunks WHERE message_id = $1 AND model = $2",
        [job.message_id, embedder.model],
      );

      if (chunks.length > 0) {
        const chunkIndices = chunks.map((_, idx) => idx);
        const chunkStarts = chunks.map((c) => c.start);
        const chunkLens = chunks.map((c) => c.text.length);
        const chunkVecs = vectors.map(formatHalfVecLiteral);

        await client.query(
          `INSERT INTO message_chunks (
             user_id, message_id, session_ref, chunk_index, chunk_start, chunk_len,
             content_sha256, model, embedding
           )
           SELECT $1, $2, $3, t.chunk_index, t.chunk_start, t.chunk_len,
                  $4, $5, t.embedding::halfvec(${embedder.dimensions})
           FROM UNNEST($6::int4[], $7::int4[], $8::int4[], $9::text[])
             AS t(chunk_index, chunk_start, chunk_len, embedding)`,
          [
            job.user_id,
            job.message_id,
            job.session_ref,
            job.content_sha256,
            embedder.model,
            chunkIndices,
            chunkStarts,
            chunkLens,
            chunkVecs,
          ],
        );
      }

      await client.query(
        "DELETE FROM embedding_jobs WHERE message_id = $1 AND content_sha256 = $2",
        [job.message_id, job.content_sha256],
      );
    });
  }

  return jobs.length;
}

export async function runWorkerLoop(options: {
  pool: Pool;
  embedder: Embedder;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const pollMs = Math.max(250, options.pollMs ?? 2000);
  while (!options.signal?.aborted) {
    const processed = await processEmbeddingBatch(options.pool, options.embedder);
    if (processed > 0) continue;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * Drain queued embedding jobs until the queue is empty or optional `maxJobs`/`maxMs`
 * budgets are reached, enabling scale-to-zero workers and inline post-upload embedding.
 */
export async function drainEmbeddingQueue(options: {
  pool: Pool;
  embedder: Embedder;
  batchSize?: number;
  maxJobs?: number;
  maxMs?: number;
  signal?: AbortSignal;
}): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const maxJobs = options.maxJobs !== undefined ? Math.max(1, options.maxJobs) : undefined;
  const deadline = options.maxMs !== undefined ? Date.now() + Math.max(1, options.maxMs) : undefined;
  let total = 0;

  while (!options.signal?.aborted) {
    if (maxJobs !== undefined && total >= maxJobs) break;
    if (deadline !== undefined && Date.now() >= deadline) break;
    const limit = maxJobs !== undefined ? Math.min(batchSize, maxJobs - total) : batchSize;
    const processed = await processEmbeddingBatch(options.pool, options.embedder, { batchSize: limit });
    if (processed === 0) break;
    total += processed;
  }

  return total;
}
