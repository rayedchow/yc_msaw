/**
 * Stripe connect (adapted from gigabrain 5448774 brain/src/integrations/stripe/connect.ts).
 *
 * Differences from the donor, on purpose:
 *  - The tenant comes from the verified yc_msaw principal (internal route), never from the request.
 *  - Each connection gets its own webhook URL (`/webhooks/stripe/<connectionId>`). The donor's single
 *    `/webhooks/stripe` route hard-coded `userId = "default"`.
 *  - No Stripe-side mutation. The donor created (and deleted) webhook endpoints with the secret key. Here the
 *    operator creates the endpoint in the Stripe Dashboard for the returned URL and event list, then posts its
 *    signing secret (`whsec_…`). A restricted read-only key (`rk_…`) is recommended.
 *  - The key is verified read-only (`GET /v1/account`, `GET /v1/events?limit=1`), and each permission gap
 *    is reported per lane instead of failing the connection.
 */
import { upsertConnection } from "../../db/connections.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import type { ConnectResult } from "../types.js";
import { StripeApiError, StripeClient, type FetchImpl } from "./api.js";
import { getConnection, insertConnection, listConnections, newConnectionId, revokeConnections, setWebhookSecret, type Executor } from "./store.js";
import { STRIPE_SYNC_FREQUENCY_SECONDS, configuredResources } from "./sync.js";
import { db as defaultDb } from "../../db/client.js";

/** The donor's curated event list (gigabrain connect.ts STRIPE_EVENTS), plus deletions the snapshots need. */
export const STRIPE_WEBHOOK_EVENTS = [
  "customer.created", "customer.updated", "customer.deleted",
  "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.trial_will_end",
  "invoice.paid", "invoice.payment_failed", "invoice.finalized", "invoice.deleted",
  "charge.dispute.created", "charge.dispute.closed",
  "payout.paid", "payout.failed",
  "checkout.session.completed", "checkout.session.expired",
  "product.created", "product.updated", "product.deleted",
  "price.created", "price.updated", "price.deleted",
  "payment_link.created",
] as const;

const API_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,247}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{8,250}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{6,64}$/;
const CONNECTION_ID = /^sc_[0-9a-f]{24}$/;

export function stripePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL)?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function stripeWebhookUrl(connectionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = stripePublicBaseUrl(env);
  return base ? `${base}/webhooks/stripe/${connectionId}` : null;
}

export interface StripeConnectDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
}

function bad(message: string, code = "invalid_input", status = 400): ConnectResult {
  return { status, body: { error: { code, message } } };
}

/**
 * Body: `{apiKey, webhookSecret?, label?, accountId?}` creates a connection. `{connectionId, webhookSecret}`
 * sets (rotates) the signing secret of an existing connection. `{list: true}` lists connections without secrets.
 */
