/**
 * Deterministic, dependency-free corpus generator for the ranking eval.
 *
 * Produces synthetic coding-assistant sessions where a known subset of turns
 * are "anchors": distinctive statements whose content is unique across the
 * corpus, so ground truth for a query is unambiguous. Everything else is
 * filler that shares vocabulary with the anchors, which is what makes the
 * eval discriminating — retrieval has to pick the right session, not merely
 * a session about the right topic.
 *
 * Adapted from the harness in the (unmerged) phase-3 branch; the corpus idea
 * and anchor categories are that design, rebuilt against the SQLite index
 * that replaced LanceDB in the 0.11.0 pivot.
 */

import type { ConversationChunk } from "../../src/types/scraper.js";

/** Mulberry32: a tiny seeded PRNG, so a corpus is reproducible without a dep. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type AnchorCategory = "decision" | "error-solution" | "gotcha" | "convention";

export interface Anchor {
  category: AnchorCategory;
  /** Session that holds this anchor — the ground truth for its query. */
  sessionRef: string;
  /** How the anchor was stated in the transcript. */
  statement: string;
  /**
   * How a developer would later ask about it. Deliberately shares few words
   * with `statement`: a query that echoes the anchor only proves keyword
   * matching works.
   */
  query: string;
}

export interface GeneratedCorpus {
  chunks: ConversationChunk[];
  anchors: Anchor[];
  /**
   * Queries with no right answer. Anything returned for one of these is a
   * false positive — the failure mode the confidence threshold exists to
   * prevent, and the one nothing here used to measure.
   */
  negatives: NegativeQuery[];
}

export interface NegativeQuery {
  /** `absent-topic` reads like a real question; `gibberish` does not read at all. */
  kind: "absent-topic" | "gibberish";
  query: string;
}

const TOOLS = ["claude-code", "codex", "cursor", "copilot", "opencode"] as const;

/**
 * One anchor is placed per subsystem, so this list is what caps the number of
 * queries the eval can ask. At twenty, a five-point move in any metric was one
 * query changing its mind — small enough that tuning could not be told apart
 * from noise, which is the whole purpose of the harness.
 */
const SUBSYSTEMS = [
  "billing", "search indexing", "session replay", "image upload",
  "notification fanout", "audit logging", "rate limiting", "feature flags",
  "webhook delivery", "password reset", "invoice export", "avatar cropping",
  "queue draining", "schema migration", "access tokens", "usage metering",
  "email templating", "cache warming", "report scheduling", "device pairing",
  "subscription renewal", "seat allocation", "tax calculation", "refund handling",
  "media transcoding", "thumbnail generation", "content moderation", "profanity filtering",
  "geo routing", "load shedding", "circuit breaking", "retry budgeting",
  "session pinning", "cookie signing", "csrf rotation", "consent capture",
  "data retention", "export bundling", "gdpr erasure", "audit replay",
  "sso handshake", "scim provisioning", "role inheritance", "policy evaluation",
  "webhook signing", "idempotency keys", "cursor pagination", "bulk ingestion",
  "dead lettering", "backfill scheduling", "shard rebalancing", "index compaction",
  "telemetry sampling", "trace propagation", "log redaction", "alert deduplication",
  "cost attribution", "quota enforcement", "trial conversion", "dunning email",
];

/**
 * Subsystems the corpus never discusses, for queries that have no right
 * answer.
 *
 * Nothing measured whether search invents an answer, so the known weakness —
 * a nonsense query clearing the confidence bar — was an anecdote rather than
 * a number, and no change to the threshold could be judged. These are phrased
 * exactly like the real queries so the only difference is that the corpus has
 * nothing to say.
 */
const ABSENT_SUBSYSTEMS = [
  "quantum ledger reconciliation", "holographic seat mapping", "tidal cache eviction",
  "orbital debris tracking", "sommelier rating intake", "kiln temperature logging",
  "lunar transfer windows", "falconry permit renewal",
];

const TECHNOLOGIES = [
  "Postgres", "Redis", "SQLite", "Kafka", "RabbitMQ", "DynamoDB", "Elasticsearch", "NATS",
];

const ERRORS = [
  "ECONNRESET during pool checkout",
  "OOMKilled on the worker deployment",
  "deadlock detected on the ledger table",
  "TLS handshake timeout to the upstream",
  "unique constraint violation on replay",
  "clock skew rejecting signed payloads",
];

const FILLER = [
  "Ran the test suite; everything green.",
  "Rebased onto main and resolved the lockfile conflict.",
  "Added a couple of log lines around the retry path.",
  "Renamed the helper for clarity, no behaviour change.",
  "Updated the README section about local setup.",
  "Bumped the linter and fixed the two new warnings.",
];

/**
 * Each category pairs a transcript statement with a differently-worded
 * question, so the eval measures retrieval rather than string overlap.
 */
