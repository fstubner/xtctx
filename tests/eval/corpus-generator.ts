/**
 * Deterministic, LLM-free corpus generator for the ranking eval harness.
 *
 * Produces synthetic coding-assistant sessions whose "anchor" chunks carry
 * known, unique content so ground-truth retrieval is unambiguous.
 *
 * A small curated vocabulary (technologies, error messages, subsystems, etc.)
 * combined with a seeded PRNG yields reproducible corpora.
 */

import { createHash } from "node:crypto";
import type { ConversationChunk } from "../../src/types/scraper.js";

// Mulberry32 — tiny seeded PRNG so tests are deterministic without a dep.
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

export type AnchorCategory =
  | "decision"
  | "error-solution"
  | "gotcha"
  | "insight"
  | "convention"
  | "faq";

export interface AnchorChunk {
  /** Deterministic chunkId that matches what the ingestion pipeline will produce. */
  chunkId: string;
  category: AnchorCategory;
  /** Raw text — rendered by the category's template. */
  content: string;
  /** Template variables used; the query generator reads from here. */
  vars: Record<string, string>;
  /** Session that contains this anchor. */
  sessionId: string;
  /** Tool (claude-code / cursor / ...). */
  tool: string;
  /** Timestamp within the session. */
  timestamp: Date;
  /** 0-based message index within the session. */
  messageIndex: number;
  /** Role of the turn the anchor is embedded in. */
  role: ConversationChunk["role"];
}

export interface GeneratedSession {
  tool: string;
  sessionId: string;
  chunks: ConversationChunk[];
  anchors: AnchorChunk[];
}

export interface GeneratedCorpus {
  sessions: GeneratedSession[];
  chunks: ConversationChunk[];
  anchors: AnchorChunk[];
}

export interface CorpusOptions {
  seed: number;
  /** Number of sessions per tool. */
  sessionsPerTool: number;
  /** Probability (0..1) that a given session contains an anchor chunk. */
  anchorRate: number;
  /** Number of filler turns per session (excluding anchor). */
  turnsPerSession: number;
  tools?: string[];
}

const DEFAULT_TOOLS = [
  "claude-code",
  "cursor",
  "codex",
  "copilot",
  "gemini",
  "opencode",
  "copilot-cli",
];

// ---- Vocabulary pool ------------------------------------------------------
// Each list is intentionally ~40 items so anchors stay distinct from each other.

const TECHNOLOGIES_A = [
  "vitest", "jest", "esbuild", "swc", "tsx", "rollup", "webpack", "parcel",
  "pnpm", "bun", "deno", "turborepo", "nx", "lerna", "zod", "valibot",
  "drizzle", "prisma", "knex", "kysely", "postgres", "sqlite", "duckdb",
  "lancedb", "qdrant", "pinecone", "weaviate", "chroma", "elasticsearch",
  "opensearch", "meilisearch", "typesense", "redis", "memcached", "mongodb",
  "clickhouse", "cassandra", "dynamodb", "s3", "r2",
];

const TECHNOLOGIES_B = [
  "mocha", "ava", "tape", "swc-jest", "tsc", "microbundle", "vite", "snowpack",
  "npm", "yarn", "node", "gulp", "grunt", "moleculer", "joi", "yup",
  "sequelize", "typeorm", "mikroorm", "bookshelf", "mysql", "leveldb", "rocksdb",
  "faiss", "milvus", "vespa", "marqo", "meili", "solr", "algolia",
  "tantivy", "bleve", "memcache", "etcd", "couchdb", "timescaledb", "scylla",
  "rethinkdb", "gcs", "b2",
];

const RATIONALES = [
  "because it has better caching semantics for our fanout workload",
  "because its cold-start latency is roughly half of the alternative",
  "because the type inference story aligns with our TS-first codebase",
  "because the schema migration flow doesn't require a downtime window",
  "because hybrid BM25 plus vector search was a first-class primitive",
  "because the test runner supports workspace-aware parallelism out of the box",
  "because operational overhead on our single-node deployment is lower",
  "because it avoids the native-module rebuild headache on Windows",
  "because the streaming API composes cleanly with our async iterables",
  "because the license terms were compatible with our redistribution plan",
  "because empirical benchmarks on our workload showed a 30% p95 win",
  "because memory overhead per connection was predictable under load",
  "because the plugin ecosystem covered the extensions we needed",
  "because upgrade cost across major versions has historically been low",
  "because debuggability of query plans was substantially better",
  "because it integrates with our existing observability stack without glue",
  "because the batch-insert throughput matched our ingest requirements",
  "because failure modes were well documented and predictable",
  "because maintainer responsiveness on issues was consistently fast",
  "because configuration-as-code worked without a separate control plane",
];

