import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { FakeStripe, db, evt, json, query, ready, resetAll } from "./harness.js";
import { connectStripe, disconnectStripe } from "../../../../src/integrations/stripe/connect.js";
import { stripeSignatureHeader, verifyStripeSignature } from "../../../../src/integrations/stripe/signature.js";
import { createStripeWebhook } from "../../../../src/integrations/stripe/webhook.js";
import { getConnection, listConnections, STRIPE_REDACTED } from "../../../../src/integrations/stripe/store.js";
import { runEventsBackfill, runObjectListing, runStripeSync, STRIPE_EVENTS_RETENTION_DAYS } from "../../../../src/integrations/stripe/sync.js";
import { stripeIntegration } from "../../../../src/integrations/stripe/index.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { stripeProvider, stripeSnapshotPath, stripeSnapshotsExport } from "../../../../src/source-lane/providers/stripe/index.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";

/**
 * Stripe lane (coordinator port of gigabrain 5448774 brain/src/integrations/stripe): signed webhooks with the
 * tenant bound to the URL connection, event.id dedupe, the 30-day events backfill, resumable listings,
 * Retry-After, tombstones, redaction, export mapping and truthful coverage. Production code only.
 */
const T = "tenant-stripe";
const T2 = "tenant-stripe-rival";
const SECRET = "whsec_testsecretAAAAAAAA";
const ENV = { SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test" } as NodeJS.ProcessEnv;
let fake: FakeStripe;
const deps = () => ({ fetchImpl: fake.fetch, executor: db as never });
const now = () => Math.floor(Date.now() / 1000);
const cus = (id: string, extra: Record<string, unknown> = {}) => ({ id, object: "customer", email: `${id}@example.test`, ...extra });

async function connect(tenant = T, body: Record<string, unknown> = {}) {
  const r = await connectStripe({ tenantId: tenant, body: { apiKey: "sk_test_validkey123", webhookSecret: SECRET, ...body } }, { ...deps(), env: ENV });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { connection: { id: string } }).connection.id;
}

async function deliver(connectionId: string, event: unknown, opts: { secret?: string; timestamp?: number; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(event);
  const app = createStripeWebhook({ executor: db as never });
  return app.request(`/${connectionId}`, {
    method: "POST",
    headers: { "stripe-signature": stripeSignatureHeader(opts.secret ?? SECRET, raw, opts.timestamp ?? now()), "content-type": "application/json" },
    body: raw,
  });
}

const storedEvents = (tenant = T) => query<{ source_event_id: string; raw_payload: Record<string, unknown>; source_namespace: string; source_object_id: string }>(
  `SELECT source_event_id, raw_payload, source_namespace, source_object_id FROM activity_events WHERE user_id = $1 AND source = 'stripe' ORDER BY source_event_id`, [tenant]);
const snapshots = (tenant = T) => query<{ resource: string; object_id: string; deleted: boolean; deleted_reason: string | null; payload: Record<string, unknown> }>(
  `SELECT resource, object_id, deleted, deleted_reason, payload FROM stripe_object_snapshots WHERE tenant_id = $1 ORDER BY resource, object_id`, [T === tenant ? T : tenant]);
const coverage = (tenant = T) => stripeProvider.coverage!({ tenantId: tenant, executor: db as never });

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
  fake = new FakeStripe();
  vi.stubEnv("STRIPE_PAGES_PER_RUN", "50");
});
afterEach(() => vi.unstubAllEnvs());

