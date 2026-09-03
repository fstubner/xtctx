import type { RetrievalMatch, SessionSearchMode, SessionSummary } from "./types.js";

/** How much a corroborating window adds; swept against the eval below. */
const CORROBORATION_WEIGHT = 0.5;

export interface RetrievalUnitRow {
  unit_id: string;
  session_ref: string;
  tool: string;
  message_start_index: number;
  message_end_index: number;
  started_at: string;
  ended_at: string;
  content: string;
  content_hash: string;
  session_started_at: string;
  session_last_activity_at: string;
  session_message_count: number;
  session_preview: string | null;
  source_path: string | null;
}


const MAX_MATCHES_PER_SESSION = 3;

/**
 * Minimum raw cosine similarity for a retrieval window to count as a semantic
 * match.
 *
 * Unrelated sentence-transformer pairs sit near 0; related ones are
 * comfortably above this.
 */
export const MIN_SEMANTIC_COSINE = 0.15;

/**
 * How similar the *best* window has to be before a query counts as having
 * found anything semantically.
 *
 * The per-window floor above cannot do this job. Raising it high enough to
 * reject a nonsense query — which cleared 0.15 on 927 of 1,145 windows, 81% of
 * the corpus — also discards genuine mid-range matches, and pure vector search
 * has no keyword hits to fall back on: at a 0.35 per-window floor the eval
 * lost recall@5 from 0.70 to 0.50.
 *
 * Whether a query found anything is a property of the query, not of each
 * window. So when nothing clears this bar, semantic matches are dropped
 * wholesale and only keyword hits remain — usually meaning "no matching
 * sessions", which is the honest answer. When something does clear it, the
 * weaker windows around it are kept.
 *
 * Swept against the eval for DEFAULT_EMBEDDING_MODEL, which is the only way
 * this number means anything: it is a cut through one model's cosine
 * distribution, so it is not portable and every model change needs its own
 * sweep. Measured on the sixty-query corpus, hybrid, false positives zero
 * except where noted:
 *
 *   0.28   mrr 0.571  recall@5 0.783  top1 0.433   (false positives 0.05)
 *   0.32   mrr 0.581  recall@5 0.800  top1 0.433
 *   0.36   mrr 0.598  recall@5 0.850  top1 0.450   <- here
 *   0.40   mrr 0.592  recall@5 0.850  top1 0.433
 *
 * The trap worth naming: held at 0.36 while the default was mpnet, that model
 * looked like it regressed false positives to 0.10. It had not — the
 * threshold simply belonged to the distribution it was cut from. A model
 * comparison at a fixed threshold measures the mismatch, not the model.
 *
 * Raising it also costs pure `vector` mode recall, since that mode has no
 * keyword hits to fall back on — 0.50 at 0.32 against 0.383 at 0.36. Hybrid
 * is the default and the mode agents actually use, and it gains what vector
 * loses, because raising the bar drops weak semantic matches and lets the
 * keyword signal carry those queries instead. Optimising the mode nobody
 * calls would be the wrong trade.
 *
 * What no value here can do is tell a real query from a well-formed one about
 * a topic the corpus has never discussed. Best-window cosine over the eval
 * corpus under this model, by kind of query:
 *
 *   genuine                          0.211 - 0.656
 *   absent, shares vocabulary        0.147 - 0.405
 *   absent, shares no vocabulary     0.140 - 0.302
 *   gibberish                        0.115 - 0.225
 *
 * The first two ranges overlap, so no cut separates them, and a query about
 * something never discussed in words the corpus does use will always be
 * answerable-looking. The last two sit under the threshold, which is the part
 * this does buy: a query sharing no vocabulary with the corpus returns
 * nothing, as does gibberish.
 *
 * If it needs to move, move it against the eval rather than against one query.
 */
export const MIN_CONFIDENT_COSINE = 0.36;
/**
 * Weight of the recency/continuity tie-break in the relevance modes. Small
 * enough that it only ever separates candidates that are otherwise equal.
 */
