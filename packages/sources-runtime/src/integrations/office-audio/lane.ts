/**
 * Office audio: consent-gated room transcript intake. Port of gigabrain 5448774 (b61e84444)
 * brain/src/integrations/office-audio/{ingest,auth}.ts.
 *
 * Deterministic intake only. Raw audio is never accepted or stored, and there is no STT, voice profiling,
 * speaker-ID enrichment, memory feed, indexing or graph/LLM work. Each session is the canonical
 * `OfficeAudioSession` JSON the Mac agent already produces and sends to `POST /api/office-audio/ingest`.
 *
 * Kept from the donor:
 *  - session/turn/device/alignment normalization: field set, bounds, 0-1000 confidence scale;
 *  - the speaker-identity guard (a person name only with identity evidence);
 *  - per-turn consent/redaction states;
 *  - the `office_audio:<sourceSessionId>` identity;
 *  - the content-hash skip.
 *
 * Changed on purpose:
 *  - Consent comes from the server only. A participant key counts as consented only when an authorized actor
 *    (a yc_msaw principal with `memory:build`) granted it through the internal route and has not revoked it.
 *    A session is accepted only when every participant it names has an active server consent and every
 *    identified speaker is one of those participants. Otherwise the whole session is rejected and the
 *    rejection is recorded. Consents in the upload body are kept as the device's claim (`clientConsents`)
 *    and authorize nothing; a body "consented" without a server grant is refused (forged consent). The
 *    donor wrote body consents into its consent table.
 *  - Device identity: `goa_<tenant>.<binding>.<secret>` minted from a yc_msaw device binding, sha256 only
 *    here, yc_msaw confirming every request (fail closed), no admin `userId` override.
 *  - Revoking a consent with `deleteCaptured` tombstones the stored sessions that name the participant.
 *  - Immutable raw versions (`…:v:<hash16>`); the donor updated one row in place.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { db as defaultDb } from "../../db/client.js";
import type { CoverageReport, ExportContext, ExtraTableExport, InternalRouteDeps, JournalInfo, SourceFileChange, SourceProviderModule } from "../../source-lane/core/types.js";
import { createYcDeviceAuthority, type DeviceAuthority } from "../coding-sessions/lane.js";

type Executor = Pick<typeof defaultDb, "execute">;
export const OFFICE_AUDIO_PROVIDER = "office-audio";
export const OFFICE_AUDIO_SOURCE = "office_audio";
const MAX_SESSIONS_PER_BATCH = 10;
const MAX_TURNS_PER_SESSION = 5_000;
const MAX_DEVICES_PER_SESSION = 20;
const MAX_INGEST_BYTES = 8 * 1024 * 1024;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- donor normalization (semantics kept)

const cleanString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 20_000) : null);
const isoOrNull = (v: unknown): string | null => {
  const t = cleanString(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
};
function confidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  const scaled = n >= 0 && n <= 1 ? n * 1000 : n;
  return Math.min(1000, Math.max(0, Math.round(scaled)));
}
const nullableConfidence = (v: unknown) => (v == null ? null : confidence(v));
const STATUSES = ["unknown", "inferred", "confirmed", "corrected", "disputed"] as const;
const validSpeakerIdentityStatus = (v: unknown) => (STATUSES.includes(v as never) && v !== "unknown" ? (v as (typeof STATUSES)[number]) : "unknown");
const validConsentState = (v: unknown) => (["consented", "pending_review", "revoked", "blocked", "deleted"].includes(String(v)) ? String(v) : "pending_review");
function speakerIdentityAllowsPersonName(status: string, evidence: unknown[]): boolean {
  if (status === "unknown" || status === "disputed") return false;
  return evidence.some((item) => {
    const type = item && typeof item === "object" && !Array.isArray(item) ? cleanString((item as Record<string, unknown>).type) : null;
    return type === "provider_known_speaker" || type === "speaker_identifier_match" || type === "voice_embedding" || type === "human_speaker_correction" || type === "human_speaker_confirmation";
  });
}

export function normalizeTurn(input: Record<string, unknown>): Record<string, unknown> | null {
  const turnIndex = intOrNull(input.turnIndex);
  const startMs = intOrNull(input.startMs);
  const endMs = intOrNull(input.endMs);
  const text = typeof input.text === "string" && input.text.trim() ? input.text.trim() : null; // transcript text is never truncated
  if (turnIndex == null || startMs == null || endMs == null || !text) return null;
  const status = validSpeakerIdentityStatus(input.speakerIdentityStatus);
  const speakerPersonId = cleanString(input.speakerPersonId);
  const speakerDisplayName = cleanString(input.speakerDisplayName);
  const evidence = Array.isArray(input.speakerEvidence) ? input.speakerEvidence : [];
  const allowed = speakerIdentityAllowsPersonName(status, evidence);
  const label = cleanString(input.speakerLabel) ?? "unknown";
  const attempted = Boolean(speakerPersonId || speakerDisplayName);
  return {
    turnIndex, startMs, endMs, text,
    speakerLabel: allowed || !attempted ? label : "unknown",
    speakerIdentityStatus: allowed ? status : "unknown",
    speakerPersonId: allowed ? speakerPersonId : null,
    speakerDisplayName: allowed ? speakerDisplayName : null,
    speakerConfidence: allowed ? confidence(input.speakerConfidence) : 0,
    primaryProviderDeviceId: cleanString(input.primaryProviderDeviceId),
    sourceProviderDeviceIds: Array.isArray(input.sourceProviderDeviceIds) ? input.sourceProviderDeviceIds.map(cleanString).filter(Boolean).slice(0, MAX_DEVICES_PER_SESSION) : [],
    alignmentConfidence: confidence(input.alignmentConfidence),
    diarizationConfidence: nullableConfidence(input.diarizationConfidence),
    asrConfidence: nullableConfidence(input.asrConfidence),
    redactionState: cleanString(input.redactionState) ?? "none",
    consentState: validConsentState(input.consentState),
  };
}

const consentKey = (c: Record<string, unknown>) => (cleanString(c.participantKey) ?? cleanString(c.participantEmail)?.toLowerCase() ?? cleanString(c.participantUserId))?.toLowerCase() ?? null;

export function normalizeSession(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const s = input as Record<string, unknown>;
  const sourceSessionId = cleanString(s.sourceSessionId);
  const startedAt = isoOrNull(s.startedAt);
  if (!sourceSessionId || !startedAt) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>).filter((x) => x && typeof x === "object") : []);
  const devices = arr(s.devices).slice(0, MAX_DEVICES_PER_SESSION).map((d) => ({
    providerDeviceId: cleanString(d.providerDeviceId), collectorUserId: cleanString(d.collectorUserId ?? d.ownerUserId), deviceName: cleanString(d.deviceName),
    inputDeviceUid: cleanString(d.inputDeviceUid), sampleRate: intOrNull(d.sampleRate), captureAppVersion: cleanString(d.captureAppVersion), status: cleanString(d.status),
    joinedAt: isoOrNull(d.joinedAt), leftAt: isoOrNull(d.leftAt),
  }));
  const clientConsents = arr(s.consents).map((c) => ({
    participantKey: consentKey(c), participantEmail: cleanString(c.participantEmail)?.toLowerCase() ?? null, participantDisplayName: cleanString(c.participantDisplayName),
    role: cleanString(c.role) ?? "participant", state: cleanString(c.state) ?? "pending", consentedAt: isoOrNull(c.consentedAt), revokedAt: isoOrNull(c.revokedAt),
  })).filter((c) => c.participantKey);
  const alignments = arr(s.alignments).map((a) => ({
    providerDeviceId: cleanString(a.providerDeviceId), referenceProviderDeviceId: cleanString(a.referenceProviderDeviceId), offsetMsAtStart: intOrNull(a.offsetMsAtStart),
    driftPpm: typeof a.driftPpm === "number" ? a.driftPpm : null, status: cleanString(a.status), modelVersion: cleanString(a.modelVersion), computedAt: isoOrNull(a.computedAt),
  }));
  const turns = arr(s.turns).slice(0, MAX_TURNS_PER_SESSION).map(normalizeTurn).filter((t): t is Record<string, unknown> => Boolean(t));
  return {
    sourceSessionId, title: cleanString(s.title), room: cleanString(s.room), organizationId: cleanString(s.organizationId), startedAt, endedAt: isoOrNull(s.endedAt),
    status: cleanString(s.status) ?? "received", shareScope: cleanString(s.shareScope) ?? "participants", retentionPolicy: cleanString(s.retentionPolicy) ?? "default",
    devices, clientConsents, alignments, turns,
  };
}

// ---------------------------------------------------------------- device auth

const KEY_RE = /^goa_([a-z0-9][a-z0-9-]{0,79})\.(sb-[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

async function authenticate(ex: Executor, authority: DeviceAuthority, key: string | null | undefined): Promise<{ ok: true; tenantId: string; bindingId: string } | { ok: false; status: 401 | 503; error: string }> {
  const m = typeof key === "string" ? KEY_RE.exec(key) : null;
  if (!m || !key) return { ok: false, status: 401, error: "Unauthorized" };
  const [tenantId, bindingId] = [m[1]!, m[2]!];
  const [row] = rowsOf<{ token_sha256: string; status: string }>(await ex.execute(sql`SELECT token_sha256, status FROM office_audio_devices WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}`));
  const a = Buffer.from(sha256(key), "hex");
  const b = Buffer.from(row?.token_sha256 ?? "00".repeat(32), "hex");
  if (!row || row.status !== "active" || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: "Unauthorized" };
  const verdict = await authority.verify(key, { tenantNs: tenantId, bindingId });
  if (verdict.state === "unavailable") return { ok: false, status: 503, error: `Device authority unavailable: ${verdict.reason}` };
  if (verdict.state === "revoked") {
    await ex.execute(sql`UPDATE office_audio_devices SET status = 'revoked', revoked_at = now() WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}`);
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  await ex.execute(sql`UPDATE office_audio_devices SET last_seen_at = now() WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}`);
  return { ok: true, tenantId, bindingId };
}

// ---------------------------------------------------------------- ingest

async function activeConsents(ex: Executor, tenantId: string): Promise<Set<string>> {
  return new Set(rowsOf<{ participant_key: string }>(await ex.execute(sql`
    SELECT participant_key FROM office_audio_participant_consents WHERE tenant_id = ${tenantId} AND revoked_at IS NULL
  `)).map((r) => r.participant_key));
}

/** Server-consent gate. Returns null when the session may be stored, else the rejection reason. */
export function consentGate(session: Record<string, unknown>, consented: Set<string>): string | null {
  const claims = session.clientConsents as Array<{ participantKey: string; state: string }>;
  const participants = new Set(claims.map((c) => c.participantKey));
  for (const t of session.turns as Array<Record<string, unknown>>) {
    const pid = (t.speakerPersonId as string | null)?.toLowerCase();
    if (pid) participants.add(pid);
  }
  if (participants.size === 0) return "no_participants_declared";
  for (const p of participants) {
    if (!consented.has(p)) {
      const claim = claims.find((c) => c.participantKey === p);
      return claim?.state === "consented" || claim?.state === "granted" ? `forged_consent:${p}` : `consent_missing:${p}`;
    }
  }
  if (claims.some((c) => c.state === "revoked" || c.state === "deleted")) return "consent_revoked_by_participant";
  return null;
}

