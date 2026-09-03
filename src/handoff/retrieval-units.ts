import { hashParts } from "./hash.js";
import type { SessionMessage } from "./types.js";

export interface MessageRow {
  id: string;
  timestamp: string;
  role: SessionMessage["role"];
  content: string;
  message_index: number;
  source_pointer: string | null;
}

/**
 * How many messages a retrieval window holds, and how far the next one starts.
 *
 * Swept on 2026-09-03 against the sixty-query eval, with the current model.
 * Smaller windows help the semantic channel a great deal and cost the keyword
 * one, which is the tension these two numbers sit in:
 *
 *   size/stride   vector mrr  r@5    top1     hybrid mrr  r@5
 *   8/4 (this)    0.246       0.350  0.183    0.333       0.533
 *   4/2           0.331       0.433  0.233    0.343       0.500
 *   2/1           0.461       0.567  0.367    0.259       0.500
 *
 * Left at 8/4 deliberately, and not because it wins everywhere — it does not.
 * Hybrid is the default mode, and 8/4 holds the best hybrid recall@5 of the
 * three, which is the metric an agent reading five results actually feels.
 * 4/2 is close to a straight upgrade on everything else and is the change to
 * make if `vector` mode becomes the one people use, or if hybrid recall stops
 * being the number to protect. That is a product decision, not a sweep result,
 * which is why the sweep is recorded here rather than acted on.
 *
 * Smaller windows are also what a static embedding model would need to be
 * viable; see the note on `DEFAULT_EMBEDDING_MODEL` for why that still loses.
 */
export const DEFAULT_WINDOW_SIZE = 8;
export const DEFAULT_WINDOW_STRIDE = 4;

interface RetrievalUnitPlan {
  start: MessageRow;
  end: MessageRow;
  content: string;
  searchableText: string;
  contentHash: string;
}

/**
 * The windows a session should have, keyed by unit id.
 *
 * Pure: the caller diffs this against what is stored. Unit ids are
 * deterministic content hashes, so the same messages always plan the same
 * ids, which is what lets unchanged windows survive a re-index untouched.
 */
export function planRetrievalUnits(
  sessionRef: string,
  messages: MessageRow[],
  windowSize: number,
  windowStride: number,
): Map<string, RetrievalUnitPlan> {
  const desired = new Map<string, RetrievalUnitPlan>();
  for (const window of buildMessageWindows(messages, windowSize, windowStride)) {
    const content = formatRetrievalUnitContent(sessionRef, window.messages);
    const searchableText = window.messages.map((message) => message.content).join("\n");
    const contentHash = hashParts([content]);
    const unitId = hashParts([
      "retrieval-unit",
      sessionRef,
      String(window.start.message_index),
      String(window.end.message_index),
      contentHash,
    ]);
    desired.set(unitId, {
      start: window.start,
      end: window.end,
      content,
      searchableText,
      contentHash,
    });
  }
  return desired;
}

function buildMessageWindows(
  messages: MessageRow[],
  windowSize: number,
  windowStride: number,
): Array<{ start: MessageRow; end: MessageRow; messages: MessageRow[] }> {
  const windows: Array<{ start: MessageRow; end: MessageRow; messages: MessageRow[] }> = [];
  for (let start = 0; start < messages.length; start += windowStride) {
    const slice = messages.slice(start, start + windowSize);
    if (slice.length === 0) {
      continue;
    }

    windows.push({
      start: slice[0],
      end: slice[slice.length - 1],
      messages: slice,
    });

    if (start + windowSize >= messages.length) {
      break;
    }
  }
  return windows;
}

function formatRetrievalUnitContent(sessionRef: string, messages: MessageRow[]): string {
  const lines = [
    `Session: ${sessionRef}`,
    `Chronological window: messages ${messages[0].message_index} through ${
      messages[messages.length - 1].message_index
    }`,
  ];

  for (const [index, message] of messages.entries()) {
    lines.push(
      [
        `Turn ${index + 1}/${messages.length}`,
        `message_index=${message.message_index}`,
        `${message.role} @ ${message.timestamp}`,
      ].join(" | "),
    );
    lines.push(message.content);
  }

  return lines.join("\n");
}