describe("signature verification (Stripe's documented scheme)", () => {
  it("accepts any matching v1, refuses wrong secret, tampering and stale timestamps", () => {
    const body = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const header = stripeSignatureHeader(SECRET, body, t);
    expect(verifyStripeSignature(body, header, [SECRET], { nowSeconds: t + 10 })).toEqual({ ok: true, secretIndex: 0 });
    expect(verifyStripeSignature(body, `${header},v1=${"0".repeat(64)}`, ["whsec_other", SECRET], { nowSeconds: t })).toEqual({ ok: true, secretIndex: 1 });
    expect(verifyStripeSignature(body, header, ["whsec_wrongwrongwrong"], { nowSeconds: t })).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verifyStripeSignature(`${body} `, header, [SECRET], { nowSeconds: t })).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verifyStripeSignature(body, header, [SECRET], { nowSeconds: t + 301 })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(verifyStripeSignature(body, "garbage", [SECRET])).toEqual({ ok: false, reason: "malformed_header" });
    expect(verifyStripeSignature(body, null, [SECRET])).toEqual({ ok: false, reason: "missing_header" });
  });
});

describe("connect", () => {
  it("verifies the key read-only, stores encrypted credentials, schedules the lanes and offers a per-connection webhook URL", async () => {
    expect((await connectStripe({ tenantId: T, body: { apiKey: "sk_test_nope00000" } }, { ...deps(), env: ENV })).status).toBe(400);
    expect((await connectStripe({ tenantId: T, body: { apiKey: "pk_test_publishable" } }, { ...deps(), env: ENV })).status).toBe(400);
    expect((await connectStripe({ tenantId: T, body: { apiKey: "sk_test_validkey123", tenantId: T2 } }, { ...deps(), env: ENV })).status).toBe(400);

    fake.calls.length = 0;
    const r = await connectStripe({ tenantId: T, body: { apiKey: "sk_test_validkey123", label: "Main" } }, { ...deps(), env: ENV });
    expect(r.status).toBe(201);
    const body = r.body as { connection: { id: string; accountId: string; accountVerified: boolean; hasWebhookSecret: boolean }; webhookUrl: string; webhookEvents: string[] };
    expect(body.connection).toMatchObject({ accountId: "acct_1TESTacct", accountVerified: true, hasWebhookSecret: false });
    expect(body.webhookUrl).toBe(`https://runtime.example.test/webhooks/stripe/${body.connection.id}`);
    expect(body.webhookEvents).toContain("customer.deleted");
    expect(fake.calls.map((u) => u.pathname)).toEqual(["/v1/account", "/v1/events"]);

    const [row] = await query<{ api_key_ciphertext: string }>(`SELECT api_key_ciphertext FROM stripe_connections WHERE id = $1`, [body.connection.id]);
    expect(row!.api_key_ciphertext).not.toContain("validkey");
    expect(JSON.stringify(await listConnections(T, db as never))).not.toContain("validkey");
    expect((await query(`SELECT kind FROM task_queue WHERE tenant_id = $1`, [T])).map((t) => t.kind)).toEqual(["stripe.backfill"]);
    expect((await query(`SELECT kind FROM task_schedules WHERE tenant_id = $1`, [T])).map((t) => t.kind)).toEqual(["stripe.sync"]);

    // The signing secret is posted after creating the Dashboard endpoint; only the owning tenant can set it.
    expect((await connectStripe({ tenantId: T2, body: { connectionId: body.connection.id, webhookSecret: SECRET } }, deps())).status).toBe(404);
    expect((await connectStripe({ tenantId: T, body: { connectionId: body.connection.id, webhookSecret: SECRET } }, deps())).status).toBe(200);
    expect((await getConnection(body.connection.id, db as never))!.webhookSecrets()).toEqual([SECRET]);
  });

  it("restricted keys without account access must name the account; a mismatch is refused", async () => {
    fake.accountStatus = 403;
    const k = { apiKey: "rk_test_restricted123" };
    expect((await connectStripe({ tenantId: T, body: k }, deps())).body).toMatchObject({ error: { code: "account_unverifiable" } });
    const r = await connectStripe({ tenantId: T, body: { ...k, accountId: "acct_1Declared" } }, deps());
    expect(r.status).toBe(201);
    expect((r.body as { connection: unknown }).connection).toMatchObject({ accountId: "acct_1Declared", accountVerified: false, keyKind: "restricted" });
    fake.accountStatus = 200;
    expect((await connectStripe({ tenantId: T, body: { apiKey: "sk_test_validkey123", accountId: "acct_1Other" } }, deps())).body).toMatchObject({ error: { code: "account_mismatch" } });
  });
});