export async function ingestOfficeAudio(ex: Executor, device: { tenantId: string; bindingId: string }, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  if (!sessions.length) return { status: 400, body: { error: "sessions array is required" } };
  if (sessions.length > MAX_SESSIONS_PER_BATCH) return { status: 400, body: { error: `Maximum ${MAX_SESSIONS_PER_BATCH} sessions per batch` } };
  const consented = await activeConsents(ex, device.tenantId);
  let stored = 0;
  let updated = 0;
  let skipped = 0;
  const rejected: Array<{ sourceSessionId: string | null; reason: string }> = [];
  for (const input of sessions) {
    const s = normalizeSession(input);
    if (!s) {
      skipped++;
      continue;
    }
    const reason = consentGate(s, consented);
    if (reason) {
      rejected.push({ sourceSessionId: String(s.sourceSessionId), reason });
      await ex.execute(sql`INSERT INTO office_audio_rejections (tenant_id, binding_id, source_session_id, reason) VALUES (${device.tenantId}, ${device.bindingId}, ${String(s.sourceSessionId)}, ${reason})`);
      continue;
    }
    const hash = sha256(JSON.stringify(s));
    const id = `${device.tenantId}:${s.sourceSessionId}`;
    const [prior] = rowsOf<{ content_hash: string; deleted: boolean }>(await ex.execute(sql`SELECT content_hash, deleted FROM office_audio_sessions WHERE id = ${id}`));
    if (prior?.deleted) {
      rejected.push({ sourceSessionId: String(s.sourceSessionId), reason: "session_deleted_after_consent_revocation" });
      continue;
    }
    if (prior && prior.content_hash === hash) {
      skipped++;
      continue;
    }
    const participants = [...new Set((s.clientConsents as Array<{ participantKey: string }>).map((c) => c.participantKey))];
    const raw = { ...s, _content_hash: hash, consentAuthority: "server", consentedParticipants: participants };
    const insertRaw = async (eid: string) => rowsOf(await ex.execute(sql`
      INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload, source_event_id,
        processing_status, source_namespace, source_object_id, record_kind)
      VALUES (${device.tenantId}, ${OFFICE_AUDIO_SOURCE}, 'office_audio_transcript', ${String(s.startedAt)}::timestamptz, ${String(s.endedAt ?? s.startedAt)}::timestamptz,
        ${String(s.startedAt)}::timestamptz, ${JSON.stringify(raw)}::jsonb, ${eid}, 'received', ${`device:${device.bindingId}`}, ${`session:${s.sourceSessionId}`}, 'snapshot')
      ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
    `)).length > 0;
    if (!(await insertRaw(`office_audio:${s.sourceSessionId}`))) await insertRaw(`office_audio:${s.sourceSessionId}:v:${hash.slice(0, 16)}`);
    await ex.execute(sql`
      INSERT INTO office_audio_sessions (id, tenant_id, binding_id, source_session_id, content_hash, participant_keys, payload, started_at)
      VALUES (${id}, ${device.tenantId}, ${device.bindingId}, ${String(s.sourceSessionId)}, ${hash}, ${JSON.stringify(participants)}::jsonb, ${JSON.stringify(raw)}::jsonb, ${String(s.startedAt)}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET binding_id = EXCLUDED.binding_id, content_hash = EXCLUDED.content_hash, participant_keys = EXCLUDED.participant_keys,
        payload = EXCLUDED.payload, started_at = EXCLUDED.started_at, version = office_audio_sessions.version + 1, observed_at = now(), updated_at = now()
    `);
    if (prior) updated++;
    else stored++;
  }
  return { status: rejected.length && !stored && !updated && !skipped ? 422 : 200, body: { stored, updated, skipped, rejected, total: sessions.length } };
}

