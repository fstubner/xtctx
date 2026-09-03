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
  return (extension === ".md" || extension === ".txt") &&
    !name.endsWith(".metadata.json") &&
    !name.includes(".resolved");
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
