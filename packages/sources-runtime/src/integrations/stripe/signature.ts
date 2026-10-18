import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signature verification, as specified by Stripe ("Verify webhook signatures manually"):
 * the `Stripe-Signature` header is `t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=…][,v0=…]`, the signed
 * payload is `${t}.${rawBody}` and the key is the endpoint's signing secret (`whsec_…`). Any `v1` may match
 * (secret rolling sends one per active secret); `v0` (test-only scheme) is ignored. A timestamp outside the
 * tolerance is refused to bound replays; exact replays inside it are deduplicated by event id.
 *
 * Same algorithm as the donor's `stripe.webhooks.constructEvent` (gigabrain 5448774 webhook.ts), implemented
 * here so the runtime needs no Stripe SDK dependency.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type StripeSignatureFailure = "missing_header" | "malformed_header" | "timestamp_out_of_tolerance" | "no_matching_signature";

export function parseStripeSignatureHeader(header: string): { timestamp: number; v1: string[] } | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) v1.push(value.toLowerCase());
  }
  return timestamp === null || v1.length === 0 ? null : { timestamp, v1 };
}

export function stripeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Header value Stripe would send for `rawBody` (tests and fixtures; same as the SDK's generateTestHeaderString). */
export function stripeSignatureHeader(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${stripeSignature(secret, timestamp, rawBody)}`;
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secrets: readonly string[],
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): { ok: true; secretIndex: number } | { ok: false; reason: StripeSignatureFailure } {
  if (!header) return { ok: false, reason: "missing_header" };
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > (opts.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  for (let i = 0; i < secrets.length; i++) {
    const expected = Buffer.from(stripeSignature(secrets[i]!, parsed.timestamp, rawBody), "hex");
    for (const candidate of parsed.v1) {
      const got = Buffer.from(candidate, "hex");
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, secretIndex: i };
    }
  }
  return { ok: false, reason: "no_matching_signature" };
}