// ---------------------------------------------------------------- consent administration (internal, principal-bound)

export async function grantConsent(ex: Executor, tenantId: string, principal: { subject: string; issuer?: string }, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = typeof body.participantKey === "string" ? body.participantKey.trim().toLowerCase() : "";
  if (!key || key.length > 320) return { status: 400, body: { error: "participantKey (participant email or stable id) is required" } };
  await ex.execute(sql`
    INSERT INTO office_audio_participant_consents (tenant_id, participant_key, display_name, granted_by_subject, granted_by_issuer, evidence)
    VALUES (${tenantId}, ${key}, ${typeof body.displayName === "string" ? body.displayName.slice(0, 200) : null}, ${principal.subject}, ${principal.issuer ?? null},
      ${JSON.stringify(body.evidence && typeof body.evidence === "object" ? body.evidence : {})}::jsonb)
    ON CONFLICT (tenant_id, participant_key) DO UPDATE SET revoked_at = NULL, revoked_by_subject = NULL, granted_by_subject = EXCLUDED.granted_by_subject,
      granted_by_issuer = EXCLUDED.granted_by_issuer, granted_at = now(), display_name = COALESCE(EXCLUDED.display_name, office_audio_participant_consents.display_name)
  `);
  return { status: 201, body: { participantKey: key, granted: true } };
}

