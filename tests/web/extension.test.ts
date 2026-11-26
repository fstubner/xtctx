import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface BackgroundOptions {
  enabled?: boolean;
  permitted?: boolean;
  storage?: Record<string, unknown>;
  fetchImpl?: (...args: unknown[]) => Promise<unknown>;
}

function background(enabledOrOpts: boolean | BackgroundOptions = true, permittedArg?: boolean) {
  const opts: BackgroundOptions =
    typeof enabledOrOpts === "boolean"
      ? { enabled: enabledOrOpts, permitted: permittedArg ?? enabledOrOpts }
      : enabledOrOpts;
  const enabled = opts.enabled ?? true;
  const permitted = opts.permitted ?? enabled;
  const store: Record<string, unknown> = {
    chatgpt: enabled,
    claude: enabled,
    ...opts.storage,
  };

  let startup: () => Promise<unknown> = async () => {};
  let listener: (message: unknown, sender: unknown, reply: (result: unknown) => void) => void = () => {};
  const sendNativeMessage = vi.fn(async () => ({ ok: true, syncEnabled: false }));
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(store, updates);
  });
  const registerContentScripts = vi.fn(async () => {});
  const fetchMock = vi.fn(
    opts.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ success: true, sessions: [] }) })),
  );

  const chrome = {
    runtime: {
      onStartup: { addListener: (fn: typeof startup) => { startup = fn; } },
      id: "fixture",
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
      sendNativeMessage,
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          if (typeof keys === "string") return { [keys]: store[keys] };
          const out: Record<string, unknown> = {};
          for (const k of keys) out[k] = store[k];
          return out;
        },
        set,
      },
    },
    tabs: { query: async () => [] },
    scripting: { unregisterContentScripts: async () => {}, registerContentScripts, executeScript: async () => {} },
    permissions: { contains: async () => permitted },
  };

  const context: Record<string, unknown> = {
    chrome,
    URL,
    TextEncoder,
    crypto: globalThis.crypto,
    fetch: fetchMock,
  };
  runInNewContext(readFileSync("browser-extension/redact.js", "utf8").replaceAll("export ", ""), context);
  runInNewContext(
    readFileSync("browser-extension/background.js", "utf8")
      .replace(/^import .*;\r?\n/gm, "")
      .replaceAll("export ", ""),
    context,
  );
  return {
    store,
    sendNativeMessage,
    fetch: fetchMock,
    set,
    registerContentScripts,
    startup: () => startup(),
    validateSyncUrl: context.validateSyncUrl as (raw: unknown) => string,
    request: (message: unknown, sender: unknown) => new Promise((resolve) => listener(message, sender, resolve)),
  };
}

const capture = {
  action: "capture",
  capture: {
    provider: "chatgpt",
    conversation: {
      id: "c",
      title: "Session title",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Use " + "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
          parent: null,
          timestamp: "2026-10-01T00:00:00.000Z",
        },
      ],
    },
  },
};
const sender = { id: "fixture", tab: { id: 1 }, frameId: 0, url: "https://chatgpt.com/c/c" };
const popupSender = { id: "fixture" };

it("manifest has no blanket sites, cookies, network interception or external message entry", () => {
  const manifest = JSON.parse(readFileSync("browser-extension/manifest.json", "utf8"));
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toEqual([
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://sync.xtctx.com/*",
  ]);
  expect(manifest.permissions).not.toContain("cookies");
  expect(manifest.permissions).not.toContain("webRequest");
  expect(manifest.externally_connectable).toBeUndefined();
});

