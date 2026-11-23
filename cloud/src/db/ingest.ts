import { createHash } from "node:crypto";
import type { AuthUser, CloudContext, UploadLimits } from "../types.js";
import {
  countCodePoints,
  redactHighConfidenceSecrets,
  sanitizeMetadataForJsonb,
  scrubNullBytes,
  scrubNullToSpace,
} from "../redact.js";
import { withUserDb } from "./pool.js";

/**
 * Default upload bounds for Postgres-backed ingestion.
 * Configurable via environment (e.g. MAX_UPLOAD_BODY_BYTES / MAX_UPLOAD_MESSAGE_BYTES)
 * for single-user self-hosters who need larger payloads.
 */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBodyBytes: 8 * 1024 * 1024,
  maxMessageBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024,
  maxSessionsPerRequest: 10,
  maxMessagesPerRequest: 500,
};

/** Backwards-compatible alias for legacy unit tests/imports. */
export const LIMITS = DEFAULT_UPLOAD_LIMITS;

const ROLES = new Set(["user", "assistant", "system", "tool"]);
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOCAL_ID = /^[0-9a-f]{16,64}$/;

export interface UploadMessage {
  id: string;
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  messageIndex: number;
  contentHash: string;
  metadataJson: string;
}

export interface UploadSession {
  tool: string;
  sourceSessionId: string;
  gitBranch: string | null;
  gitCommit: string | null;
  startedAt: string;
  lastActivityAt: string;
  preview: string | null;
  messages: UploadMessage[];
  keepIds?: string[];
}

export interface UploadBody {
  device: { id: string; name: string };
  project: { repoUrl: string; name: string };
  sessions: UploadSession[];
}

export type ParseResult =
  | { ok: true; body: UploadBody }
  | { ok: false; status: 400 | 413 | 426; error: Record<string, unknown> };

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an upload body and apply server-side secret redaction as a backstop.
 * Any oversized message produces a 413 naming that exact message so the client
 * can skip it cleanly without losing the rest of the sync stream.
 */
export function parseUpload(
  input: unknown,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): ParseResult {
  const bad = (detail: string): ParseResult => ({
    ok: false,
    status: 400,
    error: { error: "invalid_request", detail },
  });

  if (Array.isArray(input)) {
    return {
      ok: false,
      status: 426,
      error: {
        error: "client_outdated",
        detail: "Update xtctx: this server takes the v2 upload format.",
      },
    };
  }
  if (!isObject(input)) return bad("body must be an object");

  const text = (v: unknown, max = 512): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  const optionalText = (v: unknown, max = 512) =>
    v === undefined || v === null || text(v, max);

  const { device, project, sessions } = input;
  if (!isObject(device) || !text(device.id, 128) || !text(device.name, 128)) return bad("device");
  if (!isObject(project) || !text(project.repoUrl, 512) || !text(project.name, 256)) return bad("project");
  if (!Array.isArray(sessions) || sessions.length > limits.maxSessionsPerRequest) return bad("sessions");

  let messageTotal = 0;
  const out: UploadSession[] = [];
  for (const s of sessions) {
    if (!isObject(s)) return bad("session");
    if (!text(s.tool, 40) || !TOOL_ID.test(s.tool) || !text(s.sourceSessionId, 256)) return bad("session id");
    if (!text(s.startedAt, 64) || !text(s.lastActivityAt, 64)) return bad("session times");
    if (!optionalText(s.gitBranch) || !optionalText(s.gitCommit) || !optionalText(s.preview, 4096)) {
      return bad("session fields");
    }
    if (!Array.isArray(s.messages)) return bad("messages");
    messageTotal += s.messages.length;
    if (messageTotal > limits.maxMessagesPerRequest) return bad("too many messages in one request");

    const messages: UploadMessage[] = [];
    for (const m of s.messages) {
      if (!isObject(m)) return bad("message");
      if (!text(m.id, 64) || !LOCAL_ID.test(m.id)) return bad("message id");
      if (!text(m.timestamp, 64) || !ROLES.has(m.role as string) || typeof m.content !== "string") {
        return bad("message fields");
      }
      if (!Number.isInteger(m.messageIndex) || !text(m.contentHash, 128)) return bad("message fields");
      const metadataJson = m.metadataJson === undefined ? "{}" : m.metadataJson;
      if (typeof metadataJson !== "string") return bad("metadataJson");
      if (byteLength(m.content) > limits.maxMessageBytes || byteLength(metadataJson) > limits.maxMetadataBytes) {
        return {
          ok: false,
          status: 413,
          error: {
            error: "message_too_large",
            limit: limits.maxMessageBytes,
            tool: s.tool,
            sourceSessionId: s.sourceSessionId,
            messageId: m.id,
          },
        };
      }
      messages.push({
        id: m.id,
        timestamp: m.timestamp,
        role: m.role as UploadMessage["role"],
        content: redactHighConfidenceSecrets(m.content),
        messageIndex: m.messageIndex as number,
        contentHash: m.contentHash,
        metadataJson,
      });
    }

    let keepIds: string[] | undefined;
    if (s.keepIds !== undefined) {
      if (!Array.isArray(s.keepIds) || !s.keepIds.every((id) => typeof id === "string" && LOCAL_ID.test(id))) {
        return bad("keepIds");
      }
      keepIds = s.keepIds as string[];
    }

    out.push({
      tool: s.tool,
      sourceSessionId: s.sourceSessionId,
      gitBranch: (s.gitBranch as string | undefined) ?? null,
      gitCommit: (s.gitCommit as string | undefined) ?? null,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      preview: typeof s.preview === "string" ? redactHighConfidenceSecrets(s.preview).slice(0, 160) : null,
      messages,
      keepIds,
    });
  }

  return {
    ok: true,
    body: {
      device: { id: device.id, name: device.name },
      project: { repoUrl: project.repoUrl, name: project.name },
      sessions: out,
    },
  };
}