export async function revokeConsent(ex: Executor, tenantId: string, principal: { subject: string }, key: string, deleteCaptured: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const k = key.trim().toLowerCase();
  const r = rowsOf(await ex.execute(sql`
    UPDATE office_audio_participant_consents SET revoked_at = now(), revoked_by_subject = ${principal.subject}
    WHERE tenant_id = ${tenantId} AND participant_key = ${k} AND revoked_at IS NULL RETURNING participant_key
  `));
  if (!r.length) return { status: 404, body: { error: "No active consent for that participant" } };
  let tombstoned = 0;
  if (deleteCaptured) {
    tombstoned = rowsOf(await ex.execute(sql`
      UPDATE office_audio_sessions SET deleted = true, deleted_reason = 'participant_consent_revoked', observed_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND NOT deleted AND participant_keys ? ${k} RETURNING id
    `)).length;
  }
  return { status: 200, body: { participantKey: k, revoked: true, sessionsTombstoned: tombstoned } };
}

// ---------------------------------------------------------------- routes

export function registerOfficeAudioPublicRoutes(app: Hono, deps: { db?: Executor; authority?: DeviceAuthority } = {}): void {
  const ex = () => deps.db ?? defaultDb;
  app.post("/api/office-audio/ingest", async (c) => {
    const a = await authenticate(ex(), deps.authority ?? createYcDeviceAuthority(ex(), OFFICE_AUDIO_PROVIDER), c.req.header("x-api-key"));
    if (!a.ok) return c.json({ error: a.error }, a.status);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_INGEST_BYTES) return c.json({ error: `Request body exceeds ${MAX_INGEST_BYTES} bytes` }, 413);
    let body: Record<string, unknown>;
    try {
      const v = JSON.parse(raw) as unknown;
      body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    // A body userId never selects the tenant (the donor admin override is not ported).
    const r = await ingestOfficeAudio(ex(), a, body);
    return c.json(r.body, r.status as 200);
  });
}

