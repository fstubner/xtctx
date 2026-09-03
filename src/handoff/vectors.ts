import type { Database as DatabaseHandle } from "better-sqlite3";
import {
  poolVectors,
  splitTextForEmbedding,
  type EmbeddingProvider,
  capSegments,
} from "./embeddings.js";
import { type CountRow, placeholders, setSetting } from "./schema.js";
import { serializeVector } from "./vector.js";

/** Poll interval while waiting for the model; see `waitUntilEmbeddingReady`. */
const EMBEDDING_WARM_POLL_MS = 100;

/**
 * Poll until the embedding model is loaded, or the budget runs out.
 *
 * Polling rather than awaiting the load: `warm()` returns void by design, so
 * that a caller cannot accidentally block on it. The interval is short
 * relative to a model load and the whole wait is capped, so the cost of a
 * provider that never becomes ready is one bounded delay per scan.
 */
export async function waitUntilEmbeddingReady(
  embeddingProvider: EmbeddingProvider,
  embeddingWarmBudgetMs: number,
): Promise<boolean> {
  const isReady = embeddingProvider.isReady;
  if (!isReady) {
    return true;
  }

  const deadline = Date.now() + embeddingWarmBudgetMs;
  while (Date.now() < deadline) {
    if (isReady.call(embeddingProvider)) {
      return true;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, EMBEDDING_WARM_POLL_MS);
      // Never hold the process open purely to keep polling.
      timer.unref?.();
    });
  }

  return isReady.call(embeddingProvider);
}

/**
 * Discard vectors built by any model other than the one now in use.
 *
 * Every read filters on `model`, so stale rows are already inert — but
 * nothing deletes them, and changing the default model would otherwise
 * leave a whole second copy of the corpus in the index permanently. The
 * vectors are derived data that the next searches rebuild, so dropping
 * them costs re-embedding, which is budgeted and incremental, and no
 * transcript content is lost either way.
 */
export function dropVectorsFromOtherModels(db: DatabaseHandle, model: string): void {
  db.prepare("DELETE FROM retrieval_unit_vectors WHERE model != ?").run(model);
}

/**
 * Windows with no vector for the current model.
 *
 * Counted from the index rather than remembered from the last vectorizing
 * pass: that pass only runs inside a search, so anything that had not run
 * one yet reported a backlog of zero — which a JSON consumer reads as
 * "nothing outstanding" while thousands of windows are unvectorized.
 */
export function countUnvectorizedUnits(db: DatabaseHandle, model: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM retrieval_units u
       LEFT JOIN retrieval_unit_vectors v
         ON v.unit_id = u.id
        AND v.model = ?
        AND v.content_hash = u.content_hash
       WHERE v.unit_id IS NULL`,
    )
    .get(model) as CountRow | undefined;
  return row?.count ?? 0;
}

interface EnsureVectorsOptions {
  db: DatabaseHandle;
  embeddingProvider: EmbeddingProvider;
  /** Tool names to restrict the pass to; already normalized, empty for all. */
  filters: string[];
  /** How long to spend before answering with what exists; `0` for no cap. */
  vectorBudgetMs: number;
}

/**
 * Vectorize windows that have no vector for the current model, most recent
 * first, within the budget.
 *
 * Returns how many windows were still waiting when the budget ran out.
 */
export async function ensureVectors({
  db,
  embeddingProvider,
  filters,
  vectorBudgetMs,
}: EnsureVectorsOptions): Promise<number> {
  const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
  const rows = db
    .prepare(
      `SELECT u.id AS unit_id, u.content, u.content_hash
       FROM retrieval_units u
       LEFT JOIN retrieval_unit_vectors v
         ON v.unit_id = u.id
        AND v.model = ?
        AND v.content_hash = u.content_hash
       WHERE v.unit_id IS NULL ${toolWhere}
       ORDER BY u.ended_at DESC`,
    )
    .all(embeddingProvider.model, ...filters) as Array<{
      unit_id: string;
      content: string;
      content_hash: string;
    }>;

  let vectorBacklog = 0;
  if (rows.length === 0) {
    return vectorBacklog;
  }

  const upsert = db.prepare(
    `INSERT INTO retrieval_unit_vectors
     (unit_id, model, dimensions, content_hash, vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(unit_id, model) DO UPDATE SET
       dimensions = excluded.dimensions,
       content_hash = excluded.content_hash,
       vector = excluded.vector,
       created_at = excluded.created_at`,
  );

  // Bounded batches keep memory flat on a first-time index of a large
  // history, and each batch commits before the next one embeds.
  // Small enough that the budget below can actually bite. At 64 windows a
  // single batch took 20-30s on the real index, so the deadline — checked
  // between batches — could not stop a search from blowing straight past it.
  const unitBatchSize = 8;
  // Answer with the vectors that exist rather than making the caller wait
  // for the whole corpus. Every batch below commits before the next starts,
  // so an unfinished pass is progress, not wasted work.
  const deadline = vectorBudgetMs > 0 ? Date.now() + vectorBudgetMs : Infinity;
  const passStartedAt = Date.now();
  let embedded = 0;
  for (let start = 0; start < rows.length; start += unitBatchSize) {
    if (Date.now() >= deadline) {
      vectorBacklog = rows.length - start;
      break;
    }
    const batch = rows.slice(start, start + unitBatchSize);
    embedded += batch.length;
    // Long windows are segmented to the model's sequence budget and
    // mean-pooled, so content beyond the window's opening still shapes
    // the unit's vector.
    const segmented = batch.map((row) => capSegments(splitTextForEmbedding(row.content)));
    const segmentVectors = await embeddingProvider.embedBatch(segmented.flat());

    let cursor = 0;
    const pooled = segmented.map((segments) => {
      const slice = segmentVectors.slice(cursor, cursor + segments.length);
      cursor += segments.length;
      return poolVectors(slice);
    });

    const now = new Date().toISOString();
    const transaction = db.transaction(() => {
      batch.forEach((row, index) => {
        const vector = pooled[index];
        upsert.run(
          row.unit_id,
          embeddingProvider.model,
          vector.length,
          row.content_hash,
          serializeVector(vector),
          now,
        );
      });
    });
    transaction();
  }

  // Per window rather than per pass, so a pass that embedded eight and one
  // that embedded eight hundred report a comparable figure — and so the
  // backlog can be read as a duration rather than a count.
  if (embedded > 0) {
    const perUnit = Math.round(((Date.now() - passStartedAt) / embedded) * 10) / 10;
    setSetting(db, "vector_ms_per_unit", String(perUnit));
  }

  return vectorBacklog;
}
