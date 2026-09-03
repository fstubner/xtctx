import { createHash } from "node:crypto";

/**
 * A stable id from ordered parts.
 *
 * Separators matter: without them `["ab","c"]` and `["a","bc"]` hash alike,
 * and these ids key message rows and retrieval windows. Lives on its own
 * because both chunk ingestion and windowing need it, and making ingestion
 * import the windowing module for a SHA helper tied two things together that
 * have nothing to do with each other.
 */
export function hashParts(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}
