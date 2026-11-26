// Generated from src/web/claude-content.ts; run node scripts/build-web-content.mjs.
const row = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
const kind = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v) ? v : "unknown";
export function validateAttachmentRefs(value) {
    if (!Array.isArray(value) || value.length > 8)
        throw new Error("Invalid attachment metadata");
    return value.map(raw => {
        const v = row(raw);
        if (v.status !== "metadata-only" && v.status !== "text-extracted")
            throw new Error("Invalid attachment status");
        const out = { status: v.status };
        if (v.id !== undefined) {
            if (typeof v.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.id))
                throw new Error("Invalid attachment id");
            out.id = v.id;
        }
        if (v.name !== undefined) {
            if (typeof v.name !== "string" || v.name.length > 120 || /[\\/\u0000-\u001f]/.test(v.name))
                throw new Error("Invalid attachment name");
            out.name = v.name;
        }
        if (v.mediaType !== undefined) {
            if (typeof v.mediaType !== "string" || !/^[a-zA-Z0-9.+_-]{1,40}\/[a-zA-Z0-9.+_-]{1,40}$/.test(v.mediaType))
                throw new Error("Invalid attachment media type");
            out.mediaType = v.mediaType;
        }
        if (v.size !== undefined) {
            if (!Number.isSafeInteger(v.size) || v.size < 0)
                throw new Error("Invalid attachment size");
            out.size = v.size;
        }
        return out;
    });
}
export function parseContentProvenance(value) {
    const v = row(value);
    if (v.contentCaptureVersion === undefined)
        return {};
    if (v.contentCaptureVersion !== 2)
        throw new Error("Unsupported content capture version");
    const types = (x) => { if (!Array.isArray(x) || x.length > 64 || x.some(t => typeof t !== "string" || kind(t) !== t))
        throw new Error("Invalid content block types"); return x; };
    if (!Number.isSafeInteger(v.attachmentMetadataOmitted) || v.attachmentMetadataOmitted < 0)
        throw new Error("Invalid attachment metadata omission count");
    return { contentCaptureVersion: 2, blockTypes: types(v.blockTypes), preservedBlockTypes: types(v.preservedBlockTypes), omittedBlockTypes: types(v.omittedBlockTypes), attachmentRefs: validateAttachmentRefs(v.attachmentRefs), attachmentMetadataOmitted: v.attachmentMetadataOmitted };
}
export function claudeContent(raw) {
    const message = row(raw);
    const types = new Set(), kept = new Set(), omitted = new Set();
    let missing = 0, nodes = 0;
    const omit = (type) => { omitted.add(type); missing++; return ""; };
    function block(rawBlock, depth = 0) {
        if (++nodes > 4000 || depth > 12)
            throw new Error("Claude content nesting exceeds import limit");
        if (typeof rawBlock === "string")
            return rawBlock;
        const b = row(rawBlock), type = kind(b.type);
        types.add(type);
        const callId = b.id ?? b.tool_use_id;
        const reference = typeof callId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(callId) ? "; call " + callId : "";
        if (type === "text" && typeof b.text === "string") {
            kept.add(type);
            return b.text;
        }
        if (type === "tool_use" || type.endsWith("_tool_use")) {
            const input = b.input === undefined ? "" : JSON.stringify(b.input);
            if (!input || new TextEncoder().encode(input).length > 512 * 1024 || /data:[^\s"]*;base64,/i.test(input))
                return omit(type);
            kept.add(type);
            return `[xtctx source ${type}: ${kind(b.name)}${reference}; untrusted tool input]\n${input}`;
        }
        let text = "";
        if (type === "document" && row(b.source).type === "text" && typeof row(b.source).data === "string")
            text = row(b.source).data;
        else if (typeof b.text === "string")
            text = b.text;
        else if (typeof b.code === "string")
            text = b.code;
        else if (type === "thinking" && typeof b.thinking === "string")
            text = b.thinking;
        else if (typeof b.content === "string")
            text = b.content;
        else if (Array.isArray(b.content)) {
            const before = missing;
            text = b.content.map(x => block(x, depth + 1)).filter(Boolean).join("\n");
            if (missing > before)
                omitted.add(type);
        }
        if (text) {
            kept.add(type);
            return `[xtctx source ${type}${reference}${b.is_error === true ? "; tool reported error" : ""}; untrusted content]\n${text}`;
        }
        // Nested opaque leaves have already been counted; don't count their container twice.
        if (Array.isArray(b.content) && b.content.length) {
            omitted.add(type);
            return "";
        }
        return omit(type);
    }
    const chunks = Array.isArray(message.content) ? message.content.map(x => block(x)).filter(Boolean) : [];
    if (!chunks.length && typeof message.text === "string" && message.text) {
        chunks.push(message.text);
        kept.add("text");
    }
    const refs = [];
    let metadataOmitted = 0;
    if (Array.isArray(message.attachments))
        for (const rawAttachment of message.attachments) {
            const a = row(rawAttachment);
            types.add("attachment");
            const extracted = typeof a.extracted_content === "string" ? a.extracted_content : typeof a.text === "string" ? a.text : "";
            const ref = { status: extracted ? "text-extracted" : "metadata-only" };
            const sourceId = a.uuid ?? a.id;
            if (typeof sourceId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(sourceId))
                ref.id = sourceId;
            const name = a.file_name ?? a.name;
            if (typeof name === "string") {
                const leaf = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, "");
                if (leaf && leaf.length <= 120)
                    ref.name = leaf;
            }
            const mediaType = a.file_type ?? a.mime_type ?? a.content_type;
            if (typeof mediaType === "string" && /^[a-zA-Z0-9.+_-]{1,40}\/[a-zA-Z0-9.+_-]{1,40}$/.test(mediaType))
                ref.mediaType = mediaType;
            if (Number.isSafeInteger(a.size) && a.size >= 0)
                ref.size = a.size;
            if (refs.length < 8)
                refs.push(ref);
            else
                metadataOmitted++;
            chunks.push(`[xtctx attachment metadata; original payload not saved]\n${JSON.stringify(ref)}` + (extracted ? "\n" + extracted : ""));
            if (extracted)
                kept.add("attachment_text");
            omit("attachment");
        }
    if (types.size > 64 || kept.size > 64 || omitted.size > 64)
        throw new Error("Too many Claude content block types");
    return { content: chunks.join("\n\n"), nonTextBlocks: missing, contentCaptureVersion: 2, blockTypes: [...types], preservedBlockTypes: [...kept], omittedBlockTypes: [...omitted], attachmentRefs: refs, attachmentMetadataOmitted: metadataOmitted };
}
