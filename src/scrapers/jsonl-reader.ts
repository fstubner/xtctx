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
  /**
   * The first bytes of an oversized line, decoded. Empty for every other line.
   *
   * A caller that only knows "something too big was skipped" has to choose
   * between reporting every one — a real Codex store emits 47 benign oversized
   * records a scan, all of them `compacted` restatements — and reporting none,
   * which is silent data loss. Neither is right, and telling them apart needs
   * the record's `type`, which lives at the head.
   *
   * Bounded, so it cannot reintroduce the cost the cap exists to avoid: this
   * is the only part of a discarded line that is ever held.
   */
  head: string;
}

interface ReadJsonlOptions {
  /** Byte offset to resume from. Must be a boundary this reader reported. */
  start?: number;
  maxLineBytes?: number;
  /** How much of an oversized line to keep for classification. */
  headBytes?: number;
}

/**
 * Enough of an oversized line to read its `type` field, and no more.
 *
 * The head is held for every line that goes over the cap, so this is a
 * permanent cost per discarded record rather than a one-off.
 */
const DEFAULT_HEAD_BYTES = 512;

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
  const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES;
  const start = options.start ?? 0;

  const stream = createReadStream(path, start > 0 ? { start } : {});

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let consumed = start;
  // Kept separately from `pending`, which is dropped the moment a line goes
  // over the cap. Filled from the front, so it survives that drop.
  let head: Buffer[] = [];
  let headLength = 0;

  const keepHead = (piece: Buffer): void => {
    if (headLength >= headBytes) return;
    const slice = piece.subarray(0, headBytes - headLength);
    head.push(slice);
    headLength += slice.length;
  };

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
        keepHead(segment);
        yield {
          line: null,
          endOffset: consumed,
          oversized: true,
          head: Buffer.concat(head).toString("utf-8"),
        };
      } else {
        const buffer = pending.length > 0 ? Buffer.concat([...pending, segment]) : segment;
        yield { line: buffer.toString("utf-8"), endOffset: consumed, oversized: false, head: "" };
      }

      pending = [];
      pendingBytes = 0;
      discarding = false;
      head = [];
      headLength = 0;
      from = i + 1;
    }

    const tail = chunk.subarray(from);
    if (tail.length === 0) {
      continue;
    }

    pendingBytes += tail.length;
    keepHead(tail);
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