it("default web sync mode posts a redacted /api/stream payload with Bearer auth and hides tokens", async () => {
  const secretToken = "xtctx_sync_secret_token_value";
  const b = background({
    storage: {
      syncToken: secretToken,
      syncAccountLabel: "personal",
    },
  });
  const res = (await b.request(capture, sender)) as { ok: boolean; redactedCount?: number };
  expect(res).toMatchObject({ ok: true, redactedCount: 1 });
  expect(b.sendNativeMessage).not.toHaveBeenCalled();
  expect(b.fetch).toHaveBeenCalledTimes(1);

  const [url, init] = b.fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://sync.xtctx.com/api/stream");
  expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${secretToken}`);

  const body = JSON.parse(String(init.body)) as {
    project: { repoUrl: string; name: string };
    sessions: Array<{
      tool: string;
      sourceSessionId: string;
      messages: Array<{ id: string; content: string; contentHash: string }>;
    }>;
  };
  expect(body.project).toEqual({ repoUrl: "web-history:personal", name: "web-history" });
  expect(body.sessions[0].tool).toBe("web-chatgpt");
  expect(body.sessions[0].sourceSessionId).toBe("c");
  expect(body.sessions[0].messages[0].id).toMatch(/^[0-9a-f]{64}$/);
  expect(body.sessions[0].messages[0].content).toBe("Use [REDACTED:github_token]");
  expect(JSON.stringify(b.set.mock.calls)).not.toContain(secretToken);
});

it("unconfigured web sync fails cleanly without sending native messages or network requests", async () => {
  const b = background({ storage: {} });
  const res = (await b.request(capture, sender)) as { ok: boolean; unconfigured?: boolean };
  expect(res).toMatchObject({ ok: false, unconfigured: true });
  expect(b.fetch).not.toHaveBeenCalled();
  expect(b.sendNativeMessage).not.toHaveBeenCalled();
});

it("rejects non-HTTPS remote sync URLs while permitting https:// and localhost", async () => {
  const b = background({ storage: { syncToken: "tok" } });
  expect(b.validateSyncUrl("https://sync.xtctx.com/")).toBe("https://sync.xtctx.com");
  expect(b.validateSyncUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  expect(() => b.validateSyncUrl("http://evil.test")).toThrow(/https:\/\//);
  expect(() => b.validateSyncUrl("https://user:pass@sync.xtctx.com")).toThrow(/credentials/);

  const res = (await b.request(
    { action: "save-sync-config", syncMode: "web", syncUrl: "http://evil.test", syncToken: "tok" },
    popupSender,
  )) as { ok: boolean; error?: string };
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/https:\/\//);
});

it("content-script tabs cannot overwrite sync config or call sync-capture", async () => {
  const b = background();
  expect(await b.request({ action: "save-sync-config", syncMode: "web" }, sender)).toMatchObject({ ok: false });
  expect(await b.request({ action: "sync-capture", capture: capture.capture }, sender)).toMatchObject({ ok: false });
});

it("local dev mode routes opened top-level pages to the fixed local native host", async () => {
  const b = background({ storage: { syncMode: "local" } });
  expect(await b.request(capture, sender)).toMatchObject({ ok: true });
  expect(b.sendNativeMessage).toHaveBeenCalledWith("io.xtctx.web_history", capture.capture);
  expect(b.fetch).not.toHaveBeenCalled();
});

it("disabled sites, other extensions, embedded frames and mismatched conversation IDs cannot capture", async () => {
  const disabled = background(false);
  expect(await disabled.request(capture, sender)).toMatchObject({ ok: false });
  expect(disabled.sendNativeMessage).not.toHaveBeenCalled();
  for (const invalid of [
    { ...sender, id: "other" },
    { ...sender, frameId: 1 },
    { ...sender, url: "https://evil.test/c/c" },
    { ...sender, url: "https://chatgpt.com/c/other" },
  ]) {
    const b = background({ storage: { syncMode: "local" } });
    expect(await b.request(capture, invalid)).toMatchObject({ ok: false });
    expect(b.sendNativeMessage).not.toHaveBeenCalled();
  }
});

it("capture diagnostics are fixed messages and never forward page-provided text", async () => {
  const b = background();
  expect(await b.request({ action: "capture-unavailable", reason: "snapshot-too-large" }, sender)).toMatchObject({
    captureUnavailable: true,
  });
  expect(b.sendNativeMessage).not.toHaveBeenCalled();
  expect(b.set).toHaveBeenCalledWith({ captureStatus: expect.stringContaining("website backfill") });
  await b.request({ action: "capture-unavailable", reason: "arbitrary webpage instructions" }, sender);
  expect(JSON.stringify(b.set.mock.calls)).not.toContain("arbitrary webpage instructions");
});

it("browser startup restores only previously enabled sites with an existing grant", async () => {
  const enabled = background();
  await enabled.startup();
  expect(enabled.registerContentScripts).toHaveBeenCalledTimes(2);
  const disabled = background(false);
  await disabled.startup();
  expect(disabled.registerContentScripts).not.toHaveBeenCalled();
  const revoked = background(true, false);
  await revoked.startup();
  expect(revoked.registerContentScripts).not.toHaveBeenCalled();
  expect(revoked.sendNativeMessage).not.toHaveBeenCalled();
});

it("stopped capture does not replace the saved status with an error on every page timer", async () => {
  const b = background(false);
  expect(await b.request(capture, sender)).toMatchObject({ captureDisabled: true });
  expect(b.set).not.toHaveBeenCalled();
  expect(b.sendNativeMessage).not.toHaveBeenCalled();
});

it("manifest keeps nativeMessaging optional and declares a 128px store icon", () => {
  const manifest = JSON.parse(readFileSync("browser-extension/manifest.json", "utf8")) as {
    icons?: Record<string, string>;
    permissions?: string[];
    optional_permissions?: string[];
  };
  expect(manifest.icons?.["128"]).toBe("icons/icon-128.png");
  expect(manifest.permissions).not.toContain("nativeMessaging");
  expect(manifest.optional_permissions).toContain("nativeMessaging");
});

it("popup requests nativeMessaging permission only when saving local dev mode", async () => {
  function runPopup(options: { grantNative: boolean }) {
    const handlers: Record<string, Record<string, () => Promise<void> | void>> = {};
    const elements: Record<string, Record<string, unknown>> = {};
    const getEl = (sel: string) => {
      if (!elements[sel]) {
        handlers[sel] = {};
        elements[sel] = {
          value: sel === "#sync-mode" ? "web" : "",
          checked: false,
          hidden: false,
          disabled: false,
          textContent: "",
          addEventListener: (ev: string, fn: () => Promise<void> | void) => {
            handlers[sel][ev] = fn;
          },
        };
      }
      return elements[sel];
    };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const permissionsRequest = vi.fn(async (req: { permissions?: string[] }) => {
      if (req.permissions?.includes("nativeMessaging")) return options.grantNative;
      return true;
    });
    const context = {
      URL,
      document: { querySelector: getEl },
      chrome: {
        runtime: { sendMessage },
        storage: { local: { get: async () => ({}) } },
        scripting: { getRegisteredContentScripts: async () => [] },
        permissions: {
          contains: async () => false,
          request: permissionsRequest,
        },
      },
    };
    const src = readFileSync("browser-extension/popup.js", "utf8");
    const ready = runInNewContext(`(async () => {\n${src}\n})()`, context) as Promise<void>;
    return { ready, elements, handlers, sendMessage, permissionsRequest };
  }

  // Denial in local mode aborts saving and falls back to web mode.
  const denied = runPopup({ grantNative: false });
  await denied.ready;
  denied.elements["#sync-mode"].value = "local";
  await denied.handlers["#save-sync"].click();
  expect(denied.permissionsRequest).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] });
  expect(denied.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "save-sync-config" }));
  expect(denied.elements["#sync-mode"].value).toBe("web");

  // Grant in local mode proceeds to save local sync config.
  const granted = runPopup({ grantNative: true });
  await granted.ready;
  granted.elements["#sync-mode"].value = "local";
  await granted.handlers["#save-sync"].click();
  expect(granted.permissionsRequest).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] });
  expect(granted.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ action: "save-sync-config", syncMode: "local" }),
  );
});
