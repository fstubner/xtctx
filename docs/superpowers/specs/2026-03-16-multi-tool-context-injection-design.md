# Multi-Tool Context Injection — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Scope:** xtctx v0.4

---

## Problem

xtctx already syncs policy and instruction files to all five supported AI tools. What it does not do is inject *live project context* — recent session summaries and active knowledge records — at session start. Without this, a developer switching tools still needs to manually recall what happened last time or run `xtctx_search` themselves.

The field of AI tool memory has advanced unevenly: Claude Code and Gemini CLI both support AI-writable local memory files that are loaded automatically at session start. Cursor removed its memory feature in v2.1. Copilot added cloud-hosted memory (GitHub API, 28-day expiry). Codex CLI remains static-file only. The landscape is moving fast, so the design must not depend on any single tool's memory API remaining stable.

---

## Goals

1. Every supported tool receives fresh project context at session start — with no manual action required from the developer.
2. The mechanism survives tool format changes without rearchitecting the core.
3. Implementation fits within the existing `xtctx sync` + `xtctx serve` execution model.

---

## Non-Goals

- Copilot cloud memory integration (requires GitHub API auth, volatile format, 28-day expiry).
- Cursor native memory (feature was removed in v2.1 — only static rules remain).
- Any cloud storage or remote API calls for context delivery.
- Real-time in-session context streaming.

---

## Architecture: Three Delivery Layers

Context is delivered in three additive layers. Each layer is independent — a tool uses whichever layers it supports.

### Layer 1 — Managed Static Blocks (existing, all 5 tools)

`xtctx sync` already writes continuity policy and instructions into each tool's native instruction file:

- `CLAUDE.md` (Claude Code)
- `GEMINI.md` (Gemini CLI)
- `.cursorrules` / `.cursor/rules/.cursorrules` (Cursor)
- `AGENTS.md` (Codex CLI)
- `.github/copilot-instructions.md` (GitHub Copilot)

No changes to this layer except adding a reference to Layer 2 in each managed block:

```
Before coding, read `.xtctx/CONTEXT.md` for recent session context.
```

### Layer 2 — CONTEXT.md Live Snapshot (new, all 5 tools)

`.xtctx/CONTEXT.md` is a markdown file maintained by `xtctx serve` and written by `xtctx sync`. It contains:

- **Recent sessions** (up to 5 most recent): tool, date, one-line summary. Sessions where `summary` is absent are rendered with `(no summary)`.
- **Active knowledge** (up to 10 records): all six knowledge types (`decision`, `error_solution`, `insight`, `convention`, `gotcha`, `faq`), sorted by `created_at` descending, excluding records where `superseded_by` is set.

Update triggers:
- `xtctx sync` — written once on manual run
- `xtctx serve` — written on startup, then re-written after each ingestion cycle completes (debounced, 30s cooldown)

Format:

```markdown
# xtctx Context Snapshot
_Updated: 2026-03-16T14:23:00Z_

## Recent Sessions

| Date | Tool | Summary |
|------|------|---------|
| 2026-03-15 | claude | Implemented LLM-assisted compaction pipeline |
| 2026-03-14 | cursor | Fixed cursor scraper KV storage format |

## Active Knowledge

**[decision] LLM compaction provider strategy**
Two-pass approach: rule-based structure first, then LLM summary enhancement.
Fallback to rule-based on any LLM failure.

**[error_solution] ConversationChunk field mismatch**
SearchResult.metadata is a JSON string, not an object. Must parse before field access.
```

If both sessions and knowledge are empty, CONTEXT.md is still written with the headings and a `_No records yet._` placeholder under each section.

CONTEXT.md is gitignored (it contains live runtime state, not project source).

### Layer 3 — Native Memory Writes (new, Claude Code + Gemini only)

For tools with stable local-file memory paths, `xtctx sync` and `xtctx serve` write context directly into the tool's memory channel. These writes fire automatically — no instruction in the managed block required for injection.

**Claude Code**

Path: `~/.claude/projects/[encoded-path]/memory/xtctx-context.md`

