import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotCliChunk } from "../types/scraper.js";
import { pathMatchesProject } from "../utils/project-scope.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";
import { recordDrift, withDriftReport } from "./drift-log.js";
import { fileHeadHash, resumeOffset } from "./base.js";
import { readJsonlLines } from "./jsonl-reader.js";
import type { FileCursor } from "../types/scraper.js";

const SCRAPER_NAME = "copilot-cli";

/**
 * Mutation shapes the copilot-cli scraper tolerates silently. Anything
 * outside this whitelist that drops records must warn.
 */
export const ACCEPTED_DEGRADATIONS = {
  /** Sessions root missing — Copilot CLI not installed. */
  missingSessionRoot: "~/.copilot/session-state directory absent",
  /** Session directory has no events.jsonl file yet — fresh session. */
  missingEventsJsonl: "session directory has no events.jsonl",
  /** Blank line in events.jsonl. */
  blankJsonlLine: "blank line in events.jsonl",
  /** Event with no extractable role — many event types (status, tool_call,
   *  subagent meta, etc.) legitimately have no role. */
  noRole: "event has no role — non-conversation event",
  /** Event with no extractable text content. */
  noContent: "event has role but no text content",
  /** Forward-compat unknown keys alongside known fields. */
  unknownFieldsAlongside: "extra keys alongside known event schema",
};

const ROLE_MAP: Record<string, CopilotCliChunk["role"]> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  system: "system",
  tool: "tool",
};

/**
 * Current Copilot CLI writes typed events ("user.message",
 * "assistant.message", "system.message") whose payload lives under `data`.
 * The event type itself carries the role.
 */
const EVENT_TYPE_ROLE_MAP: Record<string, CopilotCliChunk["role"]> = {
  "user.message": "user",
  "assistant.message": "assistant",
  "system.message": "system",
};

/**
 * Event types that carry a `data.content` payload but are not conversation.
 *
 * `data.content` is otherwise a reliable sign that a record holds a turn — of
 * the sixteen types a real store emits, only the three routed above and this
 * one carry it. Listing it is what lets an unrecognised type carrying that
 * payload be reported as drift without warning on every scan for something
 * deliberately skipped.
 */
const KNOWN_NON_CONVERSATION_TYPES = new Set(["system.notification"]);

function warnDrift(sourcePath: string, surprise: string, _recordsAffected: number): void {
  recordDrift(SCRAPER_NAME, sourcePath, surprise);
}

export class CopilotCliScraper extends AbstractScraper<CopilotCliChunk> {
  /** Resume points from the last scan; empty on a full sync. */
  private cursors: Record<string, FileCursor> = {};
  private updatedCursors: Record<string, FileCursor> = {};
  private resuming = false;

  readonly tool = "copilot-cli";

