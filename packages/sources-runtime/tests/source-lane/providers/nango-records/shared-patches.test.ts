import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Donor env.ts and the provider registry read the environment at import time.
  process.env.NANGO_WEBHOOK_SECRET = "nango-webhook-signing-key-for-tests";
  process.env.NANGO_SECRET_KEY = "nango-env-api-key-for-tests";
  process.env.NANGO_RECORDS_CONFIG = JSON.stringify({ version: 1, sources: [{ source: "outlook", providerConfigKey: "acme-outlook", models: ["OutlookMessage"] }] });
});

vi.mock("../../../../src/db/client.js", async () => {
  const { db } = await import("./pg.js");
  return { db, pgClient: null };
});

import { Hono } from "hono";
import { clearProcessorsForTests, registerGenericNangoModels } from "../../../../src/integrations/nango/types.js";
import { handleNangoSyncRecordsTask } from "../../../../src/integrations/nango/tasks.js";
import { nangoWebhookRoute } from "../../../../src/routes/nango-webhook.js";
import { SOURCE_PROVIDERS } from "../../../../src/source-lane/providers/index.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { db, hmac, q, ready, reset, SERVICE_TOKEN, setup, SIGNING_KEY } from "./harness.js";

/**
 * Regressions for the shared patches requested in AUDIT/implementation/patch-requests/nango-expansion.md:
 *  1. donor generic Nango capture keeps the connection + exact integration in its identity
 *     (registered generic models AND the unregistered-model fallback), stable across polls;
 *  2. donor webhook accepts only X-Nango-Hmac-Sha256 keyed with the signing key and hands the
 *     generic lane's deliveries to it;
 *  3. providers/index.ts appends the generic lane's modules to the registry.
 */

function stubClient(pages: Record<string, Array<Record<string, unknown>>>) {
  return { listRecords: async (input: { connectionId: string; model: string }) => ({ records: pages[`${input.connectionId}:${input.model}`] ?? [], nextCursor: null }) };
}

const record = { id: "TCK-1", title: "same ticket", _nango_metadata: { last_action: "ADDED", last_modified_at: "2026-10-01T00:00:00.000Z", cursor: "c1" } };

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await reset();
  clearProcessorsForTests();
});

describe("patch 1: connection-scoped donor generic identity", () => {
  it("two connections of one tenant with the same record id and version stay distinct (registered generic model)", async () => {
    registerGenericNangoModels("acme", [{ model: "Ticket", eventType: "ticket" }]);
    const client = stubClient({ "conn-1:Ticket": [record], "conn-2:Ticket": [record] });
    for (const connectionId of ["conn-1", "conn-2", "conn-1"]) {
      await handleNangoSyncRecordsTask(db, { tenantId: "t1", provider: "acme", providerConfigKey: "acme-key", connectionId, model: "Ticket" }, { client });
    }
    const rows = await q<{ source_event_id: string; source_namespace: string; source_object_id: string; raw_payload: Record<string, unknown> }>(
      "SELECT source_event_id, source_namespace, source_object_id, raw_payload FROM activity_events ORDER BY source_event_id",
    );
    // The repeated poll of conn-1 is idempotent; the second account is its own row.
    expect(rows.map((r) => r.source_event_id)).toEqual([
      "nango:acme:ticket:TCK-1:c1::conn:acme-key:conn-1",
      "nango:acme:ticket:TCK-1:c1::conn:acme-key:conn-2",
    ]);
    expect(rows.map((r) => [r.source_namespace, r.source_object_id])).toEqual([["nango:acme-key:conn-1", "ticket:TCK-1"], ["nango:acme-key:conn-2", "ticket:TCK-1"]]);
    // The raw provider record is not modified to carry authority context.
    expect(rows[0]!.raw_payload).toEqual(record);
  });

  it("the unregistered-model fallback keeps the connection too; connection-less captures keep the legacy id", async () => {
    const client = stubClient({ "conn-1:Widget": [record], "conn-2:Widget": [record] });
    for (const connectionId of ["conn-1", "conn-2"]) {
      await handleNangoSyncRecordsTask(db, { tenantId: "t1", provider: "acme", providerConfigKey: "acme-key", connectionId, model: "Widget" }, { client });
    }
    const { processGenericNangoRecord } = await import("../../../../src/integrations/nango/capture.js");
    await processGenericNangoRecord(db, { tenantId: "t1", provider: "acme", model: "Widget", record });
    expect((await q<{ source_event_id: string }>("SELECT source_event_id FROM activity_events ORDER BY source_event_id")).map((r) => r.source_event_id)).toEqual([
      "nango:acme:widget:TCK-1:c1",
      "nango:acme:widget:TCK-1:c1::conn:acme-key:conn-1",
      "nango:acme:widget:TCK-1:c1::conn:acme-key:conn-2",
    ]);
  });
});