describe("webhook", () => {
  it("stores signed events for the URL's tenant once, redacts capability secrets, and refuses forgeries", async () => {
    const id = await connect();
    const e1 = evt("evt_1", "payment_intent.succeeded", now(), { id: "pi_1", object: "payment_intent", client_secret: "pi_1_secret_abc", amount: 500 }, { tenant: T2, userId: T2 });
    const ok = await deliver(id, e1);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, eventId: "evt_1" });
    expect(await (await deliver(id, e1)).json()).toEqual({ received: true, duplicate: true });

    const [stored] = await storedEvents();
    expect(stored).toMatchObject({ source_event_id: "evt_1", source_namespace: "account:acct_1TESTacct", source_object_id: "payment_intent:pi_1" });
    expect((stored!.raw_payload.data as { object: Record<string, unknown> }).object).toMatchObject({ client_secret: STRIPE_REDACTED, amount: 500 });
    expect(await storedEvents(T2)).toEqual([]);

    expect((await deliver(id, evt("evt_2", "x", now(), cus("cus_x")), { secret: "whsec_wrongwrongwrong" })).status).toBe(401);
    const raw = JSON.stringify(evt("evt_3", "x", now(), cus("cus_x")));
    const header = stripeSignatureHeader(SECRET, raw);
    const app = createStripeWebhook({ executor: db as never });
    expect((await app.request(`/${id}`, { method: "POST", headers: { "stripe-signature": header }, body: raw.replace("cus_x", "cus_y") })).status).toBe(401);
    expect((await deliver(id, evt("evt_4", "x", now() - 3600, cus("cus_x")), { timestamp: now() - 3600 })).status).toBe(401);
    expect((await deliver(id, { ...evt("evt_5", "x", now(), cus("cus_x")), livemode: true })).status).toBe(401);
    expect((await deliver(id, evt("evt_6", "x", now(), cus("cus_x"), { account: "acct_1Someoneelse" }))).status).toBe(401);
    expect((await deliver("sc_000000000000000000000000", e1)).status).toBe(404);
    expect((await app.request("/", { method: "POST", body: "{}" })).status).toBe(410);
    expect((await storedEvents()).map((e) => e.source_event_id)).toEqual(["evt_1"]);

    // Secret rotation: the previous secret keeps verifying until the next rotation.
    await connectStripe({ tenantId: T, body: { connectionId: id, webhookSecret: "whsec_rotatedBBBBBBBB" } }, deps());
    expect((await deliver(id, evt("evt_7", "customer.created", now(), cus("cus_7")))).status).toBe(200);
    expect((await deliver(id, evt("evt_8", "customer.created", now(), cus("cus_8")), { secret: "whsec_rotatedBBBBBBBB" })).status).toBe(200);

    // Disconnect erases credentials; the endpoint answers 410 and nothing else is stored.
    await stripeIntegration.disconnect!({ tenantId: T });
    expect((await deliver(id, evt("evt_9", "customer.created", now(), cus("cus_9")))).status).toBe(410);
    expect((await query<{ api_key_ciphertext: string; status: string }>(`SELECT api_key_ciphertext, status FROM stripe_connections WHERE id = $1`, [id]))[0]).toEqual({ api_key_ciphertext: "", status: "revoked" });
  });

  it("folds webhook objects into snapshots in event order; a late older event cannot overwrite newer state", async () => {
    const id = await connect();
    const t = now();
    await deliver(id, evt("evt_b", "customer.updated", t, cus("cus_1", { name: "New" })));
    await deliver(id, evt("evt_a", "customer.updated", t - 100, cus("cus_1", { name: "Old" })));
    expect((await snapshots())[0]).toMatchObject({ object_id: "cus_1", deleted: false, payload: { name: "New" } });
    await deliver(id, evt("evt_c", "customer.deleted", t + 5, cus("cus_1", { name: "New", deleted: true })));
    expect((await snapshots())[0]).toMatchObject({ deleted: true, deleted_reason: "stripe_event:customer.deleted" });
    expect((await storedEvents()).map((e) => e.source_event_id)).toEqual(["evt_a", "evt_b", "evt_c"]);
  });
});

