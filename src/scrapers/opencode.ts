import { stat } from "node:fs/promises";
import type { OpenCodeChunk } from "../types/scraper.js";
import { pathMatchesProject } from "../utils/project-scope.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

const SCRAPER_NAME = "opencode";

/**
 * Mutation shapes the opencode scraper tolerates silently. Anything outside
 * this whitelist that drops records must warn (or throw for required tables).
 */
export const ACCEPTED_DEGRADATIONS = {
  /** opencode.db missing — opencode CLI not installed on this machine. */
  missingDatabase: "opencode database absent",
  /** better-sqlite3 native module unavailable — opt-in peer dep. */
  missingSqliteBinding: "better-sqlite3 native module unavailable",
  /** Sessions table empty — pristine opencode install. */
  emptySessions: "no sessions in opencode database",
  /** A part with no extractable text (file, snapshot, step events). */
  nonTextPart: "part is not a text/reasoning part",
  /** Reasoning parts on assistant messages — internal model thoughts; skipped by default. */
  reasoningPart: "reasoning part skipped (internal thought)",
  /** Forward-compat unknown keys alongside known fields. */
  unknownFieldsAlongside: "extra keys alongside known opencode schema",
  /** A message data row that fails to parse as JSON — skip with warn. */
  malformedMessageData: "Message.data not parseable JSON",
  /** A part data row that fails to parse as JSON — skip with warn. */
  malformedPartData: "Part.data not parseable JSON",
};

function warnDrift(sourcePath: string, surprise: string, recordsAffected: number): void {
  console.warn(
    `[${SCRAPER_NAME}] schema-drift surprise at ${sourcePath}: ${surprise} ` +
      `(records affected: ${recordsAffected})`,
  );
}

interface SessionRow {
  id: string;
  time_created: number;
  title: string | null;
  directory: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface MessageData {
  role?: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  model?: { providerID?: string; modelID?: string };
  time?: { created?: number };
}

interface PartData {
  type?: string;
  text?: string;
}

export class OpenCodeScraper extends AbstractScraper<OpenCodeChunk> {
  readonly tool = "opencode";

