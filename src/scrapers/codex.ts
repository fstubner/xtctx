import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { glob } from "glob";
import type { CodexChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";
import { pathMatchesProject } from "../utils/project-scope.js";

const SCRAPER_NAME = "codex";

/**
 * Mutation shapes the codex scraper tolerates silently. Anything outside
 * this whitelist that causes records to be dropped must warn.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Sessions path missing — codex CLI simply not installed. */
  missingSessionsPath: "codex sessions directory absent",
  /** Blank / malformed JSONL line — we warn but keep reading. */
  malformedJsonlLine: "JSONL line not parseable — warned, not fatal",
  /** Event types we intentionally ignore (tool calls, meta-only events). */
  nonMessageEventType: "event is not a conversation message",
  /** response_item that carries a non-assistant role (system-injected context). */
  systemInjectedUserRole: "response_item with role != assistant",
  /** Forward-compat unknown siblings on a known event. */
  unknownFieldsAlongside: "extra keys alongside known event schema",
};

const KNOWN_EVENT_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
  "compacted",
]);

function warnDrift(sourcePath: string, surprise: string, recordsAffected: number): void {
  console.warn(
    `[${SCRAPER_NAME}] schema-drift surprise at ${sourcePath}: ${surprise} ` +
      `(records affected: ${recordsAffected})`,
  );
}

const ROLE_MAP: Record<string, CodexChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

type ApprovalMode = CodexChunk["metadata"]["approvalMode"];

export class CodexCliScraper extends AbstractScraper<CodexChunk> {
  readonly tool = "codex";

