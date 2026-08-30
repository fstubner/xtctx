import { stat } from "node:fs/promises";

/**
 * Size ceilings for transcript reads.
 *
 * Transcript stores are written by other tools, so their size is not xtctx's
 * to trust: anything that can drop a file into `~/.claude/projects/<p>/` or a
 * `chatSessions/` directory chooses how large it is. Without a bound, a single
 * unterminated line is buffered whole before `JSON.parse` sees it, and the MCP
 * server — a long-lived process — wears that as resident memory.
 *
 * The limits are deliberately far above anything a real session produces. A
 * long Claude Code turn with a large tool result is a few hundred KB; a busy
 * project's `.jsonl` is single-digit MB. These are here to stop a pathological
 * file, not to police ordinary ones.
 */

/** Largest single JSONL line xtctx will buffer, in bytes. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Largest whole transcript file xtctx will read into memory, in bytes. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * True when the file is small enough to read whole.
 *
 * A missing or unreadable file reports `true` so the caller's own error
 * handling stays in charge of what that means — this guard is about size, and
 * silently reclassifying a missing file as "too big" would hide a real fault.
 */
export async function isWithinFileLimit(
  filePath: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.size <= maxBytes;
  } catch {
    return true;
  }
}

/**
 * True when a line is short enough to parse.
 *
 * Measured in UTF-16 code units rather than bytes: that is what the string
 * already costs in memory, and it avoids re-encoding every line to count.
 */
export function isWithinLineLimit(line: string, maxBytes: number = MAX_LINE_BYTES): boolean {
  return line.length <= maxBytes;
}