const ERROR_MESSAGES = [
  "ENOENT: no such file or directory",
  "TypeError: Cannot read properties of undefined (reading 'then')",
  "SQLITE_BUSY: database is locked",
  "MODULE_NOT_FOUND: Cannot find module 'better-sqlite3'",
  "EADDRINUSE: address already in use :::3000",
  "LanceError: table 'context' does not exist",
  "Vitest caught an unhandled rejection outside of a test",
  "RangeError: Invalid time value",
  "TS2322: Type 'unknown' is not assignable to type 'string'",
  "ERR_REQUIRE_ESM: require() of ES Module",
  "heap out of memory during embedding batch",
  "fetch failed: ECONNREFUSED 127.0.0.1:11434",
  "HybridSearch returned an empty result set unexpectedly",
  "chokidar: EMFILE too many open files",
  "glob returned duplicated absolute paths on Windows",
  "better-sqlite3 native binding not compiled for node 24",
  "transformers.js failed to load Xenova/all-MiniLM-L6-v2",
  "apache-arrow schema mismatch on upsert",
  "scraper state file contained invalid JSON",
  "FTS index creation failed with 'column text does not exist'",
  "ingestion watcher did not fire on rename on macOS",
  "cursor composerData blob missing allComposers",
  "codex session_meta event arrived after first user message",
  "copilot interactive.sessions value was not a JSON object",
  "gemini session file used sessions[].turns layout",
  "MCP handshake timed out before capabilities exchange",
  "rate limiter rejected a well-formed request with 429",
  "CORS preflight failed for localhost origin in dev",
  "helmet CSP blocked inline script on the landing page",
  "release-please PR contained a merge conflict in CHANGELOG",
];

const COMMANDS = [
  "npm test", "npm run build", "npm ci", "npx vitest run", "node dist/cli.js",
  "npm run verify:release", "npm run test:integration", "pnpm install",
  "npm rebuild better-sqlite3", "npm run lint", "tsc --noEmit",
  "npm run smoke:cli", "npm run test:security", "npm run security:checklist",
  "npx tsx src/cli/index.ts", "npm pack --dry-run", "git worktree add",
  "gh pr create", "npm run landing:build", "npm run web:build",
];

const FIXES = [
  "pinning the transitive dependency and adding a resolutions override",
  "wrapping the async iterable in an explicit try/finally to release the DB",
  "switching the path separator to forward slashes on Windows",
  "rebuilding the native module against the exact Node ABI in CI",
  "deleting the stale LanceDB table before the first upsert",
  "forcing the embedding batch size to 16 to stay under the heap limit",
  "gating the FTS index creation behind an existence check",
  "allowlisting the origin explicitly instead of relying on the regex",
  "adding a retry with exponential backoff on EADDRINUSE",
  "moving the initialization out of the module top-level and into a lazy hook",
  "using prepareSync instead of prepare so the statement is reusable",
  "switching from readFile to createReadStream for files over 10 MB",
  "reordering the session_meta and turn_context handling in the parser",
  "normalising the role from numeric type before the role map lookup",
  "setting crlfDelay to Infinity on the readline interface",
];

const SUBSYSTEMS = [
  "ingestion coordinator", "scraper registry", "LanceDB store", "embedding service",
  "hybrid search", "MCP tool handlers", "API rate limiter", "session index",
  "knowledge repository", "compaction pipeline", "daemon watcher",
  "Claude Code scraper", "Cursor scraper", "Codex scraper", "Copilot scraper",
  "Gemini scraper", "state manager", "config loader", "CLI entry",
  "web runtime", "landing preview", "release automation", "security checklist",
  "auto-tagger", "dedup pass",
];

const SURPRISING_BEHAVIORS = [
  "silently drops chunks whose timestamp equals the cursor",
  "returns an empty array rather than throwing on schema mismatch",
  "double-reads the first session on startup",
  "caches the FTS index promise indefinitely",
  "treats a missing file as an empty one",
  "uses the composer ID as the session ID when the real ID is absent",
  "coerces numeric timestamps to seconds when they are milliseconds",
  "holds a write lock for the full ingestion cycle",
  "serialises metadata as a JSON string rather than a structured field",
  "runs the state save before the write commits",
];

const CONDITIONS = [
  "the workspace database is read-only",
  "two tools race on the same LanceDB path",
  "the session file is truncated mid-line",
  "the embedding service is not yet initialised",
  "the scraper has never run before on this project",
  "a custom store path is configured",
  "the project root contains non-ASCII characters",
  "the process is invoked without a TTY",
  "better-sqlite3 is installed but not compiled",
  "the daemon is restarted during a write",
];

