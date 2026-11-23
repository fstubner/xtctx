import { describe, expect, it } from "vitest";
import { DEFAULT_UPLOAD_LIMITS, parseUpload } from "../../src/db/ingest.js";
import {
  countCodePoints,
  redactHighConfidenceSecrets,
  sanitizeMetadataForJsonb,
  scrubNullBytes,
  scrubNullToSpace,
  sliceCodePoints,
} from "../../src/redact.js";

function msg(over: Record<string, unknown> = {}) {
  return {
    id: "0000000000000001",
    timestamp: "2026-10-01T00:00:00.000Z",
    role: "user",
    content: "hello",
    messageIndex: 0,
    contentHash: "hash0",
    metadataJson: "{}",
    ...over,
  };
}

function body(sessions: unknown[]) {
  return {
    device: { id: "dev1", name: "Laptop" },
    project: { repoUrl: "github.com/a/b", name: "b" },
    sessions,
  };
}

function session(over: Record<string, unknown> = {}, messages = [msg()]) {
  return {
    tool: "claude-code",
    sourceSessionId: "s1",
    startedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: "2026-10-01T00:01:00.000Z",
    messages,
    ...over,
  };
}

describe("parseUpload validation & limits", () => {
  it("returns 426 client_outdated for legacy array payloads", () => {
    const res = parseUpload([{ deviceId: "x" }]);
    expect(res).toMatchObject({ ok: false, status: 426, error: { error: "client_outdated" } });
  });

  it("rejects malformed device, tool, role, message id, keepIds, and counts", () => {
    expect(parseUpload({ sessions: [] })).toMatchObject({ ok: false, status: 400 });
    expect(parseUpload(body([session({ tool: "Bad Tool" })]))).toMatchObject({ ok: false, status: 400 });
    expect(parseUpload(body([session({}, [msg({ role: "wizard" })])]))).toMatchObject({ ok: false, status: 400 });
    expect(parseUpload(body([session({}, [msg({ id: "not-hex" })])]))).toMatchObject({ ok: false, status: 400 });
    expect(parseUpload(body([session({}, [msg({ messageIndex: 1.5 })])]))).toMatchObject({ ok: false, status: 400 });
    expect(parseUpload(body([session({ keepIds: ["bad"] })]))).toMatchObject({ ok: false, status: 400 });

    const tooManySessions = Array.from({ length: DEFAULT_UPLOAD_LIMITS.maxSessionsPerRequest + 1 }, (_, i) =>
      session({ sourceSessionId: `s${i}` }),
    );
    expect(parseUpload(body(tooManySessions))).toMatchObject({ ok: false, status: 400 });

    const tooManyMsgs = Array.from({ length: DEFAULT_UPLOAD_LIMITS.maxMessagesPerRequest + 1 }, (_, i) =>
      msg({ id: i.toString(16).padStart(16, "0"), messageIndex: i }),
    );
    expect(parseUpload(body([session({}, tooManyMsgs)]))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects oversized UTF-8 messages with 413 naming the message", () => {
    const tightLimits = { ...DEFAULT_UPLOAD_LIMITS, maxMessageBytes: 64 };
    const oversized = msg({ id: "00000000000000ff", content: "é".repeat(33) }); // 66 UTF-8 bytes
    const res = parseUpload(body([session({}, [msg(), oversized])]), tightLimits);
    expect(res).toEqual({
      ok: false,
      status: 413,
      error: {
        error: "message_too_large",
        limit: 64,
        tool: "claude-code",
        sourceSessionId: "s1",
        messageId: "00000000000000ff",
      },
    });
  });
});

describe("secret redaction & NUL/Unicode safety", () => {
  it("redacts high-confidence secrets in message content and session previews", () => {
    const gh = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const ant = "sk-ant-" + "api03-1234567890abcdef1234567890";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    const res = parseUpload(
      body([
        session(
          { preview: `leaked ${gh}` },
          [msg({ content: `gh=${gh} ant=${ant} pem=${pem} unclosed=-----BEGIN EC PRIVATE KEY-----` })],
        ),
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.sessions[0].preview).toContain("[REDACTED:github_token]");
    expect(res.body.sessions[0].preview).not.toContain(gh);
    const out = res.body.sessions[0].messages[0].content;
    expect(out).toContain("[REDACTED:github_token]");
    expect(out).toContain("[REDACTED:anthropic_key]");
    expect(out).toContain("[REDACTED:private_key]");
    expect(out).toContain("-----BEGIN EC PRIVATE KEY-----");
    expect(out).not.toContain(gh);
    expect(out).not.toContain(ant);
    expect(redactHighConfidenceSecrets("sk_live_1234567890abcdef")).toBe("[REDACTED:stripe_key]");
  });

  it("scrubs NUL escapes from JSONB metadata and TEXT columns safely", () => {
    expect(scrubNullToSpace("before\0after")).toBe("before after");
    expect(scrubNullBytes("before\0after")).toBe("beforeafter");
    expect(sanitizeMetadataForJsonb('{"skill":"x\\u0000y","nested":["a\\u0000b"]}')).toBe(
      '{"skill":"xy","nested":["ab"]}',
    );
    expect(sanitizeMetadataForJsonb("not json")).toBe("{}");
    expect(sanitizeMetadataForJsonb("[1,2]")).toBe("{}");
  });

  it("pages Unicode surrogate pairs and embedded NUL bytes losslessly by code point", () => {
    const content = `${"猫😀".repeat(4000)}\0after-tail`;
    const total = countCodePoints(content);
    expect(total).toBe(8011);

    const first = sliceCodePoints(content, 0, 8000);
    const tail = sliceCodePoints(content, 8000, 32768);
    expect(countCodePoints(first.content)).toBe(8000);
    expect(first.content_chars).toBe(total);
    expect(first.content + tail.content).toBe(content);
    expect(sliceCodePoints(content, total + 10, 100)).toEqual({ content: "", content_chars: total });
  });
});