const TIE_BREAK_WEIGHT = 0.005;

export function groupUnits(
  rows: RetrievalUnitRow[],
  keywordScores: Map<string, number>,
  retrieval: SessionSearchMode,
  limit: number,
): SessionSummary[] {
  const timeRange = getTimeRange(rows.map((row) => row.ended_at));
  const scored = rows.map((row) => {
    const keywordScore = keywordScores.get(row.unit_id) ?? 0;
    const recencyScore = scoreRecency(row.ended_at, timeRange);
    const continuityScore = scoreContinuity(row.message_end_index, row.session_message_count);
    return {
      row,
      score: blendScores("keyword", 0, keywordScore, recencyScore, continuityScore),
      // Deliberately no relevance: keyword scores are reciprocal rank, so the
      // top FTS hit is 1.0 whatever it actually matched. Reporting that as a
      // strength of match is the same lie the cosine rescale was telling.
      relevance: undefined,
      semanticScore: 0,
      keywordScore,
      recencyScore,
      continuityScore,
    };
  });
  return groupScoredUnits(scored, retrieval, limit);
}

export function groupScoredUnits(
  scored: Array<{
    row: RetrievalUnitRow;
    score: number;
    relevance: number | undefined;
    semanticScore: number;
    keywordScore: number;
    recencyScore: number;
    continuityScore: number;
  }>,
  retrieval: SessionSearchMode,
  limit: number,
): SessionSummary[] {
  // `score` orders; `relevance` is what the caller is told. Kept apart here so
  // the ranking the eval measures and the number an agent reads about a match
  // can each be the right thing.
  const ranks = new Map<string, number>();
  const sessions = new Map<string, SessionSummary>();
  /** Every window score per session, so corroboration can be measured. */
  const windowScores = new Map<string, number[]>();

  for (const item of scored) {
    const existing = sessions.get(item.row.session_ref);
    const match = formatMatch(item);
    windowScores.set(item.row.session_ref, [
      ...(windowScores.get(item.row.session_ref) ?? []),
      item.score,
    ]);

    if (existing) {
      if ((existing.matches?.length ?? 0) < MAX_MATCHES_PER_SESSION) {
        existing.matches = [...(existing.matches ?? []), match];
      }
      existing.score =
        item.relevance === undefined
          ? existing.score
          : Math.max(existing.score ?? 0, item.relevance);
      continue;
    }

    sessions.set(item.row.session_ref, {
      session_ref: item.row.session_ref,
      tool: item.row.tool,
      started_at: item.row.session_started_at,
      last_activity_at: item.row.session_last_activity_at,
      message_count: item.row.session_message_count,
      preview: item.row.session_preview ?? previewText(item.row.content),
      source_path: item.row.source_path ?? undefined,
      score: item.relevance,
      retrieval,
      matches: [match],
    });

  }

  // Score each session from all of its matching windows, not just its best.
  //
  // `Math.max` alone treats one lucky window the same as three corroborating
  // ones, and recall@5 (0.85) sitting far above top-1 (0.45) says the right
  // session is usually in the candidate set and merely not first — an
  // ordering problem, which is where corroboration should help.
  //
  // Best window still dominates: the extra terms are damped so they can
  // separate sessions of similar peak strength without letting a pile of weak
  // mentions outrank one strong answer.
  for (const [sessionRef, scores] of windowScores) {
    ranks.set(sessionRef, corroboratedScore(scores));
  }

  return [...sessions.values()]
    .sort((left, right) => (ranks.get(right.session_ref) ?? 0) - (ranks.get(left.session_ref) ?? 0))
    .slice(0, limit);
}