const INSIGHTS = [
  "hybrid RRF search consistently beats pure vector for exact-token recall",
  "embedding batches of 32 hit a sweet spot on this laptop",
  "FTS index creation dominates the first-search latency by an order of magnitude",
  "session cache invalidation after each cycle keeps reads within 200 ms stale",
  "scraper state is safe to corrupt without data loss because re-scrape is idempotent",
  "the majority of ingested chunks are assistant turns, not user",
  "chunk IDs are stable across re-ingests because they hash content not position",
  "compaction layer-1 chunks are ~6x denser in tokens than raw turns",
  "most drift failures surface as silent empty arrays rather than exceptions",
];

const CONVENTIONS = [
  "use camelCase for TypeScript identifiers and kebab-case for file names",
  "prefix scraper classes with the tool name and suffix them with Scraper",
  "keep knowledge-repository schema migrations idempotent and reversible",
  "log at WARN level or higher for any schema-shape surprise",
  "keep test fixtures inside tests/integration/fixtures/<name>",
  "every new scraper ships with a registry entry and at least three tests",
  "exported public types live in src/types and are re-exported by index.ts",
  "CLI commands always accept --project-path and default to cwd()",
  "vitest test files end in .test.ts; eval harness files end in .eval.test.ts",
  "tests never import from src/cli — go through the runtime service layer",
];

const FAQ_QA: Array<[string, string]> = [
  ["how do I regenerate the ranking baseline?", "run npm run eval:baseline and commit the JSON"],
  ["where does LanceDB store its tables?", "under .xtctx/.store/lancedb inside the project"],
  ["how do I add a new scraper?", "extend AbstractScraper, register it, add a test"],
  ["why is better-sqlite3 rebuilt after npm ci?", "its native binding must match the running Node ABI"],
  ["how is FTS index creation gated?", "a per-table pending promise prevents concurrent creation"],
  ["how are chunk IDs derived?", "sha256 of tool|session|timestamp|role|content truncated to 24 chars"],
  ["how do I run only the eval harness?", "npm run test:eval"],
  ["does the eval harness call any LLM?", "no, templates and seeded RNG only"],
  ["how many sessions does the default eval corpus have?", "200 across five tools"],
  ["what is the regression gate threshold?", "five percent relative to the recorded baseline"],
];

// --- filler content (non-anchor turns) ---

const FILLER_USER_PHRASES = [
  "can you summarise the current state of the project",
  "what should I look at next",
  "run the tests and tell me what fails",
  "rebase this branch onto main and resolve conflicts",
  "open the failing file and explain the error",
  "why does this test hang",
  "switch to strict type checking",
  "inline the helper and delete the file",
  "generate JSDoc for the public methods",
  "pretty-print the diff for me",
];

const FILLER_ASSISTANT_PHRASES = [
  "Here is the plan. I will start by inspecting the failing test.",
  "Tests pass after the refactor. Summary above.",
  "The failing line is in src/store/search.ts at line 42.",
  "I've committed the change with a descriptive message.",
  "This is a known gotcha; the fix is in the README.",
  "All lint errors cleared. Ready for review.",
  "No regressions detected in the smoke run.",
  "I'll flag this as a follow-up rather than block on it now.",
];

// ---- Chunk ID -------------------------------------------------------------

/**
 * Mirror of `createChunkId` inside IngestionCoordinator. Kept private there;
 * replicated here so the corpus generator can predict the IDs that ingestion
 * will produce, giving the eval harness ground-truth labels without any
 * post-hoc lookup.
 */
export function computeChunkId(chunk: ConversationChunk): string {
  const hash = createHash("sha256");
  hash.update(
    `${chunk.tool}|${chunk.sessionId}|${chunk.timestamp.toISOString()}|${chunk.role}|${chunk.content}`,
  );
  return hash.digest("hex").slice(0, 24);
}

// ---- Picking helpers ------------------------------------------------------

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pickPair<T>(rng: () => number, arr: readonly T[]): [T, T] {
  const a = pick(rng, arr);
  let b = pick(rng, arr);
  let guard = 0;
  while (b === a && guard < 10) {
    b = pick(rng, arr);
    guard++;
  }
  return [a, b];
}