Path encoding algorithm (derived from observed Claude Code behavior):
1. Keep original path case — do **not** lowercase.
2. Replace `:\` (Windows colon + separator) with `--`.
3. Replace remaining path separators (`\` or `/`) with `-` (single dash).

Example: `H:\projects\private\needs-work\xtctx` → `H--projects-private-needs-work-xtctx`

**Case-insensitive lookup:** Because Claude Code uses whatever case was presented at project creation (which can vary by how the user launched it), the encoded path may not exactly match the on-disk directory name. After computing the encoded path, scan all entries in `~/.claude/projects/` and find the first directory whose name matches the encoded path **case-insensitively**. Use that real directory name for the write. If no match is found (Claude Code has never been run in this project), skip the write and log a warning. Do not create the directory — Claude Code owns that namespace.

Format: standard Claude Code memory file with YAML frontmatter (the format Claude Code uses for its own memory writes):

```markdown
---
name: xtctx project context
description: Recent sessions and active knowledge — auto-updated by xtctx sync/serve
type: project
---

[same content as CONTEXT.md snapshot body, without the top-level heading]
```

Claude Code loads all files in the memory directory at every session start. No instruction required in CLAUDE.md.

**Gemini CLI**

Path: `~/.gemini/GEMINI.md`

Method: upsert a bounded section using distinct markers that do not collide with the Layer 1 managed block markers (`<!-- xtctx:begin -->` / `<!-- xtctx:end -->`).

On write: replace the block between `<!-- xtctx-context:start -->` and `<!-- xtctx-context:end -->` if it exists; otherwise append the full block. Never touch content outside the markers.

If `~/.gemini/GEMINI.md` does not exist, create it with the xtctx section as the only content.

```markdown
<!-- xtctx-context:start -->
## xtctx Context

[same content as CONTEXT.md snapshot body]
<!-- xtctx-context:end -->
```

Gemini CLI loads `~/.gemini/GEMINI.md` at every session start. No additional instruction required.

**Coexistence with Layer 1:** When Gemini scope is `global` or `hybrid`, `xtctx sync` (Layer 1) also writes a `<!-- xtctx:begin -->` / `<!-- xtctx:end -->` managed block into `~/.gemini/GEMINI.md`. The existing `upsertManagedSection` function used by Layer 1 matches only that marker pair and leaves all other content intact — it will not strip the Layer 3 `<!-- xtctx-context:start -->` / `<!-- xtctx-context:end -->` block. Both blocks coexist safely regardless of write order.

---

## Implementation Plan

### New: `src/context/snapshot.ts`

`generateContextSnapshot(sessions: SessionService | null, knowledge: KnowledgeRepository): Promise<string>` — queries recent sessions and knowledge records and renders the markdown snapshot body (without the top-level `# xtctx Context Snapshot` heading, so it can be embedded in both CONTEXT.md and memory files).

Takes explicit dependencies rather than a services bag to keep the signature lightweight for the sync path.

Data acquisition:
- Knowledge: `KnowledgeRepository` — call `listAll()` directly without calling `initialize()` (which creates directories and is a write operation inappropriate in a read context). The knowledge dir path is `path.join(projectRoot, '.xtctx', 'knowledge')`.
- Sessions: typed as `SessionService` (the interface from `src/mcp/tools/sessions.ts`), not the concrete `IndexedSessionService`. Pass `null` when LanceDB is unavailable; `generateContextSnapshot` renders `_No records yet._` for the sessions section when `null`.

### New: `src/context/writers.ts`

`writeContextToAllTargets(projectRoot: string, services): Promise<WriteContextResult>` — orchestrates all three writes:
1. Write `.xtctx/CONTEXT.md`
2. Write Claude Code memory file
3. Upsert Gemini `~/.gemini/GEMINI.md` section

Returns a result object with per-target status (`created | updated | unchanged | skipped | error`). All writes are best-effort — failure in Layer 3 does not block Layers 1 or 2.

**Unchanged detection:** Before writing any target, compare the new content against the existing file content. If they are equal (exact string match), mark the target as `unchanged` and skip the write. This prevents file-system churn on every sync/serve startup.

Helper: `encodeClaudeCodePath(absolutePath: string): string` — implements the encoding algorithm above. Exported for unit testing.

