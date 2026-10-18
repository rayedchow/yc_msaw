import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { createOfficeAudioProvider, officeAudioExport } from "../../../../src/integrations/office-audio/lane.js";

/**
 * Audit L2 (provider-repairs): the donor kept only the first 5,000 turns of a session and reported success.
 * Every turn is now stored and exported in upload order; the 8 MiB request limit is the only bound and a
 * larger body is refused (413), never cut. Synthetic data only.
 */
const pg = new PGlite();
const db = drizzle(pg);
const ready = (async () => {
  for (const f of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
})();
const SERVICE = `svc_${randomBytes(24).toString("hex")}`;
const authority = { async verify() { return { state: "active" as const }; } };
const registry = new SourceProviderRegistry([createOfficeAudioProvider({ db: db as never, authority })]);
const app = createRuntimeApp({ db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }), serviceTokenSha256: createHash("sha256").update(SERVICE).digest("hex"), integrations: [], mountInternal: true });
const T = "acme";
const q = async <R = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<R>(s, p)).rows;
const internal = (method: string, route: string, body: unknown, scopes: string[]) => app.request(`/internal/v1/tenants/${T}${route}`, {
  method, headers: { authorization: `Bearer ${SERVICE}`, "x-procmem-principal": JSON.stringify({ tenantNs: T, subject: "admin-1", issuer: "test", scopes }), "content-type": "application/json" },
  body: JSON.stringify(body),
});
const post = (key: string, body: string) => app.request("/api/office-audio/ingest", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body });
const turn = (i: number) => ({ turnIndex: i, startMs: i * 1000, endMs: i * 1000 + 900, text: `synthetic line ${i}`, speakerLabel: `spk${i % 3}`, consentState: "consented", redactionState: "none" });
const session = (id: string, turns: unknown[]) => ({ sourceSessionId: id, title: "Long synthetic session", startedAt: "2026-10-02T09:00:00Z", endedAt: "2026-10-02T11:00:00Z", consents: [{ participantEmail: "ana@acme.test", state: "consented" }], turns });

let key = "";
beforeAll(async () => {
  await ready;
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  key = `goa_${T}.${bindingId}.${randomBytes(32).toString("base64url")}`;
  expect((await internal("POST", "/devices/office-audio", { bindingId, tokenSha256: createHash("sha256").update(key).digest("hex") }, ["traces:write"])).status).toBe(201);
  expect((await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" }, ["memory:build"])).status).toBe(201);
});

async function exported(sourceSessionId: string) {
  const [{ id }] = await q<{ id: string }>(`SELECT id FROM office_audio_sessions WHERE source_session_id = $1`, [sourceSessionId]);
  const files = await officeAudioExport.map({ tenantId: T, executor: db as never }, id!, { op: "INSERT", enqueuedAt: new Date().toISOString() }, []);
  const content = (i: number) => (files[i] as { content: Buffer }).content.toString("utf8");
  return { json: JSON.parse(content(0)) as { turns: Array<{ turnIndex: number }>; invalidTurnsDropped?: number }, md: content(1) };
}

describe("office audio turn cap (audit L2)", () => {
  it("stores and exports all 5,001 turns in upload order through the production route", async () => {
    // Upload order deliberately differs from turnIndex order; it must be kept as sent.
    const turns = Array.from({ length: 5001 }, (_, i) => turn(i));
    [turns[0], turns[1]] = [turns[1]!, turns[0]!];
    const res = await post(key, JSON.stringify({ sessions: [session("long-1", turns)] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ stored: 1, rejected: [] });
    expect(body).not.toHaveProperty("invalidTurnsDropped");
    const [row] = await q<{ n: number }>(`SELECT jsonb_array_length(payload->'turns')::int AS n FROM office_audio_sessions WHERE source_session_id = 'long-1'`);
    expect(row!.n).toBe(5001);
    const [ev] = await q<{ n: number }>(`SELECT jsonb_array_length(raw_payload->'turns')::int AS n FROM activity_events WHERE source_event_id = 'office_audio:long-1'`);
    expect(ev!.n).toBe(5001);
    const { json, md } = await exported("long-1");
    expect(json.turns.map((t) => t.turnIndex)).toEqual(turns.map((t) => t.turnIndex));
    expect(json).not.toHaveProperty("invalidTurnsDropped");
    expect(md).toContain("synthetic line 5000");
    expect(md.indexOf("synthetic line 1\n")).toBeLessThan(md.indexOf("synthetic line 0\n"));
    expect(md.match(/^\*\*/gm)).toHaveLength(5001);
  });

  it("counts turns the donor validation drops instead of losing them silently", async () => {
    const turns: unknown[] = Array.from({ length: 5003 }, (_, i) => turn(i));
    turns[10] = { turnIndex: 10, startMs: 1 }; // no endMs / text
    turns[20] = "not-a-turn";
    const res = await post(key, JSON.stringify({ sessions: [session("long-2", turns)] }));
    expect(await res.json()).toMatchObject({ stored: 1, invalidTurnsDropped: 2 });
    const { json, md } = await exported("long-2");
    expect(json.turns).toHaveLength(5001);
    expect(json.invalidTurnsDropped).toBe(2);
    expect(md).toContain("turns dropped at intake (missing index, time or text): 2");
  });

  it("refuses an over-limit body with 413 instead of storing a truncated session", async () => {
    const big = "x".repeat(2_000);
    const turns = Array.from({ length: 4_300 }, (_, i) => ({ ...turn(i), text: `${i} ${big}` }));
    const raw = JSON.stringify({ sessions: [session("too-big", turns)] });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
    expect((await post(key, raw)).status).toBe(413);
    expect(await q(`SELECT 1 FROM office_audio_sessions WHERE source_session_id = 'too-big'`)).toEqual([]);
  });
});
