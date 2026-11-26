import type { CloudContext } from "./types.js";
import { SCOPE_SYNC_WRITE } from "./types.js";
import { apiAudience, authenticateToken } from "./auth/jwt.js";
import { withUserDb } from "./db/pool.js";

async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleCoverage(request: Request, ctx: CloudContext): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
  }
  const user = await authenticateToken(request, ctx, apiAudience(ctx));
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!user.scopes.includes(SCOPE_SYNC_WRITE) || !user.deviceId) {
    return Response.json({ error: "collector_identity_required" }, { status: 403 });
  }

  const raw = await readBodyCapped(request, 16_384);
  if (raw === null) return Response.json({ error: "body_too_large" }, { status: 413 });

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_coverage" }, { status: 400 });
  }

  if (data.version === 2) {
    return handleEvidence(data, { userId: user.userId, deviceId: user.deviceId }, ctx);
  }

  const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  const count = (v: unknown) =>
    v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e10);

  if (
    !text(data.source, 64) ||
    !/^[a-z0-9._:-]+$/.test(data.source as string) ||
    !text(data.device_name, 64) ||
    !text(data.observed_at, 32) ||
    !Number.isFinite(Date.parse(data.observed_at as string)) ||
    Date.parse(data.observed_at as string) > Date.now() + 300_000 ||
    !["partial", "healthy", "failed", "not_installed"].includes(data.status as string) ||
    ![data.discovered_sessions, data.indexed_sessions, data.indexed_messages, data.excluded_records].every(count) ||
    typeof data.notes !== "string" ||
    data.notes.length > 512
  ) {
    return Response.json({ error: "invalid_coverage" }, { status: 400 });
  }

  const observedIso = new Date(data.observed_at as string).toISOString();
  const receivedIso = new Date().toISOString();

  await withUserDb(ctx, user.userId, async (client) => {
    await client.query(
      `INSERT INTO source_coverage (
         user_id, device_id, source, device_name, observed_at, received_at, status,
         discovered_sessions, indexed_sessions, indexed_messages, excluded_records, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, device_id, source) DO UPDATE SET
         device_name = EXCLUDED.device_name,
         observed_at = EXCLUDED.observed_at,
         received_at = EXCLUDED.received_at,
         status = EXCLUDED.status,
         discovered_sessions = EXCLUDED.discovered_sessions,
         indexed_sessions = EXCLUDED.indexed_sessions,
         indexed_messages = EXCLUDED.indexed_messages,
         excluded_records = EXCLUDED.excluded_records,
         notes = EXCLUDED.notes
       WHERE EXCLUDED.observed_at >= source_coverage.observed_at`,
      [
        user.userId,
        user.deviceId,
        data.source,
        data.device_name,
        observedIso,
        receivedIso,
        data.status,
        data.discovered_sessions,
        data.indexed_sessions,
        data.indexed_messages,
        data.excluded_records,
        data.notes,
      ],
    );
  });

  return Response.json({ saved: true });
}

/** Each evidence kind keeps an independent clock; older retries cannot overwrite newer checks. */
async function handleEvidence(
  data: Record<string, unknown>,
  user: { userId: string; deviceId: string },
  ctx: CloudContext,
): Promise<Response> {
  const bad = () => Response.json({ error: "invalid_coverage" }, { status: 400 });
  const identifier = (v: unknown) => typeof v === "string" && /^[a-z0-9._:-]{1,128}$/.test(v);
  const timestamp = (v: unknown) =>
    typeof v === "string" && v.length <= 32 && Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now() + 300_000;

  if (
    !identifier(data.source) ||
    !(typeof data.scope === "string" && /^(main|scope-[a-f0-9]{64})$/.test(data.scope)) ||
    typeof data.device_name !== "string" ||
    !data.device_name ||
    data.device_name.length > 64 ||
    !Array.isArray(data.evidence) ||
    data.evidence.length < 1 ||
    data.evidence.length > 4
  ) {
    return bad();
  }

  const allowed: Record<string, string[]> = {
    collection: ["completed_at", "indexed_sessions", "indexed_messages", "completed", "original_attachments", "unsupported_content"],
    inventory: ["state", "discovered_sessions", "excluded_sessions"],
    reconciliation: ["matched_sessions", "missing_sessions", "retained_sessions", "text_parity", "verified_messages"],
    browser: ["state", "listed_sessions", "imported_sessions", "original_attachments", "unsupported_content"],
  };
  const enums: Record<string, string[]> = {
    state: ["detected", "not_detected", "inaccessible", "unsupported", "not_checked", "partial", "finished", "rate_limited", "unavailable"],
    text_parity: ["unverified", "verified", "mismatch"],
    original_attachments: ["unverified", "missing", "partial", "verified"],
    unsupported_content: ["unverified", "present", "none"],
  };

  const seen = new Set<string>();
  const rows: Array<{ kind: string; checkedAt: string; json: string }> = [];

  for (const value of data.evidence) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
    const e = value as Record<string, unknown>;
    const kind = e.kind;
    if (typeof kind !== "string" || !Object.hasOwn(allowed, kind) || seen.has(kind) || !timestamp(e.checked_at)) {
      return bad();
    }
    seen.add(kind);
    if (Object.keys(e).some((k) => !["kind", "checked_at", ...allowed[kind]].includes(k))) return bad();

    for (const [key, v] of Object.entries(e)) {
      if (key === "kind" || key === "checked_at" || v === null) continue;
      if (key === "completed_at") {
        if (!timestamp(v)) return bad();
      } else if (key === "completed") {
        if (typeof v !== "boolean") return bad();
      } else if (enums[key]) {
        if (typeof v !== "string" || !enums[key].includes(v)) return bad();
      } else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1e10) {
        return bad();
      }
    }

    if (
      (kind === "inventory" && !["detected", "not_detected", "inaccessible", "unsupported", "not_checked"].includes(e.state as string)) ||
      (kind === "browser" && !["partial", "finished", "rate_limited", "unavailable"].includes(e.state as string)) ||
      (kind === "reconciliation" && typeof e.text_parity !== "string")
    ) {
      return bad();
    }
    if (e.text_parity === "verified" && typeof e.verified_messages !== "number") return bad();

    rows.push({
      kind,
      checkedAt: new Date(e.checked_at as string).toISOString(),
      json: JSON.stringify(e),
    });
  }

  const receivedAt = new Date().toISOString();
  await withUserDb(ctx, user.userId, async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO coverage_evidence (
           user_id, device_id, source, scope, kind, checked_at, received_at, device_name, evidence_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, device_id, source, scope, kind) DO UPDATE SET
           checked_at = EXCLUDED.checked_at,
           received_at = EXCLUDED.received_at,
           device_name = EXCLUDED.device_name,
           evidence_json = EXCLUDED.evidence_json
         WHERE EXCLUDED.checked_at > coverage_evidence.checked_at`,
        [
          user.userId,
          user.deviceId,
          data.source,
          data.scope,
          row.kind,
          row.checkedAt,
          receivedAt,
          data.device_name,
          row.json,
        ],
      );
    }
  });

  return Response.json({ saved: true, version: 2 });
}