  constructor(
    private readonly sessionStateDir: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.sessionStateDir);
      return target.isDirectory();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.sessionStateDir];
  }

  async *scrape(since?: Date): AsyncIterable<CopilotCliChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* withDriftReport(SCRAPER_NAME, this.readAllSessions(cutoff, true), this.stateDir);
  }

  async *fullSync(): AsyncIterable<CopilotCliChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readAllSessions(new Date(0)), this.stateDir);
  }

  /** See the codex scraper: `fullSync` neither resumes nor records. */
  private async *readAllSessions(since: Date, resume = false): AsyncIterable<CopilotCliChunk> {
    this.cursors = resume ? ((await this.getLastScrapedPosition()).files ?? {}) : {};
    this.updatedCursors = {};
    this.resuming = resume;

    yield* this.readAllSessionsInner(since);

    if (resume && Object.keys(this.updatedCursors).length > 0) {
      await this.saveScrapedPosition({ files: this.updatedCursors });
    }
  }

  private async *readAllSessionsInner(since: Date): AsyncIterable<CopilotCliChunk> {
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(this.sessionStateDir);
    } catch {
      // ACCEPTED_DEGRADATIONS.missingSessionRoot
      return;
    }

    for (const sessionId of sessionDirs) {
      const sessionDir = join(this.sessionStateDir, sessionId);
      let dirStat;
      try {
        dirStat = await stat(sessionDir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const eventsPath = join(sessionDir, "events.jsonl");
      try {
        const eventsStat = await stat(eventsPath);
        if (!eventsStat.isFile()) continue;
      } catch {
        // ACCEPTED_DEGRADATIONS.missingEventsJsonl
        continue;
      }

      try {
        yield* this.readEventsFile(eventsPath, sessionId, since);
      } catch (err) {
        // One unreadable session must not abort the remaining sessions.
        warnDrift(eventsPath, `unreadable transcript file: ${(err as Error).message}`, 0);
      }
    }
  }

  private async *readEventsFile(
    filePath: string,
    sessionId: string,
    since: Date,
  ): AsyncIterable<CopilotCliChunk> {
    // Resume where the last scan stopped; see the codex scraper for the guards.
    const size = await fileSize(filePath);
    const cursor = this.cursors[filePath];
    const checkHash =
      this.resuming && cursor ? await fileHeadHash(filePath, cursor.offset) : null;
    const startAt = size === null ? 0 : resumeOffset(cursor, size, checkHash ?? undefined);
    if (size !== null && startAt > 0 && startAt >= size) {
      return;
    }

    const resumed = startAt > 0 ? cursor?.context : undefined;

    let messageIndex = resumed?.messageIndex ?? 0;
    let lineNo = 0;
    // null = no session.start context seen yet; only consulted when scoped.
    // Carried across a resume: it is set by the `session.start` record at the
    // head of the file, which a resumed read never sees again.
    let projectMatch: boolean | null = resumed ? resumed.projectMatched : null;
    let gitBranch: string | undefined = resumed?.gitBranch;
    let gitCommit: string | undefined = resumed?.gitCommit;
    let readTo = startAt;

    for await (const entry of readJsonlLines(filePath, { start: startAt })) {
      readTo = entry.endOffset;
      lineNo++;
      const line = entry.line;
      if (line === null) {
        warnDrift(filePath, `line exceeds the cap; skipped`, lineNo);
        continue;
      }
      if (!line.trim()) {
        // ACCEPTED_DEGRADATIONS.blankJsonlLine
        continue;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        warnDrift(
          `${filePath}:${lineNo}`,
          `events.jsonl line is not valid JSON: ${(err as Error).message}`,
          1,
        );
        continue;
      }

      if (!isRecord(event)) {
        warnDrift(
          `${filePath}:${lineNo}`,
          `events.jsonl line is not an object (got ${describeType(event)})`,
          1,
        );
        continue;
      }

      if (event.type === "session.start") {
        // Recorded by the CLI at session start, so it is the branch the work
        // happened on rather than whatever is checked out at index time.
        const context = isRecord(event.data) ? event.data.context : undefined;
        if (isRecord(context)) {
          gitBranch = toOptionalString(context.branch);
          gitCommit = toOptionalString(context.headCommit);
        }
      }

      if (this.projectRoot && event.type === "session.start") {
        projectMatch = sessionStartMatchesProject(event, this.projectRoot);
        if (projectMatch === false) {
          // Another project's session; nothing in this file belongs here.
          return;
        }
        continue;
      }

      const role = extractRole(event);
      const content = extractContent(event);

      if (!role) {
        // If the event looks like a conversation message (has extractable
        // content AND a 'message' or 'role'-shaped sibling that we COULDN'T
        // route), warn — likely a rename. Routine non-conversation events
        // (status, tool_call, etc.) carry no content and are silent.
        if (content) {
          // `data.content` is where a turn's text lives, so a record carrying
          // it that could not be routed has lost its type — which is what a
          // renamed `type` field looks like, and it took every turn in the
          // session with it. The three legacy markers below could not see
          // that: none of them appear in the format Copilot CLI now writes.
          const carriesTurnText =
            isRecord(event.data) &&
            typeof event.data.content === "string" &&
            !KNOWN_NON_CONVERSATION_TYPES.has(String(event.type));
          const looksLikeMessage =
            carriesTurnText ||
            event.type === "message" ||
            "role" in event ||
            (isRecord(event.message) && "role" in event.message);
          if (looksLikeMessage) {
            warnDrift(
              `${filePath}:${lineNo}`,
              "event has content but no readable role — likely role-field rename",
              1,
            );
          }
        }
        // ACCEPTED_DEGRADATIONS.noRole — non-conversation events are
        // routine in events.jsonl. Skip silently.
        continue;
      }

      if (!content) {
        // Role is present but no content extractable. If a 'content' key
        // exists in an unexpected shape (null, number, etc.), warn — silent
        // skip would hide a content-field retype. A genuinely-missing content
        // key on a role'd event is unusual but not necessarily drift.
        if ("content" in event && typeof event.content !== "string" && !Array.isArray(event.content)) {
          warnDrift(
            `${filePath}:${lineNo}`,
            `event has role but 'content' is unexpected type ${describeType(event.content)}`,
            1,
          );
        } else if (
          // The same check for where the text actually lives in the current
          // format. Only the legacy top-level key was examined, so a
          // `data.content` that turned null dropped the turn in silence — and
          // `data.content` is the field every real turn uses.
          isRecord(event.data) &&
          "content" in event.data &&
          typeof event.data.content !== "string" &&
          !Array.isArray(event.data.content)
        ) {
          warnDrift(
            `${filePath}:${lineNo}`,
            `event has role but 'data.content' is unexpected type ${describeType(event.data.content)}`,
            1,
          );
        } else if (
          typeof event.type === "string" &&
          event.type in EVENT_TYPE_ROLE_MAP &&
          !isRecord(event.data)
        ) {
          // A turn-typed event with no payload object at all. Nothing narrower
          // catches a payload that moved wholesale — with `data` gone there is
          // no field left to find surprising, and the turn vanished silently.
          //
          // The `data` check is what keeps this honest: 77 assistant.message
          // records in one real session carry a `data` holding a tool call and
          // no text, which is ordinary. Warning on "no readable content" alone
          // reported all of them as drift on the first live scan.
          warnDrift(
            `${filePath}:${lineNo}`,
            `${event.type} has no 'data' payload — the field may have been renamed`,
            1,
          );
        }
        // ACCEPTED_DEGRADATIONS.noContent
        continue;
      }

      if (this.projectRoot && projectMatch === null) {
        // Fail closed: without session.start context this session cannot be
        // attributed to a project, so scoped indexing must not include it.
        warnDrift(
          filePath,
          "session has no session.start context; cannot attribute to a project — skipped under project scoping",
          1,
        );
        return;
      }

      const tsValue = event.timestamp ?? event.created_at ?? event.createdAt ?? event.time;
      const timestamp = toDate(tsValue);
      if (since.getTime() > 0 && timestamp <= since) {
        messageIndex++;
        continue;
      }

      const eventType = typeof event.type === "string" ? event.type : undefined;

      yield {
        tool: "copilot-cli",
        sessionId,
        timestamp,
        role,
        content,
        metadata: {
          messageIndex,
          tokenEstimate: estimateTokens(content),
          referencedFiles: [],
          eventType,
          gitBranch,
          gitCommit,
        },
      };
      messageIndex++;
    }

    // Only once the file has been read through, so an interrupted read never
    // records a position past what it delivered.
    if (this.resuming && size !== null) {
      const headHash = await fileHeadHash(filePath, readTo);
      this.updatedCursors[filePath] = {
        offset: readTo,
        size,
        ...(headHash ? { headHash } : {}),
        context: {
          sessionId,
          messageIndex,
          // `false` only when scoping actually rejected this file; an
          // undecided `null` means no session.start was seen, and the
          // unscoped default is to accept.
          projectMatched: projectMatch ?? true,
          gitBranch,
          gitCommit,
        },
      };
    }
  }
}

