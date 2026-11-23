const BACKSTOP_SECRET_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:anthropic_key]" },
  { pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED:stripe_key]" },
  { pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:openai_key]" },
  { pattern: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws_access_key]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:slack_token]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED:google_api_key]" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replacement: "[REDACTED:npm_token]" },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, replacement: "[REDACTED:hf_token]" },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED:groq_key]" },
];

/** Server-side safety backstop for older or unredacted upload clients. */
export function redactHighConfidenceSecrets(text: string): string {
  const beginRe = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/g;
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    beginRe.lastIndex = cursor;
    const match = beginRe.exec(text);
    if (!match) {
      out += text.slice(cursor);
      break;
    }
    const endMarker = `-----END ${match[1]}PRIVATE KEY-----`;
    const endIndex = text.indexOf(endMarker, match.index + match[0].length);
    if (endIndex === -1) {
      out += text.slice(cursor, match.index + match[0].length);
      cursor = match.index + match[0].length;
      continue;
    }
    out += text.slice(cursor, match.index) + "[REDACTED:private_key]";
    cursor = endIndex + endMarker.length;
  }
  for (const rule of BACKSTOP_SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** PostgreSQL TEXT and TSVECTOR reject 0x00 bytes; replace NUL with space to preserve word boundaries. */
export function scrubNullToSpace(text: string): string {
  return text.includes("\0") ? text.replace(/\0/g, " ") : text;
}

/** Strip 0x00 bytes before storing metadata_raw as TEXT. */
export function scrubNullBytes(text: string): string {
  return text.includes("\0") ? text.replace(/\0/g, "") : text;
}

function cleanJsonNulls(value: unknown): unknown {
  if (typeof value === "string") return scrubNullBytes(value);
  if (Array.isArray(value)) return value.map(cleanJsonNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[scrubNullBytes(k)] = cleanJsonNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Parse untrusted metadata JSON into a safe PostgreSQL JSONB object string
 * (stripping any NUL escapes which Postgres JSONB rejects).
 */
export function sanitizeMetadataForJsonb(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(cleanJsonNulls(parsed));
    }
    return "{}";
  } catch {
    return "{}";
  }
}

/** Count Unicode code points matching `for (const ch of text)`. */
export function countCodePoints(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    count++;
  }
  return count;
}

/**
 * Single-pass Unicode code-point slice over UTF-8 decoded message content.
 * Preserves surrogate pairs and embedded NUL bytes without splitting characters.
 */
export function sliceCodePoints(
  text: string,
  startCp: number,
  maxCp: number,
): { content: string; content_chars: number } {
  const from = Math.max(0, startCp);
  const limit = Math.max(0, maxCp);
  const endCp = from + limit;
  let cpIndex = 0;
  let utf16Start = text.length;
  let utf16End = text.length;
  let i = 0;
  while (i < text.length) {
    if (cpIndex === from) utf16Start = i;
    if (cpIndex === endCp) utf16End = i;
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    cpIndex++;
  }
  if (cpIndex === from) utf16Start = text.length;
  if (utf16Start > utf16End) utf16End = utf16Start;
  return { content: text.slice(utf16Start, utf16End), content_chars: cpIndex };
}
