# xtctx Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-first cross-tool context store with MCP exposure, conversation scraping, knowledge management, and a Vue web UI.

**Architecture:** TypeScript monolith with a src/ directory for the core engine (vector store, scrapers, MCP server, ingestion daemon, compaction, config sync) and a web/ directory for the Vue 3 SPA. A shared API layer backs both the MCP tools and the web UI. A CLI (`xtctx`) is the entry point for all operations.

**Tech Stack:** TypeScript, Node.js, LanceDB, MCP TypeScript SDK, Vue 3 + Vite, chokidar, vitest, better-sqlite3 (for reading Cursor DBs), yaml (config parsing)

**Design Doc:** `docs/plans/2026-02-25-xtctx-design.md`

---

## Project Structure

```
xtctx/
├── src/
│   ├── types/              # Shared type definitions
│   │   ├── context.ts      # ContextRecord, WriteResult
│   │   ├── scraper.ts      # ConversationChunk, ScraperState, ConversationScraper
│   │   ├── compaction.ts   # CompactedSession
│   │   ├── config.ts       # XtctxConfig, ToolConfig
│   │   └── index.ts        # Re-exports
│   ├── store/              # Vector store + search
│   │   ├── lance.ts        # LanceDB wrapper
│   │   ├── embeddings.ts   # Embedding provider
│   │   ├── search.ts       # Hybrid search with RRF
│   │   └── index.ts
│   ├── knowledge/          # Shared knowledge layer
│   │   ├── repository.ts   # Read/write .xtctx/knowledge/ files
│   │   ├── autotag.ts      # Auto-tagging pipeline
│   │   ├── dedup.ts        # Deduplication + supercession
│   │   ├── enrichment.ts   # Environment version capture
│   │   └── index.ts
│   ├── scrapers/           # Conversation scraper plugins
│   │   ├── registry.ts     # Scraper discovery + registration
│   │   ├── base.ts         # Base scraper utilities
│   │   ├── claude-code.ts  # Claude Code scraper
│   │   ├── cursor.ts       # Cursor scraper
│   │   ├── codex.ts        # OpenAI Codex CLI scraper
│   │   ├── copilot.ts      # GitHub Copilot scraper
│   │   ├── gemini.ts       # Gemini CLI scraper
│   │   └── index.ts
│   ├── ingestion/          # Ingestion daemon
│   │   ├── daemon.ts       # Main daemon loop
│   │   ├── watcher.ts      # chokidar file watcher
│   │   ├── coordinator.ts  # Orchestrates scrapers + watcher
│   │   └── index.ts
│   ├── compaction/         # Compaction pipeline
│   │   ├── pipeline.ts     # Compaction orchestrator
│   │   ├── rule-based.ts   # Tier 1: rule-based compaction
│   │   ├── llm-assisted.ts # Tier 2: LLM-assisted compaction
│   │   ├── providers/      # LLM provider implementations
│   │   │   ├── cli.ts      # CLI tool provider (claude, gemini, codex)
│   │   │   ├── ollama.ts   # Ollama provider
│   │   │   └── openai.ts   # OpenAI API provider
│   │   └── index.ts
│   ├── mcp/                # MCP server
│   │   ├── server.ts       # MCP server setup
│   │   ├── tools/          # Tool handlers
│   │   │   ├── search.ts       # xtctx_search
│   │   │   ├── sessions.ts     # xtctx_recent_sessions, xtctx_session_detail
│   │   │   ├── knowledge.ts    # xtctx_project_knowledge
│   │   │   ├── write.ts        # xtctx_save_decision, _error_solution, _insight
│   │   │   └── config.ts       # xtctx_list_configs, _get_config, _tool_preferences
│   │   └── index.ts
│   ├── api/                # REST API (shared by web UI)
│   │   ├── server.ts       # Express/Fastify server
│   │   ├── routes/
│   │   │   ├── search.ts
│   │   │   ├── knowledge.ts
│   │   │   ├── sources.ts
│   │   │   └── config.ts
│   │   └── index.ts
│   ├── config/             # Config sync + tool mappings
│   │   ├── loader.ts       # Load .xtctx/config.yaml
│   │   ├── sync.ts         # Generate tool-native configs
│   │   ├── mappings/       # Tool-specific config templates
│   │   │   ├── claude-code.ts
│   │   │   ├── cursor.ts
│   │   │   ├── codex.ts
│   │   │   └── copilot.ts
│   │   └── index.ts
│   ├── cli/                # CLI entry points
│   │   ├── index.ts        # Main CLI router
│   │   ├── init.ts         # xtctx init
│   │   ├── serve.ts        # xtctx serve (daemon + MCP + web)
│   │   ├── sync.ts         # xtctx sync (config sync)
│   │   └── ingest.ts       # xtctx ingest (manual trigger)
│   └── utils/              # Shared utilities
│       ├── hash.ts         # Deterministic content hashing
│       ├── paths.ts        # Path resolution helpers
│       └── logger.ts       # Logging
├── web/                    # Vue 3 SPA
│   ├── src/
│   │   ├── App.vue
│   │   ├── main.ts
│   │   ├── router.ts
│   │   ├── pages/
│   │   │   ├── Dashboard.vue
│   │   │   ├── Search.vue
│   │   │   ├── Knowledge.vue
│   │   │   ├── Sources.vue
│   │   │   └── Config.vue
│   │   ├── components/
│   │   └── composables/
│   ├── index.html
│   └── vite.config.ts
├── landing/                # xtctx.com static landing page
├── tests/                  # Mirrors src/ structure
│   ├── store/
│   ├── knowledge/
│   ├── scrapers/
│   ├── ingestion/
│   ├── compaction/
│   ├── mcp/
│   └── fixtures/           # Test data (sample conversations, configs)
├── docs/
│   └── plans/
├── .xtctx/                 # Dogfooding: xtctx uses itself
│   └── skills/
│       └── xtctx-usage.md  # The agent skill
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## Phase 1: Project Scaffolding & Core Types

### Task 1.1: Initialize TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.npmrc`

**Step 1: Initialize package.json**

