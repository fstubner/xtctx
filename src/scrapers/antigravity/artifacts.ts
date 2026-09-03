import { extname } from "node:path";
import type { AntigravityArtifact } from "./shared.js";

/**
 * Brain artifacts: which files on disk are one, and how one reads as a chunk.
 *
 * The fallback source, used only when the language server serves nothing. It
 * has no relationship to a trajectory step beyond both ending up as chunks —
 * different origin, different fields, different failure modes.
 */

export function isReadableArtifactName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  // `.resolved` is checked anywhere in the name, not as the extension:
  // `plan.resolved.md` is a duplicate of `plan.md` with the references
  // expanded, and it ends in `.md` like any other artifact. A name ending
  // `.resolved` outright is already excluded, since that is its extension.
  //
  // There was a third clause here rejecting `.metadata.json`. It could never
  // fire — such a name has extension `.json`, so the check above rejects it
  // first — and a guard that cannot run reads as protection that is not there.
  return (extension === ".md" || extension === ".txt") && !name.includes(".resolved");
}

export function formatArtifactContent(artifact: AntigravityArtifact): string {
  const header = [
    `Antigravity artifact: ${artifact.artifactName}`,
    `Source: ${artifact.sourcePath}`,
    artifact.artifactType ? `Type: ${artifact.artifactType}` : undefined,
    artifact.summary ? `Summary: ${artifact.summary}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return `${header.join("\n")}\n\n${artifact.body.trim()}`;
}