export async function connectStripe(input: { tenantId: string; body: unknown }, deps: StripeConnectDeps = {}): Promise<ConnectResult> {
  const executor = deps.executor ?? defaultDb;
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const allowed = new Set(["apiKey", "webhookSecret", "label", "accountId", "connectionId", "list"]);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) return bad(`Unknown field(s): ${unknown.join(", ")}`);

  if (body.list === true) {
    return { status: 200, body: { connections: (await listConnections(input.tenantId, executor)).map((c) => ({ ...c, webhookUrl: stripeWebhookUrl(c.id, deps.env) })) } };
  }

  if (typeof body.connectionId === "string") {
    if (!CONNECTION_ID.test(body.connectionId)) return bad("Invalid connectionId");
    if (typeof body.webhookSecret !== "string" || !WEBHOOK_SECRET.test(body.webhookSecret)) return bad("webhookSecret must be the endpoint signing secret (whsec_…)");
    const ok = await setWebhookSecret(input.tenantId, body.connectionId, body.webhookSecret, executor);
    return ok ? { status: 200, body: { connectionId: body.connectionId, webhookSecret: "stored" } } : bad("No active Stripe connection with that id", "not_found", 404);
  }

  if (typeof body.apiKey !== "string" || !API_KEY.test(body.apiKey)) return bad("apiKey must be a Stripe secret (sk_…) or restricted (rk_…) key");
  if (body.webhookSecret !== undefined && (typeof body.webhookSecret !== "string" || !WEBHOOK_SECRET.test(body.webhookSecret))) return bad("webhookSecret must be the endpoint signing secret (whsec_…)");
  if (body.accountId !== undefined && (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId))) return bad("accountId must look like acct_…");
  if (body.label !== undefined && typeof body.label !== "string") return bad("label must be a string");
  const apiKey = body.apiKey;
  const livemode = /_live_/.test(apiKey);
  const keyKind = apiKey.startsWith("rk_") ? "restricted" : "secret";
  const client = new StripeClient(apiKey, deps.fetchImpl, deps.apiBase);

  let accountId: string | null = null;
  let accountVerified = false;
  try {
    accountId = (await client.account()).id;
    accountVerified = true;
  } catch (err) {
    if (err instanceof StripeApiError && err.status === 401) return bad("Stripe rejected the API key", "invalid_api_key");
    if (!(err instanceof StripeApiError && err.status === 403)) return bad(`Could not verify the key: ${err instanceof Error ? err.message : String(err)}`, "stripe_unreachable", 502);
  }
  if (accountId && typeof body.accountId === "string" && body.accountId !== accountId) return bad("accountId does not match the key's account", "account_mismatch", 409);
  if (!accountId) {
    if (typeof body.accountId !== "string") return bad("This restricted key cannot read /v1/account; pass accountId (acct_…) explicitly", "account_unverifiable");
    accountId = body.accountId;
  }
  let eventsReadable: boolean | string = true;
  try {
    await client.listEvents({ limit: 1 });
  } catch (err) {
    if (err instanceof StripeApiError && err.status === 401) return bad("Stripe rejected the API key", "invalid_api_key");
    eventsReadable = err instanceof StripeApiError ? `events not readable (${err.status}): ${err.message}` : String(err);
  }

  const id = newConnectionId();
  const connection = await insertConnection({
    id, tenantId: input.tenantId, accountId, accountVerified, livemode,
    label: typeof body.label === "string" ? body.label.slice(0, 200) : null,
    apiKey, keyKind, webhookSecret: typeof body.webhookSecret === "string" ? body.webhookSecret : null,
  }, executor);
  await upsertConnection({ tenantId: input.tenantId, provider: "stripe", externalAccountId: accountId, status: "active", metadata: { connectionId: id, livemode, keyKind } }, executor);
  await upsertTaskSchedule({ tenantId: input.tenantId, kind: "stripe.sync", frequencySeconds: STRIPE_SYNC_FREQUENCY_SECONDS, queue: "sync", groupKey: `${input.tenantId}:stripe` }, executor);
  await enqueueTask({ queue: "backfill", tenantId: input.tenantId, kind: "stripe.backfill", groupKey: `${input.tenantId}:stripe`, dedupeKey: `${input.tenantId}:stripe.backfill:${id}`, payload: { tenantId: input.tenantId } }, executor);
  const webhookUrl = stripeWebhookUrl(id, deps.env);
  return {
    status: 201,
    body: {
      connection,
      webhookUrl,
      webhookEvents: [...STRIPE_WEBHOOK_EVENTS],
      snapshotResources: configuredResources(),
      eventsReadable,
      note: webhookUrl
        ? "Create a webhook endpoint in the Stripe Dashboard for webhookUrl with webhookEvents, then POST {connectionId, webhookSecret} with its signing secret. Until then events are collected by polling only."
        : "SOURCES_RUNTIME_PUBLIC_URL is not set, so no webhook URL can be offered; events are collected by polling only.",
    },
  };
}

/** Tenant disconnect: erase credentials and stop the lanes (the Dashboard endpoint must be deleted by the operator). */
export async function disconnectStripe(input: { tenantId: string }, deps: StripeConnectDeps = {}): Promise<void> {
  await revokeConnections(input.tenantId, deps.executor ?? defaultDb);
}

export async function connectionForWebhook(connectionId: string, executor: Executor = defaultDb) {
  if (!CONNECTION_ID.test(connectionId)) return null;
  return getConnection(connectionId, executor);
}