function formatMatch(item: {
  row: RetrievalUnitRow;
  score: number;
  relevance: number | undefined;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  continuityScore: number;
}): RetrievalMatch {
  return {
    unit_id: item.row.unit_id,
    message_start_index: item.row.message_start_index,
    message_end_index: item.row.message_end_index,
    started_at: item.row.started_at,
    ended_at: item.row.ended_at,
    preview: previewText(item.row.content),
    // The blended value orders results; it is not a strength of match, and
    // reporting it here reproduced the "best is always 1.0" problem one level
    // down from where it was fixed.
    score: item.relevance === undefined ? undefined : roundScore(item.relevance),
    semantic_score: roundScore(item.semanticScore),
    keyword_score: roundScore(item.keywordScore),
    recency_score: roundScore(item.recencyScore),
    continuity_score: roundScore(item.continuityScore),
  };
}

/**
 * Turn the FTS ordering into a score that decays linearly rather than by
 * reciprocal rank.
 *
 * Reciprocal rank halves at second place and is down to a third by the fourth,
 * which reads a near-tie in bm25 as a rout. bm25 also favours short documents,
 * so a one-line "touched billing while I was in there" outranks a paragraph
 * that actually decided something about billing — and under reciprocal rank
 * that accident of ordering cost the real answer half its keyword score.
 *
 * Measured on the eval, in both modes that use it:
 *
 *            hybrid mrr/recall@5/top1    keyword mrr/recall@5/top1
 *   1/(i+1)  0.559 / 0.767 / 0.417       0.520 / 0.817 / 0.333
 *   linear   0.581 / 0.800 / 0.433       0.532 / 0.850 / 0.333
 *   flat     0.555 / 0.817 / 0.367       0.425 / 0.700 / 0.217
 *
 * Flat scoring is there to show position does carry signal: throwing it away
 * costs keyword mode a tenth of its MRR. The gain here is mostly recall — two
 * queries in each mode — and top-1 moves by one query, which is not a result
 * on its own.
 */
export function rankKeywordRows(rows: RetrievalUnitRow[]): Map<string, number> {
  const scores = new Map<string, number>();
  const total = rows.length || 1;
  rows.forEach((row, index) => {
    scores.set(row.unit_id, (total - index) / total);
  });
  return scores;
}

export function blendScores(
  mode: SessionSearchMode,
  semanticScore: number,
  keywordScore: number,
  recencyScore: number,
  continuityScore: number,
): number {
  // Recency and continuity survive only as a tie-break in the two relevance
  // modes, at a weight too small to reorder anything that differs on
  // relevance. `xtctx_recent_sessions` already answers "what was I just
  // doing"; mixing that signal into search made it answer a question nobody
  // asked, and measurably worse — recency swung across its full range while
  // the semantic term barely moved, so it decided orderings it had no
  // business deciding. Two windows can still score identically — they
  // overlap, and they share the scaffolding header — and the later, more
  // complete one is the better answer, which is all the tie-break decides.
  // Keyword mode keeps both as full terms: they are its only tie-breakers,
  // and the eval shows its recall is best with them.
  const tieBreak = TIE_BREAK_WEIGHT * (0.5 * recencyScore + 0.5 * continuityScore);

  if (mode === "vector") {
    return semanticScore + tieBreak;
  }

  if (mode === "keyword") {
    return 0.75 * keywordScore + 0.15 * recencyScore + 0.1 * continuityScore;
  }

  // 0.6/0.4, chosen by sweeping the blend against the eval rather than by
  // taste. At the previous 0.8/0.2 the semantic term dominated a signal that
  // is not strong enough to carry it, and hybrid ranked *worse* than plain
  // keyword on recall@5 — 0.683 against 0.817 — which is an odd thing for the
  // mode that exists to combine them.
  //
  //   semantic  keyword   mrr     recall@5  top1
  //   0.8       0.2       0.535   0.683     0.400   <- was
  //   0.6       0.4       0.559   0.767     0.417   <- is
  //   0.4       0.6       0.540   0.833     0.333
  //   0.2       0.8       0.540   0.867     0.333
  //
  // Leaning further on keyword keeps buying recall and keeps costing top-1.
  // 0.6 takes the best MRR and the best top-1 while recovering five queries
  // of recall; past it, MRR moves by less than one query and is not worth
  // reading as a difference at sixty queries.
  //
  // None of this touches false positives — the rate sat at 0.417 at every
  // weight tried, because what comes back for an unanswerable query is
  // decided by the candidate filter above, not by how the survivors are
  // ordered. That needs its own change.
  return 0.6 * semanticScore + 0.4 * keywordScore + tieBreak;
}

