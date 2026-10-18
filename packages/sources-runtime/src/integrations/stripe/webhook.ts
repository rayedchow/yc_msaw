/**
 * Stripe webhook receiver (adapted from gigabrain 5448774 brain/src/integrations/stripe/webhook.ts).
 *
 * `POST /webhooks/stripe/:connectionId`: the connection id in the URL selects the stored endpoint secret and
 * the tenant. Nothing in the event body chooses a tenant. Then:
 *  1. the signature is verified over the exact raw body (current and previous secret, 300 s tolerance);
 *  2. `livemode` must match the connection's key mode;
 *  3. a Connect `account` field, if present, must be the connection's account;
 *  4. the event is stored post-redaction, deduplicated by `event.id` exactly as the donor did, and its object
 *     is folded into the current snapshot.
 * Exact redeliveries answer 200 `{duplicate: true}`. The donor's tenant-less `/webhooks/stripe` route answers
 * 410 with a pointer to the per-connection URL.
 */
import { Hono } from "hono";
import type { StripeEvent } from "./api.js";
import { connectionForWebhook } from "./connect.js";
import { verifyStripeSignature } from "./signature.js";
import { touchWebhook, type Executor } from "./store.js";
import { ingestEvent } from "./sync.js";
import { db as defaultDb } from "../../db/client.js";

const MAX_BODY_BYTES = 1024 * 1024;

export function createStripeWebhook(deps: { executor?: Executor; nowSeconds?: () => number } = {}): Hono {
  const app = new Hono();
  app.post("/", (c) => c.json({ error: "Use the per-connection webhook URL returned by the Stripe connect call (/webhooks/stripe/<connectionId>)" }, 410));
  app.post("/:connectionId", async (c) => {
    const executor = deps.executor ?? defaultDb;
    const conn = await connectionForWebhook(c.req.param("connectionId"), executor);
    if (!conn) return c.json({ error: "Unknown Stripe connection" }, 404);
    if (conn.status !== "active") return c.json({ error: "Stripe connection revoked" }, 410);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);
    const secrets = conn.webhookSecrets();
    if (!secrets.length) return c.json({ error: "Webhook signing secret not configured for this connection" }, 503);
    const verified = verifyStripeSignature(raw, c.req.header("stripe-signature"), secrets, deps.nowSeconds ? { nowSeconds: deps.nowSeconds() } : {});
    if (!verified.ok) return c.json({ error: "Invalid signature", reason: verified.reason }, 401);
    let event: StripeEvent;
    try {
      event = JSON.parse(raw) as StripeEvent;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!event || event.object !== "event" || typeof event.id !== "string" || !event.id.startsWith("evt_") || typeof event.type !== "string" || typeof event.created !== "number" || !event.data || typeof event.data.object !== "object") {
      return c.json({ error: "Not a Stripe event" }, 400);
    }
    if (event.livemode !== conn.livemode) return c.json({ error: "Event mode does not match the connection" }, 401);
    if (typeof event.account === "string" && event.account !== conn.accountId) return c.json({ error: "Event belongs to a different Stripe account" }, 401);
    const result = await ingestEvent(conn, event, { executor });
    await touchWebhook(conn.id, executor);
    return c.json(result.stored ? { received: true, eventId: event.id } : { received: true, duplicate: true });
  });
  return app;
}
