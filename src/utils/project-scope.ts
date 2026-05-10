export function pathMatchesProject(candidatePath: string, projectRoot: string): boolean {
  const candidate = normalizeProjectPath(candidatePath);
  const root = normalizeProjectPath(projectRoot);
  return candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}--`);
}

export function encodePathForToolDirectory(projectRoot: string): string {
  return projectRoot.replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "").toLowerCase();
}