```json
{
  "name": "xtctx",
  "version": "0.1.0",
  "description": "Cross-tool context for AI coding agents",
  "type": "module",
  "bin": {
    "xtctx": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ tests/",
    "mcp": "tsx src/mcp/server.ts"
  },
  "dependencies": {
    "@lancedb/lancedb": "^0.13.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "apache-arrow": "^18.0.0",
    "better-sqlite3": "^11.0.0",
    "chokidar": "^4.0.0",
    "commander": "^13.0.0",
    "express": "^5.0.0",
    "glob": "^11.0.0",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/fstubner/xtctx.git"
  },
  "license": "MIT",
  "homepage": "https://xtctx.com"
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "paths": {
      "@xtctx/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "web", "landing", "tests"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/**/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@xtctx": resolve(__dirname, "src"),
    },
  },
});
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.xtctx/.store/
*.tsbuildinfo
coverage/
.env
.env.local
```

**Step 5: Install dependencies**

Run: `npm install`
Expected: Clean install, no errors.

**Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .npmrc
git commit --no-gpg-sign -m "scaffold: initialize TypeScript project with dependencies"
```

---

### Task 1.2: Core Type Definitions

**Files:**
- Create: `src/types/context.ts`
- Create: `src/types/scraper.ts`
- Create: `src/types/compaction.ts`
- Create: `src/types/config.ts`
- Create: `src/types/index.ts`

**Step 1: Write the test for type validation helpers**

```typescript
// tests/types/context.test.ts
import { describe, it, expect } from "vitest";
import { createContextRecordId, isValidContextType } from "@xtctx/types/context";

