import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative as relativePath } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { matchLineEndings } from "./managed-block.js";

/**
 * The filesystem primitives setup and disconnect both work through.
 *
 * They are here rather than duplicated in each because the rules they encode
 * are the same on both sides — a write is idempotent and preserves the file's
 * line endings, a read of a missing file is `null` rather than a throw, and a
 * directory is only deleted when it is empty and inside the project.
 */

export async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function readJsonIfExists(filePath: string): Promise<unknown> {
  const raw = await readUtf8IfExists(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * `containWithin` is passed by every caller rather than defaulted, because the
 * correct root differs per write: project files belong to the project root,
 * user-level files to the home directory. A default here would silently apply
 * one caller's root to another's file.
 */
export async function writeIfChanged(
  filePath: string,
  content: string,
  containWithin: string,
): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  // Preserve the existing file's dominant line endings instead of silently
  // converting a CRLF-authored file to LF.
  const finalContent = matchLineEndings(content, existing);
  if (existing !== null && existing === finalContent) {
    return false;
  }

  await writeFileAtomic(filePath, finalContent, { containWithin });
  return true;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True when the directory is missing or holds nothing. */
export async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    // Missing, or not a directory: either way there is no index to protect.
    return true;
  }
}

export async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

/** Strictly below the project root — the root itself is never a candidate. */
export function isInsideProject(candidate: string, projectRoot: string): boolean {
  const relative = relativePath(projectRoot, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !isAbsolute(relative);
}

/**
 * Remove directories that only existed to hold what was just deleted.
 *
 * Disconnect left `.vscode/`, `.github/instructions/` and
 * `.cursor/rules/xtctx-skills/` standing empty — directories xtctx created,
 * now holding nothing, in projects that never had them. It walks upward while
 * each directory is genuinely empty, so anything the user keeps alongside our
 * files stops it immediately.
 */
export async function pruneEmptyParents(directory: string, projectRoot: string): Promise<void> {
  let current = directory;

  // Hard floor at the project root. Several write paths sit at the root
  // itself — `.mcp.json`, `CLAUDE.md`, `AGENTS.md` — so `dirname` is the root,
  // and without this the walk climbed straight out of the project and deleted
  // it along with its empty ancestors. Emptiness is not a licence to delete
  // something xtctx never created.
  if (!isInsideProject(current, projectRoot)) {
    return;
  }

  // Bounded: three levels covers the deepest xtctx creates
  // (`.cursor/rules/xtctx-skills`), and a bound is cheaper than reasoning
  // about how far up an unexpected path could walk.
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isInsideProject(current, projectRoot)) {
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    try {
      // `rmdir`, not `rm`: it refuses a non-empty directory, so it is its own
      // safety net. (`rm` without `recursive` throws on any directory at all,
      // which the catch below silently turned into "give up" — the prune
      // looked implemented and did nothing.)
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
