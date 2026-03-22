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
 */
export async function syncToolHooks(projectRoot: string): Promise<HookSyncResult[]> {
  const results: HookSyncResult[] = [];

  results.push(await syncClaudeHooks(projectRoot));
  results.push(await syncCursorHooks(projectRoot));

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
      "globs: *",
      "alwaysApply: true",
      "---",
      "",
      "This project uses xtctx for cross-tool context continuity.",
      "At the start of each session, use the xtctx MCP tools to load recent context:",
      "1. Call `xtctx_recent_sessions` to see recent work across all AI tools",
      "2. Call `xtctx_project_knowledge` to load shared decisions and insights",
      "3. Use `xtctx_search` for targeted lookups when needed",
      "",
      "When you learn something important, save it:",
      "- `xtctx_save_decision` for architectural choices",
      "- `xtctx_save_error_solution` for bugs and fixes",
      "- `xtctx_save_insight` for conventions and gotchas",
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

function buildContextCommand(projectRoot: string, tool: string): string {
  return `npx xtctx context --project ${resolve(projectRoot)} --tool ${tool}`;
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
