import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const { db } = await import("./pg.js");
  return { db, pgClient: null };
});

import { verifyNangoHmac } from "../../../../src/source-lane/providers/nango-records/webhook.js";
import { connect, hmac, internal, PREVIOUS_SIGNING_KEY, q, ready, reset, runTasks, setup, SIGNING_KEY, webhook, type Setup } from "./harness.js";

/**
 * Webhook authentication (X-Nango-Hmac-Sha256 over the raw body with the signing key only),
 * replay handling, delegation of non-lane deliveries, and tenant binding through server-created
 * connect sessions: use-once, integration-bound, expiring, never from webhook tags or bodies.
 */

let s: Setup;

function authCreation(tags: Record<string, string>, over: Record<string, unknown> = {}) {
  return { type: "auth", operation: "creation", connectionId: "conn-1", providerConfigKey: "acme-outlook", provider: "microsoft", authMode: "OAUTH2", environment: "DEV", success: true, tags, ...over };
}

async function startSession(tenant = "acme", source = "outlook") {
  const res = await internal(s, "POST", "/nango-records/connect-sessions", { source }, { tenant });
  expect(res.status).toBe(201);
  return { body: (await res.json()) as Record<string, any>, nangoBody: s.nango.sessions.at(-1)! as Record<string, any> };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await reset();
  s = setup();
});

describe("Nango webhook signature", () => {
  const body = JSON.stringify({ type: "sync", connectionId: "c", providerConfigKey: "acme-outlook", model: "OutlookMessage", success: true });

  it("accepts only HMAC-SHA256 of the raw body keyed with the signing key (current or previous)", () => {
    expect(verifyNangoHmac(body, hmac(body), [SIGNING_KEY])).toBe(true);
    expect(verifyNangoHmac(body, hmac(body, PREVIOUS_SIGNING_KEY), [SIGNING_KEY, PREVIOUS_SIGNING_KEY])).toBe(true);
    expect(verifyNangoHmac(body, hmac(body).toUpperCase(), [SIGNING_KEY])).toBe(true);
    // Legacy X-Nango-Signature style: plain sha256(secret + body) never verifies.
    expect(verifyNangoHmac(body, createHash("sha256").update(SIGNING_KEY).update(body).digest("hex"), [SIGNING_KEY])).toBe(false);
    // HMAC keyed with the environment API key is not the signing key.
    expect(verifyNangoHmac(body, hmac(body, s.nango.secretKey), [SIGNING_KEY])).toBe(false);
    // Re-serialized JSON (whitespace change) is a different raw body.
    expect(verifyNangoHmac(JSON.stringify(JSON.parse(body), null, 1), hmac(body), [SIGNING_KEY])).toBe(false);
    expect(verifyNangoHmac(body, "", [SIGNING_KEY])).toBe(false);
    expect(verifyNangoHmac(body, "sha256=" + hmac(body), [SIGNING_KEY])).toBe(false);
  });

  it("rejects the legacy header, API-key HMACs and tampered bodies over HTTP; 503 without a signing key", async () => {
    expect((await webhook(s, null, { raw: body, headers: { "X-Nango-Signature": createHash("sha256").update(SIGNING_KEY).update(body).digest("hex") } })).status).toBe(401);
    expect((await webhook(s, null, { raw: body, headers: { "X-Nango-Signature": hmac(body) } })).status).toBe(401);
    expect((await webhook(s, null, { raw: body, key: s.nango.secretKey })).status).toBe(401);
    expect((await webhook(s, null, { raw: body.replace("success\":true", "success\":false"), headers: { "X-Nango-Hmac-Sha256": hmac(body) } })).status).toBe(401);
    expect((await webhook(s, null, { raw: body })).status).toBe(204);
    const unsigned = setup({ env: { NANGO_WEBHOOK_SIGNING_KEY: "", NANGO_WEBHOOK_SECRET: "" } });
    expect((await webhook(unsigned, null, { raw: body })).status).toBe(503);
    // The env API key is never used as a fallback signing key.
    const apiKeyOnly = setup({ env: { NANGO_WEBHOOK_SIGNING_KEY: "", NANGO_SECRET_KEY: "nango-env-api-key-for-tests" } });
    expect((await webhook(apiKeyOnly, null, { raw: body, key: "nango-env-api-key-for-tests" })).status).toBe(503);
  });

  it("delegates verified deliveries for integrations the lane does not capture to the donor handler", async () => {
    const donor = JSON.stringify({ type: "sync", connectionId: "j-1", providerConfigKey: "jira", model: "Issue", success: true });
    expect((await webhook(s, null, { raw: donor })).status).toBe(204);
    expect(s.delegated).toEqual([{ body: donor, signature: hmac(donor) }]);
    // Unverified deliveries are never delegated.
    expect((await webhook(s, null, { raw: donor, key: "wrong" })).status).toBe(401);
    expect(s.delegated).toHaveLength(1);
  });
});

