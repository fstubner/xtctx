import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "../utils/errors.js";

export interface HookSyncResult {
  tool: string;
  path: string;
  updated: boolean;
  created: boolean;
  skipped: boolean;
  warning?: string;
}

/**
 * Generate executable hook/automation files for each tool during sync.
 * These files make tools automatically call `xtctx context` on session start.
 *
 * - Claude Code: real executable hook via `.claude/hooks.json`
 * - Cursor: always-on `.mdc` rule file
 * - Codex, Copilot, Gemini: instruction-based "soft hooks" — a managed
 *   instruction block that tells the agent to call xtctx MCP tools at
 *   session start (these tools have no native hook mechanism).
 */
export async function syncToolHooks(projectRoot: string): Promise<HookSyncResult[]> {
  const results: HookSyncResult[] = [];

  results.push(await syncClaudeHooks(projectRoot));
  results.push(await syncCursorHooks(projectRoot));
  results.push(await syncCodexHooks(projectRoot));
  results.push(await syncCopilotHooks(projectRoot));
  results.push(await syncGeminiHooks(projectRoot));
  results.push(await syncOpenCodeHooks(projectRoot));
  results.push(await syncCopilotCliHooks(projectRoot));

  return results;
}

/**
 * Claude Code hooks: `.claude/hooks.json`
 * Merges xtctx hook into existing hooks without overwriting user-defined hooks.
 */
async function syncClaudeHooks(projectRoot: string): Promise<HookSyncResult> {
  const hooksPath = join(projectRoot, ".claude", "hooks.json");
  const xtctxCommand = buildContextCommand(projectRoot, "claude");

  try {
    const existing = await readJsonIfExists(hooksPath);
    const hooks = (existing ?? {}) as Record<string, unknown>;

    const hooksMap = (hooks.hooks ?? {}) as Record<string, unknown>;
    const sessionStart = Array.isArray(hooksMap.SessionStart) ? hooksMap.SessionStart : [];

    const alreadyHasXtctx = sessionStart.some(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).command?.toString().includes("xtctx context"),
    );

    if (alreadyHasXtctx) {
      return { tool: "claude", path: hooksPath, updated: false, created: false, skipped: true };
    }

    const xtctxHook = {
      type: "command",
      command: xtctxCommand,
    };

    hooksMap.SessionStart = [...sessionStart, xtctxHook];
    hooks.hooks = hooksMap;

    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(hooks, null, 2) + "\n", "utf-8");

    return {
      tool: "claude",
      path: hooksPath,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool: "claude",
      path: hooksPath,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to sync Claude hooks: ${errorMessage(error)}`,
    };
  }
}

/**
 * Cursor: `.cursor/rules/xtctx-context.mdc`
 * Cursor uses .mdc rule files. We create an "always" rule that runs xtctx context.
 */
async function syncCursorHooks(projectRoot: string): Promise<HookSyncResult> {
  const rulePath = join(projectRoot, ".cursor", "rules", "xtctx-context.mdc");

  try {
    const existing = await readStringIfExists(rulePath);
    const content = [
      "---",
      "description: xtctx session context injection",
      // Quote the glob so YAML parses it as a scalar string; an unquoted `*`
      // is interpreted as an alias reference and makes the frontmatter invalid,
      // which causes Cursor to ignore the rule file (C5).
      'globs: "**/*"',
      "alwaysApply: true",
      "---",
      "",
      "This project uses xtctx for cross-tool handoff. The most-recent",
      "session in another tool is briefed inside the managed block of this",
      "project's memory files (CLAUDE.md / AGENTS.md / etc.) — read it",
      "first when picking up project work.",
      "",
      "Use these MCP tools when you need more than the brief:",
      "1. `xtctx_recent_sessions` — list recent sessions across all AI tools",
      "2. `xtctx_session_detail` — drill into one session's full transcript",
      "3. `xtctx_last_session_brief` — re-fetch the brief programmatically",
      "",
      "For durable knowledge that should outlive the handoff window, use",
      "`construct` (if installed) or hand-edit AGENTS.md / CLAUDE.md outside",
      "the managed block — content outside the fences is preserved.",
      "",
    ].join("\n");

    if (existing !== null && existing.includes("xtctx")) {
      return { tool: "cursor", path: rulePath, updated: false, created: false, skipped: true };
    }

    await mkdir(dirname(rulePath), { recursive: true });
    await writeFile(rulePath, content, "utf-8");

    return {
      tool: "cursor",
      path: rulePath,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool: "cursor",
      path: rulePath,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to sync Cursor rules: ${errorMessage(error)}`,
    };
  }
}

const SOFT_HOOK_CONTENT = [
  "At the start of every session, read the handoff brief in the managed",
  "block of this file (between `<!-- xtctx:begin -->` markers, including",
  "per-tool variants like `xtctx:begin:opencode`). The brief contains a",
  "summary of the most-recent session in another tool when one exists.",
  "",
  "If you need more than the brief, use these MCP tools:",
  "1. `xtctx_recent_sessions` — list recent sessions across all AI tools",
  "2. `xtctx_session_detail` — drill into one session's full transcript",
  "3. `xtctx_last_session_brief` — re-fetch the brief programmatically",
  "",
  "For durable knowledge beyond the handoff window, use `construct` (if",
  "installed) or hand-edit AGENTS.md / CLAUDE.md outside the managed block.",
].join("\n");

