import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_HOOK_MARKER } from "./claude-settings.js";
import { isRecord, readJsonIfExists, readUtf8IfExists, writeIfChanged } from "./file-io.js";
import { SELF_HOSTED_ENTRY, isSelfHostedProject, pinnedPackageSpec } from "./server-definition.js";

export const CURSOR_HOOK_MARKER = CLAUDE_HOOK_MARKER;
const CURSOR_HOOK_ARGS = "--hook session-start --tool cursor";

function isGeneratedCursorHookCommand(command: string): boolean {
  if (command === `node ${SELF_HOSTED_ENTRY} ${CURSOR_HOOK_ARGS}`) return true;
  const rest = /^npx -y xtctx(?:@\S+)? (.*)$/.exec(command);
  return rest !== null && rest[1] === CURSOR_HOOK_ARGS;
}

async function cursorHookCommand(projectRoot: string): Promise<string> {
  return (await isSelfHostedProject(projectRoot))
    ? `node ${SELF_HOSTED_ENTRY} ${CURSOR_HOOK_ARGS}`
    : `npx -y ${pinnedPackageSpec()} ${CURSOR_HOOK_ARGS}`;
}

export interface CursorHookResult {
  changed: boolean;
  failure?: string;
}

/**
 * Install the Cursor `.cursor/hooks.json` `sessionStart` hook, preserving all
 * existing hooks and refusing to overwrite unparsable JSON.
 */
export async function installCursorHook(projectRoot: string): Promise<CursorHookResult> {
  const hooksPath = join(projectRoot, ".cursor", "hooks.json");
  const raw = await readUtf8IfExists(hooksPath);
  let root: Record<string, unknown> = {};

  if (raw !== null && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      return {
        changed: false,
        failure:
          `Failed to parse ${hooksPath}; leaving it unchanged and skipping the ` +
          `Cursor sessionStart hook: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(parsed)) {
      return {
        changed: false,
        failure: `${hooksPath} is not a JSON object; leaving it unchanged and skipping the Cursor sessionStart hook.`,
      };
    }
    root = parsed;
  }

  if (typeof root.version !== "number") {
    root.version = 1;
  }
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const sessionStart = Array.isArray(hooks.sessionStart) ? hooks.sessionStart : [];
  const command = await cursorHookCommand(projectRoot);
  const alreadyInstalled = sessionStart.some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.command === "string" &&
      entry.command.includes(CURSOR_HOOK_MARKER),
  );

  if (!alreadyInstalled) {
    hooks.sessionStart = [...sessionStart, { command }];
  } else {
    for (const entry of sessionStart) {
      if (isRecord(entry) && typeof entry.command === "string" && isGeneratedCursorHookCommand(entry.command)) {
        entry.command = command;
      }
    }
  }
  root.hooks = hooks;

  const changed = await writeIfChanged(hooksPath, JSON.stringify(root, null, 2) + "\n", projectRoot);
  return { changed };
}

/** Remove xtctx's sessionStart entry from `.cursor/hooks.json` cleanly. */
export async function removeCursorHook(projectRoot: string): Promise<boolean> {
  const hooksPath = join(projectRoot, ".cursor", "hooks.json");
  const existing = await readJsonIfExists(hooksPath);
  if (!isRecord(existing) || !isRecord(existing.hooks)) {
    return false;
  }

  const hooks = existing.hooks;
  const sessionStart = Array.isArray(hooks.sessionStart) ? hooks.sessionStart : [];
  const kept = sessionStart.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        typeof entry.command === "string" &&
        entry.command.includes(CURSOR_HOOK_MARKER)
      ),
  );
  if (kept.length === sessionStart.length) {
    return false;
  }

  const otherHookKeys = Object.keys(hooks).filter((key) => key !== "sessionStart");
  const otherRootKeys = Object.keys(existing).filter((key) => key !== "hooks" && key !== "version");
  if (kept.length === 0 && otherHookKeys.length === 0 && otherRootKeys.length === 0) {
    await rm(hooksPath, { force: true });
    return true;
  }

  if (kept.length === 0) {
    delete hooks.sessionStart;
  } else {
    hooks.sessionStart = kept;
  }
  return writeIfChanged(hooksPath, JSON.stringify(existing, null, 2) + "\n", projectRoot);
}