export function registerOfficeAudioInternalRoutes(app: Hono, deps: InternalRouteDeps & { db?: Executor }): void {
  const ex = () => deps.db ?? defaultDb;
  const principal = (c: Context) => (c.get("principal" as never) as { subject: string; issuer?: string; scopes?: string[] } | undefined) ?? { subject: "", scopes: [] };
  const admin = (c: Context) => (principal(c).scopes ?? []).includes("memory:build");
  const writer = (c: Context) => admin(c) || (principal(c).scopes ?? []).includes("traces:write");
  app.post("/tenants/:tenantId/devices/office-audio", async (c) => {
    if (!writer(c)) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!/^sb-[0-9a-f]{16}$/.test(String(b.bindingId)) || !/^[0-9a-f]{64}$/.test(String(b.tokenSha256))) return c.json({ error: "bindingId and tokenSha256 required" }, 400);
    const [prior] = rowsOf<{ token_sha256: string }>(await ex().execute(sql`SELECT token_sha256 FROM office_audio_devices WHERE tenant_id = ${deps.tenantOf(c)} AND binding_id = ${String(b.bindingId)}`));
    if (prior) return prior.token_sha256 === b.tokenSha256 ? c.json({ created: false }) : c.json({ error: "device binding already enrolled differently" }, 409);
    await ex().execute(sql`INSERT INTO office_audio_devices (tenant_id, binding_id, token_sha256, label) VALUES (${deps.tenantOf(c)}, ${String(b.bindingId)}, ${String(b.tokenSha256)}, ${typeof b.label === "string" ? b.label.slice(0, 200) : null})`);
    return c.json({ created: true, bindingId: b.bindingId, wire: "/api/office-audio/ingest" }, 201);
  });
  app.delete("/tenants/:tenantId/devices/office-audio/:bindingId", async (c) => {
    if (!writer(c)) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const r = rowsOf(await ex().execute(sql`UPDATE office_audio_devices SET status = 'revoked', revoked_at = now() WHERE tenant_id = ${deps.tenantOf(c)} AND binding_id = ${c.req.param("bindingId")} AND status = 'active' RETURNING binding_id`));
    return r.length ? c.json({ revoked: true }) : c.json({ error: { code: "not_found" } }, 404);
  });
  // Consent is granted and revoked only by an authorized actor (memory:build) of the verified tenant.
  app.post("/tenants/:tenantId/office-audio/consents", async (c) => {
    if (!admin(c)) return c.json({ error: { code: "insufficient_scope", message: "memory:build required to grant recording consent" } }, 403);
    const r = await grantConsent(ex(), deps.tenantOf(c), principal(c), (await c.req.json().catch(() => ({}))) as Record<string, unknown>);
    return c.json(r.body, r.status as 201);
  });
  app.delete("/tenants/:tenantId/office-audio/consents/:participantKey", async (c) => {
    if (!admin(c)) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const r = await revokeConsent(ex(), deps.tenantOf(c), principal(c), decodeURIComponent(c.req.param("participantKey")), c.req.query("deleteCaptured") === "true");
    return c.json(r.body, r.status as 200);
  });
  app.get("/tenants/:tenantId/office-audio/consents", async (c) => c.json({ consents: rowsOf(await ex().execute(sql`
    SELECT participant_key, display_name, granted_by_subject, granted_at, revoked_at FROM office_audio_participant_consents WHERE tenant_id = ${deps.tenantOf(c)} ORDER BY participant_key
  `)) }));
}

// ---------------------------------------------------------------- export + coverage

export function sessionDirectory(startedAt: Date, sourceSessionId: string): string {
  return `sources/office-audio/${startedAt.toISOString().slice(0, 7)}/${encodeURIComponent(sourceSessionId).replace(/\./g, "%2E")}`;
}

