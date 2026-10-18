import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const { db } = await import("./pg.js");
  return { db, pgClient: null };
});

import { runPoll, runSync } from "../../../../src/source-lane/providers/nango-records/sync.js";
import { sourceCoverage } from "../../../../src/source-lane/providers/nango-records/coverage.js";
import { refreshVerification } from "../../../../src/source-lane/providers/nango-records/verify.js";
import { connect, FakeNango, q, ready, reset, runTasks, setup, type Setup } from "./harness.js";

/**
 * Incremental /records capture through the production lane: durable cursor checkpoints,
 * pagination and continuation tasks, updates/deletes/pruning, Retry-After cooldown persisted
 * per Nango account, cursor rejection fallback, per-integration concurrency slots, connection
 * scoping (two accounts with identical record ids), and truthful coverage.
 */

const T = "acme";
const PCK = "acme-outlook";
const MODEL = "OutlookMessage";
let s: Setup;

function events() {
  return q<{ source: string; source_event_id: string; source_namespace: string; source_object_id: string; record_kind: string; event_type: string; raw_payload: Record<string, unknown> }>(
    "SELECT source, source_event_id, source_namespace, source_object_id, record_kind, event_type, raw_payload FROM activity_events ORDER BY source_updated_at, created_at, source_object_id",
  );
}

async function checkpoint(conn = "conn-1", model = MODEL) {
  return (await q<Record<string, any>>("SELECT * FROM nango_records_checkpoints WHERE connection_id = $1 AND model = $2", [conn, model]))[0];
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await reset();
  s = setup();
  await connect(s, T, "outlook", "conn-1");
});

