// Generated from src/sync/redact.ts; run node scripts/build-web-content.mjs.
/**
 * Best-effort deterministic redaction of secrets and optional PII before
 * transcript payloads leave the machine.
 *
 * Pure ES2022 with zero Node-specific imports so `scripts/build-web-content.mjs`
 * can transpile this module directly for the browser extension.
 */
const REDACTED_PREFIX = "[REDACTED:";
const PLACEHOLDER_RE = /^(?:replace(?:_with.*)?|example|sample|dummy|fake|changeme|placeholder|your[-_]|xxx+|null|undefined|true|false|none|unset|fixture|synthetic|test[-_])/i;
const DOTTED_IDENT_RE = /^[a-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)+$/;
function isPlaceholder(value) {
    if (!value || value.startsWith(REDACTED_PREFIX) || value.startsWith("$"))
        return true;
    if (PLACEHOLDER_RE.test(value))
        return true;
    return false;
}
function luhnCheck(digits) {
    if (digits.length < 13 || digits.length > 19)
        return false;
    let sum = 0;
    let alternate = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let n = digits.charCodeAt(i) - 48;
        if (n < 0 || n > 9)
            return false;
        if (alternate) {
            n *= 2;
            if (n > 9)
                n -= 9;
        }
        sum += n;
        alternate = !alternate;
    }
    return sum % 10 === 0;
}
/**
 * Redact PEM private key blocks using linear indexOf scanning so malformed or
 * unclosed headers can never trigger regex backtracking.
 */
function redactPemBlocks(text, record) {
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
        out += text.slice(cursor, match.index);
        out += record("private_key");
        cursor = endIndex + endMarker.length;
    }
    return out;
}
const SECRET_RULES = [
    // Provider keys (ordered more-specific first so `sk-ant-` beats generic `sk-`).
    {
        name: "anthropic_key",
        pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
        replace: () => "[REDACTED:anthropic_key]",
    },
    {
        name: "stripe_key",
        pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
        replace: () => "[REDACTED:stripe_key]",
    },
    {
        name: "openai_key",
        pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
        replace: () => "[REDACTED:openai_key]",
    },
    {
        name: "github_token",
        pattern: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
        replace: () => "[REDACTED:github_token]",
    },
    {
        name: "aws_access_key",
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replace: () => "[REDACTED:aws_access_key]",
    },
    {
        name: "slack_token",
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
        replace: () => "[REDACTED:slack_token]",
    },
    {
        name: "google_api_key",
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        replace: () => "[REDACTED:google_api_key]",
    },
    {
        name: "npm_token",
        pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
        replace: () => "[REDACTED:npm_token]",
    },
    {
        name: "hf_token",
        pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
        replace: () => "[REDACTED:hf_token]",
    },
    {
        name: "groq_key",
        pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g,
        replace: () => "[REDACTED:groq_key]",
    },
    {
        name: "jwt",
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        replace: () => "[REDACTED:jwt]",
    },
    {
        name: "bearer_token",
        pattern: /(\bAuthorization\s*:\s*Bearer\s+)([^\s'"`,;]{12,})/gi,
        replace: (_m, prefix, secret) => secret.startsWith(REDACTED_PREFIX) ? null : `${prefix}[REDACTED:bearer_token]`,
    },
    {
        name: "basic_auth",
        pattern: /(\bAuthorization\s*:\s*Basic\s+)([A-Za-z0-9+/=]{12,})/gi,
        replace: (_m, prefix, secret) => secret.startsWith(REDACTED_PREFIX) ? null : `${prefix}[REDACTED:basic_auth]`,
    },
    {
        name: "url_password",
        pattern: /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:@/\s"'`<>]+:)([^@/\s"'`<>]+)(@)/gi,
        replace: (_m, prefix, password, at) => isPlaceholder(password) ? null : `${prefix}[REDACTED:url_password]${at}`,
    },
    {
        name: "env_secret",
        pattern: /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|SECRET_KEY|ACCESS_SECRET|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|JWT_SECRET|DB_PASSWORD|PASSWORD|SECRET)|(?:api_key|apiKey|secret_key|secretKey|client_secret|clientSecret|auth_token|authToken|access_token|accessToken|refresh_token|refreshToken|private_key|privateKey|jwt_secret|jwtSecret|db_password|password|passwd))\b([ \t]*[:=][ \t]*)(["']?)([^\s"'\r\n,;{}()<>]{8,})\3/g,
        replace: (_m, key, sep, quote, value) => {
            if (isPlaceholder(value))
                return null;
            if (!quote && DOTTED_IDENT_RE.test(value))
                return null;
            return `${key}${sep}${quote}[REDACTED:env_secret]${quote}`;
        },
    },
];
const PII_RULES = [
    {
        name: "email",
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        replace: () => "[REDACTED:email]",
    },
    {
        name: "ssn",
        pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
        replace: () => "[REDACTED:ssn]",
    },
    {
        name: "credit_card",
        pattern: /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g,
        replace: (match) => {
            const digits = match.replace(/[^0-9]/g, "");
            return luhnCheck(digits) ? "[REDACTED:credit_card]" : null;
        },
    },
    {
        name: "phone",
        pattern: /(?<!\w)(?:\+?1[-.\s])?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
        replace: () => "[REDACTED:phone]",
    },
];
function applyRules(input, rules, record) {
    let current = input;
    for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        current = current.replace(rule.pattern, (full, ...rest) => {
            const replaced = rule.replace(full, ...rest);
            if (replaced === null || replaced === full)
                return full;
            record(rule.name);
            return replaced;
        });
    }
    return current;
}
export function redactText(text, options = {}) {
    if (!text)
        return { text, counts: {}, totalRedacted: 0 };
    const counts = {};
    let totalRedacted = 0;
    const record = (rule) => {
        counts[rule] = (counts[rule] ?? 0) + 1;
        totalRedacted += 1;
        return `[REDACTED:${rule}]`;
    };
    let out = redactPemBlocks(text, record);
    out = applyRules(out, SECRET_RULES, record);
    if (options.pii) {
        out = applyRules(out, PII_RULES, record);
    }
    if (Array.isArray(options.customPatterns)) {
        for (const raw of options.customPatterns) {
            if (typeof raw !== "string" || !raw)
                continue;
            let custom;
            try {
                custom = new RegExp(raw, "g");
            }
            catch {
                continue;
            }
            out = out.replace(custom, (match) => {
                if (!match || match.startsWith(REDACTED_PREFIX))
                    return match;
                return record("custom");
            });
        }
    }
    return { text: out, counts, totalRedacted };
}
