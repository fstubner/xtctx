/**
 * Extracts file references from `text` by matching against `repoFiles`.
 *
 * Matching rules (m2 — tightened logic):
 * 1. An exact full-path match always wins.
 * 2. A basename match is accepted only when the basename is surrounded by
 *    word boundaries (spaces, quotes, backticks, path separators, or
 *    start/end of string) to avoid false positives — e.g. `index.ts` should
 *    not match the word "reindex.ts" or "index.tsconfig".
 */
export function extractFileReferences(
  text: string,
  repoFiles: string[],
): string[] {
  const found: string[] = [];

  for (const file of repoFiles) {
    // Full-path match (most specific — always accept).
    if (text.includes(file)) {
      found.push(file);
      continue;
    }

    const basename = file.split("/").pop();
    if (!basename) {
      continue;
    }

    // Basename match: require word-boundary on both sides so "index.ts" does
    // not accidentally match inside "reindex.ts" or "src/index.tsconfig".
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\w./\\\\])${escaped}(?![\\w./\\\\])`, "i");
    if (pattern.test(text)) {
      found.push(file);
    }
  }

  return [...new Set(found)];
}

export function classifyDomains(
  text: string,
  domainKeywords: Record<string, string[]>,
): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      matched.push(domain);
    }
  }

  return matched;
}
