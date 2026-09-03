import { createHash } from "node:crypto";
import type { SessionMessage } from "./types.js";

export interface MessageRow {
  id: string;
  timestamp: string;
  role: SessionMessage["role"];
  content: string;
  message_index: number;
  source_pointer: string | null;
}

export const DEFAULT_WINDOW_SIZE = 8;
export const DEFAULT_WINDOW_STRIDE = 4;

export interface RetrievalUnitPlan {
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

export function buildMessageWindows(
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

export function formatRetrievalUnitContent(sessionRef: string, messages: MessageRow[]): string {
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

export function hashParts(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}
