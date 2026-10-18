import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Calendar + Contacts lanes on a real PostgreSQL with the production postgres.js driver
 * (array results, a real connection pool and real concurrency), the full source-lane
 * migration plan including 9175, the donor task handlers, the real exporter and the
 * journal triggers. Gated on SOURCES_TEST_PG_URL (synthetic fixture cluster); the suite
 * creates and drops its own database and touches no other.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const live = vi.hoisted(() => ({ db: null as any }));

vi.hoisted(() => {
  process.env.GOOGLE_CALENDAR_FULL_SYNC_PAGES_PER_RUN = "2";
});
vi.mock("../../../../src/db/client.js", () => ({
  // Resolved lazily: the database is created in beforeAll.
  db: new Proxy({}, { get: (_t, prop) => {
    const value = live.db[prop];
    return typeof value === "function" ? value.bind(live.db) : value;
  } }),
  pgClient: null,
}));
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => {
  const f = await import("./fake-google.js");
  return {
    ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
    getGoogleApiCredential: vi.fn(async (tenant: string, account: string | undefined, scopes: readonly string[]) => f.syntheticCredential(tenant, account, scopes)),
    isDelegationConfigured: () => false,
  };
});

import { FakeGoogle, fakePublish, inlineText, mintBindingToken } from "./fake-google.js";

const T = "tenant-cc-pg";
let adminSql: any;
let sqlc: any;
let dbName: string;
let fake: FakeGoogle;
let mods: Record<string, any>;

async function q(text: string, params: unknown[] = []): Promise<any[]> {
  return sqlc.unsafe(text, params as never[]);
}

function ev(id: string, n: number, over: Record<string, unknown> = {}) {
  return {
    id, status: "confirmed", eventType: "default", summary: `Meeting ${id}`, updated: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString(),
    start: { dateTime: "2026-11-02T10:00:00Z" }, end: { dateTime: "2026-11-02T11:00:00Z" },
    attendees: [{ email: "guest@ext.test", responseStatus: "needsAction" }], ...over,
  };
}

