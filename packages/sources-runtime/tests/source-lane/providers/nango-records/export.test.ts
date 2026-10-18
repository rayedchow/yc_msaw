import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const { db } = await import("./pg.js");
  return { db, pgClient: null };
});

import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { prettyJsonText } from "../../../../src/source-lane/providers/nango-records/export.js";
import { runSync } from "../../../../src/source-lane/providers/nango-records/sync.js";
import { connect, db, q, ready, reset, setup, type Setup } from "./harness.js";
// The real yc_msaw store (the publish target), so ordering/tombstone/history rules are the production ones.
import { SourceStore } from "../../../../../../src/sources/store.js";
import { DirectoryObjectStore } from "../../../../../../src/store/objects.js";

/**
 * Captured Nango record versions reach the yc_msaw publish protocol through the core exporter:
 * one immutable raw ledger file per version (tombstones included) and a readable latest-state
 * JSON projection per (integration, connection, model, record) that is tombstoned on delete and
 * restored on re-add, with Nango's last_modified_at as the ordering version.
 */

const T = "acme";
const PCK = "acme-outlook";
const M = "OutlookMessage";
let s: Setup;
let published: Array<Record<string, any>>;
let exporter: SourceExporter;
let store: SourceStore;
let tmp: string;

/** The exporter's publish wire, applied to a real yc_msaw SourceStore. */
function fakePublish(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "PUT" && url.pathname.startsWith("/v1/sources/blobs/")) return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/status-report") return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/publish") {
      const body = JSON.parse(String(init?.body)) as { batchId: string; changes: Array<Record<string, any>> };
      published.push(...body.changes);
      return Response.json(await store.applyBatch({ bindingId: "sb-test", providers: ["*"] }, body as never));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return;
  }
  throw new Error("exporter did not drain");
}

const text = (c: Record<string, any>) => Buffer.from(c.inline, "base64").toString("utf8");
const sync = (conn = "conn-1") => runSync(s.lane, { tenantId: T, providerConfigKey: PCK, connectionId: conn, model: M });

