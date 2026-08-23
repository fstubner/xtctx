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
  // Deliberately without the trailing-newline variant: letting the pattern eat
  // a newline after the block takes one from the user's text when a block sits
  // between paragraphs. The separator handled below is the only whitespace
  // removal that belongs to xtctx.
  const parts = normalized.split(managedBlockPattern(false));
  if (parts.length === 1) {
    return normalized;
  }

  // Take back exactly what setup put in: a block, and the "\n\n" it writes
  // before one when there is content above it. Nothing else.
  //
  // Trimming the seam from both sides instead was lossy the moment a file held
  // two blocks — which a merge conflict resolved keeping both sides produces.
  // The second pass took the newline ending the user's own line between them,
  // turning "MIDDLE\n" into "MIDDLE". Removing "at most two" newlines rather
  // than exactly the separator has the same flaw: once the blocks are gone
  // there is no way to tell the user's blank lines from ours, so the only safe
  // rule is to remove the exact sequence that was added.
  let result = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const isLast = index === parts.length - 1;
    // Setup writes "\n\n" before the block and a single "\n" after it, and the
    // one after only exists because the block is appended at the end of the
    // file. So a lone "\n" trailing the final block is ours; a "\n" followed by
    // anything else is the user's, and taking it is what lost a byte when a
    // merge left two blocks in one file.
    const tail = isLast && parts[index] === "\n" ? "" : parts[index];
    result = result.replace(/\n\n$/, "") + tail;
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
