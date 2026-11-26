const status = document.querySelector("#status");
function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind ? `status ${kind}` : "status";
}
const syncModeEl = document.querySelector("#sync-mode");
const webFieldsEl = document.querySelector("#web-sync-fields");
const localNoteEl = document.querySelector("#local-sync-note");
const syncUrlEl = document.querySelector("#sync-url");
const syncTokenEl = document.querySelector("#sync-token");
const redactPiiEl = document.querySelector("#redact-pii");
const testSyncBtn = document.querySelector("#test-sync");
const sites = { chatgpt: "https://chatgpt.com/*", claude: "https://claude.ai/*" };

function toggleModeFields() {
  const local = syncModeEl.value === "local";
  webFieldsEl.hidden = local;
  localNoteEl.hidden = !local;
  testSyncBtn.hidden = local;
}

async function loadSyncSettings() {
  const saved = await chrome.storage.local.get(["syncMode", "syncUrl", "syncToken", "redactPii"]);
  syncModeEl.value = saved.syncMode === "local" ? "local" : "web";
  syncUrlEl.value = typeof saved.syncUrl === "string" && saved.syncUrl ? saved.syncUrl : "https://sync.xtctx.com";
  syncTokenEl.value = typeof saved.syncToken === "string" ? saved.syncToken : "";
  redactPiiEl.checked = Boolean(saved.redactPii);
  toggleModeFields();
}

async function refreshCapture() {
  const saved = await chrome.storage.local.get(["chatgpt", "claude"]);
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  let any = false;
  for (const provider of Object.keys(sites)) {
    const permitted = await chrome.permissions.contains({ origins: [sites[provider]] });
    const active = Boolean(saved[provider] && permitted && scripts.some((s) => s.id === provider));
    any ||= active;
    document.querySelector(`#${provider}-state`).textContent = active
      ? "Capture on"
      : saved[provider]
        ? "Needs enabling again"
        : "Capture off";
    const button = document.querySelector(`#${provider}`);
    button.textContent = active ? "Enabled" : "Enable capture";
    button.disabled = active;
  }
  document.querySelector("#stop").disabled = !any;
}

for (const provider of Object.keys(sites)) {
  document.querySelector(`#${provider}`).addEventListener("click", async () => {
    const button = document.querySelector(`#${provider}`);
    button.disabled = true;
    try {
      if (!(await chrome.permissions.request({ origins: [sites[provider]] }))) {
        setStatus("Site access was not granted. Capture remains off.", "err");
        return;
      }
      const result = await chrome.runtime.sendMessage({ action: "enable", provider });
      if (!result?.ok) throw Error();
      setStatus("Capture enabled. Use Import history above for older chats.", "ok");
    } catch {
      setStatus("Could not enable capture. Try again.", "err");
    } finally {
      await refreshCapture().catch(() => {
        button.disabled = false;
        setStatus("Could not check capture status. Reopen this popup.", "err");
      });
    }
  });
}

document.querySelector("#stop").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ action: "stop" });
    if (!result?.ok) throw Error();
    setStatus("Capture stopped. Saved history is retained.", "ok");
    await refreshCapture();
  } catch {
    setStatus("Could not stop capture. Try again.", "err");
  }
});

syncModeEl.addEventListener("change", async () => {
  toggleModeFields();
  if (syncModeEl.value === "local") {
    const hasNative = await chrome.permissions.contains({ permissions: ["nativeMessaging"] }).catch(() => false);
    if (!hasNative) {
      setStatus("Saving local dev mode will request the nativeMessaging permission.");
    }
  }
});

document.querySelector("#save-sync").addEventListener("click", async () => {
  try {
    const syncMode = syncModeEl.value === "local" ? "local" : "web";
    const syncUrl = syncUrlEl.value.trim() || "https://sync.xtctx.com";
    if (syncMode === "local") {
      const hasNative = await chrome.permissions.contains({ permissions: ["nativeMessaging"] }).catch(() => false);
      const granted = hasNative || await chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false);
      if (!granted) {
        syncModeEl.value = "web";
        toggleModeFields();
        setStatus("Local native host permission was not granted. Staying in web sync mode.", "err");
        return;
      }
    } else {
      const origin = new URL(syncUrl).origin + "/*";
      await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    }
    const result = await chrome.runtime.sendMessage({
      action: "save-sync-config",
      syncMode,
      syncUrl,
      syncToken: syncTokenEl.value,
      redactPii: redactPiiEl.checked,
    });
    if (!result?.ok) {
      setStatus(result?.error || "Could not save sync settings.", "err");
      return;
    }
    setStatus(syncMode === "local" ? "Saved: using local native host (dev mode)." : "Saved web sync settings.", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not save sync settings.", "err");
  }
});

testSyncBtn.addEventListener("click", async () => {
  try {
    const syncUrl = syncUrlEl.value.trim() || "https://sync.xtctx.com";
    const result = await chrome.runtime.sendMessage({ action: "test-sync", syncUrl });
    setStatus(
      result?.ok ? "Sync server reachable." : `Sync server check failed (${result?.status ?? "unreachable"}).`,
      result?.ok ? "ok" : "err",
    );
  } catch {
    setStatus("Could not reach sync server.", "err");
  }
});

const saved = await chrome.storage.local.get("captureStatus");
if (saved.captureStatus) setStatus(saved.captureStatus);
await loadSyncSettings().catch(() => {});
refreshCapture().catch(() => {
  setStatus("Could not check capture status. Reopen this popup.", "err");
});
