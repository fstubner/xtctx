import type { CompactedSession } from "../types/compaction.js";
import type { ConversationChunk } from "../types/scraper.js";

export interface RuleBasedCompactionOptions {
  sessionBoundaryMinutes?: number;
  summaryMaxLength?: number;
}

export function compactChunksRuleBased(
  chunks: ConversationChunk[],
  options: RuleBasedCompactionOptions = {},
): CompactedSession[] {
  if (chunks.length === 0) {
    return [];
  }

  const sessionBoundaryMinutes = options.sessionBoundaryMinutes ?? 30;
  const summaryMaxLength = options.summaryMaxLength ?? 220;
  const sorted = [...chunks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const groups = splitIntoLogicalSessions(sorted, sessionBoundaryMinutes);

  return groups.map((group, index) => buildCompactedSession(group, summaryMaxLength, index));
}

function splitIntoLogicalSessions(
  chunks: ConversationChunk[],
  sessionBoundaryMinutes: number,
): ConversationChunk[][] {
  const groups: ConversationChunk[][] = [];
  const boundaryMs = sessionBoundaryMinutes * 60_000;
  let current: ConversationChunk[] = [];

  for (const chunk of chunks) {
    const prev = current[current.length - 1];
    const toolChanged = prev && prev.tool !== chunk.tool;
    const sessionChanged = prev && prev.sessionId !== chunk.sessionId;
    const gapExceeded =
      prev && chunk.timestamp.getTime() - prev.timestamp.getTime() > boundaryMs;

    if (current.length > 0 && (toolChanged || sessionChanged || gapExceeded)) {
      groups.push(current);
      current = [];
    }

    current.push(chunk);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function buildCompactedSession(
  group: ConversationChunk[],
  summaryMaxLength: number,
  groupIndex: number,
): CompactedSession {
  const first = group[0];
  const last = group[group.length - 1];
  const filesModified = extractFileReferences(group.map((chunk) => chunk.content).join("\n"));
  const tasksCompleted = extractTasks(group);
  const decisionsIdentified = extractDecisions(group);
  const openQuestions = extractQuestions(group);
  const summary = summarizeGroup(group, summaryMaxLength);
  const chunkRefs = group.map((chunk, i) => `${chunk.sessionId}:${groupIndex}:${i}`);

  return {
    sessionId: `${first.sessionId}${groupIndex > 0 ? `#${groupIndex + 1}` : ""}`,
    tool: first.tool,
    timeRange: {
      start: first.timestamp.toISOString(),
      end: last.timestamp.toISOString(),
    },
    summary,
    tasksCompleted,
    decisionsIdentified,
    filesModified,
    openQuestions,
    chunkRefs,
    chunkCount: group.length,
    estimatedTokens: estimateTokens(group),
  };
}

function summarizeGroup(group: ConversationChunk[], summaryMaxLength: number): string {
  const userFirst =
    group.find((chunk) => chunk.role === "user")?.content.trim() ?? "Session activity captured.";
  const assistantLast =
    group
      .slice()
      .reverse()
      .find((chunk) => chunk.role === "assistant")
      ?.content.trim() ?? "";

  const combined = assistantLast
    ? `${userFirst} Outcome: ${assistantLast}`
    : userFirst;

  if (combined.length <= summaryMaxLength) {
    return combined;
  }

  return `${combined.slice(0, summaryMaxLength - 1)}…`;
}

function extractTasks(group: ConversationChunk[]): string[] {
  const taskSignals = /(done|implemented|fixed|created|added|updated|refactored)/i;
  const tasks = group
    .filter((chunk) => chunk.role === "assistant" && taskSignals.test(chunk.content))
    .map((chunk) => sentence(chunk.content));

  return unique(tasks);
}

function extractDecisions(group: ConversationChunk[]): string[] {
  const decisionSignals = /(decision|we (will|should)|choose|chosen|use\s+\w+)/i;
  const decisions = group
    .filter((chunk) => decisionSignals.test(chunk.content))
    .map((chunk) => sentence(chunk.content));

  return unique(decisions);
}

function extractQuestions(group: ConversationChunk[]): string[] {
  const questions = group
    .filter((chunk) => chunk.content.includes("?"))
    .map((chunk) => sentence(chunk.content))
    .filter((text) => text.includes("?"));

  return unique(questions);
}

function extractFileReferences(text: string): string[] {
  const regex =
    /\b([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(ts|tsx|js|jsx|json|yaml|yml|md|sql|css|vue)\b/g;

  const matches = text.match(regex);
  if (!matches) {
    return [];
  }

  return unique(matches);
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 140) {
    return trimmed;
  }
  return `${trimmed.slice(0, 139)}…`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function estimateTokens(chunks: ConversationChunk[]): number {
  return chunks.reduce((sum, chunk) => {
    const explicit = chunk.metadata.tokenEstimate;
    if (typeof explicit === "number" && explicit > 0) {
      return sum + explicit;
    }

    return sum + Math.ceil(chunk.content.length / 4);
  }, 0);
}
