import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "@xtctx/api/server";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../integration/fixtures/sample-project", import.meta.url),
);

describe("API web hosting", () => {
  let workspaceDir = "";
  let projectDir = "";
  let webStaticDir = "";
  let apiBaseUrl = "";
  let server: Server | null = null;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-web-serving-"));
    projectDir = join(workspaceDir, "sample-project");
    webStaticDir = join(workspaceDir, "web-dist");

    await cp(FIXTURE_PROJECT, projectDir, { recursive: true });
    await mkdir(join(webStaticDir, "assets"), { recursive: true });
    await writeFile(
      join(webStaticDir, "index.html"),
      "<!doctype html><html><body><div id=\"app\">xtctx-web</div></body></html>",
      "utf-8",
    );
    await writeFile(join(webStaticDir, "assets", "app.js"), "console.log('ok');", "utf-8");

    const { app } = await createApiApp(projectDir, { webStaticDir });
    server = createServer(app);

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        server?.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
    }

    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("serves SPA root and deep links while preserving API and health routes", async () => {
    const root = await fetch(`${apiBaseUrl}/`);
    const deepLink = await fetch(`${apiBaseUrl}/dashboard/recent`);
    const health = await fetch(`${apiBaseUrl}/health`);
    const apiStatus = await fetch(`${apiBaseUrl}/api/sources/status`);

    expect(root.status).toBe(200);
    expect(await root.text()).toContain("xtctx-web");

    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("xtctx-web");

    expect(health.status).toBe(200);
    expect((await health.json()) as { ok: boolean }).toEqual(
      expect.objectContaining({ ok: true }),
    );

    expect(apiStatus.status).toBe(200);
    expect((await apiStatus.json()) as { ok: boolean }).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("returns 404 for missing static assets instead of SPA html", async () => {
    const missingAsset = await fetch(`${apiBaseUrl}/assets/missing.js`);
    const body = await missingAsset.text();

    expect(missingAsset.status).toBe(404);
    expect(body).not.toContain("xtctx-web");
  });
});
