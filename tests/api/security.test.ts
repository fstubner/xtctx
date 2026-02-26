import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApiApp,
  type ApiSecurityOptions,
} from "@xtctx/api/server";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../integration/fixtures/sample-project", import.meta.url),
);

describe("API security controls", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0, servers.length)) {
      await closeServer(server);
    }

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces optional API token auth while leaving /health open", async () => {
    const { baseUrl } = await startFixtureServer(
      tempDirs,
      servers,
      {
        apiToken: "secret-token",
      },
    );

    const health = await fetch(`${baseUrl}/health`);
    const unauthorized = await fetch(`${baseUrl}/api/sources/status`);
    const authorized = await fetch(`${baseUrl}/api/sources/status`, {
      headers: { Authorization: "Bearer secret-token" },
    });

    expect(health.status).toBe(200);
    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("restricts CORS to localhost/same-origin allowlist", async () => {
    const { baseUrl } = await startFixtureServer(tempDirs, servers);

    const denied = await fetch(`${baseUrl}/api/sources/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });

    const allowed = await fetch(`${baseUrl}/api/sources/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });

  it("applies basic API rate limiting", async () => {
    const { baseUrl } = await startFixtureServer(tempDirs, servers, {
      rateLimitWindowMs: 60_000,
      rateLimitMax: 2,
    });

    const first = await fetch(`${baseUrl}/api/sources/status`);
    const second = await fetch(`${baseUrl}/api/sources/status`);
    const third = await fetch(`${baseUrl}/api/sources/status`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("reads token and CORS controls from .xtctx/config.yaml", async () => {
    const { baseUrl } = await startFixtureServer(
      tempDirs,
      servers,
      undefined,
      `
api:
  security:
    token: fixture-token
    allowedOrigins:
      - https://allowed.example
    allowLocalhostOrigins: false
`,
    );

    const unauthorized = await fetch(`${baseUrl}/api/sources/status`);
    const authorized = await fetch(`${baseUrl}/api/sources/status`, {
      headers: { Authorization: "Bearer fixture-token" },
    });
    const deniedOrigin = await fetch(`${baseUrl}/api/sources/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });
    const allowedOrigin = await fetch(`${baseUrl}/api/sources/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://allowed.example",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(deniedOrigin.status).toBe(403);
    expect(allowedOrigin.status).toBe(204);
    expect(allowedOrigin.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example",
    );
  });

  it("reads rate limit controls from .xtctx/config.yaml", async () => {
    const { baseUrl } = await startFixtureServer(
      tempDirs,
      servers,
      undefined,
      `
api:
  security:
    rateLimitWindowMs: 60000
    rateLimitMax: 1
`,
    );

    const first = await fetch(`${baseUrl}/api/sources/status`);
    const second = await fetch(`${baseUrl}/api/sources/status`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});

async function startFixtureServer(
  tempDirs: string[],
  servers: Server[],
  security?: Partial<ApiSecurityOptions>,
  configPatch?: string,
): Promise<{ baseUrl: string }> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-api-security-"));
  const projectDir = join(workspaceDir, "sample-project");
  tempDirs.push(workspaceDir);
  await cp(FIXTURE_PROJECT, projectDir, { recursive: true });
  if (configPatch) {
    const configPath = join(projectDir, ".xtctx", "config.yaml");
    const existing = await readFile(configPath, "utf-8");
    const normalized = existing.replace(/\r\n/g, "\n");
    const withoutApi = normalized.replace(/\napi:\n[\s\S]*$/m, "\n").trimEnd();
    await writeFile(
      configPath,
      `${withoutApi}\n${configPatch.trim()}\n`,
      "utf-8",
    );
  }

  const { app } = await createApiApp(projectDir, { security });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
