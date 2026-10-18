import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeGranola, note } from "./fake-granola.js";
import { bindingToken, PublishStore } from "./publish.js";

/**
 * Granola lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster): the full
 * source-lane migration plan (every lane file, 9500 included, in plan order), the catalog trigger
 * on activity_events under real concurrency, the 9500 legacy backfill + idempotent re-apply, the
 * inventory pass and the exporter. Creates and drops its own database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const tokenStore = vi.hoisted(() => new Map<string, { token: string; refreshToken: string | null; metadata: Record<string, unknown> | null }>());
vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenFull: async (u: string, p: string) => {
    const t = tokenStore.get(`${u}:${p}`);
    return t ? { ...t, metadata: t.metadata ? { ...t.metadata } : null } : null;
  },
  getTokenMetadata: async (u: string, p: string) => tokenStore.get(`${u}:${p}`)?.metadata ?? null,
  mergeTokenMetadata: async (u: string, p: string, fields: Record<string, unknown>) => {
    const t = tokenStore.get(`${u}:${p}`);
    if (t) t.metadata = { ...(t.metadata ?? {}), ...fields };
  },
  storeToken: async () => undefined,
  deleteToken: async () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};
const T = "tenant-granola-pg";
const OTHER = "tenant-granola-pg-other";
const KEY = "grn_synthetic_pg_key";
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe.skipIf(!PG)("granola source lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `granola_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 4, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.lane = await import("../../../../src/source-lane/providers/granola/lane.js");
    mods.coverage = await import("../../../../src/source-lane/providers/granola/coverage.js");
    mods.exportMap = await import("../../../../src/source-lane/providers/granola/export-map.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
    mods.granola = await import("../../../../src/source-lane/providers/granola/index.js");
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await sql?.end({ timeout: 5 });
    try {
      await (mods.db as Any)?.pgClient?.end?.({ timeout: 5 });
    } catch {
      // client may not have been created
    }
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("re-applying 9500 is idempotent and builds catalog rows for notes captured before the lane existed", async () => {
    await sql`ALTER TABLE activity_events DISABLE TRIGGER trg_granola_source_catalog`;
    await sql`
      INSERT INTO activity_events (user_id, source, source_namespace, source_object_id, record_kind, event_type, timestamp, source_updated_at, raw_payload, source_event_id)
      VALUES (${OTHER}, 'granola', 'tenant', 'meeting_note:legacy-1', 'snapshot', 'meeting_note', now(), now(),
              ${sql.json({ granolaId: "legacy-1", title: "Legacy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", transcript: [{ text: "x" }] })},
              'granola:legacy-1:2026-01-02T00:00:00.000Z')`;
    await sql`ALTER TABLE activity_events ENABLE TRIGGER trg_granola_source_catalog`;
    expect(await sql`SELECT 1 FROM granola_source_notes WHERE tenant_id = ${OTHER}`).toHaveLength(0);

    await sql.unsafe(readFileSync(join(mods.migrations.MIGRATIONS_DIR, "9500_granola_source_lane.sql"), "utf8"));

    const [row] = await sql`SELECT * FROM granola_source_notes WHERE tenant_id = ${OTHER} AND note_id = 'legacy-1'`;
    expect(row).toMatchObject({ title: "Legacy", revision_count: 1, transcript_segments: 1, latest_updated_at: "2026-01-02T00:00:00.000Z" });
    const [journal] = await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${OTHER} AND table_name = 'granola_source_notes'`;
    expect(journal.n).toBe(1);
  });

  it("concurrent raw inserts for one note leave one consistent catalog row; recheck bookkeeping does not journal", async () => {
    const values = Array.from({ length: 8 }, (_, i) => `2026-02-0${i + 1}T00:00:00.000Z`);
    await Promise.all(values.map((v) => sql`
      INSERT INTO activity_events (user_id, source, source_namespace, source_object_id, record_kind, event_type, timestamp, source_updated_at, raw_payload, source_event_id)
      VALUES (${OTHER}, 'granola', 'tenant', 'meeting_note:conc-1', 'snapshot', 'meeting_note', now(), ${v},
              ${sql.json({ granolaId: "conc-1", title: `v ${v}`, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: v })}, ${`granola:conc-1:${v}`})`));
    const [row] = await sql`SELECT * FROM granola_source_notes WHERE tenant_id = ${OTHER} AND note_id = 'conc-1'`;
    expect(row).toMatchObject({ revision_count: 8, latest_updated_at: values.at(-1), title: `v ${values.at(-1)}` });
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE table_name = 'granola_source_notes' AND row_key = 'conc-1'`;
    await sql`UPDATE granola_source_notes SET transcript_recheck_at = now(), transcript_recheck_count = 1 WHERE tenant_id = ${OTHER} AND note_id = 'conc-1'`;
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE table_name = 'granola_source_notes' AND row_key = 'conc-1'`;
    expect(after).toBe(before);
  });

  it("runs an inventory pass with the donor poller on postgres-js and exports note.json, transcript.json and raw revisions", async () => {
    const fake = new FakeGranola();
    fake.account(KEY);
    for (const [i, id] of ["p1", "p2", "p3", "p4"].entries()) fake.put(KEY, note(id, ago(10 - i)));
    vi.stubGlobal("fetch", fake.fetch);
    tokenStore.set(`${T}:granola`, { token: KEY, refreshToken: null, metadata: { auth_mode: "api_key", includeTranscript: true, lastUpdatedAt: ago(3) } });
    await sql`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES (${T}, 'granola', 'synthetic')`;
    await sql`INSERT INTO connections (tenant_id, provider, status) VALUES (${T}, 'granola', 'active')`;

    const pass = await mods.lane.runGranolaSourceBackfill(T);
    expect(pass).toMatchObject({ listed: 4, stored: 4, inventoryComplete: true });
    await mods.lane.runGranolaSourcePoll(T);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM granola_source_notes WHERE tenant_id = ${T}`;
    expect(n).toBe(4);

    const store = new PublishStore();
    vi.stubGlobal("fetch", store.fetch);
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: new mods.registry.SourceProviderRegistry([mods.granola.granolaProvider]), fetchImpl: store.fetch, log: () => {} });
    for (let i = 0; i < 20; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    const dir = mods.exportMap.granolaNoteDirectory("p2", "Meeting p2");
    const noteJson = store.json(`${dir}/note.json`);
    expect(noteJson.revisions).toHaveLength(1);
    expect(store.current(noteJson.revisions[0].raw)?.kind).toBe("raw");
    expect(store.json(`${dir}/transcript.json`).segments).toEqual(fake.notes.get("p2")!.transcript);
    expect(store.live("sources/granola/").some((p) => p.startsWith(`sources/granola/`) && p.includes(OTHER))).toBe(false);
    const reports = await mods.coverage.granolaCoverage({ tenantId: T, executor: mods.db.db });
    expect(reports.find((r: Any) => r.scope === "account:api-key")?.state).toBe("complete");
    // The other tenant's catalog never leaks into this tenant's coverage or export.
    expect(reports.find((r: Any) => r.scope === "account:api-key")?.counts.live_notes).toBe(4);
  });
});
