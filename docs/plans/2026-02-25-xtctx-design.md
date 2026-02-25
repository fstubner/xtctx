# xtctx — Cross-Tool Context

Design document for xtctx, an open-source local-first system that gives AI coding agents persistent, shared memory across tools.

**Repository:** `fstubner/xtctx`
**Domain:** xtctx.com
**Date:** 2026-02-25

---

## Problem Statement

Developers using multiple AI coding tools (Claude Code, Cursor, Codex, Copilot, Gemini CLI, Antigravity) lose context when switching between them. When you hit a usage limit in one tool and open another in the same project, you start from scratch. The new agent has no knowledge of what was just being worked on, what decisions were made, or what errors were encountered.

xtctx solves this by continuously indexing conversation history and code changes into a local vector store, exposed via MCP to all tools.

## Landscape

Existing tools in this space (as of February 2026):

- **ai-context-bridge** — CLI using git hooks to save/restore context across 11 tools. Not real-time, no vector search, no conversation indexing.
- **cli-continues** — One-shot session extraction and injection. Not persistent.
- **mcp-memory-keeper** — MCP server for persistent decisions/progress. Single-tool, not cross-tool.
- **Various vector MCP servers** (Qdrant, vectra-based) — General-purpose memory, none index conversation logs from coding tools.

**The gap:** None combine continuous conversation history indexing across multiple tools + local vector search + MCP exposure + browsable UI + portable config sync.

---

## Architecture Overview

### Two Pillars

| Pillar | Purpose |
|---|---|
| **Context Store** | Local vector DB continuously indexing conversation history from all AI tools + file/git changes. Queryable via MCP. |
| **Config Registry** | `.xtctx/` directory holding portable skills, commands, agent configs, and cross-tool preferences that get translated into each tool's native format. |

### System Diagram

```
+---------------------------------------------------+
|                   AI Tools                         |
|  Claude Code . Cursor . Codex . Copilot . ...     |
|         (all connect via MCP client)               |
+------------------------+--------- ----------------+
                         | MCP Protocol
+------------------------v--------------------------+
|              xtctx MCP Server                      |
|  xtctx_search . xtctx_recent_sessions             |
|  xtctx_session_detail . xtctx_project_knowledge   |
|  xtctx_save_decision . xtctx_save_error_solution  |
|  xtctx_save_insight . xtctx_list_configs          |
|  xtctx_get_config . xtctx_tool_preferences        |
+--------+--------------------------+---------------+
         |                          |
+--------v--------+       +--------v--------+
| Context Store   |       | Config Registry |
| (LanceDB)      |       | (.xtctx/)       |
+--------^--------+       +-----------------+
         |
+--------+------------------------------------------+
|           Ingestion Daemon                         |
|                                                    |
|  +--------------+  +----------------------------+  |
|  | File Watcher |  | Conversation Scrapers      |  |
|  | (chokidar)   |  | (plugin per tool)          |  |
|  | code + git   |  | claude . cursor . codex    |  |
|  +--------------+  +----------------------------+  |
|                                                    |
|  Diff-based by default . Full re-sync override     |
+----------------------------------------------------+
```

### Tech Stack

- **Runtime:** Node.js / TypeScript monorepo
- **Vector Store:** LanceDB (local-first, columnar, native hybrid search with BM25)
- **MCP Server:** Official TypeScript MCP SDK
- **Web UI:** Vue 3 + Vite
- **File Watching:** chokidar
- **Ingestion:** Plugin adapter per tool
- **Config directory:** `.xtctx/` at project root

---

## Directory Structure

### Project-level `.xtctx/`

```
.xtctx/
+-- config.yaml              # committed - project config
+-- skills/                   # committed - portable skills
+-- commands/                 # committed - portable commands
+-- agents/                   # committed - agent definitions
+-- knowledge/                # committed - SHARED project knowledge
|   +-- decisions/            #   architectural decisions + rationale
|   +-- errors/               #   errors + solutions
|   +-- insights/             #   project insights
+-- tool-config/              # committed - cross-tool settings
|   +-- shared.yaml           #   which skills/settings to sync
|   +-- mappings/             #   tool-specific config generation templates
+-- .store/                   # gitignored - local only
    +-- vectors/              #   LanceDB data
    +-- conversations/        #   raw scraped conversations
    +-- compactions/          #   compacted summaries with refs
    +-- state.json            #   ingestion state tracking
```

The `knowledge/` directory is the shared gold — committed to git, benefits all team members. The `.store/` is local-only raw data and vector indices.

---

## Data Model

### Context Record (shared knowledge layer)

Every write to the knowledge layer gets a standard envelope with auto-enrichment:

