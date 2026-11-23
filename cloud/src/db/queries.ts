import type { PoolClient } from "pg";
import type { CloudContext, MessageRecord, SessionRecord } from "../types.js";
import { sliceCodePoints } from "../redact.js";
import { withSystemDb, withUserDb } from "./pool.js";

const toIso = (val: unknown): string => (val instanceof Date ? val.toISOString() : String(val ?? ""));

const INJECTED_PREVIEW_RE =
  /^(?:# AGENTS\.md|<(?:environment_context|in-app-browser-context|send_user_message_question_reply|external_codex_apps)|used ToolSearch:|\{\s*"risk_level")/i;

function mapSessionRow(row: Record<string, unknown>, overrideRepoUrl?: string): SessionRecord {
  return {
    session_ref: String(row.session_ref),
    user_id: String(row.user_id),
    device_id: String(row.device_id),
    device_name: row.device_name === null || row.device_name === undefined ? null : String(row.device_name),
    tool: String(row.tool),
    source_session_id: String(row.source_session_id),
    repo_url: overrideRepoUrl ?? String(row.repo_url),
    project_root: String(row.project_root),
    git_branch: row.git_branch === null || row.git_branch === undefined ? null : String(row.git_branch),
    git_commit: row.git_commit === null || row.git_commit === undefined ? null : String(row.git_commit),
    started_at: String(row.started_at),
    last_activity_at: String(row.last_activity_at),
    message_count: Number(row.message_count ?? 0),
    preview: row.preview === null || row.preview === undefined ? null : String(row.preview),
    updated_at: toIso(row.updated_at),
  };
}

/** Sessions for a user, newest first, with uploading device name. */
export async function getRecentSessions(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  options: { repoUrl?: string; branchFilter?: string[]; toolFilter?: string[]; limit: number },
): Promise<SessionRecord[]> {
  return withUserDb(ctx, userId, async (client) => {
    const params: unknown[] = [userId];
    let query = `
      SELECT s.*, d.device_name
      FROM sessions s
      LEFT JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = $1`;

    if (options.repoUrl) {
      params.push(options.repoUrl);
      const p = `$${params.length}`;
      query += ` AND (s.repo_url = ${p} OR EXISTS (SELECT 1 FROM session_projects p WHERE p.session_ref = s.session_ref AND p.repo_url = ${p}))`;
    }
    if (options.toolFilter && options.toolFilter.length > 0) {
      params.push(options.toolFilter);
      query += ` AND s.tool = ANY($${params.length}::text[])`;
    }
    if (options.branchFilter && options.branchFilter.length > 0) {
      params.push(options.branchFilter);
      query += ` AND s.git_branch = ANY($${params.length}::text[])`;
    }
    params.push(options.limit);
    query += ` ORDER BY s.last_activity_at DESC, s.session_ref ASC LIMIT $${params.length}`;

    const result = await client.query(query, params);
    return result.rows.map((r) => mapSessionRow(r, options.repoUrl));
  });
}

/** One session and a page of its messages, in conversation order. */
export async function getSessionMessages(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  sessionRef: string,
  options: { offset: number; limit: number },
): Promise<{ session: SessionRecord | null; messages: MessageRecord[] }> {
  return withUserDb(ctx, userId, async (client) => {
    const sessionRes = await client.query(
      `SELECT s.*, d.device_name
       FROM sessions s
       LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.session_ref = $1 AND s.user_id = $2`,
      [sessionRef, userId],
    );
    const sessionRow = sessionRes.rows[0];
    if (!sessionRow) return { session: null, messages: [] };

    const msgRes = await client.query<{
      id: string;
      session_ref: string;
      tool: string;
      source_session_id: string;
      timestamp: string;
      role: string;
      content_bytes: Buffer;
      message_index: number;
      content_hash: string;
      metadata_raw: string;
      indexed_at: Date | string;
    }>(
      `SELECT id, session_ref, tool, source_session_id, timestamp, role, content_bytes,
              message_index, content_hash, metadata_raw, indexed_at
       FROM messages
       WHERE session_ref = $1
       ORDER BY timestamp ASC, message_index ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [sessionRef, options.limit, options.offset],
    );

    const messages: MessageRecord[] = msgRes.rows.map((row) => ({
      id: row.id,
      session_ref: row.session_ref,
      tool: row.tool,
      source_session_id: row.source_session_id,
      timestamp: row.timestamp,
      role: row.role,
      content: Buffer.from(row.content_bytes).toString("utf8"),
      message_index: Number(row.message_index),
      content_hash: row.content_hash,
      metadata_json: row.metadata_raw,
      indexed_at: toIso(row.indexed_at),
    }));

    return { session: mapSessionRow(sessionRow), messages };
  });
}

export interface UploadStatusRow {
  repo_url: string;
  project_name: string;
  device_id: string;
  device_name: string | null;
  last_upload_at: string;
  client_version: string | null;
  sessions: number;
}

/** When each of the user's devices last uploaded each project. */
export async function getUploadStatus(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  repoUrl?: string,
): Promise<UploadStatusRow[]> {
  return withUserDb(ctx, userId, async (client) => {
    const result = await client.query<{
      repo_url: string;
      project_name: string;
      device_id: string;
      device_name: string | null;
      last_upload_at: Date | string;
      client_version: string | null;
      sessions: number;
    }>(
      `SELECT u.repo_url, u.project_name, u.device_id, d.device_name, u.last_upload_at, u.client_version,
              (SELECT COUNT(*)::int FROM sessions s
               WHERE s.user_id = u.user_id
                 AND EXISTS (
                   SELECT 1 FROM session_projects p
                   WHERE p.session_ref = s.session_ref AND p.repo_url = u.repo_url AND p.device_id = u.device_id
                 )) AS sessions
       FROM uploads u
       LEFT JOIN devices d ON d.id = u.device_id
       WHERE u.user_id = $1 AND ($2::text IS NULL OR u.repo_url = $2)
       ORDER BY u.last_upload_at DESC`,
      [userId, repoUrl ?? null],
    );
    return result.rows.map((r) => ({
      repo_url: r.repo_url,
      project_name: r.project_name,
      device_id: r.device_id,
      device_name: r.device_name,
      last_upload_at: toIso(r.last_upload_at),
      client_version: r.client_version,
      sessions: Number(r.sessions ?? 0),
    }));
  });
}

/** Create or rename the account; returns its current token epoch. */
export async function upsertUser(
  ctx: Pick<CloudContext, "pool">,
  userId: string,
  username: string,
): Promise<number> {
  return withSystemDb(ctx, async (client) => {
    await client.query(
      `INSERT INTO users (id, username, created_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, updated_at = now()`,
      [userId, username],
    );
    await client.query(
      `INSERT INTO token_epochs (user_id, epoch, updated_at)
       VALUES ($1, 0, now())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const res = await client.query<{ epoch: number }>(
      "SELECT epoch FROM token_epochs WHERE user_id = $1",
      [userId],
    );
    return Number(res.rows[0]?.epoch ?? 0);
  });
}

/** Whether the account exists, and the epoch its tokens must carry. */
export async function getAccountState(
  ctx: Pick<CloudContext, "pool">,
  userId: string,
): Promise<{ exists: boolean; epoch: number }> {
  return withSystemDb(ctx, async (client) => {
    const res = await client.query<{ user_exists: number | null; epoch: number | null }>(
      `SELECT (SELECT 1 FROM users WHERE id = $1) AS user_exists,
              (SELECT epoch FROM token_epochs WHERE user_id = $1) AS epoch`,
      [userId],
    );
    const row = res.rows[0];
    return {
      exists: row?.user_exists === 1,
      epoch: Number(row?.epoch ?? 0),
    };
  });
}

/** Invalidate every token and revoke active OAuth refresh tokens for this user. */
export async function bumpTokenEpoch(
  ctx: Pick<CloudContext, "pool">,
  userId: string,
): Promise<void> {
  await withSystemDb(ctx, async (client) => {
    await bumpEpochWithClient(client, userId);
    await client.query(
      "UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
  });
}

async function bumpEpochWithClient(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO token_epochs (user_id, epoch, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (user_id) DO UPDATE SET
       epoch = token_epochs.epoch + 1,
       updated_at = now()`,
    [userId],
  );
}

/**
 * Remove everything held for a user while moving the token epoch in the same transaction.
 * `token_epochs` intentionally has no CASCADE FK from `users`, so prior JWTs stay revoked
 * even if the same GitHub account registers again later.
 */
export async function deleteUserData(
  ctx: Pick<CloudContext, "pool">,
  userId: string,
): Promise<void> {
  await withSystemDb(ctx, async (client) => {
    await bumpEpochWithClient(client, userId);
    await client.query("DELETE FROM oauth_refresh_tokens WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM oauth_codes WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM source_coverage WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM coverage_evidence WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM uploads WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM devices WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
  });
}

export async function getUserMessageCount(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
): Promise<number> {
  return withUserDb(ctx, userId, async (client) => {
    const res = await client.query<{ total: string | number }>(
      "SELECT COALESCE(SUM(message_count), 0)::bigint AS total FROM sessions WHERE user_id = $1",
      [userId],
    );
    return Number(res.rows[0]?.total ?? 0);
  });
}

export async function deleteSession(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  sessionRef: string,
): Promise<boolean> {
  return withUserDb(ctx, userId, async (client) => {
    const res = await client.query(
      "DELETE FROM sessions WHERE session_ref = $1 AND user_id = $2 RETURNING session_ref",
      [sessionRef, userId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

async function displayPreviewWithClient(client: PoolClient, sessionRef: string): Promise<string> {
  const res = await client.query<{ content_bytes: Buffer; metadata_raw: string }>(
    `SELECT content_bytes, metadata_raw
     FROM messages
     WHERE session_ref = $1 AND role = 'user'
     ORDER BY message_index ASC, timestamp ASC, id ASC
     LIMIT 20`,
    [sessionRef],
  );
  for (const row of res.rows) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_raw) as Record<string, unknown>;
    } catch {
      // ignore invalid JSON metadata when choosing preview
    }
    if (metadata.mayIncludeInjectedContext === true) continue;
    const rawText = Buffer.from(row.content_bytes.subarray(0, 1024)).toString("utf8");
    const text = sliceCodePoints(rawText, 0, 240).content.trim();
    if (text && !INJECTED_PREVIEW_RE.test(text)) return text;
  }
  return "Conversation · preview unavailable";
}

export async function getOverviewRollups(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
) {
  return withUserDb(ctx, userId, async (client) => {
    const providersRes = await client.query<{
      tool: string;
      sessions: number;
      message_rows: number;
      last_activity: string;
    }>(
      `SELECT tool, COUNT(*)::int AS sessions, COALESCE(SUM(message_count), 0)::int AS message_rows,
              MAX(last_activity_at) AS last_activity
       FROM sessions
       WHERE user_id = $1
       GROUP BY tool
       ORDER BY sessions DESC`,
      [userId],
    );

    const sourceCoverageRes = await client.query<{
      device_id: string;
      device_name: string;
      source: string;
      observed_at: string;
      received_at: string;
      status: string;
      discovered_sessions: string | number | null;
      indexed_sessions: string | number | null;
      indexed_messages: string | number | null;
      excluded_records: string | number | null;
      notes: string;
    }>(
      `SELECT device_id, device_name, source, observed_at, received_at, status,
              discovered_sessions, indexed_sessions, indexed_messages, excluded_records, notes
       FROM source_coverage
       WHERE user_id = $1
       ORDER BY device_name, source`,
      [userId],
    );

    const evidenceRes = await client.query(
      `SELECT device_id, device_name, source, scope, kind, checked_at, evidence_json
       FROM coverage_evidence
       WHERE user_id = $1
       ORDER BY device_name, source, scope, kind`,
      [userId],
    );

    const projectsRes = await client.query<{
      repo_url: string;
      sessions: number;
      messages: number;
      last_activity: string;
      tools: string | null;
      github_items: number;
    }>(
      `SELECT COALESCE(NULLIF(repo_url, ''), '(no repo)') AS repo_url,
              COUNT(*)::int AS sessions,
              COALESCE(SUM(message_count), 0)::int AS messages,
              MAX(last_activity_at) AS last_activity,
              string_agg(DISTINCT tool, ',') AS tools,
              COALESCE(SUM(CASE WHEN tool = 'github' THEN 1 ELSE 0 END), 0)::int AS github_items
       FROM sessions
       WHERE user_id = $1
       GROUP BY COALESCE(NULLIF(repo_url, ''), '(no repo)')
       ORDER BY sessions DESC, last_activity DESC
       LIMIT 50`,
      [userId],
    );

    const skillRes = await client.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata
       FROM messages
       WHERE user_id = $1 AND (metadata ? 'skill' OR metadata ? 'skills')
       LIMIT 5000`,
      [userId],
    );

    const skillCounts = new Map<string, number>();
    for (const row of skillRes.rows) {
      const meta = row.metadata;
      if (!meta || typeof meta !== "object") continue;
      if (typeof meta.skill === "string" && meta.skill.trim()) {
        const name = meta.skill.trim();
        skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
      }
      if (Array.isArray(meta.skills)) {
        for (const entry of meta.skills) {
          const name =
            typeof entry === "string"
              ? entry.trim()
              : entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
                ? (entry as { name: string }).name.trim()
                : "";
          if (name) skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
        }
      }
    }

    const skills = [...skillCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    return {
      providers: providersRes.rows.map((r) => ({
        tool: r.tool,
        sessions: Number(r.sessions),
        message_rows: Number(r.message_rows),
        last_activity: r.last_activity,
      })),
      source_coverage: sourceCoverageRes.rows.map((r) => ({
        ...r,
        discovered_sessions: r.discovered_sessions === null ? null : Number(r.discovered_sessions),
        indexed_sessions: r.indexed_sessions === null ? null : Number(r.indexed_sessions),
        indexed_messages: r.indexed_messages === null ? null : Number(r.indexed_messages),
        excluded_records: r.excluded_records === null ? null : Number(r.excluded_records),
      })),
      coverage_evidence: evidenceRes.rows,
      projects: projectsRes.rows.map((r) => ({
        repo_url: r.repo_url,
        sessions: Number(r.sessions),
        messages: Number(r.messages),
        last_activity: r.last_activity,
        tools: r.tools ?? "",
        github_items: Number(r.github_items),
      })),
      skills,
    };
  });
}

export async function getDashboardSessions(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  options: { repo?: string; tool?: string; offset: number },
) {
  return withUserDb(ctx, userId, async (client) => {
    const args: unknown[] = [userId];
    let where = "s.user_id = $1";
    if (options.repo) {
      args.push(options.repo);
      where += ` AND EXISTS (SELECT 1 FROM session_projects p WHERE p.session_ref = s.session_ref AND p.repo_url = $${args.length})`;
    }
    if (options.tool) {
      args.push(options.tool);
      where += ` AND s.tool = $${args.length}`;
    }
    args.push(options.offset);
    const offsetParam = `$${args.length}`;

    const res = await client.query<{
      session_ref: string;
      tool: string;
      preview: string | null;
      repo_url: string;
      message_count: number;
      last_activity_at: string;
      device_name: string | null;
    }>(
      `SELECT s.session_ref, s.tool, s.preview, s.repo_url, s.message_count::int AS message_count,
              s.last_activity_at, d.device_name
       FROM sessions s
       LEFT JOIN devices d ON d.id = s.device_id
       WHERE ${where}
       ORDER BY s.last_activity_at DESC, s.session_ref ASC
       LIMIT 51 OFFSET ${offsetParam}`,
      args,
    );

    const rows = res.rows;
    const visible = [];
    for (const row of rows.slice(0, 50)) {
      visible.push({
        ...row,
        message_count: Number(row.message_count),
        display_preview: await displayPreviewWithClient(client, row.session_ref),
      });
    }
    return {
      sessions: visible,
      next: rows.length > 50 ? options.offset + 50 : null,
    };
  });
}

export async function getDashboardMessages(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  options: { sessionRef: string; offset: number; focus?: string | null },
) {
  return withUserDb(ctx, userId, async (client) => {
    const ownerRes = await client.query(
      `SELECT session_ref, tool, preview, repo_url, message_count::int AS message_count,
              started_at, last_activity_at, updated_at, git_branch, git_commit
       FROM sessions
       WHERE session_ref = $1 AND user_id = $2`,
      [options.sessionRef, userId],
    );
    const owner = ownerRes.rows[0];
    if (!owner) return { notFound: true as const };

    let offset = options.offset;
    if (options.focus) {
      const targetRes = await client.query<{ n: number }>(
        `SELECT n::int AS n FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY message_index ASC, timestamp ASC, id ASC) - 1 AS n
           FROM messages
           WHERE session_ref = $1
         ) sub WHERE id = $2`,
        [options.sessionRef, options.focus],
      );
      const target = targetRes.rows[0];
      if (!target) return { notFound: true as const };
      offset = Math.floor(Number(target.n) / 20) * 20;
    }

    const msgRes = await client.query<{
      id: string;
      role: string;
      timestamp: string;
      message_index: number;
      content_bytes: Buffer;
      content_chars: number;
      metadata_raw: string;
    }>(
      `SELECT id, role, timestamp, message_index, content_bytes, content_chars, metadata_raw
       FROM messages
       WHERE session_ref = $1
       ORDER BY message_index ASC, timestamp ASC, id ASC
       LIMIT 21 OFFSET $2`,
      [options.sessionRef, offset],
    );

    const mapped = msgRes.rows.map((row) => {
      const fullText = Buffer.from(row.content_bytes).toString("utf8");
      const page = sliceCodePoints(fullText, 0, 8000);
      return {
        id: row.id,
        role: row.role,
        timestamp: row.timestamp,
        message_index: Number(row.message_index),
        content: page.content,
        content_chars: Number(row.content_chars),
        metadata_json: row.metadata_raw,
      };
    });

    const displayPreview = await displayPreviewWithClient(client, options.sessionRef);
    return {
      notFound: false as const,
      session: {
        ...owner,
        message_count: Number(owner.message_count),
        updated_at: toIso(owner.updated_at),
        display_preview: displayPreview,
      },
      messages: mapped.slice(0, 20),
      next: mapped.length > 20 ? offset + 20 : null,
    };
  });
}

export async function getDashboardTextPage(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  options: { messageId: string; offset: number },
) {
  return withUserDb(ctx, userId, async (client) => {
    const res = await client.query<{ content_bytes: Buffer }>(
      `SELECT m.content_bytes
       FROM messages m
       JOIN sessions s ON s.session_ref = m.session_ref
       WHERE m.id = $1 AND s.user_id = $2`,
      [options.messageId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const text = Buffer.from(row.content_bytes).toString("utf8");
    const page = sliceCodePoints(text, options.offset, 32768);
    return {
      ...page,
      next: options.offset + 32768 < page.content_chars ? options.offset + 32768 : null,
    };
  });
}
