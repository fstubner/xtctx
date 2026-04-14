import type { WriteAction } from "../types/context.js";

export interface DuplicateCheckResult {
  action: WriteAction;
  existingId: string | null;
}

/**
 * Cosine-similarity threshold above which a new record is considered an exact
 * duplicate and rejected (no new entry created).
 * Default: 0.95 — configurable via `checkDuplicate` options (m1).
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

/**
 * Cosine-similarity threshold above which a new record supersedes an existing
 * one (the old entry is marked as superseded and replaced).
 * Default: 0.85 — configurable via `checkDuplicate` options (m1).
 */
export const DEFAULT_SUPERSEDE_THRESHOLD = 0.85;

export interface DuplicateCheckOptions {
  /**
   * Similarity score above which the new record is treated as a duplicate and
   * rejected.  Defaults to `DEFAULT_DUPLICATE_THRESHOLD` (0.95).
   */
  duplicateThreshold?: number;
  /**
   * Similarity score above which the new record supersedes an existing entry.
   * Must be less than `duplicateThreshold`.
   * Defaults to `DEFAULT_SUPERSEDE_THRESHOLD` (0.85).
   */
  supersedeThreshold?: number;
}

export function checkDuplicate(
  bestSimilarity: number,
  bestMatchId: string | null,
  options: DuplicateCheckOptions = {},
): DuplicateCheckResult {
  const duplicateThreshold = options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const supersedeThreshold = options.supersedeThreshold ?? DEFAULT_SUPERSEDE_THRESHOLD;
  if (!bestMatchId || bestSimilarity === 0) {
    return { action: "created", existingId: null };
  }

  if (bestSimilarity > duplicateThreshold) {
    return { action: "duplicate_rejected", existingId: bestMatchId };
  }

  if (bestSimilarity > supersedeThreshold) {
    return { action: "superseded", existingId: bestMatchId };
  }

  return { action: "created", existingId: null };
}
