/**
 * Managed-block splicing shared by setup and disconnect.
 *
 * These helpers were duplicated across both modules, and an audit found the
 * same defect in each copy: removal collapsed every run of 3+ newlines in the
 * whole file — including inside user code fences — which the block's own text
 * ("Content outside this managed block is preserved") promises never happens.
 * Fixing it twice is what justifies one home for it.
 */

export const MARKERS = {
  begin: "<!-- xtctx:begin -->",
  end: "<!-- xtctx:end -->",
};

export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockPattern(trailingNewline: boolean): RegExp {
  return new RegExp(
    `${escapeRegExp(MARKERS.begin)}[\\s\\S]*?${escapeRegExp(MARKERS.end)}${trailingNewline ? "\\n?" : ""}`,
    "g",
  );
}

/**
 * Remove every managed block, collapsing whitespace only at the splice seams
 * so user content elsewhere in the file is byte-preserved.
 */
export function removeManagedBlocks(content: string): string {
  const normalized = normalizeNewlines(content);
  const parts = normalized.split(managedBlockPattern(true));
  if (parts.length === 1) {
    return normalized;
  }

  let result = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const left = result.replace(/\n+$/, "");
    const right = parts[index].replace(/^\n+/, "");
    if (!left) {
      result = right;
    } else if (!right) {
      result = left;
    } else {
      result = `${left}\n\n${right}`;
    }
  }
  return result;
}

/**
 * True when the file is predominantly CRLF, so writers can put it back the
 * way the author had it instead of silently reformatting the whole file.
 */
export function isCrlfDominant(content: string): boolean {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = content.match(/\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 > lf;
}

/** Re-apply a file's original line endings to rewritten content. */
export function matchLineEndings(content: string, original: string | null): string {
  return original !== null && isCrlfDominant(original)
    ? content.replace(/\r?\n/g, "\r\n")
    : content;
}

export function countManagedBlocks(content: string): number {
  return normalizeNewlines(content).match(managedBlockPattern(false))?.length ?? 0;
}