function renderAnchor(
  rng: () => number,
  category: AnchorCategory,
): { content: string; vars: Record<string, string> } {
  switch (category) {
    case "decision": {
      const technology_A = pick(rng, TECHNOLOGIES_A);
      const technology_B = pick(rng, TECHNOLOGIES_B);
      const rationale = pick(rng, RATIONALES);
      return {
        content: `We decided to use ${technology_A} over ${technology_B} ${rationale}.`,
        vars: { technology_A, technology_B, rationale },
      };
    }
    case "error-solution": {
      const error_message = pick(rng, ERROR_MESSAGES);
      const command = pick(rng, COMMANDS);
      const fix = pick(rng, FIXES);
      return {
        content: `Hit error "${error_message}" when running \`${command}\`. Fixed by ${fix}.`,
        vars: { error_message, command, fix },
      };
    }
    case "gotcha": {
      const subsystem = pick(rng, SUBSYSTEMS);
      const surprising_behavior = pick(rng, SURPRISING_BEHAVIORS);
      const condition = pick(rng, CONDITIONS);
      return {
        content: `Watch out: the ${subsystem} ${surprising_behavior} when ${condition}.`,
        vars: { subsystem, surprising_behavior, condition },
      };
    }
    case "insight": {
      const subsystem = pick(rng, SUBSYSTEMS);
      const insight = pick(rng, INSIGHTS);
      return {
        content: `Observation about the ${subsystem}: ${insight}.`,
        vars: { subsystem, insight },
      };
    }
    case "convention": {
      const subsystem = pick(rng, SUBSYSTEMS);
      const convention = pick(rng, CONVENTIONS);
      return {
        content: `Project convention for the ${subsystem}: ${convention}.`,
        vars: { subsystem, convention },
      };
    }
    case "faq": {
      const [question, answer] = pick(rng, FAQ_QA);
      return {
        content: `Q: ${question} A: ${answer}.`,
        vars: { question, answer },
      };
    }
  }
}

const ALL_CATEGORIES: AnchorCategory[] = [
  "decision",
  "error-solution",
  "gotcha",
  "insight",
  "convention",
  "faq",
];

/** Deterministically generate a corpus of synthetic sessions. */
export function generateCorpus(options: CorpusOptions): GeneratedCorpus {
  const rng = mulberry32(options.seed);
  const tools = options.tools ?? DEFAULT_TOOLS;

  const sessions: GeneratedSession[] = [];
  const allChunks: ConversationChunk[] = [];
  const allAnchors: AnchorChunk[] = [];

  // Start well in the past so timestamps stay monotonically ascending.
  const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
  let sessionCounter = 0;

  for (const tool of tools) {
    for (let s = 0; s < options.sessionsPerTool; s++) {
      const sessionId = `eval-${tool}-${sessionCounter.toString().padStart(5, "0")}`;
      sessionCounter++;

      const sessionChunks: ConversationChunk[] = [];
      const sessionAnchors: AnchorChunk[] = [];

      const hasAnchor = rng() < options.anchorRate;
      const anchorPosition = hasAnchor
        ? Math.floor(rng() * (options.turnsPerSession + 1))
        : -1;

      const anchorCategory = pick(rng, ALL_CATEGORIES);

      for (let t = 0; t < options.turnsPerSession; t++) {
        const role: ConversationChunk["role"] = t % 2 === 0 ? "user" : "assistant";
        const timestamp = new Date(baseTime + sessionCounter * 3_600_000 + t * 60_000);

        let content: string;
        let anchorInfo: AnchorChunk | null = null;
        if (t === anchorPosition) {
          const rendered = renderAnchor(rng, anchorCategory);
          content = rendered.content;
          const chunk: ConversationChunk = {
            tool,
            sessionId,
            timestamp,
            role: "assistant",
            content,
            metadata: { messageIndex: t, tokenEstimate: Math.ceil(content.length / 4) },
          };
          const chunkId = computeChunkId(chunk);
          anchorInfo = {
            chunkId,
            category: anchorCategory,
            content,
            vars: rendered.vars,
            sessionId,
            tool,
            timestamp,
            messageIndex: t,
            role: "assistant",
          };
          sessionAnchors.push(anchorInfo);
          allAnchors.push(anchorInfo);
          sessionChunks.push(chunk);
          allChunks.push(chunk);
          continue;
        }

        content = role === "user" ? pick(rng, FILLER_USER_PHRASES) : pick(rng, FILLER_ASSISTANT_PHRASES);
        const chunk: ConversationChunk = {
          tool,
          sessionId,
          timestamp,
          role,
          content,
          metadata: { messageIndex: t, tokenEstimate: Math.ceil(content.length / 4) },
        };
        sessionChunks.push(chunk);
        allChunks.push(chunk);
      }

      sessions.push({ tool, sessionId, chunks: sessionChunks, anchors: sessionAnchors });
    }
  }

  return { sessions, chunks: allChunks, anchors: allAnchors };
}
