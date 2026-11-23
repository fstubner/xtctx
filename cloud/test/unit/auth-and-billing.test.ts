import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLI_SCOPES,
  allowedGithubIds,
  createJwt,
  isAllowedUser,
  mintToken,
  verifyJwt,
} from "../../src/auth/jwt.js";
import { DEFAULT_HOSTED_MESSAGE_QUOTA, resolveHostedQuota, verifyStripeSignature } from "../../src/billing.js";
import { SCOPE_READ } from "../../src/types.js";

const SECRET = "test-jwt-secret-at-least-32-characters-long";

describe("JWT minting and verification", () => {
  it("mints CLI vs read-only tokens with strict audiences and verifies HS256 signatures", async () => {
    const ctx = { publicUrl: "https://sync.example.com/some-ignored-path", jwtSecret: SECRET };

    const cliToken = await mintToken(
      ctx,
      { userId: "github:42", username: "alice", deviceId: "laptop", epoch: 3, scopes: CLI_SCOPES },
      3600,
    );
    const verifiedCli = await verifyJwt(cliToken, SECRET);
    expect(verifiedCli).toMatchObject({
      userId: "github:42",
      username: "alice",
      deviceId: "laptop",
      epoch: 3,
      scopes: CLI_SCOPES,
      audiences: ["https://sync.example.com/mcp", "https://sync.example.com/api"],
    });

    const readToken = await mintToken(
      ctx,
      { userId: "github:42", username: "alice", epoch: 3, scopes: [SCOPE_READ] },
      3600,
    );
    const verifiedRead = await verifyJwt(readToken, SECRET);
    expect(verifiedRead?.audiences).toEqual(["https://sync.example.com/mcp"]);
  });

  it("rejects tampered, expired, wrong-alg, and legacy unscoped tokens", async () => {
    const valid = await mintToken(
      { publicUrl: "https://sync.example.com", jwtSecret: SECRET },
      { userId: "github:1", username: "u", epoch: 0, scopes: [SCOPE_READ] },
      3600,
    );
    const [h, b, s] = valid.split(".");
    const tamperedSig = `${h}.${b}.${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    expect(await verifyJwt(tamperedSig, SECRET)).toBeNull();
    expect(await verifyJwt(valid, "different-secret-at-least-32-characters")).toBeNull();

    const noneAlg = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${b}.`;
    expect(await verifyJwt(noneAlg, SECRET)).toBeNull();

    const expired = await createJwt(
      { sub: "github:1", username: "u", ver: 0, scope: "read", aud: ["https://sync.example.com/mcp"] },
      SECRET,
      -5,
    );
    expect(await verifyJwt(expired, SECRET)).toBeNull();

    const unscoped = await createJwt({ sub: "github:1", username: "u", ver: 0 }, SECRET, 3600);
    expect(await verifyJwt(unscoped, SECRET)).toBeNull();
  });
});

describe("allowlist parsing", () => {
  it("accepts only strictly numeric GitHub ids", () => {
    const ctx = { allowedGithubIds: " 123 , abc , , 456 " };
    expect([...allowedGithubIds(ctx)]).toEqual(["123", "456"]);
    expect(isAllowedUser(ctx, "github:123")).toBe(true);
    expect(isAllowedUser(ctx, "github:456")).toBe(true);
    expect(isAllowedUser(ctx, "github:999")).toBe(false);
    expect(isAllowedUser({ allowedGithubIds: undefined }, "github:123")).toBe(false);
  });
});

describe("Stripe billing helpers", () => {
  it("verifies HMAC-SHA256 webhook signatures within 300s replay window", () => {
    const whSecret = "whsec_test_secret";
    const now = 1_700_000_000;
    const body = '{"id":"evt_1","type":"checkout.session.completed"}';
    const sigAt = (ts: number, payload = body) =>
      `t=${ts},v1=${createHmac("sha256", whSecret).update(`${ts}.${payload}`).digest("hex")}`;

    expect(verifyStripeSignature(body, sigAt(now), whSecret, now)).toBe(true);
    expect(verifyStripeSignature(body, sigAt(now - 299), whSecret, now)).toBe(true);
    expect(verifyStripeSignature(body, sigAt(now - 301), whSecret, now)).toBe(false);
    expect(verifyStripeSignature(body, sigAt(now + 301), whSecret, now)).toBe(false);
    expect(verifyStripeSignature('{"tampered":true}', sigAt(now), whSecret, now)).toBe(false);
    expect(verifyStripeSignature(body, "t=1700000000", whSecret, now)).toBe(false);
  });

  it("resolves hosted message quota safely", () => {
    expect(resolveHostedQuota({ hostedMessageQuota: undefined })).toBe(DEFAULT_HOSTED_MESSAGE_QUOTA);
    expect(resolveHostedQuota({ hostedMessageQuota: -5 })).toBe(DEFAULT_HOSTED_MESSAGE_QUOTA);
    expect(resolveHostedQuota({ hostedMessageQuota: 250 })).toBe(250);
  });
});
