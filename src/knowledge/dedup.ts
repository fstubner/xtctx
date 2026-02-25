import type { WriteAction } from "../types/context.js";

export interface DuplicateCheckResult {
  action: WriteAction;
  existingId: string | null;
}

const DUPLICATE_THRESHOLD = 0.95;
const SUPERSEDE_THRESHOLD = 0.85;

export function checkDuplicate(
  bestSimilarity: number,
  bestMatchId: string | null,
): DuplicateCheckResult {
  if (!bestMatchId || bestSimilarity === 0) {
    return { action: "created", existingId: null };
  }

  if (bestSimilarity > DUPLICATE_THRESHOLD) {
    return { action: "duplicate_rejected", existingId: bestMatchId };
  }

  if (bestSimilarity > SUPERSEDE_THRESHOLD) {
    return { action: "superseded", existingId: bestMatchId };
  }

  return { action: "created", existingId: null };
}
