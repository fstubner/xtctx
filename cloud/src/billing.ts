import { createHmac, timingSafeEqual } from "node:crypto";
import type { CloudContext } from "./types.js";
import { isAllowedUser, publicOrigin } from "./auth/jwt.js";
import { withSystemDb } from "./db/pool.js";

export const DEFAULT_HOSTED_MESSAGE_QUOTA = 100_000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SubscriptionState {
  allowed: boolean;
  billing_enabled: boolean;
  status: string;
  stripe_customer_id: string | null;
  current_period_end: number | null;
  message_quota: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveHostedQuota(ctx: Pick<CloudContext, "hostedMessageQuota">): number {
  return typeof ctx.hostedMessageQuota === "number" &&
    Number.isInteger(ctx.hostedMessageQuota) &&
    ctx.hostedMessageQuota > 0
    ? ctx.hostedMessageQuota
    : DEFAULT_HOSTED_MESSAGE_QUOTA;
}

/**
 * Verifies a Stripe `Stripe-Signature` header (`t=<unix>,v1=<hex>,...`) using
 * constant-time comparison and a 300-second replay window.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(val)) {
      timestamp = Number(val);
    } else if (key === "v1" && /^[0-9a-f]+$/i.test(val)) {
      signatures.push(val.toLowerCase());
    }
  }

  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  for (const sig of signatures) {
    if (sig.length !== expected.length * 2) continue;
    const candidate = Buffer.from(sig, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

export async function getSubscriptionState(
  ctx: Pick<CloudContext, "pool" | "allowedGithubIds" | "stripeSecretKey" | "hostedMessageQuota">,
  userId: string,
): Promise<SubscriptionState> {
  const billingEnabled = Boolean(ctx.stripeSecretKey);
  if (isAllowedUser(ctx, userId)) {
    return {
      allowed: true,
      billing_enabled: billingEnabled,
      status: "allowlisted",
      stripe_customer_id: null,
      current_period_end: null,
      message_quota: null,
    };
  }

  const row = await withSystemDb(ctx, async (client) => {
    const res = await client.query<{
      stripe_customer_id: string | null;
      status: string;
      current_period_end: string | number | null;
    }>(
      "SELECT stripe_customer_id, status, current_period_end FROM subscriptions WHERE user_id = $1",
      [userId],
    );
    return res.rows[0] ?? null;
  }).catch(() => null);

  const status = row?.status ?? "none";
  const allowed = billingEnabled && (status === "active" || status === "trialing");
  return {
    allowed,
    billing_enabled: billingEnabled,
    status,
    stripe_customer_id: row?.stripe_customer_id ?? null,
    current_period_end: row?.current_period_end == null ? null : Number(row.current_period_end),
    message_quota: resolveHostedQuota(ctx),
  };
}

async function upsertSubscription(
  ctx: Pick<CloudContext, "pool">,
  params: {
    userId: string;
    customerId: string | null;
    subscriptionId: string | null;
    status: string;
    priceId: string | null;
    currentPeriodEnd: number | null;
  },
): Promise<void> {
  await withSystemDb(ctx, async (client) => {
    await client.query(
      `INSERT INTO subscriptions (
         user_id, stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
         stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
         status = EXCLUDED.status,
         price_id = COALESCE(EXCLUDED.price_id, subscriptions.price_id),
         current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
         updated_at = now()`,
      [
        params.userId,
        params.customerId,
        params.subscriptionId,
        params.status,
        params.priceId,
        params.currentPeriodEnd,
      ],
    );
  });
}

export async function handleStripeWebhook(request: Request, ctx: CloudContext): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
  }
  if (!ctx.stripeWebhookSecret) {
    return Response.json({ error: "webhook_not_configured" }, { status: 503 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "body_too_large" }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "body_too_large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(bytes);
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), ctx.stripeWebhookSecret)) {
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody) as { type?: unknown; data?: { object?: Record<string, unknown> } };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventType = asString(event.type);
  const obj = event.data?.object;
  if (!eventType || !obj) {
    return Response.json({ received: true });
  }

  if (eventType === "checkout.session.completed") {
    const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
    const userId = asString(obj.client_reference_id) ?? asString(metadata.user_id);
    if (userId) {
      const existing = await withSystemDb(ctx, async (client) => {
        const res = await client.query<{ status: string }>(
          "SELECT status FROM subscriptions WHERE user_id = $1",
          [userId],
        );
        return res.rows[0] ?? null;
      }).catch(() => null);

      const nextStatus =
        existing && (existing.status === "active" || existing.status === "trialing")
          ? existing.status
          : obj.payment_status === "no_payment_required"
            ? "trialing"
            : "active";

      await upsertSubscription(ctx, {
        userId,
        customerId: asString(obj.customer),
        subscriptionId: asString(obj.subscription),
        status: nextStatus,
        priceId: null,
        currentPeriodEnd: null,
      });
    }
    return Response.json({ received: true });
  }

  if (
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated" ||
    eventType === "customer.subscription.deleted"
  ) {
    const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
    const customerId = asString(obj.customer);
    const subscriptionId = asString(obj.id);
    let userId = asString(metadata.user_id);

    if (!userId && customerId) {
      userId = await withSystemDb(ctx, async (client) => {
        const res = await client.query<{ user_id: string }>(
          "SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1",
          [customerId],
        );
        return res.rows[0]?.user_id ?? null;
      }).catch(() => null);
    }
    if (!userId && subscriptionId) {
      userId = await withSystemDb(ctx, async (client) => {
        const res = await client.query<{ user_id: string }>(
          "SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1",
          [subscriptionId],
        );
        return res.rows[0]?.user_id ?? null;
      }).catch(() => null);
    }

    if (userId) {
      const items = ((obj.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0];
      const priceId =
        asString((items?.price as Record<string, unknown> | undefined)?.id) ??
        asString((obj.plan as Record<string, unknown> | undefined)?.id);
      const currentPeriodEnd =
        asNumber(obj.current_period_end) ?? asNumber(items?.current_period_end);
      const status =
        eventType === "customer.subscription.deleted"
          ? "canceled"
          : (asString(obj.status) ?? "incomplete");

      await upsertSubscription(ctx, {
        userId,
        customerId,
        subscriptionId,
        status,
        priceId,
        currentPeriodEnd,
      });
    }
  }

  return Response.json({ received: true });
}

export async function createCheckoutSession(
  ctx: Pick<CloudContext, "pool" | "publicUrl" | "stripeSecretKey" | "stripePriceId">,
  user: { userId: string; username: string },
): Promise<{ url: string } | { error: string; status: number }> {
  if (!ctx.stripeSecretKey || !ctx.stripePriceId) {
    return { error: "billing_not_configured", status: 503 };
  }

  const existing = await withSystemDb(ctx, async (client) => {
    const res = await client.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1",
      [user.userId],
    );
    return res.rows[0] ?? null;
  }).catch(() => null);

  const origin = publicOrigin(ctx);
  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": ctx.stripePriceId,
    "line_items[0][quantity]": "1",
    "subscription_data[trial_period_days]": "14",
    "subscription_data[metadata][user_id]": user.userId,
    "subscription_data[metadata][github_username]": user.username,
    allow_promotion_codes: "true",
    client_reference_id: user.userId,
    "metadata[user_id]": user.userId,
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/dashboard?billing=cancel`,
  });
  if (existing?.stripe_customer_id) {
    params.set("customer", existing.stripe_customer_id);
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!response?.ok) {
    return { error: "stripe_unavailable", status: 502 };
  }
  const data = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!data || typeof data.url !== "string") {
    return { error: "stripe_invalid_response", status: 502 };
  }
  return { url: data.url };
}

export async function createPortalSession(
  ctx: Pick<CloudContext, "pool" | "publicUrl" | "stripeSecretKey">,
  userId: string,
): Promise<{ url: string } | { error: string; status: number }> {
  if (!ctx.stripeSecretKey) {
    return { error: "billing_not_configured", status: 503 };
  }

  const row = await withSystemDb(ctx, async (client) => {
    const res = await client.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1",
      [userId],
    );
    return res.rows[0] ?? null;
  }).catch(() => null);

  if (!row?.stripe_customer_id) {
    return { error: "no_stripe_customer", status: 404 };
  }

  const origin = publicOrigin(ctx);
  const params = new URLSearchParams({
    customer: row.stripe_customer_id,
    return_url: `${origin}/dashboard`,
  });

  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!response?.ok) {
    return { error: "stripe_unavailable", status: 502 };
  }
  const data = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!data || typeof data.url !== "string") {
    return { error: "stripe_invalid_response", status: 502 };
  }
  return { url: data.url };
}

/** Cancel active Stripe subscription before deleting account data; fails closed on Stripe errors. */
export async function cancelActiveSubscription(
  ctx: Pick<CloudContext, "pool" | "stripeSecretKey">,
  userId: string,
): Promise<{ ok: true; canceled: boolean } | { ok: false; error: string; status: number }> {
  if (!ctx.stripeSecretKey) {
    return { ok: true, canceled: false };
  }

  const row = await withSystemDb(ctx, async (client) => {
    const res = await client.query<{ stripe_subscription_id: string | null; status: string }>(
      "SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1",
      [userId],
    );
    return res.rows[0] ?? null;
  });

  if (!row?.stripe_subscription_id || row.status === "canceled" || row.status === "incomplete_expired") {
    return { ok: true, canceled: false };
  }

  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ctx.stripeSecretKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);

  if (response && (response.ok || response.status === 404)) {
    return { ok: true, canceled: true };
  }
  return { ok: false, error: "stripe_cancel_failed", status: 502 };
}
