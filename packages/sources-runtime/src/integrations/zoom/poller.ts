/**
 * Zoom transcript sync. Ported from askshepherd/aqueduct c7e1415 src/integrations/zoom/poller.ts.
 *
 * Kept from the donor:
 *  - `/users/me/recordings` listed in 30-day windows: the poll covers the last 7 days, the backfill up to 3650 days;
 *  - only ready VTT assets, aggregated per meeting UUID;
 *  - the snapshot is the redacted stable observation (meeting, ordered VTT files with parsed turns,
 *    participants), and its source id is `zoom:<uuid>:<sha256 of that observation>`;
 *  - participants are fetched best effort, only within Zoom's ~15-month past-participant retention.
 *
 * SOURCE-LANE PATCH (coordinator):
 *  - Each lane has a leased durable cursor (`zoom_sync_state`): window index plus next_page_token, saved after
 *    every page. A Zoom page token expires after 15 minutes, so an older one restarts its window. Re-listing is
 *    idempotent because ids are content hashes.
 *  - A 429/5xx persists Retry-After; the donor slept in-process.
 *  - Token refresh (rotating refresh tokens) happens only while the tenant's lane lease is held, and the poll
 *    and backfill lanes are mutually leased, so two refreshes never race.
 *  - The current meeting snapshot is kept in `zoom_meetings` and exported by providers/zoom. The donor's
 *    materializer hook is shared code and is not patched.
 *  - Graph/LLM processing (enqueueCollectedEventForProcessing) is not invoked.
 *  - Audit M6 (provider-repairs): a transcript file that was listed but not captured (non-429 download failure,
 *    or still `processing`) is recorded in `zoom_transcript_files` and retried by later leased runs, which
 *    re-list the meeting's own date window for fresh metadata/download URLs and re-capture the whole meeting
 *    (same snapshot identity as an undisturbed run). Rows of captured files are deleted; a successful re-list
 *    that no longer contains the meeting/file marks it `gone`. Coverage stays partial while rows remain. A 429
 *    defers both lanes (Zoom rate limits are per account).
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db/client.js";
import { getTokenFull, storeToken } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { downloadZoomTranscript, listZoomParticipants, listZoomRecordings, ZoomApiError, type ZoomRecordingFile, type ZoomRecordingMeeting } from "./client.js";
import { refreshZoomOAuthToken } from "./oauth.js";
import { parseZoomVtt } from "./vtt.js";

type Executor = Pick<typeof defaultDb, "execute">;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));

export type ZoomSyncResult = { listed: number; transcriptReady: number; stored: number; skipped: number; failed: number; participantEnrichmentFailed: number; retriedMeetings: number; gone: number; status: string; reason?: string; retryAt?: string };

/** Zoom's own credential fields are dropped from stored observations (download/play URLs carry access). */
export function redactZoom<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = (k === "download_url" || k === "play_url" || k === "download_access_token" || k === "password" || k === "recording_play_passcode") && typeof x === "string" ? "[redacted: Zoom credentialed value]" : walk(x);
    }
    return out;
  };
  return redactProviderPayload("zoom", walk(value)) as T;
}

async function usableToken(tenantId: string): Promise<string | null> {
  const stored = await getTokenFull(tenantId, "zoom");
  if (!stored) return null;
  const expiresAt = typeof stored.metadata?.expiresAt === "string" ? Date.parse(stored.metadata.expiresAt) : 0;
  if (expiresAt > Date.now() + 60_000) return stored.token;
  if (!stored.refreshToken) throw Object.assign(new Error("Zoom OAuth refresh token is missing"), { reauth: true });
  let refreshed;
  try {
    refreshed = await refreshZoomOAuthToken(stored.refreshToken);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 401) throw Object.assign(new Error("Zoom OAuth grant needs to be reconnected"), { reauth: true });
    throw err;
  }
  // Zoom rotates the refresh token on every refresh; the new one must be stored before anything else runs.
  await storeToken(tenantId, "zoom", refreshed.access_token, { ...(stored.metadata ?? {}), expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), scope: refreshed.scope ?? stored.metadata?.scope ?? null }, refreshed.refresh_token);
  return refreshed.access_token;
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export function zoomWindows(from: Date, to: Date): Array<{ from: string; to: string }> {
  const result: Array<{ from: string; to: string }> = [];
  let cursor = new Date(from);
  while (cursor <= to) {
    const end = new Date(Math.min(to.getTime(), cursor.getTime() + 29 * 86_400_000));
    result.push({ from: dateOnly(cursor), to: dateOnly(end) });
    cursor = new Date(end.getTime() + 86_400_000);
  }
  return result;
}