const CATEGORIES: Record<
  AnchorCategory,
  (vars: { subsystem: string; tech: string; error: string }) => { statement: string; query: string }
> = {
  decision: ({ subsystem, tech }) => ({
    statement: `We settled on ${tech} for the ${subsystem} subsystem, mainly for its transactional guarantees under concurrent writes.`,
    query: `which datastore did we end up picking for ${subsystem}`,
  }),
  "error-solution": ({ subsystem, error }) => ({
    statement: `The ${error} in ${subsystem} turned out to be the connection pool sizing; raising the ceiling and adding a jittered backoff cleared it.`,
    query: `how did we end up fixing the ${subsystem} failures`,
  }),
  gotcha: ({ subsystem, tech }) => ({
    statement: `Careful with ${tech} in ${subsystem}: its client silently retries non-idempotent writes, so duplicates appear under load.`,
    query: `what should I watch out for when touching ${subsystem}`,
  }),
  convention: ({ subsystem }) => ({
    statement: `Team convention for ${subsystem}: every public handler validates at the boundary and returns a typed error, never a bare string.`,
    query: `what is the agreed style for ${subsystem} handlers`,
  }),
};

const CATEGORY_NAMES = Object.keys(CATEGORIES) as AnchorCategory[];

export interface CorpusOptions {
  seed?: number;
  /** Sessions generated per tool. */
  sessionsPerTool?: number;
  /** Turns in each session. */
  turnsPerSession?: number;
}

export function generateCorpus(options: CorpusOptions = {}): GeneratedCorpus {
  const seed = options.seed ?? 20260820;
  // Twelve rather than four: with five tools that is sixty sessions and sixty
  // queries, so one query changing its mind moves a metric by 1.7 points
  // instead of 5. The corpus is generated, so the cost is eval runtime, not
  // maintenance.
  const sessionsPerTool = options.sessionsPerTool ?? 12;
  const turnsPerSession = options.turnsPerSession ?? 6;
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  const chunks: ConversationChunk[] = [];
  const anchors: Anchor[] = [];
  // Every anchor gets a distinct subsystem so exactly one session is correct.
  const subsystems = [...SUBSYSTEMS];
  let clock = Date.parse("2026-05-01T09:00:00.000Z");

  for (const tool of TOOLS) {
    for (let index = 0; index < sessionsPerTool; index += 1) {
      const sessionId = `${tool}-session-${index}`;
      const sessionRef = `${tool}:${sessionId}`;
      // One anchor per session while distinct subsystems remain.
      const subsystem = subsystems.shift();
      const anchorTurn = subsystem ? Math.floor(random() * turnsPerSession) : -1;

      for (let turn = 0; turn < turnsPerSession; turn += 1) {
        clock += 60_000;
        const isAnchor = turn === anchorTurn && subsystem !== undefined;
        let content: string;

        if (isAnchor && subsystem) {
          const category = CATEGORY_NAMES[anchors.length % CATEGORY_NAMES.length];
          const built = CATEGORIES[category]({
            subsystem,
            tech: pick(TECHNOLOGIES),
            error: pick(ERRORS),
          });
          content = built.statement;
          anchors.push({ category, sessionRef, statement: built.statement, query: built.query });
        } else {
          // Filler mentions the same vocabulary, so a query cannot win just by
          // matching the topic — it has to find the session that decided it.
          content = `${pick(FILLER)} Touched ${pick(SUBSYSTEMS)} while I was in there.`;
        }

        chunks.push({
          tool,
          sessionId,
          timestamp: new Date(clock),
          role: turn % 2 === 0 ? "user" : "assistant",
          content,
          metadata: { messageIndex: turn, tokenEstimate: Math.ceil(content.length / 4) },
        });
      }
    }
  }

  return { chunks, anchors, negatives: buildNegatives() };
}

/**
 * Queries the corpus cannot answer.
 *
 * Two kinds, because they fail differently. An absent topic is well-formed
 * English about something never discussed — the case where a plausible-looking
 * near-match is most tempting. Gibberish has no meaning at all, and is the
 * case already known to clear the confidence bar at 0.331.
 */
function buildNegatives(): NegativeQuery[] {
  const negatives: NegativeQuery[] = ABSENT_SUBSYSTEMS.flatMap((subsystem) => [
    { kind: "absent-topic" as const, query: `which datastore did we end up picking for ${subsystem}` },
    { kind: "absent-topic" as const, query: `what should I watch out for when touching ${subsystem}` },
  ]);

  for (const query of [
    "zorble frantic widgetting",
    "qqqq wwww eeee rrrr",
    "flurbing the grommet sideways",
    "asdkjh alskdjh alskdjh",
    "penumbral wibble ratchet",
    "thrompf zizzle vorp",
    "blibber blabber blorp",
    "xyzzy plugh frotz",
  ]) {
    negatives.push({ kind: "gibberish", query });
  }

  return negatives;
}