```typescript
interface ContextRecord {
  // Identity
  id: string                      // deterministic hash of content + source
  type: "decision" | "error_solution" | "insight" | "convention" | "gotcha"

  // Temporal
  created_at: string              // ISO 8601
  supersedes?: string             // id of record this replaces
  superseded_by?: string          // id of record that replaced this

  // Source
  source_tool: string             // "claude-code", "cursor", etc.
  source_session?: string         // session ref for traceability

  // Auto-tagged context
  referenced_files: string[]      // files mentioned or modified
  domain_tags: string[]           // auto-classified: "cicd", "auth", "database", etc.

  // Version context (auto-captured from project state)
  environment: {
    runtime_versions?: Record<string, string>
    dependency_versions?: Record<string, string>
    os?: string
    tool_version?: string
  }

  // Content
  title: string
  body: string
  metadata?: Record<string, unknown>
}
```

### Auto-Tagging Pipeline

On every write, the system auto-enriches:
- **File references**: regex scan of content for paths matching repo files.
- **Domain classification**: keyword-to-domain mapping (configurable in `config.yaml`).
- **Versions**: read from `package.json`, `pyproject.toml`, `.tool-versions`, etc.
- **Timestamp**: always included for supercession tracking.

### Deduplication and Supercession

On every `xtctx_save_*` call:

1. Compute embedding of new record.
2. Search existing records of same type.
3. Three outcomes based on similarity score:
   - **> 0.95**: Near-duplicate. Reject, return existing record.
   - **0.85 - 0.95**: Similar but evolved. Supersede (new replaces old, chain preserved).
   - **< 0.85**: New. Store as new record.

The agent receives feedback: `"duplicate_rejected"`, `"superseded"`, or `"created"`.

---

## MCP Tools Schema

### Tier 1: Context Query (agents read)

**`xtctx_search`** — Hybrid semantic + keyword search across all indexed content.

```typescript
params: {
  query: string
  mode: "hybrid" | "semantic" | "keyword"  // default "hybrid"
  depth: "summary" | "detail" | "raw"      // default "summary"
  source_filter?: string[]
  type_filter?: string[]
  time_range?: { after?: string, before?: string }
  format: "markdown" | "json"              // default "markdown"
  limit?: number                           // default 10
}
```

Hybrid mode uses reciprocal rank fusion (RRF) to merge vector and BM25 results.

**`xtctx_recent_sessions`** — The "continue where we left off" tool. Call first on session start.

```typescript
params: {
  limit?: number          // default 3
  tool_filter?: string[]
}
returns: {
  sessions: [{
    tool: string
    summary: string
    last_active: string
    key_decisions: string[]
    open_tasks: string[]
    session_ref: string
  }]
}
```

**`xtctx_session_detail`** — Drill into a specific session's raw data.

```typescript
params: {
  session_ref: string
  offset?: number
  limit?: number
}
```

**`xtctx_project_knowledge`** — Shared knowledge (the committed layer).

```typescript
params: {
  type?: "decision" | "error_solution" | "insight" | "all"
  query?: string
}
```

### Tier 2: Context Write (agents contribute shared knowledge)

**`xtctx_save_decision`**

```typescript
params: {
  title: string
  rationale: string
  context?: string
  alternatives_considered?: string[]
}
```

**`xtctx_save_error_solution`**

```typescript
params: {
  error: string
  solution: string
  context?: string
}
```

**`xtctx_save_insight`**

```typescript
params: {
  insight: string
  context?: string
}
```

All write tools auto-enrich with file references, domain tags, environment versions, and timestamps. All run deduplication before storing.

### Tier 3: Config and Skills (cross-tool sync)

**`xtctx_list_configs`** — List available portable skills/commands/agents.

```typescript
params: { type?: "skill" | "command" | "agent" | "all" }
```

**`xtctx_get_config`** — Get a specific skill/command definition.

```typescript
params: { type: "skill" | "command" | "agent", name: string }
```

**`xtctx_tool_preferences`** — Get tool-specific preferences and settings.

```typescript
params: { tool: string }
```

---

## Conversation Scraper Plugin Architecture

### Base Interface

```typescript
interface ConversationChunk {
  tool: string
  sessionId: string
  timestamp: Date
  role: "user" | "assistant" | "system" | "tool"
  content: string
  metadata: ChunkMetadata
}

interface ChunkMetadata {
  messageIndex: number
  tokenEstimate?: number
  referencedFiles?: string[]
}

interface ConversationScraper<T extends ConversationChunk = ConversationChunk> {
  readonly tool: string
  detect(): Promise<boolean>
  getStorePaths(): string[]
  scrape(since?: Date): AsyncIterable<T>
  fullSync(): AsyncIterable<T>
  parseRaw(raw: unknown): T
  getLastScrapedPosition(): Promise<ScraperState>
  saveScrapedPosition(state: ScraperState): Promise<void>
}

interface ScraperState {
  lastTimestamp: Date
  lastOffset?: number
  lastRowId?: number
  checksum?: string
}
```

### Tool-Specific Extensions

Each tool extends `ConversationChunk` with tool-specific metadata:

- **CursorChunk**: `composerMode`, `model`, `tabContext`, `codebaseSearchResults`
- **ClaudeCodeChunk**: `toolCalls`, `costUsd`, `sessionType`, `permissionMode`
- **CodexChunk**: `approvalMode`, `sandboxed`
- etc.

