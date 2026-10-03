import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCredentials, getCredentialsPath, saveCredentials } from "@xtctx/sync/client";
import { isOptedIn, setOptedIn } from "@xtctx/sync/consent";
import { describeCloudSync } from "@xtctx/sync/report";
import { sandbox } from "./helpers";

const creds = {
  token: "secret-token",
  user: { id: "github:1", username: "u" },
  deviceId: "dev",
  deviceName: "laptop",
  syncUrl: "https://sync.test",
};

describe("credentials and consent files", () => {
  let box: ReturnType<typeof sandbox>;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(() => box.cleanup());

  it.skipIf(process.platform === "win32")("writes credentials readable by the owner only", async () => {
    await saveCredentials(creds);
    expect(statSync(getCredentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("round-trips and deletes credentials", async () => {
    await saveCredentials(creds);
    expect(JSON.parse(readFileSync(getCredentialsPath(), "utf-8")).token).toBe("secret-token");
    await deleteCredentials();
    expect(() => statSync(getCredentialsPath())).toThrow();
  });

  it("keeps the opt-in per project, in the home directory", async () => {
    expect(await isOptedIn(box.project)).toBe(false);
    await setOptedIn(box.project, true);
    expect(await isOptedIn(box.project)).toBe(true);
    await setOptedIn(box.project, false);
    expect(await isOptedIn(box.project)).toBe(false);
  });

  it("status says there is no server when XTCTX_TOKEN is set without one to send it to", async () => {
    await setOptedIn(box.project, true);
    vi.stubEnv("XTCTX_TOKEN", "a.b.c");
    const lines = (await describeCloudSync(box.project)).join(" ");
    expect(lines).toMatch(/NOT uploading/);
    expect(lines).toMatch(/No sync server is set/);
  });
});