describe("events backfill", () => {
  it("never requests more than Stripe's 30-day retention, resumes page by page, and honours Retry-After", async () => {
    vi.stubEnv("STRIPE_EVENTS_BACKFILL_DAYS", "3650");
    vi.stubEnv("STRIPE_PAGES_PER_RUN", "2");
    const id = await connect();
    const t = now();
    fake.events = Array.from({ length: 450 }, (_, i) => evt(`evt_${String(i).padStart(4, "0")}`, "customer.updated", t - i * 60, cus(`cus_${i % 7}`)));
    let limited = 0;
    fake.hooks.push((url) => {
      if (url.pathname === "/v1/events" && url.searchParams.get("starting_after") === "evt_0299" && limited++ === 0) {
        return json({ error: { type: "rate_limit_error", message: "Too many requests" } }, 429, { "retry-after": "120" });
      }
      return undefined;
    });
    const conn = (await listConnections(T, db as never))[0]!;
    const r1 = await runEventsBackfill(conn, deps());
    expect(r1).toMatchObject({ status: "running", pages: 2 });
    const gte = Number(fake.calls.find((u) => u.pathname === "/v1/events" && u.searchParams.get("created[gte]") && !u.searchParams.get("starting_after") && u.searchParams.get("limit") === "100")!.searchParams.get("created[gte]"));
    expect(t - gte).toBeLessThanOrEqual(STRIPE_EVENTS_RETENTION_DAYS * 86_400 + 5);
    expect((await storedEvents()).length).toBe(200);

    const r2 = await runEventsBackfill(conn, deps());
    expect(r2.status).toBe("error");
    expect(r2.reason).toMatch(/rate_limited/);
    const [cur] = await query<{ retry_at: string; state: { startingAfter: string } }>(`SELECT retry_at, state FROM stripe_cursors WHERE connection_id = $1 AND lane = 'events:backfill'`, [id]);
    expect(cur!.state.startingAfter).toBe("evt_0299");
    expect(Date.parse(cur!.retry_at) - Date.now()).toBeGreaterThan(110_000);
    expect((await runEventsBackfill(conn, deps())).status).toBe("skipped");

    await query(`UPDATE stripe_cursors SET retry_at = now() - interval '1 second' WHERE connection_id = $1`, [id]);
    await runEventsBackfill(conn, deps());
    const done = await runEventsBackfill(conn, deps());
    expect(done.status).toBe("complete");
    expect((await storedEvents()).length).toBe(450);
    expect((await coverage()).find((c) => c.scope.endsWith(":events"))!.state).toBe("partial"); // poll has not run yet
    await runStripeSync(T, { ...deps(), resources: [] });
    const events = (await coverage()).find((c) => c.scope.endsWith(":events"))!;
    expect(events.state).toBe("complete");
    expect(events.reason).toMatch(/30 days only/);
  });
});