  constructor(
    private readonly opencodeDbPath: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.opencodeDbPath);
      return target.isFile();
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.opencodeDbPath];
  }

  async *scrape(since?: Date): AsyncIterable<OpenCodeChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* this.readAllSessions(cutoff);
  }

  async *fullSync(): AsyncIterable<OpenCodeChunk> {
    yield* this.readAllSessions(new Date(0));
  }

  private async *readAllSessions(since: Date): AsyncIterable<OpenCodeChunk> {
    try {
      const target = await stat(this.opencodeDbPath);
      if (!target.isFile()) {
        return;
      }
    } catch {
      // ACCEPTED_DEGRADATIONS.missingDatabase
      return;
    }

    type DatabaseConstructor = new (
      path: string,
      options?: import("better-sqlite3").Options,
    ) => import("better-sqlite3").Database;
    let Database: DatabaseConstructor | undefined;
    try {
      // Dynamic import so the module remains optional at startup.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Database = ((await import("better-sqlite3")) as any).default as DatabaseConstructor;
    } catch {
      // ACCEPTED_DEGRADATIONS.missingSqliteBinding
      return;
    }
    if (!Database) return;

    let db: import("better-sqlite3").Database;
    try {
      db = new Database(this.opencodeDbPath, { readonly: true, fileMustExist: true });
    } catch {
      // ACCEPTED_DEGRADATIONS.missingDatabase
      return;
    }

    try {
      yield* this.readFromDb(db, since);
    } finally {
      db.close();
    }
  }

  private *readFromDb(
    db: import("better-sqlite3").Database,
    since: Date,
  ): Iterable<OpenCodeChunk> {
    let sessions: SessionRow[];
    try {
      sessions = db
        .prepare(
          "SELECT id, time_created, title, directory FROM session ORDER BY time_created ASC",
        )
        .all() as SessionRow[];
    } catch {
      // Older opencode schemas may lack the directory column; retry without it.
      try {
        sessions = (
          db
            .prepare("SELECT id, time_created, title FROM session ORDER BY time_created ASC")
            .all() as Omit<SessionRow, "directory">[]
        ).map((row) => ({ ...row, directory: null }));
      } catch (err) {
        warnDrift(
          this.opencodeDbPath,
          `session table query failed: ${(err as Error).message}`,
          0,
        );
        return;
      }
    }

    if (this.projectRoot) {
      const root = this.projectRoot;
      // Fail closed: a session with no directory cannot be attributed to a
      // project, so scoped indexing must never include it.
      const unattributable = sessions.filter((session) => session.directory === null).length;
      if (unattributable > 0) {
        warnDrift(
          this.opencodeDbPath,
          "sessions without a 'directory' value cannot be attributed to a project; skipped under project scoping",
          unattributable,
        );
      }
      sessions = sessions.filter(
        (session) => session.directory !== null && pathMatchesProject(session.directory, root),
      );
    }

    if (sessions.length === 0) {
      // ACCEPTED_DEGRADATIONS.emptySessions
      return;
    }

    let getMessages: import("better-sqlite3").Statement;
    let getParts: import("better-sqlite3").Statement;
    try {
      getMessages = db.prepare(
        "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
      );
      getParts = db.prepare(
        "SELECT id, message_id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC",
      );
    } catch (err) {
      warnDrift(
        this.opencodeDbPath,
        `message/part table prepare failed: ${(err as Error).message}`,
        sessions.length,
      );
      return;
    }

    for (const session of sessions) {
      let messages: MessageRow[];
      try {
        messages = getMessages.all(session.id) as MessageRow[];
      } catch (err) {
        warnDrift(
          `${this.opencodeDbPath}#session:${session.id}`,
          `message query failed: ${(err as Error).message}`,
          0,
        );
        continue;
      }

      let messageIndex = 0;
      for (const msg of messages) {
        let msgData: MessageData;
        try {
          msgData = JSON.parse(msg.data) as MessageData;
        } catch (err) {
          warnDrift(
            `${this.opencodeDbPath}#message:${msg.id}`,
            `message.data not parseable JSON: ${(err as Error).message}`,
            1,
          );
          continue;
        }

        if (!isRecord(msgData as unknown)) {
          warnDrift(
            `${this.opencodeDbPath}#message:${msg.id}`,
            `message.data is not an object (got ${describeType(msgData)})`,
            1,
          );
          continue;
        }

        if (!("role" in (msgData as Record<string, unknown>))) {
          warnDrift(
            `${this.opencodeDbPath}#message:${msg.id}`,
            "message.data missing 'role' field — likely renamed",
            1,
          );
          continue;
        }
        if (typeof msgData.role !== "string") {
          warnDrift(
            `${this.opencodeDbPath}#message:${msg.id}`,
            `expected 'role' to be a string, got ${describeType(msgData.role)}`,
            1,
          );
          continue;
        }
        const role = normalizeRole(msgData.role);

        // Timestamp: prefer msgData.time.created, fall back to msg.time_created.
        const tsValue = msgData.time?.created ?? msg.time_created;
        const timestamp = toDate(tsValue);
        if (since.getTime() > 0 && timestamp <= since) {
          messageIndex++;
          continue;
        }

        let parts: PartRow[];
        try {
          parts = getParts.all(msg.id) as PartRow[];
        } catch (err) {
          warnDrift(
            `${this.opencodeDbPath}#message:${msg.id}`,
            `part query failed: ${(err as Error).message}`,
            0,
          );
          messageIndex++;
          continue;
        }

        const textSegments: string[] = [];
        for (const part of parts) {
          let partData: PartData;
          try {
            partData = JSON.parse(part.data) as PartData;
          } catch (err) {
            warnDrift(
              `${this.opencodeDbPath}#part:${part.id}`,
              `part.data not parseable JSON: ${(err as Error).message}`,
              1,
            );
            continue;
          }

          if (!isRecord(partData as unknown)) {
            warnDrift(
              `${this.opencodeDbPath}#part:${part.id}`,
              `part.data is not an object (got ${describeType(partData)})`,
              1,
            );
            continue;
          }

          // Only text parts contribute to conversation content. Reasoning,
          // tool-call, file, snapshot, step etc. are skipped silently.
          if (partData.type === "text") {
            const text = typeof partData.text === "string" ? partData.text : "";
            if (text.length > 0) {
              textSegments.push(text);
            }
            continue;
          }

          // ACCEPTED_DEGRADATIONS.nonTextPart / reasoningPart — silent skip.
        }

        const content = textSegments.join("\n").trim();
        if (!content) {
          messageIndex++;
          continue;
        }

        const model = msgData.modelID ?? msgData.model?.modelID;
        const providerID = msgData.providerID ?? msgData.model?.providerID;

        yield {
          tool: "opencode",
          sessionId: session.id,
          timestamp,
          role,
          content,
          metadata: {
            messageIndex,
            tokenEstimate: estimateTokens(content),
            referencedFiles: [],
            agent: typeof msgData.agent === "string" ? msgData.agent : undefined,
            model,
            providerID,
          },
        };
        messageIndex++;
      }
    }
  }
}

function normalizeRole(value: unknown): OpenCodeChunk["role"] {
  if (typeof value !== "string") return "system";
  switch (value.toLowerCase()) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "ai":
      return "assistant";
    case "tool":
      return "tool";
    case "system":
      return "system";
    default:
      return "system";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
