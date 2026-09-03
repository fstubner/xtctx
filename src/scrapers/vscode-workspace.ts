import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatchesProject } from "../utils/project-scope.js";

/**
 * Whether a VS Code workspace belongs to this project.
 *
 * Cursor and GitHub Copilot both store their history under VS Code's
 * `workspaceStorage` layout: a directory per workspace holding a
 * `state.vscdb` beside a `workspace.json` naming the folder it was opened on.
 * That file is the only evidence of which project a workspace belongs to, so
 * this is the filter that keeps one project's conversations out of another's
 * answers — for two scrapers, from one place.
 *
 * It was two places. The function was byte-identical in `cursor.ts` and
 * `copilot/scraper.ts` with nothing in either saying a second copy existed,
 * which for a boundary check means a fix or a hardening could land on one
 * scraper and silently not the other.
 *
 * Fails closed throughout: an unreadable or malformed `workspace.json`, or one
 * naming no folder, is not evidence that the workspace is ours.
 */
export async function workspaceMatchesProject(
  workspaceDbPath: string,
  projectRoot: string,
): Promise<boolean> {
  try {
    const raw = await readFile(join(dirname(workspaceDbPath), "workspace.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const folder = typeof parsed.folder === "string" ? parsed.folder : undefined;
    if (!folder) {
      return false;
    }
    const folderPath = folder.startsWith("file:") ? fileURLToPath(folder) : folder;
    return pathMatchesProject(folderPath, projectRoot);
  } catch {
    return false;
  }
}