Community contributors implement `ConversationScraper<ToolChunk>` and register it.

### Known Tool Storage Locations

| Tool | Format | Location |
|---|---|---|
| Claude Code | JSONL | `~/.claude/projects/<hash>/` |
| Cursor | SQLite | `%APPDATA%/Cursor/User/workspaceStorage/<hash>/state.vscdb` |
| Codex | JSONL | `~/.codex/history.jsonl` |
| Copilot | JSON | `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/` |
| Gemini CLI | JSON | `~/.gemini/tmp/<hash>/chats/` |
| Antigravity | Browser storage | TBD (browser-based) |

### Non-Locking Read Strategy

| Format | Strategy |
|---|---|
| JSONL (append-only) | Read from last known offset to EOF. No lock needed. |
| SQLite | Open with `SQLITE_OPEN_READONLY` in WAL mode. Concurrent readers allowed. |
| JSON files | Atomic read of file snapshot. Files are small, read is fast. |
| LanceDB (own store) | Native concurrent readers + single writer via Lance format. |

Principle: never hold a lock on the tool's data files.

---

## Compaction Pipeline

### Three Data Layers

| Layer | Source | Stored where | Purpose |
|---|---|---|---|
| **Raw** | Scrapers | `.store/conversations/` | Verbatim conversation chunks |
| **Compacted** | Background processor | `.store/compactions/` | Summarized sessions with refs to raw |
| **Knowledge** | Agent writes (MCP) | `knowledge/` (committed) | Curated decisions, errors, insights |

### Compaction Strategy

**Tier 1: Rule-based (default, free, always-on)**
- Extract file paths from conversation text.
- Detect session boundaries from timestamps (gap > 30min or tool-specific markers).
- Pull git diff for the session's time window.
- Concatenate first/last N messages as bookend summary.

**Tier 2: LLM-assisted (optional, configurable)**

Supports three provider types:

```yaml
compaction:
  strategy: "rule-based"    # or "llm-assisted"
  llm:
    # Option A: CLI tool (zero setup, uses existing auth)
    provider: "cli"
    command: "claude"       # or "gemini", "codex"
    args: ["--print", "--output-format", "json", "--model", "sonnet"]

    # Option B: Local model server
    # provider: "ollama"
    # model: "llama3.2"
    # endpoint: "http://localhost:11434"

    # Option C: Cloud API
    # provider: "openai"
    # model: "gpt-4o-mini"
    # api_key_env: "OPENAI_API_KEY"
```

---

## Agent Compliance — Ensuring Tools Get Used

### Four Reinforcement Layers

| Layer | Mechanism | Reliability |
|---|---|---|
| Skill injection | `xtctx-usage.md` injected into every tool's native config | Medium |
| MCP tool descriptions | Rich, directive descriptions on tools | Medium |
| Session start hooks | Auto-inject recent context (no agent action needed) | High |
| Config sync | Hooks auto-generated per tool during sync | High |

Critical paths (session start context injection, session end markers, conversation scraping) are automated via hooks. Agent-written knowledge is a valuable bonus, not a hard dependency.

### Hook Integration

Where tools support hooks, xtctx auto-wires them during config sync:

- **Claude Code**: `.claude/hooks.json` — `on_session_start`, `on_session_end`
- **Other tools**: Equivalent mechanisms as supported.

---

## Web UI

Vue 3 + Vite dashboard served locally by the xtctx daemon.

### Pages

1. **Dashboard** — Recent sessions across tools (timeline), ingestion status, quick stats.
2. **Search** — Unified search with semantic/keyword/hybrid mode, filters, markdown results with drill-down.
3. **Knowledge Browser** — Decisions, errors+solutions, insights. Domain tag filtering. Supersession chains. Edit/delete.
4. **Sources** — Scraper status, toggle on/off, trigger re-sync, ingestion log.
5. **Config** — Skill/agent/command matrix across tools. Tool preferences and whitelists. Compaction settings.

### Architecture

The web UI shares the same API layer as the MCP tools. One code path, consistent data.

---

## Landing Page (xtctx.com)

Simple open-source project landing page:
- Hero with tagline and architecture diagram
- Feature overview (context store, config sync, MCP, web UI)
- Quick start instructions
- Link to GitHub repo (`fstubner/xtctx`)

---

## Future Ideas (Out of Scope for v1)

- **Auto-extracted insights**: Common issues, solutions, FAQs extracted from ingested data via LLM analysis.
- **Team sync**: Shared `.store/` via sync mechanism for team-wide context.
- **VS Code extension**: Alternative to web UI, integrated into the editor.
- **Analytics**: Usage patterns across tools, session duration, error frequency.

---

## Integration with dot-agents

dot-agents and xtctx are complementary peers:
- **dot-agents**: Agent-agnostic AI engineering framework for producing high-quality software (skills, policies, verification).
- **xtctx**: Cross-tool context persistence, conversation indexing, config sync.

They coexist in a repo. xtctx can understand dot-agents format as one of its sources. The `.xtctx/` namespace is separate from `.agents/`.