describe("ContextRecord", () => {
  it("generates deterministic id from content + source", () => {
    const id1 = createContextRecordId("Use Vitest", "vitest is faster", "claude-code");
    const id2 = createContextRecordId("Use Vitest", "vitest is faster", "claude-code");
    const id3 = createContextRecordId("Use Jest", "jest is reliable", "cursor");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("validates context types", () => {
    expect(isValidContextType("decision")).toBe(true);
    expect(isValidContextType("error_solution")).toBe(true);
    expect(isValidContextType("insight")).toBe(true);
    expect(isValidContextType("convention")).toBe(true);
    expect(isValidContextType("gotcha")).toBe(true);
    expect(isValidContextType("random")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types/context.test.ts`
Expected: FAIL — modules not found.

**Step 3: Implement src/types/context.ts**

```typescript
import { createHash } from "node:crypto";

export const CONTEXT_TYPES = [
  "decision",
  "error_solution",
  "insight",
  "convention",
  "gotcha",
] as const;

export type ContextType = (typeof CONTEXT_TYPES)[number];

export interface ContextRecord {
  id: string;
  type: ContextType;

  created_at: string;
  supersedes?: string;
  superseded_by?: string;

  source_tool: string;
  source_session?: string;

  referenced_files: string[];
  domain_tags: string[];

  environment: {
    runtime_versions?: Record<string, string>;
    dependency_versions?: Record<string, string>;
    os?: string;
    tool_version?: string;
  };

  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export type WriteAction = "created" | "superseded" | "duplicate_rejected";

export interface WriteResult {
  action: WriteAction;
  id: string;
  existing?: ContextRecord;
  replaced?: string;
  message?: string;
}

export function createContextRecordId(
  title: string,
  body: string,
  sourceTool: string,
): string {
  const hash = createHash("sha256");
  hash.update(`${title}|${body}|${sourceTool}`);
  return hash.digest("hex").slice(0, 16);
}

export function isValidContextType(type: string): type is ContextType {
  return CONTEXT_TYPES.includes(type as ContextType);
}
```

**Step 4: Implement src/types/scraper.ts**

```typescript
export interface ChunkMetadata {
  messageIndex: number;
  tokenEstimate?: number;
  referencedFiles?: string[];
}

export interface ConversationChunk {
  tool: string;
  sessionId: string;
  timestamp: Date;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: ChunkMetadata;
}

export interface ScraperState {
  lastTimestamp: Date;
  lastOffset?: number;
  lastRowId?: number;
  checksum?: string;
}

export interface ConversationScraper<
  T extends ConversationChunk = ConversationChunk,
> {
  readonly tool: string;
  detect(): Promise<boolean>;
  getStorePaths(): string[];
  scrape(since?: Date): AsyncIterable<T>;
  fullSync(): AsyncIterable<T>;
  parseRaw(raw: unknown): T;
  getLastScrapedPosition(): Promise<ScraperState>;
  saveScrapedPosition(state: ScraperState): Promise<void>;
}

// --- Tool-specific chunk extensions ---

export interface ClaudeCodeChunk extends ConversationChunk {
  tool: "claude-code";
  metadata: ChunkMetadata & {
    toolCalls?: string[];
    costUsd?: number;
    sessionType: "interactive" | "headless";
    permissionMode?: string;
  };
}

export interface CursorChunk extends ConversationChunk {
  tool: "cursor";
  metadata: ChunkMetadata & {
    composerMode: "normal" | "agent";
    model: string;
    tabContext?: string[];
    codebaseSearchResults?: number;
  };
}

export interface CodexChunk extends ConversationChunk {
  tool: "codex";
  metadata: ChunkMetadata & {
    approvalMode: "suggest" | "auto-edit" | "full-auto";
    sandboxed: boolean;
  };
}
```

**Step 5: Implement src/types/compaction.ts**

```typescript
export interface CompactedSession {
  sessionId: string;
  tool: string;
  timeRange: { start: string; end: string };

  summary: string;
  tasksCompleted: string[];
  decisionsIdentified: string[];
  filesModified: string[];
  openQuestions: string[];

  chunkRefs: string[];
  chunkCount: number;
  estimatedTokens: number;
}

export interface CompactionConfig {
  strategy: "rule-based" | "llm-assisted";
  sessionBoundaryMinutes: number;
  llm?: {
    provider: "cli" | "ollama" | "openai";
    command?: string;
    args?: string[];
    model?: string;
    endpoint?: string;
    apiKeyEnv?: string;
  };
}
```

**Step 6: Implement src/types/config.ts**

```typescript
import type { CompactionConfig } from "./compaction.js";

export interface XtctxConfig {
  version: string;
  project: {
    name: string;
    root: string;
  };
  ingestion: {
    scrapers: ScraperConfig[];
    watchPaths: string[];
    pollIntervalMs: number;
    excludePatterns: string[];
  };
  compaction: CompactionConfig;
  search: {
    defaultMode: "hybrid" | "semantic" | "keyword";
    defaultDepth: "summary" | "detail" | "raw";
    defaultLimit: number;
  };
  domainTags: Record<string, string[]>;
  web: {
    port: number;
  };
}

export interface ScraperConfig {
  tool: string;
  enabled: boolean;
  customStorePath?: string;
}

export interface ToolSyncConfig {
  skills: string[];
  commands: string[];
  agents: string[];
  preferences: Record<string, unknown>;
}
```

**Step 7: Create src/types/index.ts barrel export**

```typescript
export * from "./context.js";
export * from "./scraper.js";
export * from "./compaction.js";
export * from "./config.js";
```

**Step 8: Run tests**

Run: `npx vitest run tests/types/context.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add src/types/ tests/types/
git commit --no-gpg-sign -m "feat: add core type definitions"
```

---

## Phase 2: Vector Store & Search

### Task 2.1: LanceDB Wrapper

**Files:**
- Create: `src/store/lance.ts`
- Test: `tests/store/lance.test.ts`

**Step 1: Write failing test**

```typescript
// tests/store/lance.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceStore } from "@xtctx/store/lance";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LanceStore", () => {
  let store: LanceStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-test-"));
    store = new LanceStore(tempDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores and retrieves vectors", async () => {
    await store.upsert("test-table", [
      {
        id: "rec-1",
        text: "Use Vitest for testing",
        vector: new Array(384).fill(0.1),
        metadata: JSON.stringify({ type: "decision" }),
      },
    ]);

    const results = await store.vectorSearch(
      "test-table",
      new Array(384).fill(0.1),
      5,
    );
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("rec-1");
  });

  it("performs full-text search", async () => {
    await store.upsert("test-table", [
      {
        id: "rec-1",
        text: "ECONNREFUSED port 5432 postgres",
        vector: new Array(384).fill(0.1),
        metadata: JSON.stringify({ type: "error_solution" }),
      },
      {
        id: "rec-2",
        text: "Use Vitest for testing",
        vector: new Array(384).fill(0.2),
        metadata: JSON.stringify({ type: "decision" }),
      },
    ]);

    const results = await store.ftsSearch("test-table", "ECONNREFUSED", 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("rec-1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/lance.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement LanceDB wrapper**

```typescript
// src/store/lance.ts
import * as lancedb from "@lancedb/lancedb";

export interface VectorRecord {
  id: string;
  text: string;
  vector: number[];
  metadata: string; // JSON string
}

export interface SearchResult {
  id: string;
  text: string;
  metadata: string;
  score: number;
}

export class LanceStore {
  private db: lancedb.Connection | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
  }

  async upsert(tableName: string, records: VectorRecord[]): Promise<void> {
    if (!this.db) throw new Error("Store not initialized");

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(tableName)) {
      const table = await this.db.openTable(tableName);
      await table.add(records);
    } else {
      await this.db.createTable(tableName, records);
    }
  }

  async vectorSearch(
    tableName: string,
    queryVector: number[],
    limit: number,
  ): Promise<SearchResult[]> {
    if (!this.db) throw new Error("Store not initialized");

    const table = await this.db.openTable(tableName);
    const results = await table
      .vectorSearch(queryVector)
      .limit(limit)
      .toArray();

    return results.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      metadata: r.metadata as string,
      score: r._distance != null ? 1 / (1 + r._distance) : 0,
    }));
  }

  async ftsSearch(
    tableName: string,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    if (!this.db) throw new Error("Store not initialized");

    const table = await this.db.openTable(tableName);

    // Create FTS index if not exists (LanceDB handles this idempotently)
    try {
      await table.createIndex("text", { config: lancedb.Index.fts() });
    } catch {
      // Index already exists
    }

    const results = await table
      .search(query, "text")
      .limit(limit)
      .toArray();

    return results.map((r, i) => ({
      id: r.id as string,
      text: r.text as string,
      metadata: r.metadata as string,
      score: 1 / (1 + i), // rank-based score for FTS
    }));
  }

  async tableExists(tableName: string): Promise<boolean> {
    if (!this.db) throw new Error("Store not initialized");
    const names = await this.db.tableNames();
    return names.includes(tableName);
  }

  async deleteTable(tableName: string): Promise<void> {
    if (!this.db) throw new Error("Store not initialized");
    await this.db.dropTable(tableName);
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/store/lance.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/store/lance.ts tests/store/lance.test.ts
git commit --no-gpg-sign -m "feat: add LanceDB vector store wrapper"
```

---

### Task 2.2: Embedding Service

**Files:**
- Create: `src/store/embeddings.ts`
- Test: `tests/store/embeddings.test.ts`

Embeddings are needed for vector search. For v1, use a lightweight local approach (no API dependency). The `@xenova/transformers` package provides local ONNX-based embeddings.

**Step 1: Add dependency**

Run: `npm install @xenova/transformers`

**Step 2: Write failing test**

```typescript
// tests/store/embeddings.test.ts
import { describe, it, expect } from "vitest";
import { EmbeddingService } from "@xtctx/store/embeddings";

describe("EmbeddingService", () => {
  it("generates embeddings of consistent dimension", async () => {
    const service = new EmbeddingService();
    await service.initialize();

    const embedding = await service.embed("Use Vitest for testing");
    expect(embedding.length).toBeGreaterThan(0);
    expect(embedding.every((v) => typeof v === "number")).toBe(true);
  });

  it("generates similar embeddings for similar text", async () => {
    const service = new EmbeddingService();
    await service.initialize();

    const e1 = await service.embed("postgres database connection error");
    const e2 = await service.embed("postgresql db connection failure");
    const e3 = await service.embed("how to bake a chocolate cake");

    const sim12 = cosineSimilarity(e1, e2);
    const sim13 = cosineSimilarity(e1, e3);

    expect(sim12).toBeGreaterThan(sim13);
  }, 30_000);
});

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}
```

**Step 3: Implement embedding service**

```typescript
// src/store/embeddings.ts
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export class EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private dimension = 384;

  async initialize(): Promise<void> {
    this.extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) throw new Error("EmbeddingService not initialized");

    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  getDimension(): number {
    return this.dimension;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/store/embeddings.test.ts`
Expected: PASS (first run may be slow due to model download)

**Step 5: Commit**

```bash
git add src/store/embeddings.ts tests/store/embeddings.test.ts
git commit --no-gpg-sign -m "feat: add local embedding service using MiniLM"
```

---

### Task 2.3: Hybrid Search with RRF

**Files:**
- Create: `src/store/search.ts`
- Test: `tests/store/search.test.ts`

**Step 1: Write failing test**

```typescript
// tests/store/search.test.ts
import { describe, it, expect } from "vitest";
import { fuseResults, type RankedResult } from "@xtctx/store/search";

describe("fuseResults (RRF)", () => {
  it("ranks items appearing in both lists higher", () => {
    const vectorResults: RankedResult[] = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.7 },
      { id: "c", score: 0.5 },
    ];
    const bm25Results: RankedResult[] = [
      { id: "b", score: 0.95 },
      { id: "d", score: 0.8 },
      { id: "a", score: 0.6 },
    ];

    const fused = fuseResults(vectorResults, bm25Results);

    // "a" and "b" appear in both lists, should rank highest
    expect(fused[0].id).toBe("b"); // rank 2 in vector + rank 1 in bm25
    expect(fused[1].id).toBe("a"); // rank 1 in vector + rank 3 in bm25
    expect(fused.length).toBe(4);  // a, b, c, d
  });

  it("returns empty for empty inputs", () => {
    expect(fuseResults([], [])).toEqual([]);
  });
});
```

**Step 2: Implement RRF and hybrid search**

```typescript
// src/store/search.ts
import type { LanceStore, SearchResult } from "./lance.js";
import type { EmbeddingService } from "./embeddings.js";

export interface RankedResult {
  id: string;
  score: number;
}

export interface HybridSearchResult extends SearchResult {
  fusedScore: number;
}

export type SearchMode = "hybrid" | "semantic" | "keyword";

export function fuseResults(
  vectorResults: RankedResult[],
  bm25Results: RankedResult[],
  k = 60,
): RankedResult[] {
  const scores = new Map<string, number>();

  for (const [rank, r] of vectorResults.entries()) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
  }
  for (const [rank, r] of bm25Results.entries()) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export class HybridSearch {
  constructor(
    private store: LanceStore,
    private embeddings: EmbeddingService,
  ) {}

  async search(
    tableName: string,
    query: string,
    mode: SearchMode,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    if (mode === "keyword") {
      const results = await this.store.ftsSearch(tableName, query, limit);
      return results.map((r) => ({ ...r, fusedScore: r.score }));
    }

    if (mode === "semantic") {
      const vector = await this.embeddings.embed(query);
      const results = await this.store.vectorSearch(tableName, vector, limit);
      return results.map((r) => ({ ...r, fusedScore: r.score }));
    }

    // Hybrid: run both, fuse with RRF
    const vector = await this.embeddings.embed(query);
    const [vectorResults, ftsResults] = await Promise.all([
      this.store.vectorSearch(tableName, vector, limit * 2),
      this.store.ftsSearch(tableName, query, limit * 2),
    ]);

    const fused = fuseResults(
      vectorResults.map((r) => ({ id: r.id, score: r.score })),
      ftsResults.map((r) => ({ id: r.id, score: r.score })),
    );

    // Enrich fused results with full data from the higher-scoring source
    const allResults = new Map<string, SearchResult>();
    for (const r of [...vectorResults, ...ftsResults]) {
      if (!allResults.has(r.id)) allResults.set(r.id, r);
    }

    return fused
      .slice(0, limit)
      .map((f) => {
        const full = allResults.get(f.id)!;
        return { ...full, fusedScore: f.score };
      })
      .filter(Boolean);
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/store/search.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/store/search.ts tests/store/search.test.ts
git commit --no-gpg-sign -m "feat: add hybrid search with reciprocal rank fusion"
```

---

## Phase 3: Knowledge Store

### Task 3.1: Knowledge Repository (file I/O)

**Files:**
- Create: `src/knowledge/repository.ts`
- Test: `tests/knowledge/repository.test.ts`

Reads/writes ContextRecord YAML files in `.xtctx/knowledge/`.

**Step 1: Write failing test**

```typescript
// tests/knowledge/repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeRepository } from "@xtctx/knowledge/repository";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("KnowledgeRepository", () => {
  let repo: KnowledgeRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-knowledge-"));
    repo = new KnowledgeRepository(tempDir);
    await repo.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("saves and retrieves a decision", async () => {
    const record = {
      id: "abc123",
      type: "decision" as const,
      created_at: new Date().toISOString(),
      source_tool: "claude-code",
      referenced_files: ["vitest.config.ts"],
      domain_tags: ["testing"],
      environment: {},
      title: "Use Vitest over Jest",
      body: "Vitest has native ESM support and is faster for Vite projects.",
    };

    await repo.save(record);
    const retrieved = await repo.getById("abc123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Use Vitest over Jest");
  });

  it("lists records by type", async () => {
    await repo.save({
      id: "d1", type: "decision" as const, created_at: new Date().toISOString(),
      source_tool: "claude-code", referenced_files: [], domain_tags: [],
      environment: {}, title: "Decision 1", body: "Body 1",
    });
    await repo.save({
      id: "e1", type: "error_solution" as const, created_at: new Date().toISOString(),
      source_tool: "cursor", referenced_files: [], domain_tags: [],
      environment: {}, title: "Error 1", body: "Solution 1",
    });

    const decisions = await repo.listByType("decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].id).toBe("d1");
  });

  it("updates supersession chain", async () => {
    await repo.save({
      id: "old", type: "decision" as const, created_at: "2026-01-01T00:00:00Z",
      source_tool: "claude-code", referenced_files: [], domain_tags: [],
      environment: {}, title: "Old decision", body: "Original",
    });
    await repo.supersede("old", "new");

    const old = await repo.getById("old");
    expect(old!.superseded_by).toBe("new");
  });
});
```

**Step 2: Implement repository (reads/writes YAML files)**

```typescript
// src/knowledge/repository.ts
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ContextRecord, ContextType } from "../types/context.js";

const TYPE_DIRS: Record<ContextType, string> = {
  decision: "decisions",
  error_solution: "errors",
  insight: "insights",
  convention: "conventions",
  gotcha: "gotchas",
};

export class KnowledgeRepository {
  constructor(private readonly knowledgeDir: string) {}

  async initialize(): Promise<void> {
    for (const dir of Object.values(TYPE_DIRS)) {
      await mkdir(join(this.knowledgeDir, dir), { recursive: true });
    }
  }

  async save(record: ContextRecord): Promise<void> {
    const dir = TYPE_DIRS[record.type];
    const filePath = join(this.knowledgeDir, dir, `${record.id}.yaml`);
    await writeFile(filePath, stringifyYaml(record), "utf-8");
  }

  async getById(id: string): Promise<ContextRecord | null> {
    for (const dir of Object.values(TYPE_DIRS)) {
      const filePath = join(this.knowledgeDir, dir, `${id}.yaml`);
      try {
        const content = await readFile(filePath, "utf-8");
        return parseYaml(content) as ContextRecord;
      } catch {
        continue;
      }
    }
    return null;
  }

  async listByType(type: ContextType): Promise<ContextRecord[]> {
    const dir = TYPE_DIRS[type];
    const dirPath = join(this.knowledgeDir, dir);
    try {
      const files = await readdir(dirPath);
      const records: ContextRecord[] = [];
      for (const file of files) {
        if (!file.endsWith(".yaml")) continue;
        const content = await readFile(join(dirPath, file), "utf-8");
        records.push(parseYaml(content) as ContextRecord);
      }
      return records.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    } catch {
      return [];
    }
  }

  async listAll(): Promise<ContextRecord[]> {
    const all: ContextRecord[] = [];
    for (const type of Object.keys(TYPE_DIRS) as ContextType[]) {
      all.push(...(await this.listByType(type)));
    }
    return all.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    const old = await this.getById(oldId);
    if (old) {
      old.superseded_by = newId;
      await this.save(old);
    }
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/knowledge/repository.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/knowledge/repository.ts tests/knowledge/repository.test.ts
git commit --no-gpg-sign -m "feat: add knowledge repository with YAML file persistence"
```

---

### Task 3.2: Auto-Tagging Pipeline

**Files:**
- Create: `src/knowledge/autotag.ts`
- Test: `tests/knowledge/autotag.test.ts`

**Step 1: Write failing test**

```typescript
// tests/knowledge/autotag.test.ts
import { describe, it, expect } from "vitest";
import { extractFileReferences, classifyDomains } from "@xtctx/knowledge/autotag";

describe("autotag", () => {
  it("extracts file references from text", () => {
    const text = "I modified src/utils/hash.ts and vitest.config.ts to fix the issue";
    const repoFiles = ["src/utils/hash.ts", "vitest.config.ts", "package.json"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toContain("src/utils/hash.ts");
    expect(refs).toContain("vitest.config.ts");
    expect(refs).not.toContain("package.json");
  });

  it("classifies domains from content", () => {
    const defaultMap = {
      cicd: ["github actions", "ci/cd", "pipeline", "workflow", "deploy"],
      database: ["postgres", "mysql", "sqlite", "migration", "schema"],
      testing: ["test", "vitest", "jest", "spec", "assert"],
    };

    const tags = classifyDomains(
      "Fixed the GitHub Actions workflow for running vitest tests",
      defaultMap,
    );
    expect(tags).toContain("cicd");
    expect(tags).toContain("testing");
    expect(tags).not.toContain("database");
  });
});
```

**Step 2: Implement auto-tagging**

```typescript
// src/knowledge/autotag.ts
export function extractFileReferences(
  text: string,
  repoFiles: string[],
): string[] {
  const found: string[] = [];
  for (const file of repoFiles) {
    // Match the filename itself or any path suffix
    const basename = file.split("/").pop()!;
    if (text.includes(file) || text.includes(basename)) {
      found.push(file);
    }
  }
  return [...new Set(found)];
}

export function classifyDomains(
  text: string,
  domainKeywords: Record<string, string[]>,
): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      matched.push(domain);
    }
  }

  return matched;
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/knowledge/autotag.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/knowledge/autotag.ts tests/knowledge/autotag.test.ts
git commit --no-gpg-sign -m "feat: add auto-tagging for file references and domain classification"
```

---

### Task 3.3: Deduplication & Supercession

**Files:**
- Create: `src/knowledge/dedup.ts`
- Test: `tests/knowledge/dedup.test.ts`

**Step 1: Write failing test**

```typescript
// tests/knowledge/dedup.test.ts
import { describe, it, expect } from "vitest";
import { checkDuplicate, DuplicateCheckResult } from "@xtctx/knowledge/dedup";

describe("dedup", () => {
  it("detects near-duplicates (score > 0.95)", () => {
    const result = checkDuplicate(0.97, "existing-id");
    expect(result.action).toBe("duplicate_rejected");
    expect(result.existingId).toBe("existing-id");
  });

  it("detects supersession (score 0.85-0.95)", () => {
    const result = checkDuplicate(0.90, "old-id");
    expect(result.action).toBe("superseded");
    expect(result.existingId).toBe("old-id");
  });

  it("allows new records (score < 0.85)", () => {
    const result = checkDuplicate(0.70, "other-id");
    expect(result.action).toBe("created");
  });

  it("allows new records when no similar found", () => {
    const result = checkDuplicate(0, null);
    expect(result.action).toBe("created");
  });
});
```

**Step 2: Implement deduplication logic**

```typescript
// src/knowledge/dedup.ts
import type { WriteAction } from "../types/context.js";

export interface DuplicateCheckResult {
  action: WriteAction;
  existingId: string | null;
}

const DUPLICATE_THRESHOLD = 0.95;
const SUPERSEDE_THRESHOLD = 0.85;

export function checkDuplicate(
  bestSimilarity: number,
  bestMatchId: string | null,
): DuplicateCheckResult {
  if (!bestMatchId || bestSimilarity === 0) {
    return { action: "created", existingId: null };
  }

  if (bestSimilarity > DUPLICATE_THRESHOLD) {
    return { action: "duplicate_rejected", existingId: bestMatchId };
  }

  if (bestSimilarity > SUPERSEDE_THRESHOLD) {
    return { action: "superseded", existingId: bestMatchId };
  }

  return { action: "created", existingId: null };
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/knowledge/dedup.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/knowledge/dedup.ts tests/knowledge/dedup.test.ts
git commit --no-gpg-sign -m "feat: add deduplication with similarity-based supercession"
```

---

## Phase 4: Scraper Framework + First Scraper

### Task 4.1: Scraper Registry

**Files:**
- Create: `src/scrapers/registry.ts`
- Create: `src/scrapers/base.ts`
- Test: `tests/scrapers/registry.test.ts`

**Step 1: Write failing test**

```typescript
// tests/scrapers/registry.test.ts
import { describe, it, expect } from "vitest";
import { ScraperRegistry } from "@xtctx/scrapers/registry";
import type { ConversationScraper, ConversationChunk } from "@xtctx/types/scraper";

class MockScraper implements ConversationScraper {
  readonly tool = "mock-tool";
  async detect() { return true; }
  getStorePaths() { return ["/tmp/mock"]; }
  async *scrape() { /* empty */ }
  async *fullSync() { /* empty */ }
  parseRaw(raw: unknown) { return raw as ConversationChunk; }
  async getLastScrapedPosition() { return { lastTimestamp: new Date() }; }
  async saveScrapedPosition() { /* noop */ }
}

describe("ScraperRegistry", () => {
  it("registers and retrieves scrapers", () => {
    const registry = new ScraperRegistry();
    registry.register(new MockScraper());
    expect(registry.get("mock-tool")).toBeDefined();
    expect(registry.getAll()).toHaveLength(1);
  });

  it("detects available scrapers", async () => {
    const registry = new ScraperRegistry();
    registry.register(new MockScraper());
    const available = await registry.detectAvailable();
    expect(available).toHaveLength(1);
    expect(available[0].tool).toBe("mock-tool");
  });
});
```

**Step 2: Implement registry**

```typescript
// src/scrapers/registry.ts
import type { ConversationScraper, ConversationChunk } from "../types/scraper.js";

export class ScraperRegistry {
  private scrapers = new Map<string, ConversationScraper>();

  register<T extends ConversationChunk>(scraper: ConversationScraper<T>): void {
    this.scrapers.set(scraper.tool, scraper as ConversationScraper);
  }

  get(tool: string): ConversationScraper | undefined {
    return this.scrapers.get(tool);
  }

  getAll(): ConversationScraper[] {
    return [...this.scrapers.values()];
  }

  async detectAvailable(): Promise<ConversationScraper[]> {
    const results: ConversationScraper[] = [];
    for (const scraper of this.scrapers.values()) {
      if (await scraper.detect()) {
        results.push(scraper);
      }
    }
    return results;
  }
}
```

**Step 3: Implement base scraper utilities**

```typescript
// src/scrapers/base.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ScraperState } from "../types/scraper.js";

export class ScraperStateManager {
  constructor(private readonly stateDir: string) {}

  async load(tool: string): Promise<ScraperState> {
    const path = this.statePath(tool);
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw);
      return { ...data, lastTimestamp: new Date(data.lastTimestamp) };
    } catch {
      return { lastTimestamp: new Date(0) };
    }
  }

  async save(tool: string, state: ScraperState): Promise<void> {
    const path = this.statePath(tool);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
  }

  private statePath(tool: string): string {
    return join(this.stateDir, `${tool}-state.json`);
  }
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/scrapers/registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/scrapers/registry.ts src/scrapers/base.ts tests/scrapers/registry.test.ts
git commit --no-gpg-sign -m "feat: add scraper registry and state management"
```

---

### Task 4.2: Claude Code Scraper

**Files:**
- Create: `src/scrapers/claude-code.ts`
- Test: `tests/scrapers/claude-code.test.ts`
- Create: `tests/fixtures/claude-code/` (sample JSONL data)

Claude Code stores sessions in `~/.claude/projects/<hash>/` as JSONL files. Each line is a JSON object with `type`, `role`, `content`, etc.

**Step 1: Create test fixture**

```typescript
// tests/fixtures/claude-code/sample-session.jsonl
// (This is a data file, create it with Write tool)
```

Contents for the fixture file (one JSON object per line):

```jsonl
{"type":"human","content":"Help me set up vitest","timestamp":"2026-02-24T10:00:00Z"}
{"type":"assistant","content":"I'll help you set up vitest. Let me create the config file.","timestamp":"2026-02-24T10:00:05Z"}
{"type":"tool_use","name":"Write","content":"vitest.config.ts","timestamp":"2026-02-24T10:00:10Z"}
{"type":"assistant","content":"Done! I've created vitest.config.ts with ESM support.","timestamp":"2026-02-24T10:00:15Z"}
```

**Step 2: Write failing test**

```typescript
// tests/scrapers/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

describe("ClaudeCodeScraper", () => {
  let scraper: ClaudeCodeScraper;
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-claude-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    const projectDir = join(tempDir, "abc123");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session-001.jsonl"),
      [
        '{"type":"human","content":"Help me set up vitest","timestamp":"2026-02-24T10:00:00Z"}',
        '{"type":"assistant","content":"I\'ll create the config.","timestamp":"2026-02-24T10:00:05Z"}',
      ].join("\n") + "\n",
    );
    scraper = new ClaudeCodeScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects claude code installation", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("scrapes conversation chunks from JSONL", async () => {
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("Help me set up vitest");
    expect(chunks[1].role).toBe("assistant");
  });

  it("maps claude types to standard roles", async () => {
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }
    // "human" -> "user", "assistant" -> "assistant"
    expect(chunks[0].role).toBe("user");
    expect(chunks[1].role).toBe("assistant");
  });
});
```

**Step 3: Implement Claude Code scraper**

```typescript
// src/scrapers/claude-code.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  ConversationScraper,
  ClaudeCodeChunk,
  ScraperState,
  ChunkMetadata,
} from "../types/scraper.js";
import { ScraperStateManager, estimateTokens } from "./base.js";

const ROLE_MAP: Record<string, ClaudeCodeChunk["role"]> = {
  human: "user",
  assistant: "assistant",
  system: "system",
  tool_use: "tool",
  tool_result: "tool",
};

export class ClaudeCodeScraper implements ConversationScraper<ClaudeCodeChunk> {
  readonly tool = "claude-code";
  private stateManager: ScraperStateManager;

  constructor(
    private readonly claudeProjectsDir: string,
    stateDir: string,
  ) {
    this.stateManager = new ScraperStateManager(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const s = await stat(this.claudeProjectsDir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.claudeProjectsDir];
  }

  async *scrape(since?: Date): AsyncIterable<ClaudeCodeChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<ClaudeCodeChunk> {
    yield* this.readAllSessions(new Date(0));
  }

  parseRaw(raw: unknown): ClaudeCodeChunk {
    const obj = raw as Record<string, unknown>;
    const timestamp = new Date((obj.timestamp as string) || Date.now());
    const content = (obj.content as string) || "";
    const type = (obj.type as string) || "unknown";

    return {
      tool: "claude-code",
      sessionId: (obj.sessionId as string) || "unknown",
      timestamp,
      role: ROLE_MAP[type] || "system",
      content,
      metadata: {
        messageIndex: (obj.messageIndex as number) || 0,
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        toolCalls: type === "tool_use" ? [(obj.name as string) || ""] : undefined,
        costUsd: obj.costUsd as number | undefined,
        sessionType: "interactive",
      } as ClaudeCodeChunk["metadata"],
    };
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    return this.stateManager.save(this.tool, state);
  }

  private async *readAllSessions(
    since: Date,
  ): AsyncIterable<ClaudeCodeChunk> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.claudeProjectsDir);
    } catch {
      return;
    }

    for (const projectHash of projectDirs) {
      const projectDir = join(this.claudeProjectsDir, projectHash);
      let files: string[];
      try {
        files = await readdir(projectDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.replace(".jsonl", "");
        const filePath = join(projectDir, file);

        let messageIndex = 0;
        const rl = createInterface({
          input: createReadStream(filePath, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const timestamp = new Date(obj.timestamp || 0);
            if (timestamp <= since) {
              messageIndex++;
              continue;
            }
            obj.sessionId = sessionId;
            obj.messageIndex = messageIndex++;
            yield this.parseRaw(obj);
          } catch {
            // Skip malformed lines
          }
        }
      }
    }
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/scrapers/claude-code.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/scrapers/claude-code.ts tests/scrapers/claude-code.test.ts
git commit --no-gpg-sign -m "feat: add Claude Code conversation scraper"
```

---

## Phase 5: MCP Server

### Task 5.1: MCP Server Scaffold + Search Tool

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools/search.ts`
- Test: `tests/mcp/server.test.ts`

**Step 1: Write failing test**

```typescript
// tests/mcp/server.test.ts
import { describe, it, expect } from "vitest";
import { buildToolDefinitions } from "@xtctx/mcp/server";

describe("MCP Server", () => {
  it("exposes all expected tools", () => {
    const tools = buildToolDefinitions();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("xtctx_search");
    expect(toolNames).toContain("xtctx_recent_sessions");
    expect(toolNames).toContain("xtctx_session_detail");
    expect(toolNames).toContain("xtctx_project_knowledge");
    expect(toolNames).toContain("xtctx_save_decision");
    expect(toolNames).toContain("xtctx_save_error_solution");
    expect(toolNames).toContain("xtctx_save_insight");
    expect(toolNames).toContain("xtctx_list_configs");
    expect(toolNames).toContain("xtctx_get_config");
    expect(toolNames).toContain("xtctx_tool_preferences");
  });

  it("xtctx_search has correct parameter schema", () => {
    const tools = buildToolDefinitions();
    const search = tools.find((t) => t.name === "xtctx_search")!;
    const props = search.inputSchema.properties as Record<string, unknown>;

    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("depth");
    expect(props).toHaveProperty("format");
  });
});
```

**Step 2: Implement MCP server with tool definitions**

```typescript
// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function buildToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "xtctx_search",
      description:
        "Search across all indexed context (conversations, code changes, knowledge). " +
        "Supports hybrid (semantic + keyword), semantic-only, or keyword-only modes. " +
        "Start with depth 'summary' and drill deeper if needed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description: "Search mode. Default: hybrid",
          },
          depth: {
            type: "string",
            enum: ["summary", "detail", "raw"],
            description: "Result depth. Start with summary. Default: summary",
          },
          source_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by source tool, e.g. ['claude-code', 'cursor']",
          },
          type_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by type: decision, error_solution, insight",
          },
          time_range: {
            type: "object",
            properties: {
              after: { type: "string", description: "ISO 8601 date" },
              before: { type: "string", description: "ISO 8601 date" },
            },
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
          limit: {
            type: "number",
            description: "Max results. Default: 10",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "xtctx_recent_sessions",
      description:
        "CALL THIS FIRST when starting any session. Returns recent work " +
        "across all AI tools so you can continue where the last session left off.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max sessions. Default: 3" },
          tool_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tool name",
          },
        },
      },
    },
    {
      name: "xtctx_session_detail",
      description: "Drill into a specific session's raw conversation data.",
      inputSchema: {
        type: "object",
        properties: {
          session_ref: { type: "string", description: "Session reference from search results" },
          offset: { type: "number", description: "Message offset for pagination" },
          limit: { type: "number", description: "Max messages to return" },
        },
        required: ["session_ref"],
      },
    },
    {
      name: "xtctx_project_knowledge",
      description:
        "Get shared project knowledge (architectural decisions, error solutions, insights).",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "error_solution", "insight", "all"],
            description: "Filter by type. Default: all",
          },
          query: { type: "string", description: "Optional semantic filter" },
        },
      },
    },
    {
      name: "xtctx_save_decision",
      description:
        "Record an architectural or design decision with rationale. " +
        "Auto-enriched with file refs, domain tags, and version context. " +
        "Deduplication prevents near-duplicate entries.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short decision title" },
          rationale: { type: "string", description: "Why this was decided" },
          context: { type: "string", description: "What led to this decision" },
          alternatives_considered: {
            type: "array",
            items: { type: "string" },
            description: "Other options that were considered",
          },
        },
        required: ["title", "rationale"],
      },
    },
    {
      name: "xtctx_save_error_solution",
      description:
        "Record an error and its solution for future reference. " +
        "Auto-enriched with environment versions and domain tags.",
      inputSchema: {
        type: "object",
        properties: {
          error: { type: "string", description: "The error message or pattern" },
          solution: { type: "string", description: "What fixed it" },
          context: { type: "string", description: "When/why this occurs" },
        },
        required: ["error", "solution"],
      },
    },
    {
      name: "xtctx_save_insight",
      description:
        "Record a project insight, convention, or gotcha. " +
        "Use for things a future session should know.",
      inputSchema: {
        type: "object",
        properties: {
          insight: { type: "string", description: "The insight" },
          context: { type: "string", description: "Supporting context" },
        },
        required: ["insight"],
      },
    },
    {
      name: "xtctx_list_configs",
      description: "List available portable skills, commands, and agent definitions.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["skill", "command", "agent", "all"],
            description: "Filter by config type. Default: all",
          },
        },
      },
    },
    {
      name: "xtctx_get_config",
      description: "Get a specific skill, command, or agent definition.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["skill", "command", "agent"] },
          name: { type: "string", description: "Config name" },
        },
        required: ["type", "name"],
      },
    },
    {
      name: "xtctx_tool_preferences",
      description: "Get tool-specific preferences and settings from cross-tool config.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Tool name, e.g. claude-code" },
        },
        required: ["tool"],
      },
    },
  ];
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "xtctx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const tools = buildToolDefinitions();

  server.setRequestHandler("tools/list" as any, async () => ({
    tools,
  }));

  server.setRequestHandler("tools/call" as any, async (request: any) => {
    const { name, arguments: args } = request.params;
    // Tool handlers will be wired in Phase 5 tasks
    return {
      content: [{ type: "text", text: `Tool ${name} called with ${JSON.stringify(args)}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit --no-gpg-sign -m "feat: add MCP server scaffold with all tool definitions"
```

---

### Task 5.2: Wire MCP Tool Handlers

**Files:**
- Create: `src/mcp/tools/search.ts`
- Create: `src/mcp/tools/sessions.ts`
- Create: `src/mcp/tools/knowledge.ts`
- Create: `src/mcp/tools/write.ts`
- Create: `src/mcp/tools/config.ts`
- Modify: `src/mcp/server.ts` — wire handlers

Each tool handler file exports a function that takes dependencies (store, knowledge repo, etc.) and returns the handler. Tests for these will be integration-level (Phase 8). For now, implement the handler logic.

**Implement each handler following this pattern:**

```typescript
// src/mcp/tools/search.ts
import type { HybridSearch, SearchMode } from "../../store/search.js";

interface SearchParams {
  query: string;
  mode?: SearchMode;
  depth?: "summary" | "detail" | "raw";
  source_filter?: string[];
  type_filter?: string[];
  time_range?: { after?: string; before?: string };
  format?: "markdown" | "json";
  limit?: number;
}

export function createSearchHandler(search: HybridSearch) {
  return async (params: SearchParams) => {
    const mode = params.mode ?? "hybrid";
    const depth = params.depth ?? "summary";
    const format = params.format ?? "markdown";
    const limit = params.limit ?? 10;

    const results = await search.search("context", params.query, mode, limit);

    // TODO: apply source_filter, type_filter, time_range post-search
    // TODO: format results as markdown or json based on format param

    if (format === "markdown") {
      return formatAsMarkdown(results, params.query);
    }
    return { results };
  };
}

function formatAsMarkdown(results: any[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`## ${results.length} results for "${query}"\n`];
  for (const [i, r] of results.entries()) {
    const meta = JSON.parse(r.metadata || "{}");
    lines.push(`### ${i + 1}. ${meta.title || "Untitled"}`);
    lines.push(`**Source:** ${meta.source_tool || "unknown"} | **Score:** ${r.fusedScore?.toFixed(3)}\n`);
    lines.push(r.text);
    if (meta.session_ref) {
      lines.push(`\n> Session ref: \`${meta.session_ref}\``);
    }
    lines.push("\n---\n");
  }
  return lines.join("\n");
}
```

**Repeat pattern for sessions.ts, knowledge.ts, write.ts, config.ts.**

**Commit after implementing all handlers:**

```bash
git add src/mcp/tools/
git commit --no-gpg-sign -m "feat: implement MCP tool handlers"
```

---

## Phase 6: Ingestion Daemon

### Task 6.1: File Watcher + Ingestion Coordinator

**Files:**
- Create: `src/ingestion/watcher.ts`
- Create: `src/ingestion/coordinator.ts`
- Create: `src/ingestion/daemon.ts`
- Test: `tests/ingestion/coordinator.test.ts`

The coordinator runs scrapers on a configurable interval, processes new chunks, embeds them, and stores in LanceDB. The watcher triggers immediate re-scrape when source files change.

**Implement, test, commit following the same TDD pattern as above.**

---

## Phase 7: Compaction Pipeline

### Task 7.1: Rule-Based Compaction

**Files:**
- Create: `src/compaction/rule-based.ts`
- Create: `src/compaction/pipeline.ts`
- Test: `tests/compaction/rule-based.test.ts`

### Task 7.2: CLI LLM Provider

**Files:**
- Create: `src/compaction/providers/cli.ts`
- Test: `tests/compaction/providers/cli.test.ts`

---

## Phase 8: CLI

### Task 8.1: CLI Entry Points

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/serve.ts`

**`xtctx init`** — scaffolds `.xtctx/` in the current project.
**`xtctx serve`** — starts the ingestion daemon + MCP server + web UI.
**`xtctx sync`** — generates tool-native configs from `.xtctx/tool-config/`.
**`xtctx ingest`** — manual trigger for full re-sync.

---

## Phase 9: Web UI

### Task 9.1: Vue 3 + Vite Scaffold

**Files:**
- Create: `web/` directory (Vue 3 SPA)
- Create: `src/api/server.ts` (Express API server)

Run: `npm create vite@latest web -- --template vue-ts` inside project root.

### Task 9.2: Dashboard Page
### Task 9.3: Search Page
### Task 9.4: Knowledge Browser Page
### Task 9.5: Sources Page
### Task 9.6: Config Page

Each page consumes the REST API (same logic as MCP tools).

---

## Phase 10: Config Sync

### Task 10.1: Config Loader
### Task 10.2: Tool-Specific Config Generators

Generate `.cursorrules`, `CLAUDE.md` additions, `AGENTS.md` additions, `.github/copilot-instructions.md` additions from `.xtctx/tool-config/shared.yaml`.

---

## Phase 11: Agent Skill

### Task 11.1: Write xtctx-usage.md

Create `.xtctx/skills/xtctx-usage.md` with the agent instructions designed during brainstorming.

---

## Phase 12: Landing Page

### Task 12.1: Static Landing Page

Create `landing/` with a simple static page for xtctx.com:
- Hero section with tagline
- Architecture diagram
- Feature overview
- Quick start
- GitHub link

---

## Phase 13: Additional Scrapers

### Task 13.1: Cursor Scraper (SQLite)
### Task 13.2: Codex CLI Scraper (JSONL)
### Task 13.3: GitHub Copilot Scraper (JSON)
### Task 13.4: Gemini CLI Scraper (JSON)

Each follows the same pattern as the Claude Code scraper: implement `ConversationScraper<ToolChunk>`, register in the registry.

---

## Execution Order

Phases 1-5 form the **critical path** — they produce a working MCP server you can connect to from any tool. This is the MVP.

Phases 6-7 add **real-time ingestion and compaction** — turns it from manual to automatic.

Phase 8 adds the **CLI** — makes it installable and usable.

Phase 9 adds the **web UI** — browse and manage.

Phases 10-13 are **polish and breadth** — more scrapers, config sync, landing page.
