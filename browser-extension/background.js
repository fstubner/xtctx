import { redactText } from "./redact.js";

const HOST = "io.xtctx.web_history";
const DEFAULT_SYNC_URL = "https://sync.xtctx.com";
const MAX_MESSAGES_PER_CHUNK = 200;
const MAX_CHUNK_BYTES = 700 * 1024;
const sites = { chatgpt: "https://chatgpt.com/*", claude: "https://claude.ai/*" };

async function state(message) {
  await chrome.storage.local.set({ captureStatus: message });
}

export function validateSyncUrl(raw) {
  const input = (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_SYNC_URL);
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid sync server URL.");
  }
  if (url.username || url.password) {
    throw new Error("Sync server URL must not include credentials.");
  }
  const isLocalHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Sync server URL must use https:// (http:// is allowed only for localhost).");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${cleanPath}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateDeviceId(saved) {
  if (typeof saved.syncDeviceId === "string" && saved.syncDeviceId.length >= 8) {
    return saved.syncDeviceId;
  }
  const id = typeof crypto.randomUUID === "function"
    ? `ext_${crypto.randomUUID()}`
    : `ext_${(await sha256Hex(String(Date.now()) + String(Math.random()))).slice(0, 24)}`;
  await chrome.storage.local.set({ syncDeviceId: id });
  return id;
}

function normalizeRole(role) {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  if (role === "developer") return "system";
  return "user";
}

function sanitizeLabel(raw) {
  const clean = typeof raw === "string" ? raw.trim().replace(/[^a-zA-Z0-9._-]/g, "-") : "";
  return clean ? clean.slice(0, 64) : "web";
}