async function storeZoomTranscript(ex: Executor, tenantId: string, meeting: ZoomRecordingMeeting, downloaded: Array<{ file: ZoomRecordingFile; vtt: string }>, participants: unknown[]): Promise<"stored" | "skipped"> {
  const ordered = [...downloaded].sort((a, b) => a.file.id.localeCompare(b.file.id));
  const transcriptFiles = ordered.map(({ file, vtt }) => ({ id: file.id, vtt, turns: parseZoomVtt(vtt) }));
  const transcript = transcriptFiles.flatMap((file) => file.turns);
  const snapshotPayload = redactZoom({ ...meeting, zoomMeetingUuid: meeting.uuid, transcriptFileIds: ordered.map(({ file }) => file.id), transcriptFiles, transcript, participants }) as Record<string, unknown>;
  const contentHash = createHash("sha256").update(JSON.stringify(snapshotPayload)).digest("hex");
  const sourceEventId = `zoom:${meeting.uuid}:${contentHash}`;
  const rawPayload = { ...snapshotPayload, _content_hash: contentHash, api: { source: "zoom_cloud_recordings", fetchedAt: new Date().toISOString() } };
  const occurrence = firstValidDate(meeting.start_time, ...ordered.map(({ file }) => file.recording_start)) ?? new Date();
  const sourceUpdatedAt = latestValidDate(...ordered.map(({ file }) => file.recording_end), meeting.start_time);
  const inserted = rowsOf(await ex.execute(sql`
    INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload, source_event_id,
      processing_status, source_namespace, source_object_id, record_kind, extracted_entities)
    VALUES (${tenantId}, 'zoom', 'meeting_transcript', ${occurrence.toISOString()}::timestamptz, ${sourceUpdatedAt}::timestamptz, ${occurrence.toISOString()}::timestamptz,
      ${JSON.stringify(rawPayload)}::jsonb, ${sourceEventId}, 'received', 'tenant', ${`meeting:${meeting.uuid}`}, 'snapshot', ${JSON.stringify(participantEntities(participants))}::jsonb)
    ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
  `)).length > 0;
  await ex.execute(sql`
    INSERT INTO zoom_meetings (id, tenant_id, meeting_uuid, topic, content_hash, source_event_id, payload, meeting_start, source_updated_at)
    VALUES (${`${tenantId}:${meeting.uuid}`}, ${tenantId}, ${meeting.uuid}, ${meeting.topic ?? null}, ${contentHash}, ${sourceEventId}, ${JSON.stringify(rawPayload)}::jsonb,
      ${occurrence.toISOString()}::timestamptz, ${sourceUpdatedAt}::timestamptz)
    ON CONFLICT (id) DO UPDATE SET topic = EXCLUDED.topic, content_hash = EXCLUDED.content_hash, source_event_id = EXCLUDED.source_event_id,
      payload = EXCLUDED.payload, meeting_start = EXCLUDED.meeting_start, source_updated_at = EXCLUDED.source_updated_at, observed_at = now(), updated_at = now()
    WHERE zoom_meetings.content_hash <> EXCLUDED.content_hash
  `);
  return inserted ? "stored" : "skipped";
}

function firstValidDate(...values: Array<string | undefined>): Date | null {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function latestValidDate(...values: Array<string | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    const date = firstValidDate(value);
    if (date && (!latest || date.toISOString() > latest)) latest = date.toISOString();
  }
  return latest;
}

function participantEntities(participants: unknown[]): Array<{ type: "email_contact"; id: string; name: string; email: string }> | null {
  const seen = new Set<string>();
  const entities: Array<{ type: "email_contact"; id: string; name: string; email: string }> = [];
  for (const value of participants) {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const email = typeof row.user_email === "string" ? row.user_email.trim().toLowerCase() : "";
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    entities.push({ type: "email_contact", id: email, name: typeof row.name === "string" ? row.name : email, email });
  }
  return entities.length ? entities : null;
}

