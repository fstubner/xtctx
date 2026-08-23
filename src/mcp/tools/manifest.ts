import type { SessionService, SessionSummary } from "../../handoff/types.js";
import { indexingPayload } from "./sessions.js";

interface HandoffManifestParams {
  session_refs?: string[];
  tool_filter?: string[];
  branch_filter?: string[];
  limit?: number;
  correlation_id?: string;
  format?: "markdown" | "json";
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

/**
 * Creates a read-only, provenance-first envelope for an external orchestrator.
 * The caller owns correlation IDs; xtctx only echoes them and never persists
 * generated task state or summaries.
 */
export function createHandoffManifestHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as HandoffManifestParams;
    const requestedRefs = uniqueStrings(params.session_refs);

    // Requested refs are resolved directly by primary key — filtering a
    // recency-limited list would misreport older indexed sessions as missing.
    let selected: SessionSummary[];
    let missingRefs: string[];
    if (requestedRefs.length > 0) {
      const resolved = await Promise.all(
        requestedRefs.map((sessionRef) => service.getSessionByRef(sessionRef)),
      );
      selected = resolved.filter((session): session is SessionSummary => session !== null);
      missingRefs = requestedRefs.filter((_, index) => resolved[index] === null);
    } else {
      const limit = normalizeLimit(params.limit, DEFAULT_LIMIT);
      selected = await service.listRecentSessions(limit, params.tool_filter, params.branch_filter);
      missingRefs = [];
    }

    const status = await service.getStatus();
    const manifest = {
      schema_version: "xtctx/handoff-manifest/v1",
      generated_at: new Date().toISOString(),
      correlation_id: normalizeCorrelationId(params.correlation_id),
      project: {
        root: status.project_root,
      },
      freshness: {
        last_scan_at: status.last_scan_at,
        indexed_sessions: status.sessions,
        // An orchestrator holding these refs needs to know the set is still
        // filling, or it treats a partial index as the whole history.
        indexing: indexingPayload(service) ?? null,
      },
      sessions: selected.map(formatSession),
      missing_session_refs: missingRefs,
      contract: {
        authority: "raw-transcript",
        detail_tool: "xtctx_session_detail",
        notes: "Correlation IDs are caller-owned and are not persisted by xtctx.",
      },
    };

    if (params.format === "markdown") {
      return formatManifestMarkdown(manifest);
    }

    return manifest;
  };
}

function formatSession(session: SessionSummary) {
  return {
    handoff_id: session.session_ref,
    session_ref: session.session_ref,
    tool: session.tool,
    started_at: session.started_at,
    last_activity_at: session.last_activity_at,
    message_count: session.message_count,
    source_path: session.source_path,
    retrieve: {
      tool: "xtctx_session_detail",
      arguments: {
        session_ref: session.session_ref,
      },
    },
  };
}

function formatManifestMarkdown(manifest: {
  correlation_id?: string;
  project: { root: string };
  freshness: { last_scan_at: string | null; indexed_sessions: number };
  sessions: Array<ReturnType<typeof formatSession>>;
  missing_session_refs: string[];
}): string {
  const lines = ["## xtctx Handoff Manifest", ""];
  if (manifest.correlation_id) {
    lines.push(`- Correlation ID: ${manifest.correlation_id}`);
  }
  lines.push(`- Project: ${manifest.project.root}`);
  lines.push(`- Last scan: ${manifest.freshness.last_scan_at ?? "never"}`);
  lines.push(`- Indexed sessions: ${manifest.freshness.indexed_sessions}`, "");

  for (const session of manifest.sessions) {
    lines.push(`### ${session.handoff_id}`);
    lines.push(`- Tool: ${session.tool}`);
    lines.push(`- Last activity: ${session.last_activity_at}`);
    lines.push(`- Messages: ${session.message_count}`);
    lines.push(`- Retrieve: xtctx_session_detail(session_ref=${session.session_ref})`, "");
  }

  if (manifest.missing_session_refs.length > 0) {
    lines.push(`Missing sessions: ${manifest.missing_session_refs.join(", ")}`);
  }

  return lines.join("\n").trim();
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function normalizeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(fallback, MAX_LIMIT);
  }
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}