function extractRole(event: Record<string, unknown>): CopilotCliChunk["role"] | null {
  // Try event.role first.
  if (typeof event.role === "string") {
    const mapped = ROLE_MAP[event.role.toLowerCase()];
    if (mapped) return mapped;
  }

  // Try event.message.role.
  const message = event.message;
  if (isRecord(message) && typeof message.role === "string") {
    const mapped = ROLE_MAP[message.role.toLowerCase()];
    if (mapped) return mapped;
  }

  // Typed events: event.data.role, then the role implied by the event type.
  const data = event.data;
  if (isRecord(data) && typeof data.role === "string") {
    const mapped = ROLE_MAP[data.role.toLowerCase()];
    if (mapped) return mapped;
  }
  if (typeof event.type === "string") {
    const mapped = EVENT_TYPE_ROLE_MAP[event.type];
    if (mapped) return mapped;
  }

  return null;
}

function sessionStartMatchesProject(
  event: Record<string, unknown>,
  projectRoot: string,
): boolean {
  const data = event.data;
  if (!isRecord(data)) return false;
  const context = data.context;
  if (!isRecord(context)) return false;
  const candidates = [context.cwd, context.gitRoot].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return candidates.some((candidate) => pathMatchesProject(candidate, projectRoot));
}

function extractContent(event: Record<string, unknown>): string | undefined {
  // 1. event.content as string.
  if (typeof event.content === "string") {
    const trimmed = event.content.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // 2. event.text as string.
  if (typeof event.text === "string") {
    const trimmed = event.text.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // 3. event.message.content as string or array of {type, text}.
  const message = event.message;
  if (isRecord(message)) {
    const inner = message.content;
    if (typeof inner === "string") {
      const trimmed = inner.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(inner)) {
      const texts = inner
        .map((item) => {
          if (typeof item === "string") return item;
          if (isRecord(item) && typeof item.text === "string") return item.text;
          return "";
        })
        .filter((t) => t.length > 0);
      const joined = texts.join("\n").trim();
      if (joined.length > 0) return joined;
    }
  }

  // 4. event.content as array of {type, text}.
  if (Array.isArray(event.content)) {
    const texts = event.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter((t) => t.length > 0);
    const joined = texts.join("\n").trim();
    if (joined.length > 0) return joined;
  }

  // 5. Typed events: event.data.content / event.data.text.
  const data = event.data;
  if (isRecord(data)) {
    if (typeof data.content === "string") {
      const trimmed = data.content.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(data.content)) {
      const texts = data.content
        .map((item) => {
          if (typeof item === "string") return item;
          if (isRecord(item) && typeof item.text === "string") return item.text;
          return "";
        })
        .filter((t) => t.length > 0);
      const joined = texts.join("\n").trim();
      if (joined.length > 0) return joined;
    }
    if (typeof data.text === "string") {
      const trimmed = data.text.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  return undefined;
}

/** A non-empty string, or nothing. An empty branch is no branch. */
function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Size in bytes, or null when it cannot be read — in which case do not resume. */
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}