export function sessionRefFor(userId: string, tool: string, sourceSessionId: string): string {
  return `${userId}:${tool}:${sourceSessionId}`;
}

export interface IngestResult {
  success: true;
  sessions: Array<{ tool: string; sourceSessionId: string; messageCount: number }>;
}

/**
 * Persist one upload atomically inside one PostgreSQL RLS-scoped transaction.
 * Stores raw UTF-8 bytes in `content_bytes`, exact code-point counts, JSONB metadata,
 * `to_tsvector('simple')` for lexical search, and enqueues new/changed messages into `embedding_jobs`.
 */
export async function ingestUpload(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  user: AuthUser,
  body: UploadBody,
  clientVersion: string | null,
): Promise<IngestResult> {
  const deviceId = `${user.userId}:${body.device.id}`;

  return withUserDb(ctx, user.userId, async (client) => {
    await client.query(
      `INSERT INTO devices (id, user_id, device_name, last_seen_at, created_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         device_name = EXCLUDED.device_name,
         last_seen_at = EXCLUDED.last_seen_at
       WHERE devices.user_id = EXCLUDED.user_id`,
      [deviceId, user.userId, scrubNullBytes(body.device.name)],
    );

    const refs: string[] = [];
    for (const s of body.sessions) {
      const sessionRef = sessionRefFor(user.userId, s.tool, s.sourceSessionId);
      refs.push(sessionRef);

      await client.query(
        `INSERT INTO sessions (
           session_ref, user_id, device_id, tool, source_session_id, repo_url, project_root,
           git_branch, git_commit, started_at, last_activity_at, message_count, preview, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, now())
         ON CONFLICT (session_ref) DO UPDATE SET
           device_id = EXCLUDED.device_id,
           repo_url = EXCLUDED.repo_url,
           project_root = EXCLUDED.project_root,
           git_branch = COALESCE(EXCLUDED.git_branch, sessions.git_branch),
           git_commit = COALESCE(EXCLUDED.git_commit, sessions.git_commit),
           started_at = LEAST(sessions.started_at, EXCLUDED.started_at),
           last_activity_at = GREATEST(sessions.last_activity_at, EXCLUDED.last_activity_at),
           preview = COALESCE(EXCLUDED.preview, sessions.preview),
           updated_at = now()
         WHERE sessions.user_id = EXCLUDED.user_id`,
        [
          sessionRef,
          user.userId,
          deviceId,
          s.tool,
          scrubNullBytes(s.sourceSessionId),
          scrubNullBytes(body.project.repoUrl),
          scrubNullBytes(body.project.name),
          s.gitBranch ? scrubNullBytes(s.gitBranch) : null,
          s.gitCommit ? scrubNullBytes(s.gitCommit) : null,
          scrubNullBytes(s.startedAt),
          scrubNullBytes(s.lastActivityAt),
          s.preview !== null ? scrubNullBytes(s.preview) : null,
        ],
      );

      if (s.messages.length > 0) {
        // Deduplicate within one request so ON CONFLICT DO UPDATE never hits the same key twice.
        const deduped = new Map<string, UploadMessage>();
        for (const m of s.messages) {
          deduped.set(`${sessionRef}:${m.id}`, m);
        }

        const ids: string[] = [];
        const timestamps: string[] = [];
        const roles: string[] = [];
        const contentBytesArr: Buffer[] = [];
        const contentCharsArr: number[] = [];
        const contentShaArr: string[] = [];
        const indices: number[] = [];
        const contentHashes: string[] = [];
        const metadataJsonbArr: string[] = [];
        const metadataRawArr: string[] = [];
        const searchTextArr: string[] = [];

        for (const [fullId, m] of deduped) {
          const bytes = Buffer.from(m.content, "utf8");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          ids.push(fullId);
          timestamps.push(scrubNullBytes(m.timestamp));
          roles.push(m.role);
          contentBytesArr.push(bytes);
          contentCharsArr.push(countCodePoints(m.content));
          contentShaArr.push(sha256);
          indices.push(m.messageIndex);
          contentHashes.push(scrubNullBytes(m.contentHash));
          metadataJsonbArr.push(sanitizeMetadataForJsonb(m.metadataJson));
          metadataRawArr.push(scrubNullBytes(m.metadataJson));
          searchTextArr.push(scrubNullToSpace(m.content));
        }

        await client.query(
          `INSERT INTO messages (
             id, user_id, session_ref, tool, source_session_id, timestamp, role,
             content_bytes, content_chars, content_sha256, message_index, content_hash,
             metadata, metadata_raw, search_tsv, indexed_at
           )
           SELECT
             t.id, $1, $2, $3, $4, t.ts, t.role,
             t.content_bytes, t.content_chars, t.content_sha256, t.message_index, t.content_hash,
             t.metadata_json::jsonb, t.metadata_raw, to_tsvector('simple', t.search_text), now()
           FROM UNNEST(
             $5::text[],
             $6::text[],
             $7::text[],
             $8::bytea[],
             $9::int4[],
             $10::text[],
             $11::int4[],
             $12::text[],
             $13::text[],
             $14::text[],
             $15::text[]
           ) AS t(
             id, ts, role,
             content_bytes, content_chars, content_sha256, message_index, content_hash,
             metadata_json, metadata_raw, search_text
           )
           ON CONFLICT (id) DO UPDATE SET
             timestamp = EXCLUDED.timestamp,
             role = EXCLUDED.role,
             content_bytes = EXCLUDED.content_bytes,
             content_chars = EXCLUDED.content_chars,
             content_sha256 = EXCLUDED.content_sha256,
             message_index = EXCLUDED.message_index,
             content_hash = EXCLUDED.content_hash,
             metadata = EXCLUDED.metadata,
             metadata_raw = EXCLUDED.metadata_raw,
             search_tsv = EXCLUDED.search_tsv
           WHERE messages.user_id = EXCLUDED.user_id`,
          [
            user.userId,
            sessionRef,
            s.tool,
            scrubNullBytes(s.sourceSessionId),
            ids,
            timestamps,
            roles,
            contentBytesArr,
            contentCharsArr,
            contentShaArr,
            indices,
            contentHashes,
            metadataJsonbArr,
            metadataRawArr,
            searchTextArr,
          ],
        );

        // Drop stale vectors when message content changes so coverage counts stay accurate.
        await client.query(
          `DELETE FROM message_chunks mc
           USING UNNEST($1::text[], $2::text[]) AS t(id, content_sha256)
           WHERE mc.message_id = t.id
             AND mc.user_id = $3
             AND mc.content_sha256 IS DISTINCT FROM t.content_sha256`,
          [ids, contentShaArr, user.userId],
        );

        // Enqueue messages that lack up-to-date vector chunks.
        await client.query(
          `INSERT INTO embedding_jobs (message_id, user_id, content_sha256, attempts, next_attempt_at, last_error, updated_at)
           SELECT t.id, $1, t.content_sha256, 0, now(), NULL, now()
           FROM UNNEST($2::text[], $3::text[]) AS t(id, content_sha256)
           WHERE NOT EXISTS (
             SELECT 1 FROM message_chunks mc
             WHERE mc.message_id = t.id AND mc.content_sha256 = t.content_sha256
           )
           ON CONFLICT (message_id) DO UPDATE SET
             content_sha256 = EXCLUDED.content_sha256,
             attempts = 0,
             next_attempt_at = now(),
             last_error = NULL,
             updated_at = now()
           WHERE embedding_jobs.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256`,
          [user.userId, ids, contentShaArr],
        );
      }

      if (s.keepIds) {
        const fullKeepIds = s.keepIds.map((id) => `${sessionRef}:${id}`);
        if (fullKeepIds.length === 0) {
          await client.query("DELETE FROM messages WHERE session_ref = $1", [sessionRef]);
        } else {
          await client.query(
            "DELETE FROM messages WHERE session_ref = $1 AND NOT (id = ANY($2::text[]))",
            [sessionRef, fullKeepIds],
          );
        }
      }

      await client.query(
        `UPDATE sessions
         SET message_count = (SELECT COUNT(*)::int FROM messages WHERE messages.session_ref = sessions.session_ref)
         WHERE session_ref = $1 AND user_id = $2`,
        [sessionRef, user.userId],
      );
    }

    if (refs.length > 0) {
      await client.query(
        `INSERT INTO session_projects (session_ref, user_id, repo_url, device_id, project_name)
         SELECT ref, $1, $2, $3, $4
         FROM UNNEST($5::text[]) AS ref
         ON CONFLICT (session_ref, repo_url, device_id) DO UPDATE SET
           project_name = EXCLUDED.project_name`,
        [
          user.userId,
          scrubNullBytes(body.project.repoUrl),
          deviceId,
          scrubNullBytes(body.project.name),
          refs,
        ],
      );
    }

    await client.query(
      `INSERT INTO uploads (user_id, device_id, repo_url, project_name, last_upload_at, client_version)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (user_id, device_id, repo_url) DO UPDATE SET
         project_name = EXCLUDED.project_name,
         last_upload_at = EXCLUDED.last_upload_at,
         client_version = EXCLUDED.client_version`,
      [
        user.userId,
        deviceId,
        scrubNullBytes(body.project.repoUrl),
        scrubNullBytes(body.project.name),
        clientVersion ? scrubNullBytes(clientVersion) : null,
      ],
    );

    if (refs.length === 0) return { success: true, sessions: [] };

    const counted = await client.query<{
      tool: string;
      source_session_id: string;
      message_count: number;
    }>(
      `SELECT tool, source_session_id, message_count::int AS message_count
       FROM sessions
       WHERE user_id = $1 AND session_ref = ANY($2::text[])`,
      [user.userId, refs],
    );

    return {
      success: true,
      sessions: counted.rows.map((r) => ({
        tool: r.tool,
        sourceSessionId: r.source_session_id,
        messageCount: Number(r.message_count),
      })),
    };
  });
}