describe("patch 2: donor webhook signature + delegation", () => {
  function donorApp() {
    const app = new Hono();
    app.route("/webhooks/nango", nangoWebhookRoute);
    return app;
  }
  const post = (app: Hono, body: string, headers: Record<string, string>) => app.request("/webhooks/nango", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("authorizes only X-Nango-Hmac-Sha256 keyed with the signing key", async () => {
    const app = donorApp();
    const body = JSON.stringify({ type: "sync", success: true, providerConfigKey: "jira", connectionId: "unknown", model: "Issue" });
    expect((await post(app, body, { "x-nango-signature": hmac(body) })).status).toBe(401);
    expect((await post(app, body, { "x-nango-hmac-sha256": createHash("sha256").update(SIGNING_KEY).update(body).digest("hex") })).status).toBe(401);
    expect((await post(app, body, { "x-nango-hmac-sha256": hmac(body, "nango-env-api-key-for-tests") })).status).toBe(401);
    expect((await post(app, body, { "x-nango-hmac-sha256": hmac(body) })).status).toBe(204);
  });

  it("hands the generic lane's deliveries to the lane (auth binding + sync enqueue through the donor URL)", async () => {
    const s = setup();
    // createRuntimeApp mounted the lane's public routes, which registered the delegate.
    const res = await s.app.request("/internal/v1/tenants/acme/nango-records/connect-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": JSON.stringify({ tenantNs: "acme", subject: "u", issuer: "i", scopes: ["memory:build"] }), "content-type": "application/json" },
      body: JSON.stringify({ source: "outlook" }),
    });
    expect(res.status).toBe(201);
    const tags = s.nango.sessions[0]!.tags as Record<string, string>;
    const auth = JSON.stringify({ type: "auth", operation: "creation", connectionId: "conn-9", providerConfigKey: "acme-outlook", provider: "microsoft", success: true, tags });
    expect((await post(donorApp(), auth, { "x-nango-hmac-sha256": hmac(auth) })).status).toBe(204);
    expect(await q("SELECT tenant_id, connection_id FROM nango_records_connections")).toEqual([{ tenant_id: "acme", connection_id: "conn-9" }]);
    const sync = JSON.stringify({ type: "sync", connectionId: "conn-9", providerConfigKey: "acme-outlook", model: "OutlookMessage", success: true, modifiedAfter: "2026-10-01T00:00:00Z" });
    expect((await post(donorApp(), sync, { "x-nango-hmac-sha256": hmac(sync) })).status).toBe(204);
    expect(await q("SELECT kind, tenant_id FROM task_queue WHERE kind = 'nango_records.sync'")).toEqual([{ kind: "nango_records.sync", tenant_id: "acme" }]);
  });
});

describe("patch 3: registry registration", () => {
  it("the default registry holds the specialized modules, the lane control module and configured sources", () => {
    const ids = SOURCE_PROVIDERS.map((m) => m.id);
    expect(ids).toContain("nango-records");
    expect(ids).toContain("outlook");
    expect(ids).toContain("github");
    const registry = defaultRegistry();
    expect(registry.forEventSource("outlook")?.id).toBe("outlook");
    expect(registry.get("nango-records")?.taskHandlers).toBeTypeOf("function");
  });
});
