import { describe, expect, it } from "vitest";
import { redactText } from "@xtctx/sync/redact";

const join = (...parts: string[]) => parts.join("");

describe("redactText", () => {
  it("leaves normal code, commands, and placeholders untouched", () => {
    const sample = [
      "const token = credentials.token;",
      "const accessToken = params.token;",
      'const example = "REPLACE_WITH_YOUR_KEY";',
      "JWT_SECRET=placeholder-not-real",
      "export API_KEY=$MY_LOCAL_ENV_KEY",
      "npm run build && git status",
      "Bearer authentication uses short-lived tokens.",
      "https://user:example@localhost:8787/api",
    ].join("\n");

    const res = redactText(sample);
    expect(res.text).toBe(sample);
    expect(res.totalRedacted).toBe(0);
    expect(res.counts).toEqual({});
  });

  it("redacts PEM private key blocks safely, and ignores unclosed headers without backtracking", () => {
    const pem = join(
      "-----BEGIN RSA PRIVATE KEY-----\n",
      "MIIEowIBAAKCAQEAtestline1\n",
      "MIIEowIBAAKCAQEAtestline2\n",
      "-----END RSA PRIVATE KEY-----",
    );
    const res = redactText(`key:\n${pem}\ndone`);
    expect(res.text).toBe("key:\n[REDACTED:private_key]\ndone");
    expect(res.counts.private_key).toBe(1);

    const unclosed = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "a".repeat(50_000);
    const resUnclosed = redactText(unclosed);
    expect(resUnclosed.text).toBe(unclosed);
    expect(resUnclosed.totalRedacted).toBe(0);
  });

  it("redacts high-confidence provider keys, JWTs, Authorization headers, URL passwords, and env secrets", () => {
    const anthropic = join("sk-ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUvWx");
    const openai = join("sk-proj-", "AbCdEfGhIjKlMnOpQrStUvWx");
    const github = join("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
    const githubPat = join("github_pat_", "11ABCDEFG_0123456789abcdefghijklmno");
    const aws = join("AKIA", "1234567890ABCDEF");
    const slack = join("xoxb-", "1234567890-abcdef");
    const stripe = join("sk_live_", "1234567890abcdef12");
    const google = join("AIza", "SyAbCdEfGhIjKlMnOpQrStUvWxYz1234567");
    const npmTok = join("npm_", "1234567890abcdefghijklmnopqrstuvwxyz");
    const hf = join("hf_", "abcdefghijklmnopqrstuvwxyz123456");
    const groq = join("gsk_", "1234567890abcdefghijkl");
    const jwt = join("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");

    const input = [
      `anthropic=${anthropic}`,
      `openai=${openai}`,
      `github=${github}`,
      `pat=${githubPat}`,
      `aws=${aws}`,
      `slack=${slack}`,
      `stripe=${stripe}`,
      `google=${google}`,
      `npm=${npmTok}`,
      `hf=${hf}`,
      `groq=${groq}`,
      `jwt=${jwt}`,
      "Authorization: Bearer super_secret_bearer_token_12345",
      "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l",
      "postgres://appuser:s3cr3tP4ss!@db.internal:5432/prod",
      'DB_PASSWORD="my-very-secret-password"',
    ].join("\n");

    const res = redactText(input);
    expect(res.text).toContain("anthropic=[REDACTED:anthropic_key]");
    expect(res.text).toContain("openai=[REDACTED:openai_key]");
    expect(res.text).toContain("github=[REDACTED:github_token]");
    expect(res.text).toContain("pat=[REDACTED:github_token]");
    expect(res.text).toContain("aws=[REDACTED:aws_access_key]");
    expect(res.text).toContain("slack=[REDACTED:slack_token]");
    expect(res.text).toContain("stripe=[REDACTED:stripe_key]");
    expect(res.text).toContain("google=[REDACTED:google_api_key]");
    expect(res.text).toContain("npm=[REDACTED:npm_token]");
    expect(res.text).toContain("hf=[REDACTED:hf_token]");
    expect(res.text).toContain("groq=[REDACTED:groq_key]");
    expect(res.text).toContain("jwt=[REDACTED:jwt]");
    expect(res.text).toContain("Authorization: Bearer [REDACTED:bearer_token]");
    expect(res.text).toContain("Authorization: Basic [REDACTED:basic_auth]");
    expect(res.text).toContain("postgres://appuser:[REDACTED:url_password]@db.internal:5432/prod");
    expect(res.text).toContain('DB_PASSWORD="[REDACTED:env_secret]"');
    expect(res.totalRedacted).toBe(16);

    // Strictly idempotent on second pass.
    const second = redactText(res.text);
    expect(second.text).toBe(res.text);
    expect(second.totalRedacted).toBe(0);
  });

  it("redacts PII only when pii: true, validating credit cards with Luhn", () => {
    const card = ["4111", "1111", "1111", "1111"].join("-");
    const notCard = ["4111", "1111", "1111", "1112"].join("-");
    const input = `Email alice@example.com, SSN 123-45-6789, card ${card}, bad ${notCard}, phone (415) 555-0199`;

    const off = redactText(input);
    expect(off.text).toBe(input);
    expect(off.totalRedacted).toBe(0);

    const on = redactText(input, { pii: true });
    expect(on.text).toBe(
      `Email [REDACTED:email], SSN [REDACTED:ssn], card [REDACTED:credit_card], bad ${notCard}, phone [REDACTED:phone]`,
    );
    expect(on.counts).toEqual({ email: 1, ssn: 1, credit_card: 1, phone: 1 });
    expect(on.totalRedacted).toBe(4);

    // Idempotent with pii: true as well.
    const second = redactText(on.text, { pii: true });
    expect(second.text).toBe(on.text);
    expect(second.totalRedacted).toBe(0);
  });

  it("supports custom patterns safely without crashing on invalid regexes", () => {
    const res = redactText("client secret-9988 inside prose", {
      customPatterns: ["[invalid(", "secret-\\d+"],
    });
    expect(res.text).toBe("client [REDACTED:custom] inside prose");
    expect(res.counts.custom).toBe(1);
    expect(redactText(res.text, { customPatterns: ["\\[REDACTED:custom\\]"] }).totalRedacted).toBe(0);
  });
});