const SOFT_HOOK_MARKER_BEGIN = "<!-- xtctx:hooks:begin -->";
const SOFT_HOOK_MARKER_END = "<!-- xtctx:hooks:end -->";

/**
 * When two tools share a memory file (codex + opencode → AGENTS.md;
 * copilot + copilot-cli → .github/copilot-instructions.md), each tool needs
 * tool-suffixed hook markers so their soft-hook blocks coexist.
 */
function hookMarkers(toolSuffix?: string): { begin: string; end: string } {
  if (!toolSuffix) {
    return { begin: SOFT_HOOK_MARKER_BEGIN, end: SOFT_HOOK_MARKER_END };
  }
  return {
    begin: `<!-- xtctx:hooks:begin:${toolSuffix} -->`,
    end: `<!-- xtctx:hooks:end:${toolSuffix} -->`,
  };
}

/**
 * Codex: writes a managed instruction block into `AGENTS.md`.
 * Codex has no native hook mechanism, so we use an instruction-based soft hook.
 */
async function syncCodexHooks(projectRoot: string): Promise<HookSyncResult> {
  return syncSoftHook(projectRoot, "codex", "AGENTS.md");
}

/**
 * Copilot: writes a managed instruction block into `.github/copilot-instructions.md`.
 */
async function syncCopilotHooks(projectRoot: string): Promise<HookSyncResult> {
  return syncSoftHook(projectRoot, "copilot", join(".github", "copilot-instructions.md"));
}

/**
 * Gemini CLI: writes a managed instruction block into `GEMINI.md`.
 */
async function syncGeminiHooks(projectRoot: string): Promise<HookSyncResult> {
  return syncSoftHook(projectRoot, "gemini", "GEMINI.md");
}

/**
 * opencode: writes a managed instruction block into `AGENTS.md` (shared with
 * Codex). Tool-suffixed markers prevent the codex and opencode hook blocks
 * from overwriting one another on each sync pass.
 */
async function syncOpenCodeHooks(projectRoot: string): Promise<HookSyncResult> {
  return syncSoftHook(projectRoot, "opencode", "AGENTS.md", "opencode");
}

/**
 * Copilot CLI: writes a managed instruction block into
 * `.github/copilot-instructions.md` (shared with the VS Code Copilot extension).
 */
async function syncCopilotCliHooks(projectRoot: string): Promise<HookSyncResult> {
  return syncSoftHook(
    projectRoot,
    "copilot-cli",
    join(".github", "copilot-instructions.md"),
    "copilot-cli",
  );
}

/**
 * Generic soft hook writer: embeds a managed instruction block that tells
 * the agent to call xtctx MCP tools at session start.
 */
async function syncSoftHook(
  projectRoot: string,
  tool: string,
  relativePath: string,
  markerSuffix?: string,
): Promise<HookSyncResult> {
  const filePath = join(projectRoot, relativePath);
  const markers = hookMarkers(markerSuffix);

  try {
    const existing = await readStringIfExists(filePath);
    const block = renderSoftHookBlock(markers);

    if (existing !== null && existing.includes(markers.begin)) {
      // Already has a soft hook block — check if it needs updating
      const pattern = new RegExp(
        `${escapeRegExp(markers.begin)}[\\s\\S]*?${escapeRegExp(markers.end)}\\n?`,
        "g",
      );
      const existingBlock = existing.match(pattern)?.[0] ?? "";
      if (normalizeNewlines(existingBlock).trim() === normalizeNewlines(block).trim()) {
        return { tool, path: filePath, updated: false, created: false, skipped: true };
      }

      // Replace existing block
      const updated = existing.replace(pattern, block);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, updated, "utf-8");
      return { tool, path: filePath, updated: true, created: false, skipped: false };
    }

    // No existing block — append
    const separator = existing && existing.trim().length > 0 ? "\n\n" : "";
    const content = (existing ?? "") + separator + block;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    return {
      tool,
      path: filePath,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool,
      path: filePath,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to sync ${tool} hooks: ${errorMessage(error)}`,
    };
  }
}

function renderSoftHookBlock(markers: { begin: string; end: string } = hookMarkers()): string {
  return [
    markers.begin,
    "Generated by xtctx sync. Do not edit inside this block.",
    "",
    "# xtctx Session Context",
    "",
    SOFT_HOOK_CONTENT,
    markers.end,
    "",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function buildContextCommand(projectRoot: string, tool: string): string {
  // Quote the resolved path so spaces (and other shell-special characters)
  // in the project root do not break the generated hook command (C4).
  const quotedPath = `"${resolve(projectRoot).replace(/"/g, '\\"')}"`;
  return `npx xtctx context --project ${quotedPath} --tool ${tool}`;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readStringIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
