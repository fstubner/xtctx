/**
 * The ranking behaviours that only the eval defended.
 *
 * A mutation sweep on 2026-09-03 zeroed four tuned constants one at a time.
 * Every one survived `npm test` and was caught only by `tests/eval`, which is
 * excluded from it — so a developer running the normal suite got no signal on
 * any of them, and the eval is slow enough that nobody runs it casually.
 *
 * Leaving the numbers to the eval is right: a weight is a quality decision,
 * swept against a corpus, and pinning 0.5 in a unit test would fight the next
 * sweep. What the eval should not be sole owner of is whether the behaviour
 * exists at all. These assert the shape — corroboration helps, the tie-break
 * only breaks ties, windows overlap, one session cannot crowd out the rest —
 * and say nothing about the values, so a re-sweep passes and a deletion does
 * not.
 */
import { describe, expect, it } from "vitest";
import { rankSearchCandidates, type VectorUnitRow } from "@xtctx/handoff/ranking";
import {
  DEFAULT_WINDOW_SIZE,
  DEFAULT_WINDOW_STRIDE,
  planRetrievalUnits,
  type MessageRow,
} from "@xtctx/handoff/retrieval-units";

/**
 * The cosine each row should score, carried in the row itself.
 *
 * `rankSearchCandidates` takes its similarity functions as parameters, so a
 * test can choose the similarity directly instead of manufacturing vectors
 * that happen to produce it.
 */
function unit(
  sessionRef: string,
  unitId: string,
  cosine: number,
  options: { endedAt?: string; messageEndIndex?: number } = {},
): VectorUnitRow {
  const endedAt = options.endedAt ?? "2026-05-10T10:00:00.000Z";
  return {
    unit_id: unitId,
    session_ref: sessionRef,
    tool: "codex",
    message_start_index: 0,
    message_end_index: options.messageEndIndex ?? 8,
    started_at: endedAt,
    ended_at: endedAt,
    content: `content for ${unitId}`,
    content_hash: unitId,
    session_started_at: "2026-05-10T09:00:00.000Z",
    session_last_activity_at: endedAt,
    session_message_count: 20,
    session_preview: null,
    source_path: null,
    // Read back by the injected deserializer below, never by real code.
    vector: Buffer.from(new Float64Array([cosine]).buffer),
    dimensions: 1,
  };
}

function rank(rows: VectorUnitRow[], limit = 5) {
  return rankSearchCandidates({
    rows,
    keywordRows: [],
    queryVector: Float32Array.from([1]),
    mode: "vector",
    limit,
    deserializeVector: (buffer) => Float32Array.from(new Float64Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    )),
    cosineSimilarity: (_query, vector) => vector[0],
  }).map((session) => session.session_ref);
}

describe("ranking contracts the eval alone used to hold", () => {
  it("prefers a session corroborated by several windows to one lone window", () => {
    // Several windows saying the same thing is evidence the session is about
    // the query, not that one sentence happened to match. Zeroing the
    // corroboration weight left the whole unit suite green.
    const ranked = rank([
      unit("codex:lone", "lone-1", 0.8),
      unit("codex:corroborated", "corr-1", 0.8),
      unit("codex:corroborated", "corr-2", 0.75),
      unit("codex:corroborated", "corr-3", 0.7),
    ]);

    expect(ranked[0]).toBe("codex:corroborated");
  });

  it("uses recency only to break a tie, never to overturn relevance", () => {
    // Both halves matter. Without the tie-break, two identical scores keep
    // whatever order they arrived in; with it weighted too heavily, a stale
    // strong match loses to a recent weak one — which is the failure the
    // small weight exists to avoid.
    const tied = rank([
      unit("codex:older", "older-1", 0.8, { endedAt: "2026-05-01T10:00:00.000Z" }),
      unit("codex:newer", "newer-1", 0.8, { endedAt: "2026-05-20T10:00:00.000Z" }),
    ]);
    expect(tied[0]).toBe("codex:newer");

    // A near-tie, deliberately. Vector mode rescales the survivors onto [0,1],
    // so with only two of them any gap becomes the full range and the
    // tie-break would need a weight above 2 to overturn it — an assertion that
    // loose passes even at 1.5 and is worth nothing. A third row stretches the
    // scale so the top two sit close together, which is where a tie-break that
    // has grown too heavy actually shows.
    const differing = rank([
      unit("codex:stronger", "s-1", 0.9, { endedAt: "2026-05-01T10:00:00.000Z" }),
      unit("codex:recent", "r-1", 0.88, { endedAt: "2026-05-20T10:00:00.000Z" }),
      unit("codex:weak", "w-1", 0.2, { endedAt: "2026-05-02T10:00:00.000Z" }),
    ]);
    expect(differing[0]).toBe("codex:stronger");
  });

  it("lets several sessions through rather than one filling the answer", () => {
    // A session with many matching windows must not consume the whole result
    // set. Cutting the candidate budget to one window per session was invisible
    // to the unit suite.
    const rows = [
      ...Array.from({ length: 8 }, (_unused, i) => unit("codex:noisy", `noisy-${i}`, 0.9 - i * 0.01)),
      unit("codex:other-a", "a-1", 0.7),
      unit("codex:other-b", "b-1", 0.65),
    ];

    const ranked = rank(rows, 3);

    expect(new Set(ranked).size).toBe(ranked.length);
    expect(ranked).toContain("codex:other-a");
  });

  it("overlaps windows so a phrase across a boundary stays whole in one of them", () => {
    // Stride below size is what keeps a sentence spanning a boundary intact
    // somewhere. At stride === size the windows tile, and a phrase split
    // across the seam is in no window entire.
    const messages: MessageRow[] = Array.from({ length: 16 }, (_unused, i) => ({
      id: `m${i}`,
      timestamp: new Date(Date.parse("2026-05-10T10:00:00.000Z") + i * 1000).toISOString(),
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${i}`,
      message_index: i,
      source_pointer: null,
    }));

    // The real defaults, not literals: passing 8 and 4 by hand tested the
    // windowing mechanism and left the constants undefended, which is the gap
    // this file exists to close. Setting stride to the window size must fail
    // here.
    expect(DEFAULT_WINDOW_STRIDE).toBeLessThan(DEFAULT_WINDOW_SIZE);
    const units = [
      ...planRetrievalUnits("codex:s", messages, DEFAULT_WINDOW_SIZE, DEFAULT_WINDOW_STRIDE).values(),
    ];
    const spans = units.map(
      (plan) => [plan.start.message_index, plan.end.message_index] as const,
    );

    // Straddle the first tiling boundary: without overlap no window holds
    // both the message before it and the one after.
    const before = DEFAULT_WINDOW_SIZE - 2;
    const after = DEFAULT_WINDOW_SIZE + 1;
    const holdsBoth = spans.some(([start, end]) => start <= before && end >= after);
    expect(holdsBoth, `windows: ${JSON.stringify(spans)}`).toBe(true);
  });
});
