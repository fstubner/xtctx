import {validateAttachmentRefs} from "../web/claude-content.js";
/**
 * What a message looks like on its way to xtctx cloud.
 *
 * The limits mirror the server's (cloud/src/db.ts `LIMITS`). The client stays
 * under them on its own. Large content negotiates self-hosted limits; refusals
 * retain the local original and leave the durable sync checkpoint unchanged.
 */
export const UPLOAD_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxMetadataBytes: 4 * 1024,
  maxSessionsPerRequest: 10,
  maxMessagesPerRequest: 500,
  /** Requests are packed to this, leaving room for the envelope under maxBodyBytes. */
  targetBodyBytes: 768 * 1024,
} as const;

/**
 * Metadata fields that may leave the machine. Everything else is dropped:
 * `sourcePath` (an absolute transcript or working-directory path),
 * `referencedFiles` (paths), and anything a scraper adds later until it is
 * looked at and listed here.
 *
 * Looked at and decided: `subagent` (a flag) and `subagentType` (the kind of
 * subagent Cursor names, such as "explore") are sent, so a reader of the
 * cloud copy can tell a subagent's turns from the main agent's, as the local
 * index can. `parentToolCallId` (Copilot CLI) is not: it is an id into the
 * tool's own records, which the cloud does not have, so it says nothing there.
 */
const UPLOADED_METADATA_KEYS = [
  "messageIndex",
  // Archive provenance and extraction limitations; raw tool arguments stay local.
  "source_provider", "source_namespace", "source_message_id", "source_channel",
  "source_parent_session_id", "tool_call_id", "tool_name", "tool_calls_omitted",
  "sourceFormat", "mayIncludeInjectedContext", "nonTextParts",
  "tokenEstimate",
  "toolCalls",
  "toolName",
  "model",
  "stepType",
  "artifactType",
  "artifactName",
  "sessionType",
  "approvalMode",
  "sandboxed",
  "layer",
  "costUsd",
  "gitBranch",
  "gitCommit",
  "skills",
  "subagent",
  "subagentType",
  // Web provenance is needed to distinguish branches, revisions and omissions.
  // Credentials, local paths and attachment payloads remain excluded.
  "source", "provider_message_id", "provider_conversation_id", "parent_id",
  "source_role", "source_complete", "timestamp_inferred", "non_text_blocks",
  "representation", "revision", "untrusted_transcript_data",
  "content_capture_version", "block_types", "preserved_block_types", "omitted_block_types", "attachment_refs", "attachment_metadata_omitted",
] as const;

export const UPLOADED_METADATA_FIELDS: readonly string[] = UPLOADED_METADATA_KEYS;

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/]|file:)/;

function safeValue(value: unknown): unknown {
  if (typeof value === "string") return ABSOLUTE_PATH.test(value.trim()) ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const kept = value.map(safeValue).filter((v) => v !== undefined && typeof v !== "object");
    return kept.length > 0 ? kept : undefined;
  }
  return undefined; // nested objects are not uploaded
}

/** The stored metadata JSON reduced to UPLOADED_METADATA_FIELDS, with no absolute paths. */
export function sanitizeMetadata(json: string | null | undefined): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "{}");
  } catch {
    return "{}";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
  const out: Record<string, unknown> = {};
  for (const key of UPLOADED_METADATA_KEYS) {
    const raw = (parsed as Record<string, unknown>)[key];
    let value: unknown;
    if(key==="attachment_refs"&&raw!==undefined){try{value=validateAttachmentRefs(raw);}catch{value=undefined;}}else value=safeValue(raw);
    if (value !== undefined) out[key] = value;
  }
  if ((parsed as Record<string, unknown>).tool_calls != null) out.tool_calls_omitted = true;
  let text = JSON.stringify(out);
  // Keep core provenance when optional attachment descriptors exhaust the
  // metadata budget, and explicitly count descriptors absent remotely.
  while (Buffer.byteLength(text) > UPLOAD_LIMITS.maxMetadataBytes && Array.isArray(out.attachment_refs) && out.attachment_refs.length) {
    out.attachment_refs.pop();
    out.attachment_metadata_omitted = (typeof out.attachment_metadata_omitted === "number" ? out.attachment_metadata_omitted : 0) + 1;
    text = JSON.stringify(out);
  }
  return Buffer.byteLength(text) > UPLOAD_LIMITS.maxMetadataBytes ? "{}" : text;
}

/** Refuse unsupported content; never replace the remote source with shortened text. */
export function fitContent(content: string, maximum: number = UPLOAD_LIMITS.maxMessageBytes): string {
  if(Buffer.byteLength(content)>maximum)throw new Error("Message exceeds negotiated remote limit; original retained locally and sync checkpoint unchanged");
  return content;
}
