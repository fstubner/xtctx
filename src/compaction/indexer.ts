import type { VectorRecord } from "../store/lance.js";
import type { CompactedSession } from "../types/compaction.js";

export interface CompactionEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface CompactionStore {
  upsert(tableName: string, records: VectorRecord[]): Promise<void>;
}

/**
 * Indexes compacted sessions into the hybrid-search table so that
 * summary-level recall is available alongside raw message chunks.
 *
 * Design choices (M2):
 *
 *  - One vector record per compacted session, not per tasksCompleted /
 *    decisionsIdentified entry. Keeps the index from bloating on verbose
 *    compactions, and a single record can carry the whole narrative
 *    (summary + tasks + decisions + questions) inside its text field —
 *    FTS can still hit individual sentences.
 *
 *  - `metadata.layer = 1` flags these as a distinct conversation layer
 *    above raw chunks (layer 0). Downstream search consumers can filter
 *    in/out via the existing metadata filter surface without any new
 *    API — the `depth` and `type_filter` params already exist.
 *
 *  - No ranking override. Let BM25 + cosine fight it out. The summary
 *    is often the better hit for "why/what/how" queries because it
 *    already distills rationale; raw chunks still win on exact-phrase
 *    recall. If real usage shows one layer dominating incorrectly, add
 *    a score weighting then, not now.
 *
 *  - `id` derives from `{tool}:{sessionId}:compacted:v1` — stable per
 *    session so reruns of `xtctx compact` upsert cleanly rather than
 *    duplicating.
 *
 *  - `timestamp` is the session's end time, matching what raw chunks
 *    carry. Keeps time_range filters consistent across layers.
 */
export class CompactionIndexer {
  constructor(
    private readonly embedder: CompactionEmbedder,
    private readonly store: CompactionStore,
    private readonly tableName: string = "context",
  ) {}

  async indexSessions(sessions: CompactedSession[]): Promise<number> {
    if (sessions.length === 0) return 0;

    const texts = sessions.map(composeSummaryText);
    const vectors = await this.embedder.embedBatch(texts);

    const records: VectorRecord[] = sessions.map((session, i) => ({
      id: buildCompactedId(session),
      text: texts[i],
      vector: vectors[i] ?? [],
      metadata: JSON.stringify({
        source_tool: session.tool,
        source_session: session.sessionId,
        role: "summary",
        timestamp: session.timeRange.end,
        messageIndex: 0,
        referenced_files: session.filesModified ?? [],
        layer: 1,
        chunk_count: session.chunkCount,
        estimated_tokens: session.estimatedTokens,
      }),
    }));

    await this.store.upsert(this.tableName, records);
    return records.length;
  }
}

/**
 * Compose the indexable text for a compacted session. Structure is stable
 * so FTS queries like "decided lance-db" and "implemented retry" both land
 * — we concatenate summary, decisions, tasks, and open questions in a
 * predictable order with section markers that don't pollute natural text.
 */
function composeSummaryText(session: CompactedSession): string {
  const parts: string[] = [session.summary];
  if (session.decisionsIdentified?.length) {
    parts.push(`Decisions: ${session.decisionsIdentified.join("; ")}`);
  }
  if (session.tasksCompleted?.length) {
    parts.push(`Tasks: ${session.tasksCompleted.join("; ")}`);
  }
  if (session.openQuestions?.length) {
    parts.push(`Open questions: ${session.openQuestions.join("; ")}`);
  }
  return parts.join("\n\n");
}

/**
 * Derive a stable id for a compacted session. Rule-based compaction
 * synthesizes session ids of the form `{baseSessionId}#{groupIndex+1}`
 * where `groupIndex` depends on the chunk ordering at compact-time, so
 * the same underlying conversation can get a different synthesized id
 * if new chunks are added between runs. That would break upsert: the
 * same conversation gets two compacted rows.
 *
 * Stripping the `#N` suffix and including `timeRange.start` anchors the
 * id to the session's time window. Re-compacting the same window
 * produces the same id; a new window produces a new id. Either way,
 * no duplicates per window.
 */
function buildCompactedId(session: CompactedSession): string {
  const baseSessionId = session.sessionId.split("#")[0] ?? session.sessionId;
  return `${session.tool}:${baseSessionId}:compacted:v1:${session.timeRange.start}`;
}
