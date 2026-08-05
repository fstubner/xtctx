export function pathMatchesProject(candidatePath: string, projectRoot: string): boolean {
  const candidate = normalizeProjectPath(candidatePath);
  const root = normalizeProjectPath(projectRoot);
  return candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}--`);
}

export function encodePathForToolDirectory(projectRoot: string): string {
  return projectRoot.replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
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