/**
 * A session's rank from every window that matched it.
 *
 * The best window carries the score; each further window adds a damped share,
 * so a session that answers the query in three places outranks one that
 * mentions it once — without letting many weak mentions beat a single strong
 * answer, which is the failure mode of summing.
 *
 * Harmonic damping (1/2, 1/3, …) rather than a flat bonus: the second
 * corroborating window is worth much more than the fifth, and the series
 * converges, so a very long session cannot accumulate its way to the top.
 */
function corroboratedScore(scores: number[]): number {
  if (scores.length === 0) return 0;
  const ordered = [...scores].sort((left, right) => right - left);
  let total = ordered[0];
  for (let index = 1; index < ordered.length; index++) {
    total += CORROBORATION_WEIGHT * (ordered[index] / (index + 1));
  }
  return total;
}

export function scoreContinuity(messageEndIndex: number, messageCount: number): number {
  if (messageCount <= 1) {
    return 1;
  }
  return Math.max(0, Math.min(1, messageEndIndex / (messageCount - 1)));
}

export function scoreRecency(value: string, range: { oldest: number; newest: number }): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || range.newest <= range.oldest) {
    return 1;
  }
  return Math.max(0, Math.min(1, (timestamp - range.oldest) / (range.newest - range.oldest)));
}

export function getTimeRange(values: string[]): { oldest: number; newest: number } {
  const timestamps = values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return { oldest: 0, newest: 0 };
  }
  return {
    oldest: Math.min(...timestamps),
    newest: Math.max(...timestamps),
  };
}

function previewText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}


/** A window with a stored vector, as the semantic query returns it. */
export interface VectorUnitRow extends RetrievalUnitRow {
  vector: Buffer;
  dimensions: number;
}

/**
 * Score windows against a query and group them into sessions.
 *
 * Everything here is a pure function of what the caller already fetched: the
 * vectorized windows, the keyword hits, and the embedded query (null when
 * there are no vectors to compare it against). The database work and the
 * embedding call stay with the index; this is the part the eval tunes, so it
 * lives beside the thresholds it applies.
 */
