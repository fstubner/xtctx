export function extractFileReferences(
  text: string,
  repoFiles: string[],
): string[] {
  const found: string[] = [];

  for (const file of repoFiles) {
    const basename = file.split("/").pop();
    if (!basename) {
      continue;
    }

    if (text.includes(file) || text.includes(basename)) {
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
