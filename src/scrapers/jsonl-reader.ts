import { createReadStream } from "node:fs";

import { MAX_LINE_BYTES } from "./limits.js";

/** One line of a JSONL file, with the byte position just past its newline. */
interface JsonlLine {
  /** Line text, or null when it exceeded the cap and was discarded unread. */
  line: string | null;
  /**
   * Bytes consumed up to and including this line's newline.
   *
   * Always a line boundary, which is what makes it safe to resume from: a
   * trailing partial line — a file being appended to as we read — is never
   * counted, so the next pass re-reads it once it is complete.
   */
  endOffset: number;
  /** True when the line was over the cap; `line` is null and its bytes are gone. */
  oversized: boolean;
}

interface ReadJsonlOptions {
  /** Byte offset to resume from. Must be a boundary this reader reported. */
  start?: number;
  maxLineBytes?: number;
}

/**
 * Read a JSONL file line by line, reporting byte offsets and bounding memory.
 *
 * Two things `readline` cannot do, both of which this project needs:
 *
 * Byte offsets, so an append-only log can be resumed rather than re-read. A
 * real Codex store here holds 18GB across 841 files, 94% of it in 17 files,
 * and every scan streamed all of it to find the few new lines at the end.
 * `readline` reports no position, and a line's `String.length` is UTF-16 units
 * rather than bytes, so an offset derived from it drifts on any non-ASCII
 * content and eventually resumes mid-line.
 *
 * A real cap, so an oversized line costs nothing. `readline` materialises the
 * whole line before a caller can reject it, which made the existing 8MB limit
 * avoid the parse but not the read — a 22MB line was already in memory by the
 * time it was refused. Here the bytes are counted and dropped as they arrive.
 */
export async function* readJsonlLines(
  path: string,
  options: ReadJsonlOptions = {},
): AsyncGenerator<JsonlLine> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const start = options.start ?? 0;

  const stream = createReadStream(path, start > 0 ? { start } : {});

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let consumed = start;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0x0a) {
        continue;
      }

      const segment = chunk.subarray(from, i);
      const lineBytes = pendingBytes + segment.length;
      consumed += lineBytes + 1;

      if (discarding || lineBytes > maxLineBytes) {
        yield { line: null, endOffset: consumed, oversized: true };
      } else {
        const buffer = pending.length > 0 ? Buffer.concat([...pending, segment]) : segment;
        yield { line: buffer.toString("utf-8"), endOffset: consumed, oversized: false };
      }

      pending = [];
      pendingBytes = 0;
      discarding = false;
      from = i + 1;
    }

    const tail = chunk.subarray(from);
    if (tail.length === 0) {
      continue;
    }

    pendingBytes += tail.length;
    if (discarding || pendingBytes > maxLineBytes) {
      // Past the cap: keep counting so the offset stays right, but stop
      // holding the bytes. This is the whole point of not using readline.
      discarding = true;
      pending = [];
    } else {
      pending.push(tail);
    }
  }

  // Whatever is left has no newline, so it is either a final line with no
  // trailing newline or a line still being written. Deliberately not yielded
  // and not counted: re-reading it next pass is correct in both cases, and
  // guessing which one it is would risk emitting half a record.
}