describe.skipIf(!PG)("calendar + contacts lanes on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { MIGRATIONS_DIR, planMigrations } = await import("../../../../src/source-lane/core/migrations.js");
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    dbName = `cc_lane_${randomBytes(6).toString("hex")}`;
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    sqlc = postgres(url.href, { max: 6, onnotice: () => {} });
    for (const file of planMigrations().apply) await sqlc.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    live.db = drizzle(sqlc);
    mods = {
      google: await import("../../../../src/integrations/google/index.js"),
      calendar: await import("../../../../src/source-lane/providers/calendar/index.js"),
      contacts: await import("../../../../src/source-lane/providers/google-contacts/index.js"),
      paths: await import("../../../../src/source-lane/providers/calendar/export.js"),
      exporter: await import("../../../../src/source-lane/export/exporter.js"),
      bindings: await import("../../../../src/source-lane/export/bindings.js"),
      registry: await import("../../../../src/source-lane/registry.js"),
    };
    fake = new FakeGoogle();
    vi.stubGlobal("fetch", fake.fetch);
    await q(`INSERT INTO connections (tenant_id, provider, status, external_account_id) VALUES ($1, 'google', 'active', 'ana@acme.test')`, [T]);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await sqlc?.end({ timeout: 5 });
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("runs the donor task handlers through resumable sync, leases, 410 removal, merges and the exporter", async () => {
    const handlers = mods.google.googleIntegration.taskHandlers();
    const ctx = { task: { id: "t", queue: "sync", tenantId: T } };
    fake.putCalendar(T, "ana@acme.test", { id: "ana@acme.test", primary: true, accessRole: "owner", timeZone: "UTC" });
    for (let i = 1; i <= 5; i++) fake.putEvent(T, "ana@acme.test", "ana@acme.test", ev(`e${i}`, i));
    fake.putPerson(T, "ana@acme.test", "connections", { resourceName: "people/c1", etag: "a", names: [{ displayName: "Sam Rivera" }], emailAddresses: [{ value: "sam@ext.test" }] });
    fake.putPerson(T, "ana@acme.test", "connections", { resourceName: "people/c2", etag: "b", names: [{ displayName: "Samuel Rivera" }], emailAddresses: [{ value: "samuel@ext.test" }] });

    // Two concurrent polls on a real pool: the cursor lease lets exactly one list the calendar.
    const [a, b] = await Promise.all([handlers["calendar.poll"]({ tenantId: T }, ctx), handlers["calendar.poll"]({ tenantId: T }, ctx)]);
    expect(a.calendarsSynced + a.calendarsPartial + b.calendarsSynced + b.calendarsPartial).toBe(2);
    expect(fake.calls.filter((c) => c.url.pathname.endsWith("/events") && !c.url.searchParams.get("pageToken"))).toHaveLength(1);
    const [cur] = await q(`SELECT sync_token, full_sync_page_token FROM google_calendar_lane_cursors WHERE tenant_id = $1 AND resource_type = 'events'`, [T]);
    expect(cur).toMatchObject({ sync_token: null, full_sync_page_token: "evp:4" });

    await handlers["calendar.poll"]({ tenantId: T }, ctx);
    const [done] = await q(`SELECT sync_token FROM google_calendar_lane_cursors WHERE tenant_id = $1 AND resource_type = 'events'`, [T]);
    expect(done.sync_token).toMatch(/^ev:/);
    const runs = await q(`SELECT status FROM source_sync_runs WHERE user_id = $1 AND metadata ->> 'taskKind' = 'calendar.poll'`, [T]);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);

    // Gap: token expired, e5 purged, e2 cancelled.
    fake.pageSize = 50;
    fake.purgeEvent(T, "ana@acme.test", "ana@acme.test", "e5");
    fake.putEvent(T, "ana@acme.test", "ana@acme.test", { id: "e2", status: "cancelled", updated: new Date(Date.parse("2026-10-02T00:00:00Z")).toISOString() });
    fake.expireEventSyncTokens(T, "ana@acme.test", "ana@acme.test");
    await handlers["calendar.poll"]({ tenantId: T }, ctx);
    const removed = await q(`SELECT event_id, reason FROM google_calendar_event_revisions WHERE tenant_id = $1 AND op = 'removed'`, [T]);
    expect(removed).toEqual([{ event_id: "e5", reason: "not_in_full_listing" }]);

    await handlers["google.contacts_sync"]({ tenantId: T }, ctx);
    fake.putPerson(T, "ana@acme.test", "connections", { resourceName: "people/c1", metadata: { deleted: true } });
    fake.putPerson(T, "ana@acme.test", "connections", { resourceName: "people/c2", etag: "c", metadata: { previousResourceNames: ["people/c1"] }, names: [{ displayName: "Samuel Rivera" }], emailAddresses: [{ value: "samuel@ext.test" }, { value: "sam@ext.test" }] });
    await handlers["google.contacts_sync"]({ tenantId: T }, ctx);
    const people = await q(`SELECT resource_name, state, merged_into FROM google_contact_snapshots WHERE tenant_id = $1 ORDER BY resource_name`, [T]);
    expect(people).toEqual([
      { resource_name: "people/c1", state: "merged", merged_into: "people/c2" },
      { resource_name: "people/c2", state: "active", merged_into: null },
    ]);

    // Exporter on the real driver (SKIP LOCKED claims, journal triggers on every lane table).
    const registry = new mods.registry.SourceProviderRegistry([mods.calendar.calendarProvider, mods.contacts.googleContactsProvider]);
    const published: Array<Record<string, any>> = [];
    const binding = mintBindingToken(T);
    await mods.bindings.setTenantBinding(live.db, { tenantId: T, bindingId: binding.bindingId, token: binding.token, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: live.db, registry, fetchImpl: fakePublish(published), log: () => {} });
    for (let i = 0; i < 30; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    const finalState = new Map<string, Record<string, any>>();
    for (const c of published) finalState.set(c.path, c);
    const evPath = (id: string) => mods.paths.calendarEventPath("ana@acme.test", "ana@acme.test", id);
    expect(finalState.get(evPath("e1"))?.op).toBe("put");
    expect(finalState.get(evPath("e2"))).toMatchObject({ op: "delete", reason: "cancelled" });
    // e5 was created and removed before the first export pass: no current file is ever
    // published for it, while both revisions are (append-only ledger, never coalesced).
    expect(finalState.get(evPath("e5"))).toBeUndefined();
    const e5Revisions = published.filter((c) => c.op === "put" && c.path.includes("--e5--r")).map((c) => JSON.parse(inlineText(c)));
    expect(e5Revisions.map((r) => [r.op, r.reason])).toEqual([["created", null], ["removed", "not_in_full_listing"]]);
    expect(finalState.get("sources/google-contacts/accounts/ana@acme.test/connections/c1.json")).toMatchObject({ op: "delete", reason: "merged_into:people/c2" });
    const e1 = JSON.parse(inlineText(finalState.get(evPath("e1"))!));
    expect(e1.raw_payload.rawEvent.id).toBe("e1");
    expect(await q(`SELECT 1 FROM source_lane_journal WHERE tenant_id = $1`, [T])).toEqual([]);

    const coverage = [...await mods.calendar.calendarProvider.coverage({ tenantId: T, executor: live.db }), ...await mods.contacts.googleContactsProvider.coverage({ tenantId: T, executor: live.db })];
    expect(coverage.find((r: any) => r.provider === "calendar" && r.scope === "mailbox:ana@acme.test").state).toBe("complete");
    expect(coverage.find((r: any) => r.provider === "google-contacts" && r.scope === "mailbox:ana@acme.test/connections").state).toBe("complete");
  }, 120_000);
});