describe("tenant-bound connect sessions", () => {
  it("creates a Nango connect session for exactly the configured integration with a server-side correlation tag", async () => {
    const { body, nangoBody } = await startSession();
    expect(body).toMatchObject({ source: "outlook", providerConfigKey: "acme-outlook", token: "nango_connect_session_1" });
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
    expect(nangoBody.allowed_integrations).toEqual(["acme-outlook"]);
    expect(Object.keys(nangoBody).sort()).toEqual(["allowed_integrations", "tags"]);
    expect(nangoBody.tags.procmem_session).toMatch(/^[0-9a-f]{48}$/);
    const row = (await q<Record<string, any>>("SELECT * FROM nango_records_connect_sessions"))[0]!;
    expect(row).toMatchObject({ tenant_id: "acme", principal_subject: "user-acme", principal_issuer: "https://auth.example.test", source: "outlook", outcome: "pending" });
    // The Nango session token is never stored.
    expect(JSON.stringify(row)).not.toContain("nango_connect_session_1");
  });

  it("binds the connection to the session's tenant, never to tenant-looking tags in the webhook", async () => {
    const { nangoBody } = await startSession("acme");
    const tags = { ...nangoBody.tags, end_user_id: "rival", organization_id: "rival" };
    const res = await webhook(s, authCreation(tags));
    expect(res.status).toBe(204);
    expect(await q("SELECT tenant_id, source, status, bound_via FROM nango_records_connections")).toEqual([{ tenant_id: "acme", source: "outlook", status: "active", bound_via: "webhook" }]);
    expect(await q("SELECT tenant_id, provider, status, external_account_id FROM connections")).toEqual([{ tenant_id: "acme", provider: "outlook", status: "active", external_account_id: "conn-1" }]);
    const sched = await q<Record<string, any>>("SELECT tenant_id, kind, group_key, enabled, frequency_seconds FROM task_schedules");
    expect(sched).toEqual([{ tenant_id: "acme", kind: "nango_records.poll", group_key: "acme:nango-records", enabled: true, frequency_seconds: 300 }]);
  });

  it("is use-once: a second connection or a different integration on the same session stays unbound; exact re-delivery is idempotent", async () => {
    const { nangoBody } = await startSession();
    expect((await webhook(s, authCreation(nangoBody.tags))).status).toBe(204);
    // Identical body again: acknowledged as a replay, no effect.
    expect((await webhook(s, authCreation(nangoBody.tags))).status).toBe(204);
    expect(await q("SELECT outcome FROM nango_records_webhook_deliveries")).toEqual([{ outcome: "connected" }]);
    await webhook(s, authCreation(nangoBody.tags, { connectionId: "conn-2" }));
    await webhook(s, authCreation(nangoBody.tags, { connectionId: "conn-3", providerConfigKey: "acme-hubspot" }));
    expect(await q("SELECT connection_id FROM nango_records_connections")).toEqual([{ connection_id: "conn-1" }]);
    const session = (await q<Record<string, any>>("SELECT outcome, connection_id, last_error FROM nango_records_connect_sessions"))[0]!;
    expect(session).toMatchObject({ outcome: "connected", connection_id: "conn-1" });
    expect(session.last_error).toContain("left unbound");
  });

  it("refuses expired sessions and unknown tags", async () => {
    const { nangoBody } = await startSession();
    s.clock.offsetMs = 41 * 60_000; // past 30 min expiry + 10 min delivery grace
    await webhook(s, authCreation(nangoBody.tags));
    await webhook(s, authCreation({ procmem_session: "0".repeat(48) }, { connectionId: "conn-x" }));
    expect(await q("SELECT * FROM nango_records_connections")).toEqual([]);
    expect(await q("SELECT outcome FROM nango_records_connect_sessions")).toEqual([{ outcome: "expired" }]);
  });

  it("reconciles by authenticated tag lookup when the auth webhook never arrives, and checks Nango's creation time", async () => {
    const { body, nangoBody } = await startSession();
    let status = await internal(s, "GET", `/nango-records/connect-sessions/${body.sessionId}`);
    expect(await status.json()).toMatchObject({ state: "pending" });
    s.nango.addConnection({ connection_id: "conn-r", provider_config_key: "acme-outlook", tags: nangoBody.tags });
    status = await internal(s, "GET", `/nango-records/connect-sessions/${body.sessionId}`);
    expect(await status.json()).toMatchObject({ state: "connected", connectionId: "conn-r" });
    expect(s.nango.requests.find((r) => r.path === "/connections")!.query).toMatchObject({ "tags[procmem_session]": nangoBody.tags.procmem_session });
    expect(await q("SELECT tenant_id, bound_via FROM nango_records_connections")).toEqual([{ tenant_id: "acme", bound_via: "reconcile" }]);

    // A connection Nango reports as created after the session expired is not bound.
    const late = await startSession();
    s.nango.addConnection({ connection_id: "conn-late", provider_config_key: "acme-outlook", tags: late.nangoBody.tags, created: new Date(Date.now() + 40 * 60_000).toISOString() });
    status = await internal(s, "GET", `/nango-records/connect-sessions/${late.body.sessionId}`);
    expect((await status.json()).state).not.toBe("connected");
    expect(await q("SELECT connection_id FROM nango_records_connections ORDER BY connection_id")).toEqual([{ connection_id: "conn-r" }]);
  });

  it("never lets another tenant read or use a session or connection", async () => {
    const { body } = await startSession("acme");
    expect((await internal(s, "GET", `/nango-records/connect-sessions/${body.sessionId}`, undefined, { tenant: "rival" })).status).toBe(404);
    await connect(s, "acme", "outlook", "conn-1");
    expect((await internal(s, "DELETE", "/nango-records/connections/outlook/conn-1", undefined, { tenant: "rival" })).status).toBe(404);
    expect(s.nango.deleted).toEqual([]);
    // URL tenant must equal the forwarded principal (core middleware).
    expect((await internal(s, "GET", "/nango-records", undefined, { tenant: "rival", urlTenant: "acme" })).status).toBe(403);
  });

  it("refuses client-chosen tenant/account fields, unknown sources and missing scopes", async () => {
    expect((await internal(s, "POST", "/nango-records/connect-sessions", { source: "outlook", tenantId: "rival" })).status).toBe(400);
    expect((await internal(s, "POST", "/nango-records/connect-sessions", { source: "outlook", connectionId: "x" })).status).toBe(400);
    expect((await internal(s, "POST", "/nango-records/connect-sessions", { source: "dropbox" })).status).toBe(404);
    expect((await internal(s, "POST", "/nango-records/connect-sessions", { source: "outlook" }, { scopes: ["memory:read"] })).status).toBe(403);
    expect((await internal(s, "GET", "/nango-records", undefined, { scopes: [] })).status).toBe(403);
    expect(s.nango.sessions).toHaveLength(0);
  });

  it("refuses a session for an integration verification proved missing", async () => {
    s.nango.deploy("acme-hubspot", []);
    await q("INSERT INTO nango_records_verification (provider_config_key, checked_at, integration_found) VALUES ('acme-outlook', now(), false)");
    expect((await internal(s, "POST", "/nango-records/connect-sessions", { source: "outlook" })).status).toBe(409);
  });
});

