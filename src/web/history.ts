import {claudeContent,parseContentProvenance,type ContentProvenance} from "./claude-content.js";
/** User-owned web history only. Provider text is untrusted data, never instructions. */
import type { ArchivedSession } from "../handoff/archive.js";
import { hashParts } from "../handoff/hash.js";
export type WebProvider = "chatgpt" | "claude" | "gemini";
type Row = Record<string, unknown>;
function object(v: unknown): Row {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected a web-history object");
  return v as Row;
}
function id(v: unknown, label: string): string {
  if (typeof v !== "string" || !v || v.length > 1000) throw new Error(`Missing or invalid ${label}`);
  return v;
}
function timestamp(v: unknown): string | null {
  const date = typeof v === "number" ? new Date(v * 1000) : typeof v === "string" ? new Date(v) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function chatGptContent(value: unknown): {text: string; nonTextBlocks: number} {
 const content=value&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
 if(Array.isArray(content.parts)){
  const texts: string[]=[];let nonTextBlocks=0;
  for(const part of content.parts){
   if(typeof part==="string")texts.push(part);
   else if(part&&typeof part==="object"&&part.type==="text"&&typeof part.text==="string")texts.push(part.text);
   else nonTextBlocks++;
  }
  return {text:texts.join("\n"),nonTextBlocks};
 }
 if(typeof content.text==="string")return {text:content.text,nonTextBlocks:0};
 // Keep the message identity even when its payload is audio/image/tool metadata.
 // Never stringify an opaque payload or invent replacement conversation text.
 return {text:"",nonTextBlocks:1};
}
export interface WebMessage extends Partial<ContentProvenance> {
  id: string;
  role: string;
  content: string;
  timestamp: string | null;
  parent: string | null;
  nonTextBlocks: number;
}
export interface WebConversation {
  id: string;
  title: string;
  startedAt: string | null;
  messages: WebMessage[];
  complete: boolean;
  representation?: "provider-export" | "provider-api" | "rendered-text";
  messageOffset?: number;
}
/** Exports contain whole history; browser snapshots explicitly contain only the opened branch. */
export function parseWebExport(provider: WebProvider, value: unknown): WebConversation[] {
  if(provider==="gemini")throw new Error("Gemini Takeout imports are not supported yet; use website backfill");
  if (!Array.isArray(value)) throw new Error("Expected the extracted conversations.json array, not a ZIP archive");
  if (value.length > 100_000) throw new Error("Too many conversations in one import");
  return value.map((entry) => {
    const row = object(entry);
    const conversationId = id(provider === "chatgpt" ? row.id ?? row.conversation_id : row.uuid, "conversation id");
    const messages: WebMessage[] = [];
    if (provider === "chatgpt") {
      const mapping = object(row.mapping);
      for (const [nodeId, rawNode] of Object.entries(mapping)) {
        const node = object(rawNode);
        if (node.message === null || node.message === undefined) continue;
        const message = object(node.message);
        const extracted = chatGptContent(message.content);
        const role = id(object(message.author).role, "author role");
        messages.push({ id: id(message.id ?? nodeId, "message id"), role,
          content: extracted.text,
          timestamp: timestamp(message.create_time), parent: typeof node.parent === "string" ? node.parent : null,
          nonTextBlocks: extracted.nonTextBlocks });
      }
    } else {
      if (!Array.isArray(row.chat_messages)) throw new Error("Claude conversation has no chat_messages array");
      for (const raw of row.chat_messages) {
        const message = object(raw);
        const extracted = claudeContent(message);
        const messageId = id(message.uuid, "message id");
        messages.push({ id: messageId, role: message.sender === "human" ? "user" : id(message.sender, "sender"),
          ...extracted,
          // Array order is not evidence of ancestry (tree responses can contain siblings).
          timestamp: timestamp(message.created_at), parent: typeof message.parent_message_uuid === "string" ? id(message.parent_message_uuid, "parent id") : null,
        });
      }
    }
    return { id: conversationId, title: typeof (row.title ?? row.name) === "string" ? String(row.title ?? row.name) : "",
      startedAt: timestamp(row.create_time ?? row.created_at), messages, complete: true };
  });
}
export function archiveWebConversation(provider: WebProvider, account: string, c: WebConversation, projectRoot: string): ArchivedSession {
  id(account, "account namespace"); id(c.id, "conversation id");
  const tool = `${provider}-web`;
  const sourceId = hashParts([provider, account, c.id]);
  const seen = new Set<string>();
  const messages = c.messages.map((m, position) => {
    id(m.id, "message id");
    if (seen.has(m.id)) throw new Error("Duplicate provider message id");
    seen.add(m.id);
    if (!["user", "assistant", "system", "tool", "developer"].includes(m.role)) throw new Error("Unsupported web-message role");
    const contentHash = hashParts([m.content]);
    return { id: hashParts([tool, sourceId, m.id, m.role, contentHash]),
      timestamp: m.timestamp ?? c.startedAt ?? new Date(0).toISOString(), role: m.role === "developer" ? "system" : m.role,
      content: m.content, content_hash: contentHash, message_index: position + (c.messageOffset ?? 0),
      metadata_json: JSON.stringify({ source: tool, provider_message_id: m.id, provider_conversation_id: c.id,
        parent_id: m.parent, source_role: m.role, source_complete: c.complete, timestamp_inferred: m.timestamp === null,
        non_text_blocks: m.nonTextBlocks, ...(m.contentCaptureVersion===2?{content_capture_version:2,block_types:m.blockTypes,preserved_block_types:m.preservedBlockTypes,omitted_block_types:m.omittedBlockTypes,attachment_refs:m.attachmentRefs,attachment_metadata_omitted:m.attachmentMetadataOmitted}:{}), representation: c.representation ?? (c.complete ? "provider-export" : "rendered-text"), revision: contentHash, untrusted_transcript_data: true }),
      source_pointer: `${tool}:${sourceId}:${m.id}` };
  });
  const times = messages.map((m) => m.timestamp).sort();
  return { session_ref: `${tool}:${sourceId}`, tool, source_session_id: sourceId, project_root: projectRoot,
    git_branch: null, git_commit: null, started_at: times[0] ?? c.startedAt ?? new Date(0).toISOString(),
    last_activity_at: times.at(-1) ?? c.startedAt ?? new Date(0).toISOString(), preview: c.title.slice(0, 1000), source_path: null, messages };
}

/** Narrow browser-to-native boundary: no paths, URLs, credentials or commands. */
export function parseWebCapture(value: unknown): { provider: WebProvider; conversation: WebConversation; providerAccount?: string } {
  const row = object(value);
  if (row.version !== 1 || (row.provider !== "chatgpt" && row.provider !== "claude" && row.provider !== "gemini")) throw new Error("Unsupported capture version/provider");
  const c = object(row.conversation);
  if (!Array.isArray(c.messages) || c.messages.length > 20_000) throw new Error("Invalid capture messages");
  const messages: WebMessage[] = c.messages.map((raw) => {
    const m = object(raw);
    if (typeof m.content !== "string" || Buffer.byteLength(m.content,"utf8") > 64*1024*1024) throw new Error("Invalid captured content");
    if (m.timestamp !== null && timestamp(m.timestamp) === null) throw new Error("Invalid captured timestamp");
    const parent = m.parent === null ? null : id(m.parent,"parent id");
    if(m.nonTextBlocks !== undefined && (!Number.isInteger(m.nonTextBlocks) || (m.nonTextBlocks as number)<0 || (m.nonTextBlocks as number)>100000)) throw new Error("Invalid non-text block count");
    return {...parseContentProvenance(m),id:id(m.id,"message id"),role:id(m.role,"role"),content:m.content,
      parent,timestamp:timestamp(m.timestamp),nonTextBlocks:typeof m.nonTextBlocks === "number" ? m.nonTextBlocks : 0};
  });
  const messageOffset = row.message_offset ?? 0;
  if (!Number.isInteger(messageOffset) || (messageOffset as number)<0 || (messageOffset as number)+messages.length>20_000) throw new Error("Invalid capture message offset");
  const conversation: WebConversation = {id:id(c.id,"conversation id"),title:typeof c.title === "string" ? c.title.slice(0,1000) : "",
    startedAt:null,messages,messageOffset:messageOffset as number,complete:false,representation:row.capture_kind === "provider-api" ? "provider-api" : "rendered-text"};
  let providerAccount: string | undefined;
  if(row.provider==="gemini"){
    if(typeof row.provider_account!=="string"||!/^gemini-[a-f0-9]{64}$/.test(row.provider_account))throw new Error("Gemini capture requires a verified provider account");
    providerAccount=row.provider_account;
  }
  return {provider:row.provider,conversation,...(providerAccount?{providerAccount}:{})};
}