const isTranscriptFile = (file: ZoomRecordingFile) => file.file_type?.toUpperCase() === "TRANSCRIPT" || file.file_extension?.toUpperCase() === "VTT";
type ListWindow = { from: string; to: string };
type FileOutcome = { file: ZoomRecordingFile; state: "processing" | "failed"; status: number | null; error: string };

/** The meeting's own listing dates: its UTC start/recording dates widened by a day each side (never past today). */
function meetingListWindow(meeting: ZoomRecordingMeeting, listed: ListWindow): ListWindow {
  const files = meeting.recording_files ?? [];
  const times = [meeting.start_time, ...files.flatMap((f) => [f.recording_start, f.recording_end])].map((v) => firstValidDate(v)?.getTime()).filter((t): t is number => t != null);
  if (!times.length) return listed;
  return { from: dateOnly(new Date(Math.min(...times) - 86_400_000)), to: dateOnly(new Date(Math.min(Date.now(), Math.max(...times) + 86_400_000))) };
}

/** Capture one listed meeting (donor per-meeting body) and record every transcript file it could not capture. */
async function captureMeeting(ex: Executor, tenantId: string, token: string, meeting: ZoomRecordingMeeting, listed: ListWindow, result: ZoomSyncResult): Promise<void> {
  const transcriptFiles = (meeting.recording_files ?? []).filter(isTranscriptFile);
  const outcomes: FileOutcome[] = [];
  const downloaded: Array<{ file: ZoomRecordingFile; vtt: string }> = [];
  if (transcriptFiles.length === 0) {
    result.skipped++;
  } else {
    const readyFiles = transcriptFiles.filter((file) => file.download_url && file.status !== "processing");
    result.skipped += transcriptFiles.length - readyFiles.length;
    result.transcriptReady += readyFiles.length;
    for (const file of transcriptFiles) if (!readyFiles.includes(file)) outcomes.push({ file, state: "processing", status: null, error: file.download_url ? `transcript status ${file.status}` : "transcript has no download_url yet" });
    for (const file of readyFiles) {
      try {
        downloaded.push({ file, vtt: await downloadZoomTranscript(token, file.download_url!) });
      } catch (err) {
        if (err instanceof ZoomApiError && err.status === 429) throw err;
        result.failed++;
        outcomes.push({ file, state: "failed", status: err instanceof ZoomApiError ? err.status : null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
    }
    if (downloaded.length > 0) {
      let participants: unknown[] = [];
      const meetingTime = Date.parse(meeting.start_time ?? "");
      if (Number.isFinite(meetingTime) && meetingTime >= Date.now() - 15 * 31 * 86_400_000) {
        try {
          participants = await listZoomParticipants(token, meeting.uuid);
        } catch (err) {
          if (err instanceof ZoomApiError && err.status === 429) throw err;
          result.participantEnrichmentFailed++;
        }
      }
      result[await storeZoomTranscript(ex, tenantId, meeting, downloaded, participants)]++;
    }
  }
  const own = meetingListWindow(meeting, listed);
  const capturedIds = downloaded.map(({ file }) => file.id);
  const listedIds = transcriptFiles.map((file) => file.id);
  if (capturedIds.length) await ex.execute(sql`DELETE FROM zoom_transcript_files WHERE tenant_id = ${tenantId} AND meeting_uuid = ${meeting.uuid} AND file_id IN (${sql.join(capturedIds.map((id) => sql`${id}`), sql`, `)})`);
  // A file this successful listing no longer shows was removed at Zoom: it can never be captured.
  const gone = rowsOf(await ex.execute(sql`
    UPDATE zoom_transcript_files SET state = 'gone', last_error = 'transcript file no longer listed by Zoom', updated_at = now()
    WHERE tenant_id = ${tenantId} AND meeting_uuid = ${meeting.uuid} AND state <> 'gone'
      ${listedIds.length ? sql`AND file_id NOT IN (${sql.join(listedIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
    RETURNING file_id
  `));
  result.gone += gone.length;
  for (const o of outcomes) {
    // Exponential retry (5 min doubling, capped at 12 h); a 429 never reaches here (it defers the whole lane).
    await ex.execute(sql`
      INSERT INTO zoom_transcript_files (tenant_id, meeting_uuid, file_id, state, meeting_start, list_from, list_to, window_from, window_to, attempts, next_attempt_at, last_status, last_error)
      VALUES (${tenantId}, ${meeting.uuid}, ${o.file.id}, ${o.state}, ${firstValidDate(meeting.start_time)?.toISOString() ?? null}::timestamptz, ${own.from}::date, ${own.to}::date,
        ${listed.from}::date, ${listed.to}::date, 1, now() + interval '5 minutes', ${o.status}, ${o.error})
      ON CONFLICT (tenant_id, meeting_uuid, file_id) DO UPDATE SET state = EXCLUDED.state, meeting_start = EXCLUDED.meeting_start,
        list_from = EXCLUDED.list_from, list_to = EXCLUDED.list_to,
        window_from = LEAST(zoom_transcript_files.window_from, EXCLUDED.window_from), window_to = GREATEST(zoom_transcript_files.window_to, EXCLUDED.window_to),
        attempts = zoom_transcript_files.attempts + 1,
        next_attempt_at = now() + LEAST(interval '12 hours', interval '5 minutes' * power(2, LEAST(zoom_transcript_files.attempts, 8))),
        last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error, updated_at = now()
    `);
  }
}

/** Find one meeting by UUID in a listing window (all pages). Null only when the whole listing succeeded without it. */
async function findListedMeeting(token: string, uuid: string, window: ListWindow, maxPages: number): Promise<ZoomRecordingMeeting | null | "truncated"> {
  let pageToken: string | null = null;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await listZoomRecordings(token, { ...window, ...(pageToken ? { nextPageToken: pageToken } : {}) });
    const hit = (page.meetings ?? []).find((m) => m.uuid === uuid);
    if (hit) return hit;
    pageToken = page.next_page_token || null;
    if (!pageToken) return null;
  }
  return "truncated";
}

/**
 * Retry due `processing`/`failed` transcript files, a meeting at a time: re-list the meeting's own dates (then
 * its original 30-day window) for fresh metadata and download URLs, then capture the whole meeting again.
 * A 429 propagates (the lane persists Retry-After); any other listing error only pushes that meeting back.
 */
async function retryZoomTranscriptFiles(ex: Executor, tenantId: string, token: string, result: ZoomSyncResult, limit: number): Promise<void> {
  const due = rowsOf<{ meeting_uuid: string; list_from: string; list_to: string; window_from: string; window_to: string }>(await ex.execute(sql`
    SELECT meeting_uuid, min(list_from)::text AS list_from, max(list_to)::text AS list_to, min(window_from)::text AS window_from, max(window_to)::text AS window_to
    FROM zoom_transcript_files WHERE tenant_id = ${tenantId} AND state <> 'gone' AND next_attempt_at <= now()
    GROUP BY meeting_uuid ORDER BY min(next_attempt_at), meeting_uuid LIMIT ${limit}
  `));
  for (const row of due) {
    result.retriedMeetings++;
    const windows = [{ from: row.list_from.slice(0, 10), to: row.list_to.slice(0, 10) }, { from: row.window_from.slice(0, 10), to: row.window_to.slice(0, 10) }];
    try {
      let found: ZoomRecordingMeeting | null | "truncated" = null;
      for (const w of windows) {
        found = await findListedMeeting(token, row.meeting_uuid, w, 20);
        if (found) break;
      }
      if (found === "truncated") throw new Error("Zoom listing exceeded the retry page budget");
      if (found) {
        await captureMeeting(ex, tenantId, token, found, windows[1]!, result);
        continue;
      }
      const gone = rowsOf(await ex.execute(sql`
        UPDATE zoom_transcript_files SET state = 'gone', last_error = 'meeting recording no longer listed by Zoom', updated_at = now()
        WHERE tenant_id = ${tenantId} AND meeting_uuid = ${row.meeting_uuid} AND state <> 'gone' RETURNING file_id
      `));
      result.gone += gone.length;
    } catch (err) {
      if ((err instanceof ZoomApiError && err.status === 429) || (err as { reauth?: boolean }).reauth) throw err;
      await ex.execute(sql`
        UPDATE zoom_transcript_files SET attempts = attempts + 1, last_status = ${err instanceof ZoomApiError ? err.status : null},
          last_error = ${`re-list failed: ${(err as Error).message}`.slice(0, 300)},
          next_attempt_at = now() + LEAST(interval '12 hours', interval '5 minutes' * power(2, LEAST(attempts, 8))), updated_at = now()
        WHERE tenant_id = ${tenantId} AND meeting_uuid = ${row.meeting_uuid} AND state <> 'gone'
      `);
    }
  }
}

export interface ZoomSyncOptions {
  executor?: Executor;
  now?: () => Date;
  maxPages?: number;
  /** Meetings with due transcript-file retries handled per run (default 10). */
  maxRetryMeetings?: number;
}

/**
 * Advance one lane (`poll`: last 7 days, restarted each time it completes; `backfill`: `days` back, once).
 * Both lanes share a tenant lease, so they never run (or refresh tokens) concurrently.
 */
export async function syncZoomLane(tenantId: string, lane: "poll" | "backfill", days: number, opts: ZoomSyncOptions = {}): Promise<ZoomSyncResult> {
  const ex = opts.executor ?? defaultDb;
  const now = opts.now ?? (() => new Date());
  const result: ZoomSyncResult = { listed: 0, transcriptReady: 0, stored: 0, skipped: 0, failed: 0, participantEnrichmentFailed: 0, retriedMeetings: 0, gone: 0, status: "ok" };
  const owner = randomBytes(8).toString("hex");
  await ex.execute(sql`INSERT INTO zoom_sync_state (tenant_id, lane) VALUES (${tenantId}, 'poll'), (${tenantId}, ${lane}) ON CONFLICT DO NOTHING`);
  // Tenant lock: both lanes lease the single 'poll' row, atomically, so they never run (or rotate the
  // refresh token) concurrently. The lane's own row carries its cursor and retry state.
  const [locked] = rowsOf(await ex.execute(sql`
    UPDATE zoom_sync_state SET lease_owner = ${owner}, lease_until = now() + interval '15 minutes'
    WHERE tenant_id = ${tenantId} AND lane = 'poll' AND (lease_until IS NULL OR lease_until < now())
    RETURNING tenant_id
  `));
  if (!locked) return { ...result, status: "skipped", reason: "another Zoom run holds the tenant lease" };
  const unlock = () => ex.execute(sql`UPDATE zoom_sync_state SET lease_owner = NULL, lease_until = NULL WHERE tenant_id = ${tenantId} AND lane = 'poll' AND lease_owner = ${owner}`);
  const [row] = rowsOf<Record<string, unknown>>(await ex.execute(sql`
    SELECT *, (retry_at IS NOT NULL AND retry_at > now()) AS deferred FROM zoom_sync_state WHERE tenant_id = ${tenantId} AND lane = ${lane}
  `));
  if (!row || row.deferred === true || (lane === "backfill" && row.status === "complete")) {
    await unlock();
    // A finished backfill reports complete (its task chain stops); transcript-file retries run in the poll lane.
    if (row && lane === "backfill" && row.status === "complete") return { ...result, status: "complete", reason: "backfill already complete" };
    return { ...result, status: "skipped", reason: "retry pending", ...(row?.retry_at ? { retryAt: new Date(String(row.retry_at)).toISOString() } : {}) };
  }
  let rangeFrom = row.range_from ? new Date(String(row.range_from)) : null;
  let rangeTo = row.range_to ? new Date(String(row.range_to)) : null;
  let windowIndex = Number(row.window_index ?? 0);
  let pageToken = (row.next_page_token as string | null) ?? null;
  const tokenAge = row.page_token_at ? now().getTime() - Date.parse(String(row.page_token_at)) : 0;
  if (pageToken && tokenAge > 14 * 60_000) pageToken = null; // Zoom page tokens expire after 15 minutes: restart the window.
  if (!rangeFrom || !rangeTo) {
    rangeTo = now();
    rangeFrom = new Date(rangeTo.getTime() - Math.max(1, Math.min(days, 3650)) * 86_400_000);
    windowIndex = 0;
    pageToken = null;
  }
  const save = (u: { status?: string; complete?: boolean; retryAt?: Date | null; attempts?: number; lastError?: string | null; release?: boolean; success?: boolean; coveredFrom?: string | null }) => ex.execute(sql`
    UPDATE zoom_sync_state SET range_from = ${u.complete ? null : dateOnly(rangeFrom!)}::date, range_to = ${u.complete ? null : dateOnly(rangeTo!)}::date,
      window_index = ${u.complete ? 0 : windowIndex}, next_page_token = ${u.complete ? null : pageToken}, page_token_at = ${pageToken && !u.complete ? now().toISOString() : null}::timestamptz,
      status = COALESCE(${u.status ?? null}, status),
      covered_from = CASE WHEN ${u.coveredFrom ?? null}::date IS NOT NULL THEN LEAST(COALESCE(covered_from, ${u.coveredFrom ?? null}::date), ${u.coveredFrom ?? null}::date) ELSE covered_from END,
      completed_at = CASE WHEN ${u.complete === true} THEN now() ELSE completed_at END,
      last_success_at = CASE WHEN ${u.success === true} THEN now() ELSE last_success_at END,
      retry_at = ${u.retryAt ? u.retryAt.toISOString() : null}::timestamptz, attempts = ${u.attempts ?? 0}, last_error = ${u.lastError ?? null},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND lane = ${lane}
      AND EXISTS (SELECT 1 FROM zoom_sync_state l WHERE l.tenant_id = ${tenantId} AND l.lane = 'poll' AND l.lease_owner = ${owner})
  `).then(async (r) => {
    if (u.release === true) await unlock();
    return r;
  });
  try {
    const token = await usableToken(tenantId);
    if (!token) {
      await save({ status: "blocked", lastError: "Zoom is not connected", release: true });
      return { ...result, status: "blocked", reason: "not connected" };
    }
    const windows = zoomWindows(rangeFrom, rangeTo);
    let pages = 0;
    const maxPages = opts.maxPages ?? 20;
    while (windowIndex < windows.length && pages < maxPages) {
      const window = windows[windowIndex]!;
      const page = await listZoomRecordings(token, { ...window, ...(pageToken ? { nextPageToken: pageToken } : {}) });
      pages++;
      for (const meeting of page.meetings ?? []) {
        result.listed++;
        await captureMeeting(ex, tenantId, token, meeting, window, result);
      }
      pageToken = page.next_page_token || null;
      if (!pageToken) windowIndex++;
      await save({ status: "running", success: true, coveredFrom: windowIndex >= windows.length ? dateOnly(rangeFrom) : null });
    }
    const complete = windowIndex >= windows.length;
    await retryZoomTranscriptFiles(ex, tenantId, token, result, opts.maxRetryMeetings ?? 10);
    await save({ status: complete ? "complete" : "running", complete, success: true, coveredFrom: complete ? dateOnly(rangeFrom) : null, release: true });
    if (complete && lane === "poll") {
      // The poll lane is a rolling window: the next run starts a fresh 7-day range.
      await ex.execute(sql`UPDATE zoom_sync_state SET status = 'pending' WHERE tenant_id = ${tenantId} AND lane = 'poll'`);
    }
    return { ...result, status: complete ? "complete" : "running" };
  } catch (err) {
    const attempts = Number(row.attempts ?? 0) + 1;
    if ((err as { reauth?: boolean }).reauth) {
      await save({ status: "blocked", lastError: (err as Error).message, attempts, release: true });
      return { ...result, status: "blocked", reason: (err as Error).message };
    }
    const retryAfter = err instanceof ZoomApiError && err.retryAfterSeconds != null ? err.retryAfterSeconds : Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
    if (err instanceof ZoomApiError && err.status === 429) {
      // Zoom rate limits are per account: the other lane waits too (never shortening a later deadline).
      const until = new Date(Date.now() + retryAfter * 1000).toISOString();
      await ex.execute(sql`UPDATE zoom_sync_state SET retry_at = GREATEST(COALESCE(retry_at, ${until}::timestamptz), ${until}::timestamptz), updated_at = now() WHERE tenant_id = ${tenantId} AND lane <> ${lane}`);
    }
    const retryAt = new Date(Date.now() + retryAfter * 1000);
    await save({ status: "error", retryAt, attempts, lastError: `${err instanceof ZoomApiError && err.status === 429 ? "rate_limited" : "error"}: ${(err as Error).message}`.slice(0, 500), release: true });
    return { ...result, status: err instanceof ZoomApiError && err.status === 429 ? "rate_limited" : "error", reason: (err as Error).message, retryAt: retryAt.toISOString() };
  }
}