describe("generic Nango records sync", () => {
  it("captures an operator-configured model through real /records paging and stores the last record cursor", async () => {
    s.lane.pageLimit = 2;
    for (let i = 1; i <= 5; i++) s.nango.upsert(PCK, "conn-1", MODEL, { id: `m${i}`, subject: `hello ${i}`, from: { address: "a@example.test" } });
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r).toMatchObject({ outcome: "caught_up", pages: 3, fetched: 5, stored: 5 });
    const reqs = s.nango.requests.filter((x) => x.path === "/records");
    // Connection identity in headers, never in the query string.
    expect(reqs.every((x) => x.headers["connection-id"] === "conn-1" && x.headers["provider-config-key"] === PCK && !("connection_id" in x.query))).toBe(true);
    expect(reqs[0]!.query).toMatchObject({ model: MODEL, limit: "2" });
    expect(reqs[0]!.query.cursor).toBeUndefined();
    expect(reqs[1]!.query.cursor).toBe(FakeNango.cursorOf(2));
    const cp = await checkpoint();
    expect(cp.cursor).toBe(FakeNango.cursorOf(5));
    expect(cp.full_pass_completed_at).not.toBeNull();
    expect(Number(cp.stored_total)).toBe(5);

    const rows = await events();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ source: "outlook", source_namespace: "nango:acme-outlook:conn-1", source_object_id: "OutlookMessage:m1", record_kind: "snapshot", event_type: "outlookmessage" });
    expect(rows[0]!.source_event_id).toMatch(/^nango-records:acme-outlook:conn-1:OutlookMessage:m1:2026-10-01T00%3A00%3A0\d\.000Z~[0-9a-f]{20}$/u);
    // The stored raw payload is the provider record (with Nango metadata), nothing about tenant/connection added.
    expect(rows[0]!.raw_payload).toMatchObject({ id: "m1", subject: "hello 1", _nango_metadata: { last_action: "ADDED" } });
    expect(Object.keys(rows[0]!.raw_payload).sort()).toEqual(["_nango_metadata", "from", "id", "subject"]);

    // Unchanged re-poll: resumes from the stored cursor, no new rows.
    const again = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(again).toMatchObject({ outcome: "caught_up", fetched: 0, stored: 0 });
    expect(s.nango.requests.filter((x) => x.path === "/records").at(-1)!.query.cursor).toBe(FakeNango.cursorOf(5));
    expect(await events()).toHaveLength(5);
  });

  it("captures updates as new versions, deletes as tombstones (A->B->A stays distinct) and skips pruned payloads", async () => {
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1", subject: "A" });
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m2", subject: "keep" });
    await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1", subject: "B" });
    await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1", subject: "A" });
    s.nango.remove(PCK, "conn-1", MODEL, "m2");
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m3", subject: "old" });
    s.nango.prune(PCK, "conn-1", MODEL, "m3");
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r).toMatchObject({ outcome: "caught_up", stored: 2, tombstones: 1, pruned: 1 });

    const m1 = (await events()).filter((e) => e.source_object_id === "OutlookMessage:m1");
    expect(m1.map((e) => e.raw_payload.subject)).toEqual(["A", "B", "A"]);
    expect(new Set(m1.map((e) => e.source_event_id)).size).toBe(3);
    const m2 = (await events()).filter((e) => e.source_object_id === "OutlookMessage:m2");
    expect(m2.map((e) => [e.record_kind, e.event_type])).toEqual([["snapshot", "outlookmessage"], ["tombstone", "outlookmessage.deleted"]]);
    expect(m2[1]!.raw_payload).toMatchObject({ subject: "keep", _nango_metadata: { last_action: "DELETED" } });
    expect((await events()).some((e) => e.source_object_id === "OutlookMessage:m3")).toBe(false);
    expect(Number((await checkpoint()).pruned_skipped_total)).toBe(1);
    const cov = await sourceCoverage(s.lane, s.lane.catalog.sources[0]!, T);
    expect(cov.find((c) => c.scope === `nango:${PCK}:conn-1:${MODEL}`)!.reason).toContain("1 record(s) were already pruned by Nango");
  });

  it("keeps two accounts of one tenant apart even with identical record ids and versions", async () => {
    await connect(s, T, "outlook", "conn-2");
    for (const conn of ["conn-1", "conn-2"]) s.nango.upsert(PCK, conn, MODEL, { id: "same-id", subject: "same" });
    // Same Nango clock tick on both connections: identical payload + metadata except the record cursor.
    for (const conn of ["conn-1", "conn-2"]) await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: conn, model: MODEL });
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_namespace).sort()).toEqual(["nango:acme-outlook:conn-1", "nango:acme-outlook:conn-2"]);
    expect(rows[0]!.source_event_id).not.toBe(rows[1]!.source_event_id);
    expect(rows.map((r) => r.source_event_id.split(":")[2]).sort()).toEqual(["conn-1", "conn-2"]);
  });

  it("pages a backlog across continuation tasks instead of holding one task", async () => {
    s.lane.pageLimit = 1;
    s.lane.maxPagesPerRun = 2;
    for (let i = 1; i <= 5; i++) s.nango.upsert(PCK, "conn-1", MODEL, { id: `m${i}` });
    const first = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL, slot: "a" });
    expect(first).toMatchObject({ outcome: "backlog", pages: 2, stored: 2 });
    expect((await checkpoint()).backlog).toBe(true);
    const queued = await q<{ dedupe_key: string; payload: any }>("SELECT dedupe_key, payload FROM task_queue WHERE kind = 'nango_records.sync' AND state = 'queued'");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ tenantId: T, connectionId: "conn-1", model: MODEL, slot: "b" });
    const ran = await runTasks(s);
    expect(ran.filter((r) => r.kind === "nango_records.sync").map((r) => (r.output as any).outcome)).toEqual(["backlog", "caught_up"]);
    expect(await events()).toHaveLength(5);
    expect((await checkpoint()).backlog).toBe(false);
  });

  it("persists a Retry-After cooldown for the Nango account and defers instead of retrying in-process", async () => {
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1" });
    s.nango.injectOnce("/records", { status: 429, headers: { "retry-after": "120" } });
    const before = Date.now();
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL, slot: "a" });
    expect(r.outcome).toBe("deferred");
    const retryAt = Date.parse(r.retryAt!);
    expect(retryAt).toBeGreaterThanOrEqual(before + 119_000);
    const quota = await q<{ quota_key: string; blocked_until: Date; last_status: number }>("SELECT quota_key, blocked_until, last_status FROM nango_records_quota WHERE blocked_until IS NOT NULL");
    expect(quota).toHaveLength(1);
    expect(quota[0]!.quota_key).toBe(s.lane.api!.quotaKey);
    expect(quota[0]!.last_status).toBe(429);
    const deferred = await q<{ run_at: Date; payload: any }>("SELECT run_at, payload FROM task_queue WHERE kind = 'nango_records.sync' AND state = 'queued'");
    expect(deferred).toHaveLength(1);
    expect(Math.abs(new Date(deferred[0]!.run_at).getTime() - retryAt)).toBeLessThan(2000);
    expect(deferred[0]!.payload.slot).toBe("b");

    // The cooldown is account-wide: another connection's sync does not call Nango at all.
    await connect(s, T, "outlook", "conn-2");
    const calls = s.nango.count("/records");
    const other = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-2", model: MODEL });
    expect(other.outcome).toBe("deferred");
    expect(s.nango.count("/records")).toBe(calls);
    // Not yet due: the queue does not run the deferred task now.
    expect((await runTasks(s)).filter((t) => t.kind === "nango_records.sync")).toHaveLength(0);
    expect((await sourceCoverage(s.lane, s.lane.catalog.sources[0]!, T)).find((c) => c.scope.endsWith(":conn-1:OutlookMessage"))!.reason).toContain("rate limited until");
  });

  it("blocks on an exhausted X-RateLimit window before any 429", async () => {
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1" });
    s.nango.injectOnce("/records", { status: 200, body: { records: [], next_cursor: null }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 90) } });
    await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    const calls = s.nango.count("/records");
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r.outcome).toBe("deferred");
    expect(s.nango.count("/records")).toBe(calls);
  });

  it("falls back to modified_after (high water - 1h) when Nango rejects the stored cursor", async () => {
    for (let i = 1; i <= 3; i++) s.nango.upsert(PCK, "conn-1", MODEL, { id: `m${i}` });
    await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    const stored = (await checkpoint()).cursor as string;
    s.nango.rejectCursors.add(stored);
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m4" });
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r).toMatchObject({ outcome: "caught_up", cursorReset: true, stored: 1 });
    const fallback = s.nango.requests.filter((x) => x.path === "/records").at(-1)!;
    expect(fallback.query.cursor).toBeUndefined();
    const highWater = Date.parse("2026-10-01T00:00:03.000Z");
    expect(Date.parse(fallback.query.modified_after!)).toBe(highWater - 3_600_000);
    const cp = await checkpoint();
    expect(Number(cp.cursor_resets)).toBe(1);
    expect(cp.modified_after_fallback).toBeNull();
    expect(cp.cursor).toBe(FakeNango.cursorOf(4));
    expect(cp.notes[0].note).toContain("stored cursor rejected");
    // Re-read records were deduplicated by version.
    expect(await events()).toHaveLength(4);
  });

  it("enforces per-integration concurrency slots across workers", async () => {
    s.lane.catalog.sources[0]!.maxConcurrentSyncs = 1;
    await q("INSERT INTO nango_records_slots (quota_key, slot, holder, lease_until) VALUES ($1, 0, 'other-worker', now() + interval '5 minutes')", [`nango-sync:${PCK}`]);
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1" });
    const r = await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r.outcome).toBe("deferred");
    expect(r.reason).toContain("sync slots");
    expect(s.nango.count("/records")).toBe(0);
    await q("UPDATE nango_records_slots SET lease_until = now() - interval '1 second'");
    expect((await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL })).outcome).toBe("caught_up");
    expect(await q("SELECT holder FROM nango_records_slots WHERE holder IS NOT NULL")).toHaveLength(0);
  });

  it("never syncs for a payload tenant that does not own the connection", async () => {
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1" });
    const r = await runSync(s.lane, { tenantId: "rival", providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    expect(r).toMatchObject({ outcome: "skipped", reason: "connection is not bound to this tenant" });
    expect(s.nango.count("/records")).toBe(0);
    await expect(s.handlers["nango_records.sync"]!({ tenantId: "rival", providerConfigKey: PCK, connectionId: "conn-1", model: MODEL }, { task: { tenantId: "acme" } as never, heartbeat: async () => {} })).rejects.toThrow(/tenant/);
  });

  it("records 5xx errors and lets the queue retry", async () => {
    s.nango.injectOnce("/records", { status: 502 });
    await expect(runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL })).rejects.toThrow(/502/);
    const cp = await checkpoint();
    expect(cp.last_error).toContain("502");
    expect(cp.cursor).toBeNull();
  });

  it("discovers deployed models for discoverModels sources and reports undeclared deployed models as pending", async () => {
    s.nango.deploy("acme-hubspot", [{ name: "contacts", returns: ["HubspotContact"] }, { name: "deals", returns: ["HubspotDeal"], enabled: false }]);
    s.nango.deploy(PCK, [{ name: "emails", returns: ["OutlookMessage", "OutlookAttachmentMeta"] }]);
    await connect(s, T, "hubspot", "hs-1");
    s.nango.upsert("acme-hubspot", "hs-1", "HubspotContact", { id: "c1", email: "x@example.test" });
    s.nango.upsert("acme-hubspot", "hs-1", "HubspotDeal", { id: "d1" });
    const poll = await runPoll(s.lane, T);
    expect(poll.verified).toBe(2);
    const ran = await runTasks(s);
    const synced = ran.filter((t) => t.kind === "nango_records.sync").map((t) => (t.output as any).outcome);
    expect(synced.filter((o) => o === "caught_up").length).toBeGreaterThanOrEqual(2);
    const sources = (await events()).map((e) => `${e.source}/${e.source_object_id}`);
    expect(sources).toContain("hubspot/HubspotContact:c1");
    // A disabled sync's model is not read; OutlookEvent (declared, not deployed) is not read either.
    expect(sources.some((x) => x.includes("HubspotDeal"))).toBe(false);
    expect(s.nango.requests.some((x) => x.path === "/records" && x.query.model === "OutlookEvent")).toBe(false);
    const outlookCov = await sourceCoverage(s.lane, s.lane.catalog.sources[0]!, T);
    expect(outlookCov.find((c) => c.scope.endsWith(":OutlookEvent"))).toMatchObject({ state: "pending", reason: "no deployed Nango sync function returns OutlookEvent" });
    const unconfigured = await q("SELECT provider_config_key, model FROM nango_records_unconfigured_models");
    expect(unconfigured).toEqual([{ provider_config_key: PCK, model: "OutlookAttachmentMeta" }]);
    const ctl = await s.modules[0]!.coverage!({ tenantId: T, executor: s.lane.db });
    expect(ctl).toContainEqual(expect.objectContaining({ provider: "outlook", state: "pending", scope: `nango:${PCK}:model:OutlookAttachmentMeta` }));
  });

  it("reports pending until the first full pass, then partial (never complete)", async () => {
    const src = s.lane.catalog.sources[0]!;
    const before = await sourceCoverage(s.lane, src, T);
    expect(before.find((c) => c.scope.endsWith(":OutlookMessage"))).toMatchObject({ state: "pending" });
    expect(before.find((c) => c.scope.endsWith(":OutlookMessage"))!.reason).toContain("deployment of OutlookMessage not yet verified");
    s.nango.upsert(PCK, "conn-1", MODEL, { id: "m1" });
    await runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: "conn-1", model: MODEL });
    s.nango.deploy(PCK, [{ name: "emails", returns: [MODEL], track_deletes: false }]);
    await refreshVerification(s.lane, src, { force: true });
    const after = (await sourceCoverage(s.lane, src, T)).find((c) => c.scope.endsWith(":OutlookMessage"))!;
    expect(after.state).toBe("partial");
    expect(after.reason).toContain("latest payload");
    expect(after.reason).toContain("does not track deletes");
    expect(after.lastSuccessAt).toBeTruthy();
    expect(after.counts).toMatchObject({ versionsStored: 1 });
    expect((await sourceCoverage(s.lane, src, T)).some((c) => c.state === "complete")).toBe(false);
  });
});