export function renderTranscript(s: Record<string, any>): string {
  const turns = (s.turns ?? []) as Array<Record<string, any>>;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  return [`# ${s.title ?? `Office session ${s.sourceSessionId}`}`, "", `- room: ${s.room ?? "unknown"}`, `- started: ${s.startedAt}`, `- ended: ${s.endedAt ?? "unknown"}`,
    `- participants (server consent): ${(s.consentedParticipants ?? []).join(", ")}`, "", "## Transcript", "",
    ...turns.map((t) => {
      const who = t.speakerDisplayName ?? t.speakerLabel ?? "unknown";
      const body = t.consentState === "consented" && t.redactionState === "none" ? t.text : `[withheld: consent ${t.consentState}, redaction ${t.redactionState}]`;
      return `**${fmt(t.startMs)}–${fmt(t.endMs)}** ${who}: ${body}`;
    })].join("\n") + "\n";
}

export const officeAudioExport: ExtraTableExport = {
  table: "office_audio_sessions",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
    const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT source_session_id, payload::text AS payload_text, started_at, version, observed_at, deleted, deleted_reason FROM office_audio_sessions WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
    `));
    if (!r) return prev.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason: "session_row_deleted", capturedAt: j.enqueuedAt }));
    const dir = sessionDirectory(new Date(String(r.started_at)), String(r.source_session_id));
    const capturedAt = new Date(String(r.observed_at)).toISOString();
    const provenance = { runtime: "office-audio transcript lane", port: "askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/integrations/office-audio", externalId: String(r.source_session_id), transcriptOnly: true };
    const paths = [`${dir}/session.json`, `${dir}/transcript.md`];
    if (r.deleted) return paths.map((path) => ({ op: "delete" as const, path, deletedAt: capturedAt, reason: String(r.deleted_reason ?? "deleted"), capturedAt, provenance }));
    const payload = JSON.parse(String(r.payload_text)) as Record<string, unknown>;
    const v = Number(r.version);
    return [
      { op: "put", path: paths[0]!, kind: "raw", contentType: "application/json", content: Buffer.from(String(r.payload_text), "utf8"), sourceUpdatedAt: null, capturedAt, sourceVersion: { ref: `v${v}`, ordinal: v }, provenance },
      { op: "put", path: paths[1]!, kind: "projection", contentType: "text/markdown", content: Buffer.from(renderTranscript(payload), "utf8"), sourceUpdatedAt: null, capturedAt, sourceVersion: { ref: `v${v}`, ordinal: v }, provenance },
    ];
  },
};

export async function officeAudioCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const devices = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`SELECT binding_id, status, last_seen_at FROM office_audio_devices WHERE tenant_id = ${ctx.tenantId}`));
  if (!devices.length) return [{ provider: OFFICE_AUDIO_PROVIDER, scope: "devices", state: "pending", reason: "no enrolled office-audio device" }];
  const [rej] = rowsOf<{ n: number }>(await ctx.executor.execute(sql`SELECT count(*)::int AS n FROM office_audio_rejections WHERE tenant_id = ${ctx.tenantId}`));
  return devices.map((d) => ({
    provider: OFFICE_AUDIO_PROVIDER,
    scope: `device:${d.binding_id}`,
    state: d.status !== "active" ? "blocked" as const : "partial" as const,
    reason: d.status !== "active"
      ? "device binding revoked"
      : `transcript-only (no audio, no STT, no voice profiling); sessions accepted only with server-issued participant consent${rej?.n ? `; ${rej.n} session(s) rejected for missing/forged/revoked consent` : ""}; completeness depends on the device uploading every session`,
    ...(d.last_seen_at ? { lastSuccessAt: new Date(String(d.last_seen_at)).toISOString() } : {}),
    counts: { rejectedSessions: rej?.n ?? 0 },
  }));
}

export function createOfficeAudioProvider(deps: { db?: Executor; authority?: DeviceAuthority } = {}): SourceProviderModule {
  return {
    id: OFFICE_AUDIO_PROVIDER,
    eventSources: [OFFICE_AUDIO_SOURCE],
    mirrorRoots: [],
    connectionProviders: [],
    extraTables: [officeAudioExport],
    coverage: (ctx) => officeAudioCoverage(ctx),
    publicRoutes: (app) => registerOfficeAudioPublicRoutes(app, deps),
    internalRoutes: (app, d) => registerOfficeAudioInternalRoutes(app, { ...d, ...(deps.db ? { db: deps.db } : {}) }),
  };
}
