/**
 * Cross-tool pickup smoke tests.
 *
 * These tests prove the end-to-end claim at the heart of xtctx:
 * *you can switch between AI coding tools mid-project and pick up
 * context from the tool you just left.*
 *
 * Every scenario:
 *   - spawns the *built* CLI via `node dist/src/cli/index.js <cmd>`
 *   - sandboxes HOME / USERPROFILE / APPDATA so scrapers read our
 *     fixture data, not the developer's real history
 *   - seeds each scraper's *native* storage format (real SQLite DBs,
 *     real JSONL event streams) — no in-memory shortcuts
 *   - queries the MCP server over real JSON-RPC 2.0 stdio, not by
 *     importing handler functions
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendClaudeCode,
  CLI_ENTRY,
  mcpCall,
  parseSearchResponse,
  REPO_ROOT,
  sandboxEnv,
  seedClaudeCode,
  seedCodex,
  seedCopilot,
  seedCursor,
  seedGemini,
  spawnCli,
  type SearchHit,
} from "./helpers.js";

// Each scenario is an end-to-end pipeline exercise; give it plenty of room.
// (vitest's per-file timeout is also bumped via the CLI in package.json.)
const SCENARIO_TIMEOUT = 180_000;

let workspaceRoot = "";

beforeAll(async () => {
  // Real build so every scenario runs against fresh dist.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmCmd, ["run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`npm run build exited with code ${code}`));
    });
  });

  workspaceRoot = await mkdtemp(join(tmpdir(), "xtctx-smoke-"));
}, 240_000);

afterAll(async () => {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

/** Allocate an isolated (projectDir, fakeHome, env) triple per scenario. */
async function allocScenario(label: string): Promise<{
  projectDir: string;
  fakeHome: string;
  env: NodeJS.ProcessEnv;
}> {
  const scenarioDir = await mkdtemp(join(workspaceRoot, `${label}-`));
  const projectDir = join(scenarioDir, "project");
  const fakeHome = join(scenarioDir, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  const env = sandboxEnv(fakeHome);
  // Initialize the project so .xtctx layout exists (deterministic starting state).
  const init = await spawnCli(["init", projectDir], env);
  if (init.code !== 0) {
    throw new Error(`init failed: ${init.stderr}\n${init.stdout}`);
  }
  return { projectDir, fakeHome, env };
}

async function runIngest(projectDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await spawnCli(["ingest", "--project", projectDir], env, {
    timeoutMs: 180_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `ingest failed (code=${result.code}): ${result.stderr}\nSTDOUT:\n${result.stdout}`,
    );
  }
  return result.stdout + result.stderr;
}

async function searchViaMcp(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  query: string,
  opts: { mode?: "hybrid" | "semantic" | "keyword"; limit?: number } = {},
): Promise<SearchHit[]> {
  const resp = await mcpCall(projectDir, "xtctx_search", {
    query,
    mode: opts.mode ?? "hybrid",
    limit: opts.limit ?? 10,
    format: "json",
  }, env);
  return parseSearchResponse(resp);
}

function hasHitMatching(hits: SearchHit[], needle: string): boolean {
  const lower = needle.toLowerCase();
  return hits.some((h) => h.text.toLowerCase().includes(lower));
}

function findHitWithText(hits: SearchHit[], needle: string): SearchHit | undefined {
  const lower = needle.toLowerCase();
  return hits.find((h) => h.text.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("cross-tool pickup smoke", () => {
  it(
    "[1] short handoff: Cursor -> Claude Code (seed in Cursor, query via MCP as Claude)",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s1");

      await seedCursor(fakeHome, "composer-s1", [
        {
          role: "user",
          content:
            "Should we use pgvector or LanceDB for embeddings?",
        },
        {
          role: "assistant",
          content:
            "We chose LanceDB over pgvector because of the offline-first requirement; LanceDB runs fully embedded without a Postgres server, which fits xtctx's per-project desktop install model.",
        },
      ]);

      const ingestLog = await runIngest(projectDir, env);
      expect(ingestLog).toMatch(/Ingestion complete/);

      const hits = await searchViaMcp(projectDir, env, "why not pgvector?");
      expect(hits.length).toBeGreaterThan(0);

      const match = findHitWithText(hits, "LanceDB");
      expect(match, `expected a hit mentioning LanceDB, got: ${JSON.stringify(hits, null, 2)}`).toBeDefined();
      expect(match!.metadata.source_tool).toBe("cursor");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "[2] reverse handoff: Claude Code -> Cursor (seed in Claude, query via MCP as Cursor)",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s2");

      await seedClaudeCode(fakeHome, "proj-hash-s2", "session-s2", [
        {
          role: "user",
          content:
            "How are we handling cross-session rate limits in the API layer?",
        },
        {
          role: "assistant",
          content:
            "We settled on express-rate-limit with a per-IP token bucket of 120 requests per minute; the window is configurable via .xtctx/config.yaml under api.security.rateLimitMax.",
        },
      ]);

      await runIngest(projectDir, env);
      const hits = await searchViaMcp(projectDir, env, "rate limiting approach");

      expect(hits.length).toBeGreaterThan(0);
      const match = findHitWithText(hits, "express-rate-limit");
      expect(match).toBeDefined();
      expect(match!.metadata.source_tool).toBe("claude-code");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "[3] full chain: Claude -> Gemini -> Cursor -> Codex -> Claude (5 hops)",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s3");

      // Hop 1: Claude Code fires up the project, records an initial decision.
      await seedClaudeCode(fakeHome, "proj-hash-s3", "claude-hop-1", [
        {
          role: "assistant",
          content:
            "Scaffolded the hop-chain feature: first milestone is cross-tool handoff with FACT_ALPHA_CLAUDE as the sentinel phrase to verify chain integrity.",
        },
      ]);
      await runIngest(projectDir, env);

      // Hop 2: User switches to Gemini; seed Gemini storage; re-ingest.
      await seedGemini(fakeHome, "gem-hop-2", [
        {
          role: "assistant",
          content:
            "Added input validation using zod. FACT_BETA_GEMINI: validated payloads now short-circuit at the API boundary before touching LanceDB.",
        },
      ]);
      await runIngest(projectDir, env);

      // Hop 3: User switches to Cursor; seed Cursor storage.
      await seedCursor(fakeHome, "cursor-hop-3", [
        {
          role: "assistant",
          content:
            "Refactored the search pipeline. FACT_GAMMA_CURSOR: hybrid search now fuses BM25 and vector results with reciprocal rank fusion, k=60.",
        },
      ]);
      await runIngest(projectDir, env);

      // Hop 4: User switches to Codex; seed Codex storage.
      await seedCodex(fakeHome, "codex-hop-4", [
        {
          role: "user",
          content: "Finalize the dedup rules for knowledge writeback.",
        },
        {
          role: "assistant",
          content:
            "Implemented dedup threshold at cosine similarity 0.92. FACT_DELTA_CODEX: near-duplicate entries are rejected instead of superseded unless they share the same title prefix.",
        },
      ]);
      await runIngest(projectDir, env);

      // Hop 5: User returns to Claude Code. At this point Claude must be able
      // to see FACT_ALPHA through FACT_DELTA across all four prior tools.
      const hitsAlpha = await searchViaMcp(projectDir, env, "FACT_ALPHA_CLAUDE sentinel phrase cross-tool handoff");
      const hitsBeta = await searchViaMcp(projectDir, env, "FACT_BETA_GEMINI zod input validation");
      const hitsGamma = await searchViaMcp(projectDir, env, "FACT_GAMMA_CURSOR hybrid search reciprocal rank fusion");
      const hitsDelta = await searchViaMcp(projectDir, env, "FACT_DELTA_CODEX dedup threshold cosine similarity");

      const alpha = findHitWithText(hitsAlpha, "FACT_ALPHA_CLAUDE");
      const beta = findHitWithText(hitsBeta, "FACT_BETA_GEMINI");
      const gamma = findHitWithText(hitsGamma, "FACT_GAMMA_CURSOR");
      const delta = findHitWithText(hitsDelta, "FACT_DELTA_CODEX");

      expect(alpha, "Claude-origin fact missing").toBeDefined();
      expect(beta, "Gemini-origin fact missing").toBeDefined();
      expect(gamma, "Cursor-origin fact missing").toBeDefined();
      expect(delta, "Codex-origin fact missing").toBeDefined();

      expect(alpha!.metadata.source_tool).toBe("claude-code");
      expect(beta!.metadata.source_tool).toBe("gemini");
      expect(gamma!.metadata.source_tool).toBe("cursor");
      expect(delta!.metadata.source_tool).toBe("codex");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "[4] knowledge writeback round-trip via MCP",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s4");

      // Seed some conversation so there's project context, then have the
      // active tool actively write back via xtctx_save_decision over MCP.
      await seedClaudeCode(fakeHome, "proj-hash-s4", "session-s4", [
        {
          role: "assistant",
          content: "Exploring options for session boundary detection.",
        },
      ]);
      await runIngest(projectDir, env);

      const saveResp = await mcpCall(
        projectDir,
        "xtctx_save_decision",
        {
          title: "Session boundary heuristic",
          rationale:
            "Use a 30-minute gap of inactivity as the session boundary. Shorter windows over-fragment; longer windows conflate unrelated work. Matches industry convention for chat transcripts.",
          context: "Chose this after reviewing compaction strategies for rule-based mode.",
        },
        env,
      );
      expect(saveResp.isError ?? false).toBe(false);

      // Later "tool" queries project knowledge and sees the decision.
      const knowledgeResp = await mcpCall(
        projectDir,
        "xtctx_project_knowledge",
        { type: "decision", format: "json" },
        env,
      );
      const parsed = JSON.parse(knowledgeResp.content[0]!.text) as {
        records: Array<{ title: string; type: string; source_tool: string; body: string }>;
      };
      const decision = parsed.records.find((r) => r.title === "Session boundary heuristic");
      expect(decision, `decision not found in project knowledge: ${JSON.stringify(parsed)}`).toBeDefined();
      expect(decision!.type).toBe("decision");
      expect(decision!.source_tool).toBe("mcp");
      expect(decision!.body).toContain("30-minute gap");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "[5] incremental pickup: re-ingest only processes new data",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s5");

      // Seed multiple tools so the cursor mechanism is exercised across scrapers.
      const baseTime = Date.now() - 120_000;
      await seedClaudeCode(
        fakeHome,
        "proj-hash-s5",
        "session-s5",
        [
          { role: "user", content: "Initial planning discussion." },
          {
            role: "assistant",
            content:
              "OLD_FACT_INCREMENTAL: the original plan was to store embeddings in SQLite with sqlite-vss before we switched to LanceDB.",
          },
        ],
        baseTime,
      );
      await seedCursor(
        fakeHome,
        "composer-s5",
        [
          { role: "user", content: "Paired design review." },
          {
            role: "assistant",
            content: "OLD_FACT_CURSOR: agreed on keeping the web UI as a static SPA served by the API server.",
          },
        ],
        baseTime,
      );

      const firstLog = await runIngest(projectDir, env);
      const firstMatch = firstLog.match(/(\d+)\s+chunks\s+from\s+(\d+)\s+scraper/);
      expect(firstMatch, `could not parse ingest log: ${firstLog}`).toBeTruthy();
      const firstChunks = Number(firstMatch![1]);
      expect(firstChunks).toBeGreaterThanOrEqual(4); // at least 4 messages seeded

      // Append ONE new message to Claude Code. Cursor is untouched.
      const appendTime = Date.now() - 1000;
      await appendClaudeCode(
        fakeHome,
        "proj-hash-s5",
        "session-s5",
        [
          {
            role: "assistant",
            content:
              "NEW_FACT_APPENDED: added streaming ingestion with chokidar watchers for sub-second re-index.",
          },
        ],
        appendTime,
      );

      const secondLog = await runIngest(projectDir, env);
      const secondMatch = secondLog.match(/(\d+)\s+chunks\s+from\s+(\d+)\s+scraper/);
      expect(secondMatch, `could not parse second ingest log: ${secondLog}`).toBeTruthy();
      const secondChunks = Number(secondMatch![1]);
      const secondScrapers = Number(secondMatch![2]);

      // (a) new content findable
      const newHits = await searchViaMcp(projectDir, env, "NEW_FACT_APPENDED streaming chokidar");
      expect(findHitWithText(newHits, "NEW_FACT_APPENDED"), "new fact not found").toBeDefined();

      // (b) old content still findable (no clobber)
      const oldHits = await searchViaMcp(projectDir, env, "OLD_FACT_INCREMENTAL sqlite-vss");
      expect(findHitWithText(oldHits, "OLD_FACT_INCREMENTAL"), "old fact clobbered").toBeDefined();
      const oldCursorHits = await searchViaMcp(projectDir, env, "OLD_FACT_CURSOR static SPA");
      expect(findHitWithText(oldCursorHits, "OLD_FACT_CURSOR"), "cursor fact clobbered").toBeDefined();

      // (c) second ingest processed strictly fewer chunks than the first
      //     (the `since` cursor skipped already-indexed content).
      expect(secondChunks).toBeLessThan(firstChunks);
      // At most one scraper had new content (claude-code). Cursor should be
      // skipped because its cursor already covers everything we seeded.
      expect(secondScrapers).toBeLessThanOrEqual(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "[6] cold start with mixed corpus: ingest sees all five tools in one pass",
    async () => {
      const { projectDir, fakeHome, env } = await allocScenario("s6");

      // Populate all five tools BEFORE any ingest runs.
      await seedClaudeCode(fakeHome, "proj-hash-s6", "claude-s6", [
        { role: "assistant", content: "COLD_CLAUDE_FACT: bootstrap done from Claude session." },
      ]);
      await seedCursor(fakeHome, "cursor-s6", [
        { role: "assistant", content: "COLD_CURSOR_FACT: Cursor pinned the composer model to claude-3.5-sonnet." },
      ]);
      await seedCodex(fakeHome, "codex-s6", [
        { role: "assistant", content: "COLD_CODEX_FACT: Codex enabled auto-edit approval mode for this repo." },
      ]);
      await seedCopilot(fakeHome, "copilot-s6", [
        {
          user: "Summarize the rate limit config.",
          assistant: "COLD_COPILOT_FACT: Copilot confirmed the 120 rpm per-IP rate limit in the API security block.",
        },
      ]);
      await seedGemini(fakeHome, "gemini-s6", [
        { role: "assistant", content: "COLD_GEMINI_FACT: Gemini added streaming response support in the web UI." },
      ]);

      const log = await runIngest(projectDir, env);
      // All five should have been detected and processed.
      const match = log.match(/(\d+)\s+chunks\s+from\s+(\d+)\s+scraper/);
      expect(match, `cannot parse ingest log: ${log}`).toBeTruthy();
      const scrapers = Number(match![2]);
      expect(scrapers, "expected 5 scrapers to have contributed").toBe(5);

      const queries: Array<{ query: string; needle: string; tool: string }> = [
        { query: "COLD_CLAUDE_FACT bootstrap", needle: "COLD_CLAUDE_FACT", tool: "claude-code" },
        { query: "COLD_CURSOR_FACT composer model", needle: "COLD_CURSOR_FACT", tool: "cursor" },
        { query: "COLD_CODEX_FACT auto-edit approval", needle: "COLD_CODEX_FACT", tool: "codex" },
        { query: "COLD_COPILOT_FACT rate limit config", needle: "COLD_COPILOT_FACT", tool: "copilot" },
        { query: "COLD_GEMINI_FACT streaming response", needle: "COLD_GEMINI_FACT", tool: "gemini" },
      ];

      for (const q of queries) {
        const hits = await searchViaMcp(projectDir, env, q.query);
        const hit = findHitWithText(hits, q.needle);
        expect(hit, `missing fact from ${q.tool}: ${q.needle}`).toBeDefined();
        expect(hit!.metadata.source_tool).toBe(q.tool);
      }
    },
    SCENARIO_TIMEOUT,
  );
});

// (silence unused import warnings for items we rely on being resolvable)
void CLI_ENTRY;
void readdir;
void hasHitMatching;