export function rankSearchCandidates(options: {
  rows: VectorUnitRow[];
  keywordRows: RetrievalUnitRow[];
  queryVector: Float32Array | null;
  mode: Exclude<SessionSearchMode, "keyword">;
  limit: number;
  cosineSimilarity: (left: Float32Array, right: Float32Array) => number;
  deserializeVector: (buffer: Buffer, dimensions: number) => Float32Array;
}): SessionSummary[] {
  const { rows, keywordRows, queryVector, mode, limit } = options;

  /**
   * Windows that matched on words but have no vector yet.
   *
   * These used to be unreachable. The semantic query inner-joins the vector
   * table, so hybrid could only ever return units that were already
   * embedded, and a keyword hit on anything else was invisible. Vectorizing
   * is budgeted and runs eight windows at a time on semantic searches only,
   * so a partly-embedded index is the ordinary state rather than an edge
   * case — this project sat at 8 vectorized windows out of 1,770.
   *
   * Measured on the eval by freezing the vectorized fraction, hybrid recall
   * tracked coverage almost exactly — 0.500 at half embedded, 0.250 at a
   * quarter, nothing at all at zero — while keyword held 0.850 throughout.
   * Hybrid is the default mode, so the default was a strict subset of the
   * cheaper one it is supposed to improve on.
   */
  const vectorized = new Set(rows.map((row) => row.unit_id));
  const keywordOnly = keywordRows.filter((row) => !vectorized.has(row.unit_id));

  if (rows.length === 0 && keywordOnly.length === 0) {
    return [];
  }

  const keywordScores = rankKeywordRows(keywordRows);
  const timeRange = getTimeRange([...rows, ...keywordOnly].map((row) => row.ended_at));
  const candidates = [
    ...rows.map((row) => ({
      row: row as RetrievalUnitRow,
      rawCosine: queryVector
        ? options.cosineSimilarity(queryVector, options.deserializeVector(row.vector, row.dimensions))
        : 0,
      keywordScore: keywordScores.get(row.unit_id) ?? 0,
      recencyScore: scoreRecency(row.ended_at, timeRange),
      continuityScore: scoreContinuity(row.message_end_index, row.session_message_count),
    })),
    // No semantic evidence yet — carried on the keyword match alone, which
    // the filter below still requires.
    ...keywordOnly.map((row) => ({
      row,
      rawCosine: 0,
      keywordScore: keywordScores.get(row.unit_id) ?? 0,
      recencyScore: scoreRecency(row.ended_at, timeRange),
      continuityScore: scoreContinuity(row.message_end_index, row.session_message_count),
    })),
  ]
    // Require actual evidence. Raw cosine sits near zero for unrelated
    // content, so without this the entire corpus came back for a query
    // matching nothing, formatted exactly like a real hit. A unit qualifies
    // on semantic similarity or a keyword match; "no matching sessions" is
    // a more useful answer than a nearest vector.
    .filter((item) => item.rawCosine >= MIN_SEMANTIC_COSINE || item.keywordScore > 0);

  // Nothing here is actually similar to the query — keep only what matched
  // on words. For a query that means nothing to this corpus that leaves
  // nothing at all, which is the answer.
  const bestCosine = candidates.reduce((best, item) => Math.max(best, item.rawCosine), 0);
  const semanticallyConfident = bestCosine >= MIN_CONFIDENT_COSINE;
  const surviving = semanticallyConfident
    ? candidates
    : candidates.filter((item) => item.keywordScore > 0);

  if (surviving.length === 0) {
    return [];
  }

  // Ordering and reporting are two different jobs, and conflating them is
  // what made the score meaningless.
  //
  // Ordering wants contrast: rescaling this query's survivors onto [0,1]
  // spreads them out and measurably ranks better (hybrid MRR 0.566 -> 0.613
  // on the eval). Reporting wants an absolute: the rescale forces the best
  // survivor to exactly 1.0 however weak it is, so three nonsense words
  // scored 0.901 against a real query's 0.872 and an agent had no way to
  // tell a find from a shrug.
  //
  // So candidates are ranked on the rescaled value and reported with the
  // cosine itself.
  const cosines = surviving.map((item) => item.rawCosine);
  const lowest = Math.min(...cosines);
  const highest = Math.max(...cosines);
  const spread = highest - lowest;

  const scored = surviving
    .map((item) => {
      // A lone survivor is the best match by definition, not the worst.
      const semanticScore = spread > 0 ? (item.rawCosine - lowest) / spread : 1;
      // A window with no vector has *unknown* similarity, not zero. Blending
      // it as zero docks it 60% of the available score for not having been
      // embedded yet, so a mediocre vectorized match outranked a strong
      // keyword one purely by being earlier in the queue: at half coverage
      // that held recall to 0.600 against keyword's 0.850. Scoring those on
      // the evidence they do have — the keyword blend — removes the penalty
      // without inventing a similarity for them.
      const unvectorized = !vectorized.has(item.row.unit_id);
      return {
        ...item,
        semanticScore,
        relevance: unvectorized ? undefined : Math.max(0, Math.min(1, item.rawCosine)),
        score: blendScores(
          unvectorized ? "keyword" : mode,
          semanticScore,
          item.keywordScore,
          item.recencyScore,
          item.continuityScore,
        ),
      };
    })
    .sort((left, right) => right.score - left.score);

  return groupScoredUnits(scored, mode, limit);
}