  constructor(
    private readonly codexSessionsPath: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.codexSessionsPath);
      return target.isDirectory() || target.isFile();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.codexSessionsPath];
  }

  async *scrape(since?: Date): AsyncIterable<CodexChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<CodexChunk> {
    yield* this.readAllSessions(new Date(0));
  }

  parseRaw(raw: unknown): CodexChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";
    const role = normalizeRole(toStringValue(value.role) ?? toStringValue(value.type));

    return {
      tool: "codex",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role,
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: [],
        approvalMode: normalizeApprovalMode(toStringValue(value.approvalMode)),
        sandboxed: toBoolean(value.sandboxed),
        layer: toMessageIndex(value.layer),
      },
    };
  }

  /**
   * Processes Codex JSONL session files, which use an event-stream format.
   *
   * Each line is a JSON event with `type` ∈ {session_meta, turn_context,
   * response_item, event_msg, compacted}. Conversation messages live inside
   * `response_item` events where `payload.type === "message"`.
   *
   * Session-level state (session ID, approval mode, sandbox flag) is tracked
   * across events so that every message chunk carries accurate metadata.
   */
  private async *readAllSessions(since: Date): AsyncIterable<CodexChunk> {
    const files = await this.resolveJsonlFiles();

    for (const filePath of files) {
      const sessionIdFromFile = inferSessionId(filePath);
      const reader = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      // Session-level state, updated as we encounter meta/context events.
      let sessionId = sessionIdFromFile;
      let approvalMode: ApprovalMode = "suggest";
      let sandboxed = false;
      let messageIndex = 0;
      let projectMatched = this.projectRoot ? false : true;

      for await (const line of reader) {
        if (!line.trim()) {
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
          warnDrift(
            filePath,
            `JSONL line not parseable: ${(err as Error).message}`,
            1,
          );
          continue;
        }

        const eventType = toStringValue(parsed.type);

        // Strict-mode drift detection: an event with no readable 'type' is a
        // surprise — Codex always stamps one. A null/missing/renamed 'type'
        // means we cannot route the event and will silently lose data
        // otherwise.
        if (eventType === undefined) {
          warnDrift(
            filePath,
            `event has no readable 'type' field (got ${describeType(parsed.type)})`,
            1,
          );
          continue;
        }

        if (!KNOWN_EVENT_TYPES.has(eventType)) {
          // Unknown event type — could be a new event kind added by a newer
          // codex version. Warn so drift is observable; continue reading.
          warnDrift(filePath, `unknown event type '${eventType}'`, 1);
          continue;
        }

        // session_meta carries the canonical session UUID.
        if (eventType === "session_meta") {
          const payload = parsed.payload;
          if (isRecord(payload)) {
            sessionId = toStringValue(payload.id) ?? sessionIdFromFile;
            const match = this.matchesProject(payload.cwd);
            if (match === false) {
              break;
            }
            projectMatched = match ?? projectMatched;
          }
          continue;
        }

        // turn_context carries the approval policy and sandbox mode.
        if (eventType === "turn_context") {
          const payload = parsed.payload;
          if (isRecord(payload)) {
            const match = this.matchesProject(payload.cwd);
            if (match === false) {
              break;
            }
            projectMatched = match ?? projectMatched;
            approvalMode =
              normalizeApprovalMode(toStringValue(payload.approval_policy)) ?? approvalMode;
            const sandboxPolicy = payload.sandbox_policy;
            sandboxed =
              isRecord(sandboxPolicy) && toStringValue(sandboxPolicy.type) !== "none";
          }
          continue;
        }

        if (!projectMatched) {
          continue;
        }

        // Actual user messages arrive as event_msg with type "user_message".
        // response_item events with role "user" are system-injected context
        // (AGENTS.md, permissions, environment) and are intentionally skipped.
        if (eventType === "event_msg") {
          const payload = parsed.payload;
          if (!isRecord(payload)) {
            warnDrift(
              filePath,
              `event_msg payload is not an object (got ${describeType(payload)})`,
              1,
            );
            continue;
          }
          if (payload.type !== "user_message") {
            // Could be a new message sub-type — warn so drift is visible.
            if (!("type" in payload)) {
              warnDrift(
                filePath,
                "event_msg payload missing 'type' key — likely renamed",
                1,
              );
            }
            continue;
          }

          const content = toStringValue(payload.message);
          if (!content) {
            messageIndex++;
            continue;
          }

          const timestamp = toDate(parsed.timestamp ?? parsed.created_at ?? parsed.createdAt);
          if (timestamp <= since) {
            messageIndex++;
            continue;
          }

          yield this.parseRaw({
            sessionId,
            messageIndex,
            timestamp,
            role: "user",
            content,
            approvalMode,
            sandboxed,
          });
          messageIndex++;
          continue;
        }

        // compacted events hold AI-generated summaries of prior turns that were
        // removed from the active context window to save space. They represent
        // a higher-abstraction view of the conversation (layer 1).
        if (eventType === "compacted") {
          const payload = parsed.payload;
          const content = isRecord(payload)
            ? (toStringValue(payload.summary) ??
              toStringValue(payload.content) ??
              toStringValue(payload.text))
            : undefined;

          if (content) {
            const timestamp = toDate(parsed.timestamp ?? parsed.created_at ?? parsed.createdAt);
            if (timestamp > since) {
              yield this.parseRaw({
                sessionId,
                messageIndex,
                timestamp,
                role: "assistant",
                content,
                approvalMode,
                sandboxed,
                layer: 1,
              });
              messageIndex++;
            }
          }
          continue;
        }

        // Only assistant messages from response_item events are conversation turns.
        if (eventType !== "response_item") continue;

        const payload = parsed.payload;
        if (!isRecord(payload)) {
          warnDrift(
            filePath,
            `response_item payload is not an object (got ${describeType(payload)})`,
            1,
          );
          continue;
        }
        if (payload.type !== "message") {
          if (!("type" in payload)) {
            warnDrift(
              filePath,
              "response_item payload missing 'type' key — likely renamed",
              1,
            );
          }
          continue;
        }

        // Skip system-injected context which Codex sends as "user" role items.
        const role = toStringValue(payload.role);
        if (role !== "assistant") {
          if (!("role" in payload)) {
            warnDrift(
              filePath,
              "response_item message payload missing 'role' key",
              1,
            );
          }
          messageIndex++;
          continue;
        }

        // Extract text from the content-part array (or plain string fallback).
        const content = extractContent(payload.content);
        if (!content) {
          messageIndex++;
          continue;
        }

        const timestamp = toDate(parsed.timestamp ?? parsed.created_at ?? parsed.createdAt);
        if (timestamp <= since) {
          messageIndex++;
          continue;
        }

        yield this.parseRaw({
          sessionId,
          messageIndex,
          timestamp,
          role,
          content,
          approvalMode,
          sandboxed,
        });
        messageIndex++;
      }
    }
  }

  private matchesProject(value: unknown): boolean | undefined {
    if (!this.projectRoot) {
      return true;
    }
    const cwd = toStringValue(value);
    return cwd ? pathMatchesProject(cwd, this.projectRoot) : undefined;
  }

  /**
   * Recursively resolves JSONL files under the sessions directory.
   * Codex stores sessions in year/month/day subdirectories.
   */
  private async resolveJsonlFiles(): Promise<string[]> {
    try {
      const target = await stat(this.codexSessionsPath);
      if (target.isFile()) {
        return this.codexSessionsPath.endsWith(".jsonl") ? [this.codexSessionsPath] : [];
      }

      if (!target.isDirectory()) {
        return [];
      }

      return await glob("**/*.jsonl", {
        cwd: this.codexSessionsPath,
        absolute: true,
        nodir: true,
      });
    } catch {
      return [];
    }
  }
}

/**
 * Extracts text from a Codex content-part value.
 * Content is an array of {type, text} objects or a plain string.
 */
function extractContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((item) => (isRecord(item) ? toStringValue(item.text) : undefined))
      .filter((t): t is string => t !== undefined);
    const joined = texts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  }

  return undefined;
}

function normalizeRole(value?: string): CodexChunk["role"] {
  if (!value) {
    return "system";
  }

  return ROLE_MAP[value.toLowerCase()] ?? "system";
}

function normalizeApprovalMode(value?: string): ApprovalMode {
  switch (value) {
    case "auto-edit":
      return "auto-edit";
    case "full-auto":
      return "full-auto";
    default:
      return "suggest";
  }
}

function inferSessionId(filePath: string): string {
  return basename(filePath).replace(".jsonl", "") || "unknown";
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }

  return 0;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