describe("webhook-driven sync and connection status", () => {
  beforeEach(async () => {
    await connect(s, "acme", "outlook", "conn-1");
    await q("DELETE FROM task_queue");
  });

  it("a successful sync webhook enqueues an incremental read for the bound tenant; unknown connections are ignored", async () => {
    s.nango.upsert("acme-outlook", "conn-1", "OutlookMessage", { id: "m1" });
    const hook = { type: "sync", connectionId: "conn-1", providerConfigKey: "acme-outlook", syncName: "emails", model: "OutlookMessage", success: true, modifiedAfter: new Date().toISOString(), responseResults: { added: 1, updated: 0, deleted: 0 } };
    expect((await webhook(s, hook)).status).toBe(204);
    const tasks = await q<Record<string, any>>("SELECT tenant_id, kind, payload FROM task_queue");
    expect(tasks).toEqual([{ tenant_id: "acme", kind: "nango_records.sync", payload: expect.objectContaining({ tenantId: "acme", connectionId: "conn-1", model: "OutlookMessage" }) }]);
    await runTasks(s);
    expect(await q("SELECT source_object_id FROM activity_events")).toEqual([{ source_object_id: "OutlookMessage:m1" }]);

    await webhook(s, { ...hook, connectionId: "not-bound", modifiedAfter: "2026-10-02T00:00:00Z" });
    expect(await q("SELECT 1 FROM task_queue WHERE state = 'queued'")).toEqual([]);
  });

  it("records failed sync runs and undeclared models without capturing them", async () => {
    await webhook(s, { type: "sync", connectionId: "conn-1", providerConfigKey: "acme-outlook", syncName: "emails", model: "OutlookMessage", success: false, error: { type: "script_error", description: "token=abc failed" }, startedAt: "x", failedAt: "y" });
    const cp = (await q<Record<string, any>>("SELECT last_sync_webhook_error FROM nango_records_checkpoints"))[0]!;
    expect(cp.last_sync_webhook_error).toContain("script_error");
    expect(cp.last_sync_webhook_error).not.toContain("abc");
    await webhook(s, { type: "sync", connectionId: "conn-1", providerConfigKey: "acme-outlook", syncName: "files", model: "OneDriveFile", success: true, modifiedAfter: "2026-10-03T00:00:00Z" });
    expect(await q("SELECT model, tenant_id FROM nango_records_unconfigured_models")).toEqual([{ model: "OneDriveFile", tenant_id: "acme" }]);
    expect(await q("SELECT 1 FROM task_queue")).toEqual([]);
  });

  it("auth refresh/deletion webhooks are verified through the Nango API, not trusted", async () => {
    // Body claims a refresh failure, but Nango reports the connection healthy.
    await webhook(s, { type: "auth", operation: "refresh", connectionId: "conn-1", providerConfigKey: "acme-outlook", success: false, error: { type: "refresh_token_error", description: "x" }, tags: {} });
    await runTasks(s);
    expect((await q("SELECT status FROM nango_records_connections"))[0]).toEqual({ status: "active" });
    // Nango now reports an auth error.
    s.nango.connections[0]!.errors = [{ type: "auth", log_id: "L1" }];
    await webhook(s, { type: "auth", operation: "refresh", connectionId: "conn-1", providerConfigKey: "acme-outlook", success: false, tags: {}, environment: "PROD" });
    await runTasks(s);
    expect((await q("SELECT status, last_error FROM nango_records_connections"))[0]).toMatchObject({ status: "error" });
    // Deleted in Nango: revoked, polling floor disabled.
    s.nango.connections.length = 0;
    await webhook(s, { type: "auth", operation: "deletion", connectionId: "conn-1", providerConfigKey: "acme-outlook", success: true, tags: {} });
    await runTasks(s);
    expect((await q("SELECT status FROM nango_records_connections"))[0]).toEqual({ status: "revoked" });
    expect(await q("SELECT enabled FROM task_schedules")).toEqual([{ enabled: false }]);
  });

  it("disconnect deletes the Nango connection, cancels queued reads and keeps captured history", async () => {
    s.nango.upsert("acme-outlook", "conn-1", "OutlookMessage", { id: "m1" });
    await internal(s, "POST", "/nango-records/sync", {});
    await runTasks(s);
    await internal(s, "POST", "/nango-records/sync", { source: "outlook" });
    const res = await internal(s, "DELETE", "/nango-records/connections/outlook/conn-1");
    expect(await res.json()).toMatchObject({ status: "revoked", nangoConnectionDeleted: true });
    expect(s.nango.deleted).toEqual([{ connectionId: "conn-1", providerConfigKey: "acme-outlook" }]);
    expect(await q("SELECT state FROM task_queue WHERE kind = 'nango_records.sync' AND state IN ('queued', 'running')")).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM activity_events")).toEqual([{ n: 1 }]);
    const status = (await (await internal(s, "GET", "/nango-records")).json()) as Record<string, any>;
    expect(status.coverage).toContainEqual(expect.objectContaining({ provider: "outlook", scope: "nango:acme-outlook:conn-1:OutlookMessage", state: "blocked" }));
  });
});
