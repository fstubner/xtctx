/**
 * True when `candidatePath` is the project root or a path inside it.
 *
 * Only `/` separates a child from its parent. A previous `<root>--<suffix>`
 * clause — borrowed from Claude Code's encoded *directory names*, where `--`
 * is meaningful — leaked into real path comparison and made `.../app` match
 * the sibling directory `.../app--secret`, indexing and serving another
 * project's transcripts.
 */
export function pathMatchesProject(candidatePath: string, projectRoot: string): boolean {
  const candidate = normalizeProjectPath(candidatePath);
  const root = normalizeProjectPath(projectRoot);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Encode a project root the way Claude Code names its store directories:
 * every `:`, `\` and `/` becomes `-`. The leading separator is part of that
 * encoding on POSIX (`/Users/me/app` -> `-Users-me-app`); stripping it meant
 * the name never matched the directory on disk, so macOS and Linux projects
 * scraped nothing. Windows paths start with a drive letter and are unaffected.
 */
export function encodePathForToolDirectory(projectRoot: string): string {
  return projectRoot.replace(/[:\\/]/g, "-").replace(/-+$/g, "");
}

function normalizeProjectPath(value: string): string {
  let normalized = value.trim();
  if (/^file:/i.test(normalized)) {
    normalized = fileUrlToPathLike(normalized);
  } else {
    normalized = decodePathLike(normalized);
  }

  return normalized
    .replace(/\\/g, "/")
    .replace(/^\/([a-zA-Z]:\/)/, "$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/g, "")
    .toLowerCase();
}

function fileUrlToPathLike(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") {
      return value;
    }

    const path = decodePathLike(url.pathname);
    return url.hostname ? `//${url.hostname}${path}` : path;
  } catch {
    return decodePathLike(value);
  }
}

function decodePathLike(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