### Changes: `xtctx sync` (`src/cli/sync.ts`)

After existing instruction file sync, call `writeContextToAllTargets`. Do **not** call `createProjectServices()` — sync should remain lightweight. Instantiate only `KnowledgeRepository` directly (knowledge dir: `path.join(projectRoot, '.xtctx', 'knowledge')`). Pass `null` for the sessions service — the sync path intentionally produces a knowledge-only snapshot with an empty sessions section, because sessions require LanceDB which sync deliberately avoids initializing.

Report each target in sync output (created / updated / unchanged / skipped).

### Changes: `xtctx serve` (`src/cli/serve.ts`)

On startup: call `writeContextToAllTargets` before entering the event loop.

Pass a debounced `writeContextToAllTargets` wrapper (30s cooldown) to `IngestionCoordinator` via the new `onCycleComplete` option (see below).

### Changes: `src/ingestion/coordinator.ts` — `IngestionCoordinator`

Add `onCycleComplete` to `IngestionCoordinator`, not `IngestionDaemon`. The coordinator is the right owner because it calls `runCycle()` in all three trigger paths: the daemon calls it directly for the initial run and file watcher callbacks, and `coordinator.start()` manages the poll timer internally and calls `runCycle()` there too. The daemon never sees poll timer completions.

Add to `IngestionCoordinator` constructor options:

```typescript
onCycleComplete?: (result: IngestionCycleResult) => Promise<void>;
```

Call `onCycleComplete` at the end of `runCycle()`, after the result is available. Errors from `onCycleComplete` are caught and logged; they must not throw out of `runCycle()`.

### Changes: `.gitignore`

Add `.xtctx/CONTEXT.md`.

### Changes: `xtctx sync` managed block templates (`src/config/sync.ts`)

Each tool's template gains the Layer 2 reference line in its context feed section.

---

## Error Handling

- Claude Code memory directory does not exist: warn and skip (not an error — Claude Code may not have been run here yet).
- `~/.gemini/GEMINI.md` does not exist: create it with xtctx section only.
- Any write fails: log at `warn` level and continue — sync/serve still succeed.
- Sessions store missing (LanceDB not initialized): degrade to empty sessions list, proceed with knowledge-only snapshot.
- All Layer 3 writes are best-effort and do not affect sync/serve exit codes.

---

## Testing

- Unit: `generateContextSnapshot` with mock sessions + knowledge, verifies table output and knowledge blocks
- Unit: `generateContextSnapshot` with empty sessions and empty knowledge — must produce valid markdown with placeholder, not crash
- Unit: `generateContextSnapshot` excludes superseded records (`superseded_by` set)
- Unit: `encodeClaudeCodePath` — Windows paths (`H:\foo\bar` → `H--foo-bar`), Unix paths (`/home/user/proj` → `home-user-proj`), paths with existing hyphens preserved
- Unit: Gemini upsert — no existing file; existing file without markers; existing file with markers; existing file with both Layer 1 `<!-- xtctx:begin -->` block and Layer 3 markers (must not corrupt Layer 1 block)
- Unit: `SessionSummary.summary` absent — renders `(no summary)` in table
- Integration: `xtctx sync` in the test fixture project writes all three targets
- Integration: `IngestionCoordinator` calls `onCycleComplete` after `runCycle()` — verify via mock callback; verify errors in the callback do not propagate
- Integration: Layer 1 sync run after a Layer 3 write does not corrupt the Layer 3 `<!-- xtctx-context:start/end -->` block in `~/.gemini/GEMINI.md`
- Unit: `encodeClaudeCodePath` + case-insensitive directory scan finds the correct target even when casing differs from computed encoded name

---

## Future Considerations (out of scope for v0.4)

- **Copilot cloud memory**: If GitHub exposes a stable local cache path, add a Layer 3 adapter.
- **Per-tool content filtering**: Some tools may benefit from shorter snapshots. Currently all targets receive identical snapshot body content.
- **MCP tool `xtctx_refresh_context`**: Allow assistants to trigger a context snapshot refresh mid-session without a full sync.