describe("object listings", () => {
  it("lists every page, tombstones objects a later full listing no longer returns, and blocks only the resource a key cannot read", async () => {
    vi.stubEnv("STRIPE_PAGES_PER_RUN", "1");
    vi.stubEnv("STRIPE_SNAPSHOT_REFRESH_SECONDS", "600");
    await connect();
    const conn = (await listConnections(T, db as never))[0]!;
    fake.objects.customers = Array.from({ length: 250 }, (_, i) => cus(`cus_${String(i).padStart(3, "0")}`)).map((c) => ({ ...c }));
    fake.hooks.push((url) => (url.pathname === "/v1/invoices" ? json({ error: { type: "invalid_request_error", message: "The provided key does not have the required permissions for this endpoint" } }, 403) : undefined));
    for (let i = 0; i < 3; i++) await runObjectListing(conn, "customers", deps());
    expect((await snapshots()).filter((s) => !s.deleted)).toHaveLength(250);
    expect((await coverage()).find((c) => c.scope.endsWith(":objects:customers"))!.state).toBe("complete");

    const invoices = await runObjectListing(conn, "invoices", deps());
    expect(invoices.status).toBe("blocked");
    expect((await coverage()).find((c) => c.scope.endsWith(":objects:invoices"))!.state).toBe("blocked");

    // Refresh after the interval: cus_007 is gone at Stripe.
    fake.objects.customers = fake.objects.customers!.filter((c) => c.id !== "cus_007");
    await query(`UPDATE stripe_cursors SET state = jsonb_set(state, '{lastCompleteAt}', to_jsonb(0)) WHERE lane = 'objects:customers'`);
    for (let i = 0; i < 3; i++) await runObjectListing(conn, "customers", deps());
    const gone = (await snapshots()).find((s) => s.object_id === "cus_007")!;
    expect(gone).toMatchObject({ deleted: true, deleted_reason: "not_in_full_listing" });
    expect((await snapshots()).filter((s) => !s.deleted)).toHaveLength(249);
  });
});

describe("export and registration", () => {
  it("registers the connector and module, journals snapshot changes (not listing bookkeeping) and maps them to files", async () => {
    expect(integrationById("stripe")).toBe(stripeIntegration);
    const registry = defaultRegistry();
    expect(registry.forEventSource("stripe")).toBe(stripeProvider);
    expect(registry.extraTable("stripe_object_snapshots")?.provider).toBe(stripeProvider);

    const id = await connect();
    const t = now();
    await deliver(id, evt("evt_1", "customer.created", t, cus("cus_1", { name: "A" })));
    const [{ id: key }] = await query<{ id: string }>(`SELECT id FROM stripe_object_snapshots`);
    expect((await query(`SELECT row_key FROM source_lane_journal WHERE table_name = 'stripe_object_snapshots'`)).length).toBe(1);
    await query(`UPDATE stripe_object_snapshots SET last_seen_run = 'r1'`);
    expect((await query(`SELECT row_key FROM source_lane_journal WHERE table_name = 'stripe_object_snapshots'`)).length).toBe(1);

    const ctx = { tenantId: T, executor: db as never };
    const journal = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const [put] = await stripeSnapshotsExport.map(ctx, key!, journal, []);
    expect(put).toMatchObject({ op: "put", path: "sources/stripe/acct_1TESTacct/test/customers/cus_1.json", kind: "raw", sourceVersion: { ordinal: t } });
    expect(JSON.parse((put as { content: Buffer }).content.toString("utf8"))).toMatchObject({ id: "cus_1", name: "A" });
    expect(stripeSnapshotPath({ account_id: "acct_1TESTacct", livemode: true, resource: "prices", object_id: "price_1" })).toBe("sources/stripe/acct_1TESTacct/live/prices/price_1.json");
    expect(await stripeSnapshotsExport.map({ tenantId: T2, executor: db as never }, key!, journal, [])).toEqual([]);

    await deliver(id, evt("evt_2", "customer.deleted", t + 1, cus("cus_1", { deleted: true })));
    const [del] = await stripeSnapshotsExport.map(ctx, key!, journal, [(put as { path: string }).path]);
    expect(del).toMatchObject({ op: "delete", reason: "stripe_event:customer.deleted" });
    await disconnectStripe({ tenantId: T });
    expect((await coverage()).every((c) => c.state === "blocked")).toBe(true);
  });
});