beforeAll(async () => {
  await ready;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Current bytes of a stored path, or null when absent or tombstoned. */
async function current(stored: string): Promise<string | null> {
  const r = await store.resolve(stored);
  if (!r || r.type !== "file" || r.entry.t !== "f") return null;
  const v = await store.version(r.entry.v);
  return (await store.readRange(v, 0, v.size)).toString("utf8");
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "nango-records-store-"));
  store = new SourceStore(new DirectoryObjectStore(tmp), T);
  await reset();
  s = setup();
  published = [];
  exporter = new SourceExporter({ db: db as never, registry: s.registry, fetchImpl: fakePublish(), log: () => {} });
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  await setTenantBinding(db as never, { tenantId: T, bindingId, token: `psb_${T}.${bindingId}.${randomBytes(32).toString("base64url")}`, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
  await connect(s, T, "outlook", "conn-1");
});

describe("Nango records export", () => {
  it("publishes the exact raw ledger version and a readable projection", async () => {
    s.nango.upsert(PCK, "conn-1", M, { id: "m/1", subject: "Hi", size: 12, nested: { list: [1, 2.5, "x"] } });
    await sync();
    await drain();
    const raw = published.filter((c) => c.path.startsWith("sources/outlook/_raw/"));
    expect(raw).toHaveLength(1);
    expect(raw[0]!.path).toMatch(/^sources\/outlook\/_raw\/nango:acme-outlook:conn-1\/OutlookMessage:m%2F1\/\d{4}-\d{2}\/nango-records:acme-outlook:conn-1:OutlookMessage:m%252F1:[^/]+\.json$/u);
    expect(raw[0]).toMatchObject({ kind: "raw", contentType: "application/json" });
    const doc = JSON.parse(text(raw[0]!));
    expect(doc).toMatchObject({ schema: "aqueduct.activity_event/v1", source: "outlook", record_kind: "snapshot", raw_payload: { id: "m/1", subject: "Hi", nested: { list: [1, 2.5, "x"] } } });
    const stored = (await q<{ t: string }>("SELECT raw_payload::text AS t FROM activity_events"))[0]!.t;
    expect(text(raw[0]!)).toContain(`"raw_payload": ${stored}`);

    const proj = published.filter((c) => c.path === "sources/outlook/acme-outlook/conn-1/OutlookMessage/m%2F1.json");
    expect(proj).toHaveLength(1);
    expect(proj[0]).toMatchObject({ op: "put", kind: "projection", contentType: "application/json", sourceVersion: { ordinal: Date.parse("2026-10-01T00:00:01.000Z") } });
    expect(proj[0]!.provenance).toMatchObject({ lane: "nango-records", providerConfigKey: PCK, connectionId: "conn-1", model: M, recordId: "m/1" });
    const body = text(proj[0]!);
    expect(body).toContain('\n  "subject": "Hi",\n');
    expect(JSON.parse(body)).toEqual(JSON.parse(stored));
  });

  it("tombstones the projection on delete and restores it on re-add; raw versions all stay", async () => {
    const P = "outlook/acme-outlook/conn-1/OutlookMessage/m1.json";
    s.nango.upsert(PCK, "conn-1", M, { id: "m1", subject: "v1" });
    await sync();
    await drain();
    s.nango.remove(PCK, "conn-1", M, "m1");
    await sync();
    await drain();
    expect(await current(P)).toBeNull();
    s.nango.upsert(PCK, "conn-1", M, { id: "m1", subject: "v2" });
    await sync();
    await drain();
    const proj = published.filter((c) => c.path === `sources/${P}`);
    expect(proj.map((c) => c.op)).toEqual(["put", "delete", "put"]);
    expect(proj[1]).toMatchObject({ reason: "nango_record_deleted", deletedAt: "2026-10-01T00:00:02.000Z" });
    expect(JSON.parse((await current(P))!).subject).toBe("v2");
    const h = await store.history(P);
    expect(h.versions.map((v) => v.kind)).toEqual(["projection", "tombstone", "projection"]);
    const raw = published.filter((c) => c.path.startsWith("sources/outlook/_raw/"));
    expect(raw).toHaveLength(3);
    expect(raw.map((c) => JSON.parse(text(c)).record_kind)).toEqual(["snapshot", "tombstone", "snapshot"]);
  });

  it("converges to the latest state when versions of one record are exported together in any order", async () => {
    const P = "outlook/acme-outlook/conn-1/OutlookMessage/m1.json";
    s.nango.upsert(PCK, "conn-1", M, { id: "m1", subject: "v1" });
    await sync();
    s.nango.upsert(PCK, "conn-1", M, { id: "m1", subject: "v2" });
    await sync();
    s.nango.remove(PCK, "conn-1", M, "m1");
    await sync();
    s.nango.upsert(PCK, "conn-1", M, { id: "m1", subject: "v3" });
    await sync();
    // All four versions are journaled before the exporter runs (one batch, exporter order).
    await drain();
    expect(JSON.parse((await current(P))!).subject).toBe("v3");
    // Re-exporting everything (tenant backfill) does not regress the projection.
    await exporter.enqueueTenantBackfill(T);
    await drain();
    expect(JSON.parse((await current(P))!).subject).toBe("v3");
  });

  it("gives each connection of a tenant its own projection and raw namespace", async () => {
    await connect(s, T, "outlook", "conn-2");
    for (const c of ["conn-1", "conn-2"]) s.nango.upsert(PCK, c, M, { id: "same", subject: c });
    await sync("conn-1");
    await sync("conn-2");
    await drain();
    const paths = published.filter((c) => c.kind === "projection").map((c) => c.path).sort();
    expect(paths).toEqual(["sources/outlook/acme-outlook/conn-1/OutlookMessage/same.json", "sources/outlook/acme-outlook/conn-2/OutlookMessage/same.json"]);
    expect(new Set(published.filter((c) => c.kind === "raw").map((c) => c.path.split("/")[3])).size).toBe(2);
  });

  it("keeps the core default raw mapping for rows that are not lane identities", async () => {
    await q(`INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id, processing_status)
             VALUES ('acme', 'outlook', 'legacy', now(), '{"id":"x"}'::jsonb, 'nango:outlook:Legacy:x:v1', 'collected')`);
    await drain();
    expect(published.map((c) => c.path)).toEqual([expect.stringMatching(/^sources\/outlook\/_raw\/_\/_\/\d{4}-\d{2}\/nango:outlook:Legacy:x:v1\.json$/u)]);
  });
});

describe("prettyJsonText", () => {
  it("re-indents without touching value text", () => {
    const src = '{"a": 12345678901234567890, "b": [1.50, -0.0, 1e400], "c": "x, {y}: \\"z\\" \\\\", "d": {}, "e": [], "f": {"g": null}}';
    const out = prettyJsonText(src);
    expect(out).toContain("12345678901234567890");
    expect(out).toContain("1.50");
    expect(out).toContain("1e400");
    expect(out).toContain('"x, {y}: \\"z\\" \\\\"');
    expect(out).toBe(['{', '  "a": 12345678901234567890,', '  "b": [', '    1.50,', '    -0.0,', '    1e400', '  ],', '  "c": "x, {y}: \\"z\\" \\\\",', '  "d": {},', '  "e": [],', '  "f": {', '    "g": null', '  }', '}'].join("\n"));
  });
});
