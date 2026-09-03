import type { AntigravityChunk } from "../../types/scraper.js";

/**
 * Coercions for the untyped records this reader is handed.
 *
 * Everything Antigravity gives us arrives as JSON off the language server or
 * off disk, so every field has to be narrowed before it is used. These are the
 * narrowings, and nothing else: no knowledge of trajectories, steps or
 * artifacts lives here, which is what lets the on-disk store depend on them
 * without dragging the trajectory reader in behind it.
 */

export function normalizeRole(value?: string): AntigravityChunk["role"] {
  switch (value) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return value;
    default:
      return "assistant";
  }
}

export function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function toPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function extractReferencedFiles(content: string): string[] {
  const matches = content.match(/file:\/\/\/[^\s)\]>"]+/g) ?? [];
  return [...new Set(matches.map(decodeFileUrl).filter((value) => value.length > 0))];
}

export function decodeFileUrl(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^file:\/\/\//, ""));
  } catch {
    return value.replace(/^file:\/\/\//, "");
  }
}
