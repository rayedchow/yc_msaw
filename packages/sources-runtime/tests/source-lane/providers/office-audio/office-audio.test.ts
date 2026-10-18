import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { SourceProviderRegistry, defaultRegistry } from "../../../../src/source-lane/registry.js";
import { createOfficeAudioProvider, officeAudioExport, officeAudioCoverage } from "../../../../src/integrations/office-audio/lane.js";

/**
 * Office audio (coordinator port of gigabrain office-audio intake): transcript-only, consent granted by an
 * authorized actor on the server; missing / forged / revoked consent rejects the session; device keys fail
 * closed through the yc_msaw authority; immutable versions; revocation can tombstone captured sessions.
 */
const pg = new PGlite();
const db = drizzle(pg);
const ready = (async () => {
  for (const f of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
})();
const SERVICE = `svc_${randomBytes(24).toString("hex")}`;
const authority = { down: false, revoked: new Set<string>(), async verify(_k: string, d: { bindingId: string }) { return authority.down ? { state: "unavailable" as const, reason: "down" } : authority.revoked.has(d.bindingId) ? { state: "revoked" as const, reason: "no" } : { state: "active" as const }; } };
const registry = new SourceProviderRegistry([createOfficeAudioProvider({ db: db as never, authority })]);
const app = createRuntimeApp({ db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }), serviceTokenSha256: createHash("sha256").update(SERVICE).digest("hex"), integrations: [], mountInternal: true });
const T = "acme";
const q = async <R = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<R>(s, p)).rows;
const internal = (method: string, route: string, body?: unknown, scopes = ["memory:build"], tenant = T) => app.request(`/internal/v1/tenants/${tenant}${route}`, {
  method, headers: { authorization: `Bearer ${SERVICE}`, "x-procmem-principal": JSON.stringify({ tenantNs: tenant, subject: "admin-1", issuer: "test", scopes }), "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
async function device(tenant = T) {
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  const key = `goa_${tenant}.${bindingId}.${randomBytes(32).toString("base64url")}`;
  expect((await internal("POST", "/devices/office-audio", { bindingId, tokenSha256: createHash("sha256").update(key).digest("hex") }, ["traces:write"], tenant)).status).toBe(201);
  return { key, bindingId };
}
const upload = (key: string, sessions: unknown[], extra: Record<string, unknown> = {}) => app.request("/api/office-audio/ingest", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ sessions, ...extra }) });
const session = (over: Record<string, unknown> = {}) => ({
  sourceSessionId: "room-1", title: "Standup", room: "Blue", startedAt: "2026-10-01T09:00:00Z", endedAt: "2026-10-01T09:15:00Z",
  consents: [{ participantEmail: "ana@acme.test", state: "consented" }, { participantEmail: "bo@acme.test", state: "consented" }],
  devices: [{ providerDeviceId: "mac-1", deviceName: "Mic", audioBase64: "AAAA" }],
  turns: [
    { turnIndex: 0, startMs: 0, endMs: 2000, text: "Morning everyone", speakerLabel: "spk0", consentState: "consented", redactionState: "none", speakerPersonId: "ana@acme.test", speakerIdentityStatus: "confirmed", speakerEvidence: [{ type: "human_speaker_confirmation" }], speakerDisplayName: "Ana" },
    { turnIndex: 1, startMs: 2000, endMs: 4000, text: "Hi", speakerLabel: "spk1", consentState: "pending_review", speakerDisplayName: "Guess Name" },
  ],
  audio: { pcm: "AAAA" },
  ...over,
});

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM office_audio_sessions; DELETE FROM office_audio_rejections; DELETE FROM office_audio_participant_consents; DELETE FROM office_audio_devices; DELETE FROM activity_events WHERE source = 'office_audio';`);
  authority.down = false;
  authority.revoked.clear();
});

describe("office audio intake", () => {
  it("accepts a session only when every named participant has server-issued consent; forged body consent is refused", async () => {
    const d = await device();
    const r1 = await upload(d.key, [session()]);
    expect(r1.status).toBe(422);
    expect(((await r1.json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("forged_consent:ana@acme.test");
    expect(await q(`SELECT 1 FROM office_audio_sessions`)).toEqual([]);
    expect((await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" }, ["traces:write"])).status).toBe(403); // devices/collectors cannot grant consent
    await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" });
    expect(((await (await upload(d.key, [session()])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("forged_consent:bo@acme.test");
    await internal("POST", "/office-audio/consents", { participantKey: "bo@acme.test" });
    const ok = await upload(d.key, [session()], { userId: "rival" });
    expect(await ok.json()).toMatchObject({ stored: 1, rejected: [] });
    const [row] = await q<{ tenant_id: string; payload: Record<string, any> }>(`SELECT tenant_id, payload FROM office_audio_sessions`);
    expect(row!.tenant_id).toBe(T);
    // Transcript-only: no audio of any kind is stored, and unverified speaker names are dropped.
    expect(JSON.stringify(row!.payload)).not.toMatch(/AAAA|audio/i);
    expect(row!.payload.turns[1]).toMatchObject({ speakerDisplayName: null, speakerLabel: "unknown" });
    expect(row!.payload.turns[0]).toMatchObject({ speakerDisplayName: "Ana", speakerConfidence: 0 });
    expect((await q(`SELECT count(*)::int AS n FROM office_audio_rejections`))[0]!.n).toBe(2);
  });

  it("rejects sessions whose participants lack consent or declare a revocation, and fails closed on the device authority", async () => {
    const d = await device();
    await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" });
    const solo = session({ consents: [{ participantEmail: "ana@acme.test", state: "consented" }], turns: [session().turns[0]] });
    expect(((await (await upload(d.key, [{ ...solo, sourceSessionId: "s-missing", consents: [{ participantEmail: "cy@acme.test", state: "pending" }] }])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("consent_missing:cy@acme.test");
    expect(((await (await upload(d.key, [{ ...solo, sourceSessionId: "s-rev", consents: [{ participantEmail: "ana@acme.test", state: "revoked" }] }])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("consent_revoked_by_participant");
    expect(((await (await upload(d.key, [{ ...solo, sourceSessionId: "s-none", consents: [], turns: [{ turnIndex: 0, startMs: 0, endMs: 1, text: "x" }] }])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("no_participants_declared");
    authority.down = true;
    expect((await upload(d.key, [solo])).status).toBe(503);
    authority.down = false;
    expect((await upload(`${d.key.slice(0, -2)}AA`, [solo])).status).toBe(401);
    authority.revoked.add(d.bindingId);
    expect((await upload(d.key, [solo])).status).toBe(401);
    expect((await q<{ status: string }>(`SELECT status FROM office_audio_devices`))[0]!.status).toBe("revoked");
    expect(await q(`SELECT 1 FROM office_audio_sessions`)).toEqual([]);
  });

  it("versions edits immutably, and revoking consent with deleteCaptured tombstones the sessions naming the participant", async () => {
    const d = await device();
    await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" });
    const solo = session({ consents: [{ participantEmail: "ana@acme.test", state: "consented" }], turns: [session().turns[0]] });
    await upload(d.key, [solo]);
    expect(await (await upload(d.key, [solo])).json()).toMatchObject({ skipped: 1 });
    await upload(d.key, [{ ...solo, title: "Standup (edited)" }]);
    const ids = (await q<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE source = 'office_audio' ORDER BY created_at`)).map((r) => r.source_event_id);
    expect(ids[0]).toBe("office_audio:room-1");
    expect(ids[1]).toMatch(/^office_audio:room-1:v:[0-9a-f]{16}$/);
    const [{ id }] = await q<{ id: string }>(`SELECT id FROM office_audio_sessions`);
    const files = await officeAudioExport.map({ tenantId: T, executor: db as never }, id!, { op: "INSERT", enqueuedAt: new Date().toISOString() }, []);
    expect(files.map((f) => f.path)).toEqual(["sources/office-audio/2026-10/room-1/session.json", "sources/office-audio/2026-10/room-1/transcript.md"]);
    expect((files[1] as { content: Buffer }).content.toString()).toContain("Ana: Morning everyone");
    const rev = await internal("DELETE", "/office-audio/consents/ana%40acme.test?deleteCaptured=true");
    expect(await rev.json()).toMatchObject({ revoked: true, sessionsTombstoned: 1 });
    const del = await officeAudioExport.map({ tenantId: T, executor: db as never }, id!, { op: "UPDATE", enqueuedAt: new Date().toISOString() }, []);
    expect(del.every((c) => c.op === "delete" && (c as { reason: string }).reason === "participant_consent_revoked")).toBe(true);
    // After revocation the same participant's sessions are refused again.
    expect(((await (await upload(d.key, [{ ...solo, sourceSessionId: "room-2" }])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("forged_consent:ana@acme.test");
    expect(defaultRegistry().extraTable("office_audio_sessions")?.provider.id).toBe("office-audio");
    expect((await officeAudioCoverage({ tenantId: T, executor: db as never }))[0]!.reason).toMatch(/transcript-only/);
  });

  it("isolates tenants: another tenant's admin cannot grant consent for this tenant, and sessions stay per tenant", async () => {
    const d = await device();
    await internal("POST", "/office-audio/consents", { participantKey: "ana@acme.test" }, ["memory:build"], "rival");
    const solo = session({ consents: [{ participantEmail: "ana@acme.test", state: "consented" }], turns: [session().turns[0]] });
    expect(((await (await upload(d.key, [solo])).json()) as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toBe("forged_consent:ana@acme.test");
  });
});