async function uploadCaptureToWeb(capture, settings) {
  const syncUrl = validateSyncUrl(settings.syncUrl);
  const token = typeof settings.syncToken === "string" ? settings.syncToken.trim() : "";
  if (!token) {
    return {
      ok: false,
      unconfigured: true,
      error: "Web sync not configured. Add a sync token in the popup or switch to Local Dev Mode.",
    };
  }

  const provider = capture?.provider;
  const convId = capture?.conversation?.id;
  if (typeof provider !== "string" || typeof convId !== "string" || !convId) {
    throw new Error("Invalid capture payload.");
  }

  const deviceId = await getOrCreateDeviceId(settings);
  const accountLabel = sanitizeLabel(settings.syncAccountLabel);
  const redactOptions = { pii: Boolean(settings.redactPii) };
  const nowIso = new Date().toISOString();
  const baseOffset = Number.isInteger(capture.message_offset) ? capture.message_offset : 0;
  const rawMessages = Array.isArray(capture.conversation.messages) ? capture.conversation.messages : [];

  let redactedTotal = 0;
  const prepared = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const m = rawMessages[i];
    const redacted = redactText(String(m?.content ?? ""), redactOptions);
    redactedTotal += redacted.totalRedacted;
    const msgId = await sha256Hex(`${provider}:${convId}:${String(m?.id ?? i + baseOffset)}`);
    const contentHash = await sha256Hex(redacted.text);
    const ts = typeof m?.timestamp === "string" && m.timestamp ? m.timestamp : nowIso;
    prepared.push({
      id: msgId,
      timestamp: ts,
      role: normalizeRole(m?.role),
      content: redacted.text,
      messageIndex: baseOffset + i,
      contentHash,
      metadataJson: JSON.stringify({
        source: "browser-extension",
        provider,
        provider_message_id: String(m?.id ?? ""),
        provider_conversation_id: convId,
        ...(m?.nonTextBlocks ? { non_text_blocks: m.nonTextBlocks } : {}),
        untrusted_transcript_data: true,
      }),
    });
  }

  const timestamps = prepared.map((m) => m.timestamp).sort();
  const startedAt = timestamps[0] ?? nowIso;
  const lastActivityAt = timestamps[timestamps.length - 1] ?? nowIso;
  const rawPreview = typeof capture.conversation.title === "string" && capture.conversation.title.trim()
    ? capture.conversation.title.trim()
    : prepared[0]?.content ?? "";
  const previewResult = rawPreview ? redactText(rawPreview, redactOptions) : null;
  if (previewResult) redactedTotal += previewResult.totalRedacted;
  const preview = previewResult ? previewResult.text.slice(0, 160) || null : null;

  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const m of prepared) {
    const size = new TextEncoder().encode(JSON.stringify(m)).length + 1;
    if (current.length > 0 && (current.length >= MAX_MESSAGES_PER_CHUNK || currentBytes + size > MAX_CHUNK_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(m);
    currentBytes += size;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);

  for (const chunk of chunks) {
    const payload = {
      device: { id: deviceId.slice(0, 128), name: "browser-extension" },
      project: { repoUrl: `web-history:${accountLabel}`, name: "web-history" },
      sessions: [
        {
          tool: `web-${provider}`,
          sourceSessionId: convId.slice(0, 256),
          gitBranch: null,
          gitCommit: null,
          startedAt,
          lastActivityAt,
          preview,
          messages: chunk,
        },
      ],
    };

    const res = await fetch(`${syncUrl}/api/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Web sync token was rejected. Re-enter a valid sync:write token in the popup." };
    }
    if (!res.ok) {
      return { ok: false, error: `Web sync failed (${res.status}). Check your sync server and try again.` };
    }
  }

  return { ok: true, syncEnabled: true, redactedCount: redactedTotal };
}

async function handleCaptureDispatch(capture) {
  const settings = await chrome.storage.local.get([
    "syncMode",
    "syncUrl",
    "syncToken",
    "syncAccountLabel",
    "redactPii",
    "syncDeviceId",
  ]);
  const mode = settings.syncMode === "local" ? "local" : "web";
  if (mode === "local") {
    const result = await chrome.runtime.sendNativeMessage(HOST, capture);
    await state(
      result.ok
        ? result.syncPending
          ? "Saved locally; sync pending."
          : result.syncEnabled === false
            ? "Saved locally; remote sync is disabled."
            : "Saved and synced."
        : "Capture was rejected by the local host.",
    );
    return result;
  }

  const result = await uploadCaptureToWeb(capture, settings);
  if (result.ok) {
    const suffix = result.redactedCount > 0 ? ` (${result.redactedCount} secret/PII item(s) redacted)` : "";
    await state(`Synced to web archive${suffix}.`);
  } else if (result.error) {
    await state(result.error);
  }
  return result;
}

async function register(provider) {
  await chrome.scripting.unregisterContentScripts({ ids: [provider] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    { id: provider, matches: [sites[provider]], js: ["capture.js"], runAt: "document_idle", persistAcrossSessions: true },
  ]);
  // Registration covers future navigation; also attach to already-open matching tabs.
  for (const tab of await chrome.tabs.query({ url: [sites[provider]] })) {
    if (typeof tab.id === "number") {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js"] }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (sender.id !== chrome.runtime.id) throw new Error("Unknown sender");
    if (message.action === "enable") {
      if (sender.tab || !Object.hasOwn(sites, message.provider)) throw new Error("Invalid enable request");
      if (!(await chrome.permissions.contains({ origins: [sites[message.provider]] }))) {
        throw new Error("Site permission required");
      }
      await chrome.storage.local.set({ [message.provider]: true });
      await register(message.provider);
      return { ok: true };
    }
    if (message.action === "stop") {
      if (sender.tab) throw new Error("Invalid stop request");
      await chrome.storage.local.set({ chatgpt: false, claude: false });
      await chrome.scripting.unregisterContentScripts();
      return { ok: true };
    }
    if (message.action === "save-sync-config") {
      if (sender.tab) throw new Error("Invalid config request");
      const syncMode = message.syncMode === "local" ? "local" : "web";
      const syncUrl = syncMode === "web" ? validateSyncUrl(message.syncUrl) : undefined;
      const updates = {
        syncMode,
        ...(syncUrl ? { syncUrl } : {}),
        ...(typeof message.syncToken === "string" ? { syncToken: message.syncToken.trim() } : {}),
        ...(typeof message.syncAccountLabel === "string" ? { syncAccountLabel: sanitizeLabel(message.syncAccountLabel) } : {}),
        ...(typeof message.redactPii === "boolean" ? { redactPii: message.redactPii } : {}),
      };
      await chrome.storage.local.set(updates);
      return { ok: true, syncMode, ...(syncUrl ? { syncUrl } : {}) };
    }
    if (message.action === "test-sync") {
      if (sender.tab) throw new Error("Invalid test request");
      const syncUrl = validateSyncUrl(message.syncUrl);
      const res = await fetch(`${syncUrl}/health`, { method: "GET" });
      return { ok: res.ok, status: res.status };
    }
    if (message.action === "sync-capture") {
      if (sender.tab) throw new Error("Invalid sync-capture request");
      return await handleCaptureDispatch(message.capture);
    }
    if (!["capture", "capture-unavailable"].includes(message.action) || !sender.tab || sender.frameId !== 0) {
      throw new Error("Invalid capture request");
    }
    const url = new URL(sender.url);
    const provider = url.hostname === "chatgpt.com" ? "chatgpt" : url.hostname === "claude.ai" ? "claude" : null;
    if (!provider || url.protocol !== "https:") throw new Error("Unsupported page");
    const enabled = await chrome.storage.local.get(provider);
    if (!enabled[provider]) return { ok: false, captureDisabled: true };
    const match = url.pathname.match(provider === "chatgpt" ? /\/c\/([^/]+)$/ : /^\/chat\/([^/]+)$/);
    if (!match) throw new Error("Conversation mismatch");
    if (message.action === "capture-unavailable") {
      const reasons = {
        "missing-provider-ids": "Opened-page capture cannot find stable message IDs. Use website backfill for this conversation.",
        "snapshot-too-large": "Opened-page capture exceeds its size limit. Use website backfill to preserve this large conversation.",
      };
      if (!Object.hasOwn(reasons, message.reason)) throw new Error("Unsupported capture diagnostic");
      await state(reasons[message.reason]);
      return { ok: false, captureUnavailable: true };
    }
    if (!match || message.capture?.provider !== provider || message.capture?.conversation?.id !== match[1]) {
      throw new Error("Conversation mismatch");
    }
    return await handleCaptureDispatch(message.capture);
  })()
    .then(reply)
    .catch(async (error) => {
      const message = error instanceof Error && /Sync server URL/.test(error.message)
        ? error.message
        : "Capture unavailable. Check sync settings and page compatibility.";
      await state(message);
      reply({ ok: false, error: message });
    });
  return true;
});

async function restoreCapture() {
  for (const provider of Object.keys(sites)) {
    const enabled = await chrome.storage.local.get(provider);
    if (!enabled[provider]) continue;
    if (await chrome.permissions.contains({ origins: [sites[provider]] })) {
      await register(provider);
    } else {
      await chrome.scripting.unregisterContentScripts({ ids: [provider] }).catch(() => {});
      await state("Site access is no longer granted; capture remains off until you enable it.");
    }
  }
}

chrome.runtime.onStartup?.addListener(() =>
  restoreCapture().catch(() => state("Could not restore opened-page capture; enable it again from the popup.")),
);
chrome.runtime.onInstalled?.addListener(() =>
  restoreCapture().catch(() => state("Could not restore opened-page capture; enable it again from the popup.")),
);
