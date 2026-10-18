import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { enqueueTask, type TaskHandler } from "../../../queue/queue.js";
import { NangoApiError, NangoRateLimitedError, type ListRecordsPage } from "./api.js";
import { captureNangoRecord } from "./capture.js";
import {
  checkConnectionHealth,
  getConnection,
  POLL_TASK,
  RECONCILE_TASK,
  sourceOf,
  SYNC_TASK,
  syncGroupKey,
  tenantConnections,
  type LaneConnection,
} from "./connections.js";
import { lastModifiedAt, recordCursor } from "./identity.js";
import { rows, safeError, toDate, type NangoRecordsLane } from "./lane.js";
import { acquireSlot, observeRateHeaders, pace, quotaBlockedUntil, recordRateLimited, releaseSlot, renewSlot } from "./quota.js";
import { reconcileOpenSessions } from "./sessions.js";
import { loadCapabilities, modelsToPoll, noteUnconfiguredModel, refreshVerification } from "./verify.js";

/**
 * Incremental /records sync per (tenant, connection, model) and the tenant polling floor.
 *
 * Checkpoint (nango_records_checkpoints): the cursor only advances after every record of the
 * page it came from was captured (captures are idempotent inserts, so a crash replays at most
 * one page). Paging follows next_cursor until null; the stored checkpoint is the last record's
 * _nango_metadata.cursor (Nango's documented resume point). A rejected cursor falls back to
 * modified_after = high-water - 1h (re-reads are deduplicated by version), or a new full pass
 * when nothing was captured yet. A run reads at most maxPagesPerRun pages and then yields to
 * a continuation task, so a task lease is never held across a long backlog or a long wait:
 * 429/503 Retry-After (or X-RateLimit-Reset) is persisted per Nango account and the run is
 * re-enqueued for that time. Concurrency: at most maxConcurrentSyncs runs per integration
 * (DB leases shared by all workers) and one run per connection (queue group key).
 */

export const CURSOR_FALLBACK_WINDOW_MS = 60 * 60_000;
export const HEALTH_CHECK_INTERVAL_MS = 15 * 60_000;
const SLOT_BUSY_RETRY_MS = 30_000;
const POLL_DUE_SLACK_MS = 10_000;

export interface SyncPayload {
  tenantId: string;
  providerConfigKey: string;
  connectionId: string;
  model: string;
  /** Which of the two dedupe slots this task holds (lets a running task enqueue its own follow-up). */
  slot?: "a" | "b";
}

export type SyncOutcome = "caught_up" | "backlog" | "deferred" | "skipped" | "blocked" | "error";

export interface SyncResult extends Record<string, unknown> {
  outcome: SyncOutcome;
  reason?: string;
  pages: number;
  fetched: number;
  stored: number;
  tombstones: number;
  pruned: number;
  cursorReset: boolean;
  retryAt?: string;
}

export function syncDedupeKey(p: Omit<SyncPayload, "slot">, slot: "a" | "b"): string {
  return ["nango-records", "sync", p.tenantId, p.providerConfigKey, p.connectionId, p.model, slot].join(":");
}

/** Enqueue a sync; collapses with an already queued one. `after` = the slot of the running task enqueuing its follow-up. */
export async function enqueueSync(lane: NangoRecordsLane, p: Omit<SyncPayload, "slot">, opts: { runAt?: Date; after?: "a" | "b" } = {}): Promise<string | null> {
  const order: Array<"a" | "b"> = opts.after === "a" ? ["b"] : opts.after === "b" ? ["a"] : ["a", "b"];
  for (const slot of order) {
    const id = await enqueueTask(
      {
        queue: "sync",
        tenantId: p.tenantId,
        groupKey: syncGroupKey(p.tenantId, p.providerConfigKey, p.connectionId),
        kind: SYNC_TASK,
        payload: { tenantId: p.tenantId, providerConfigKey: p.providerConfigKey, connectionId: p.connectionId, model: p.model, slot },
        dedupeKey: syncDedupeKey(p, slot),
        ...(opts.runAt ? { runAt: opts.runAt } : {}),
      },
      lane.db,
    );
    if (id) return id;
  }
  return null;
}

interface CheckpointRow {
  cursor: string | null;
  high_water_modified_at: unknown;
  modified_after_fallback: unknown;
  full_pass_started_at: unknown;
  full_pass_completed_at: unknown;
}

async function loadCheckpoint(lane: NangoRecordsLane, p: SyncPayload): Promise<CheckpointRow> {
  await lane.db.execute(sql`
    INSERT INTO nango_records_checkpoints (tenant_id, provider_config_key, connection_id, model)
    VALUES (${p.tenantId}, ${p.providerConfigKey}, ${p.connectionId}, ${p.model}) ON CONFLICT DO NOTHING
  `);
  return rows<CheckpointRow>(
    await lane.db.execute(sql`
      SELECT cursor, high_water_modified_at, modified_after_fallback, full_pass_started_at, full_pass_completed_at
      FROM nango_records_checkpoints
      WHERE tenant_id = ${p.tenantId} AND provider_config_key = ${p.providerConfigKey} AND connection_id = ${p.connectionId} AND model = ${p.model}
    `),
  )[0]!;
}

function key(p: SyncPayload) {
  return sql`tenant_id = ${p.tenantId} AND provider_config_key = ${p.providerConfigKey} AND connection_id = ${p.connectionId} AND model = ${p.model}`;
}

async function noteCheckpoint(lane: NangoRecordsLane, p: SyncPayload, note: string): Promise<void> {
  const entry = JSON.stringify([{ at: lane.now().toISOString(), note: note.slice(0, 300) }]);
  // Keep the 20 most recent notes.
  await lane.db.execute(sql`
    UPDATE nango_records_checkpoints
    SET notes = (SELECT COALESCE(jsonb_agg(n), '[]'::jsonb) FROM (SELECT n FROM jsonb_array_elements(${entry}::jsonb || notes) AS n LIMIT 20) t), updated_at = now()
    WHERE ${key(p)}
  `);
}

async function recordError(lane: NangoRecordsLane, p: SyncPayload, error: unknown): Promise<string> {
  const msg = safeError(error);
  await lane.db.execute(sql`UPDATE nango_records_checkpoints SET last_error = ${msg}, last_error_at = now(), last_attempt_at = now(), updated_at = now() WHERE ${key(p)}`);
  return msg;
}

function isCursorRejection(error: unknown): boolean {
  return error instanceof NangoApiError && (error.status === 400 || error.status === 410) && /cursor/iu.test(`${error.code ?? ""} ${error.message}`);
}

export function parseSyncPayload(raw: Record<string, unknown>): SyncPayload {
  const req = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || !v || v.length > 512) throw new Error(`${SYNC_TASK} payload requires ${k}`);
    return v;
  };
  return { tenantId: req("tenantId"), providerConfigKey: req("providerConfigKey"), connectionId: req("connectionId"), model: req("model"), slot: raw.slot === "b" ? "b" : "a" };
}

export async function runSync(lane: NangoRecordsLane, p: SyncPayload, ctx: { holder?: string; heartbeat?: () => Promise<void> } = {}): Promise<SyncResult> {
  const result: SyncResult = { outcome: "skipped", pages: 0, fetched: 0, stored: 0, tombstones: 0, pruned: 0, cursorReset: false };
  // Authority: the server-recorded binding, never the payload alone.
  const conn = await getConnection(lane, p.providerConfigKey, p.connectionId);
  if (!conn || conn.tenantId !== p.tenantId) return { ...result, reason: "connection is not bound to this tenant" };
  if (conn.status !== "active") return { ...result, reason: `connection is ${conn.status}` };
  const source = sourceOf(lane, conn);
  if (!source) return { ...result, reason: "integration is no longer configured for the generic lane" };
  const model = modelsToPoll(source, await loadCapabilities(lane, source)).find((m) => m.model === p.model);
  if (!model) {
    await noteUnconfiguredModel(lane, p.providerConfigKey, p.model, p.tenantId);
    return { ...result, reason: `model ${p.model} is not enabled (or not deployed) for ${source.source}` };
  }
  if (!lane.api) return { ...result, outcome: "blocked", reason: "NANGO_SECRET_KEY is not configured" };
  const api = lane.api;

  const defer = async (retryAt: Date, reason: string): Promise<SyncResult> => {
    await lane.db.execute(sql`UPDATE nango_records_checkpoints SET backlog = true, last_attempt_at = now(), updated_at = now() WHERE ${key(p)}`);
    await enqueueSync(lane, p, { runAt: retryAt, after: p.slot ?? "a" });
    return { ...result, outcome: "deferred", reason, retryAt: retryAt.toISOString() };
  };

  const holder = ctx.holder ?? randomBytes(8).toString("hex");
  const slotKey = `nango-sync:${p.providerConfigKey}`;
  if ((await acquireSlot(lane.db, slotKey, source.maxConcurrentSyncs, holder)) === null) {
    await loadCheckpoint(lane, p);
    return defer(new Date(lane.now().getTime() + SLOT_BUSY_RETRY_MS), `all ${source.maxConcurrentSyncs} sync slots of ${p.providerConfigKey} are busy`);
  }
  try {
    const cp = await loadCheckpoint(lane, p);
    let cursor = cp.cursor;
    let fallback = toDate(cp.modified_after_fallback);
    let highWater = toDate(cp.high_water_modified_at);
    if (!cursor && !fallback && !toDate(cp.full_pass_started_at)) {
      await lane.db.execute(sql`UPDATE nango_records_checkpoints SET full_pass_started_at = now() WHERE ${key(p)}`);
    }
    await lane.db.execute(sql`UPDATE nango_records_checkpoints SET last_attempt_at = now(), updated_at = now() WHERE ${key(p)}`);

    while (result.pages < lane.maxPagesPerRun) {
      const blocked = await quotaBlockedUntil(lane.db, api.quotaKey);
      if (blocked) return await defer(blocked, "Nango API rate limit cooldown");
      const gate = await pace(lane.db, api.quotaKey, lane.minRequestIntervalMs);
      if (!gate.ok) return await defer(gate.retryAt, gate.reason === "blocked" ? "Nango API rate limit cooldown" : "request pacing");

      const sent = cursor;
      let page: ListRecordsPage;
      try {
        page = await api.listRecords({
          providerConfigKey: p.providerConfigKey,
          connectionId: p.connectionId,
          model: p.model,
          cursor: sent,
          modifiedAfter: sent ? null : fallback,
          limit: lane.pageLimit,
        });
      } catch (error) {
        if (error instanceof NangoRateLimitedError) {
          await recordRateLimited(lane.db, api.quotaKey, { retryAt: error.retryAt, status: error.status, rate: error.rate });
          await noteCheckpoint(lane, p, `HTTP ${error.status} from Nango; resuming at ${error.retryAt.toISOString()}`);
          return await defer(error.retryAt, `Nango responded ${error.status}`);
        }
        if (sent && isCursorRejection(error)) {
          // Resume by time (overlapping window, deduplicated by version), or start a new full pass.
          fallback = highWater ? new Date(highWater.getTime() - CURSOR_FALLBACK_WINDOW_MS) : null;
          cursor = null;
          result.cursorReset = true;
          await lane.db.execute(sql`
            UPDATE nango_records_checkpoints
            SET cursor = NULL, modified_after_fallback = ${fallback ? fallback.toISOString() : null}::timestamptz, cursor_resets = cursor_resets + 1,
                full_pass_started_at = CASE WHEN ${fallback === null} THEN now() ELSE full_pass_started_at END,
                full_pass_completed_at = CASE WHEN ${fallback === null} THEN NULL ELSE full_pass_completed_at END, updated_at = now()
            WHERE ${key(p)}
          `);
          await noteCheckpoint(lane, p, fallback ? `stored cursor rejected (${safeError(error)}); resuming from modified_after=${fallback.toISOString()}` : `stored cursor rejected (${safeError(error)}); restarting a full pass`);
          continue;
        }
        if (error instanceof NangoApiError && error.status === 404) {
          const msg = await recordError(lane, p, error);
          await checkConnectionHealth(lane, conn).catch(() => conn);
          return { ...result, outcome: "error", reason: msg };
        }
        if (error instanceof NangoApiError && (error.status === 401 || error.status === 403)) {
          const msg = await recordError(lane, p, error);
          return { ...result, outcome: "blocked", reason: `Nango refused the API key (needs environment:records:read): ${msg}` };
        }
        await recordError(lane, p, error);
        throw error;
      }
      await observeRateHeaders(lane.db, api.quotaKey, page.rate);
      result.pages += 1;
      result.fetched += page.records.length;

      let stored = 0;
      let tombstones = 0;
      let pruned = 0;
      let lastCursor: string | null = null;
      for (const record of page.records) {
        const r = await captureNangoRecord(lane.db, { tenantId: p.tenantId, source, connectionId: p.connectionId, model, record });
        if (r.stored) stored += 1;
        if (r.stored && r.deleted) tombstones += 1;
        if (r.pruned) pruned += 1;
        lastCursor = recordCursor(record) ?? lastCursor;
        const lm = lastModifiedAt(record);
        if (lm && (!highWater || new Date(lm) > highWater)) highWater = new Date(lm);
      }
      result.stored += stored;
      result.tombstones += tombstones;
      result.pruned += pruned;
      const checkpoint = lastCursor ?? page.nextCursor ?? sent;
      const advanced = checkpoint !== sent;
      const done = !page.nextCursor || (page.nextCursor === sent && page.records.length === 0);
      await lane.db.execute(sql`
        UPDATE nango_records_checkpoints SET
          cursor = ${checkpoint},
          modified_after_fallback = CASE WHEN ${advanced && checkpoint !== null} THEN NULL ELSE modified_after_fallback END,
          high_water_modified_at = ${highWater ? highWater.toISOString() : null}::timestamptz,
          pages_total = pages_total + 1, records_total = records_total + ${page.records.length}, stored_total = stored_total + ${stored},
          tombstones_total = tombstones_total + ${tombstones}, pruned_skipped_total = pruned_skipped_total + ${pruned},
          last_error = NULL, last_error_at = NULL, updated_at = now()
          ${done ? sql`, caught_up_at = now(), last_success_at = now(), backlog = false,
          full_pass_completed_at = CASE WHEN full_pass_started_at IS NOT NULL AND full_pass_completed_at IS NULL THEN now() ELSE full_pass_completed_at END` : sql``}
        WHERE ${key(p)}
      `);
      if (checkpoint !== null && advanced) fallback = null;
      cursor = page.nextCursor ?? checkpoint;
      await ctx.heartbeat?.();
      await renewSlot(lane.db, slotKey, holder);
      if (done) return { ...result, outcome: "caught_up" };
      if (page.nextCursor === sent) {
        const msg = await recordError(lane, p, new Error("Nango returned a non-advancing next_cursor with records; stopped to avoid a loop"));
        return { ...result, outcome: "error", reason: msg };
      }
    }
    await lane.db.execute(sql`UPDATE nango_records_checkpoints SET backlog = true, updated_at = now() WHERE ${key(p)}`);
    await enqueueSync(lane, p, { after: p.slot ?? "a" });
    return { ...result, outcome: "backlog", reason: `read ${result.pages} pages; continuing in a follow-up task` };
  } finally {
    await releaseSlot(lane.db, slotKey, holder);
  }
}

interface DueRow {
  last_attempt_at: unknown;
  backlog: boolean;
}

/**
 * Tenant polling floor (nango_records.poll): re-verify deployed models, reconcile connect
 * sessions whose webhook never arrived, health-check connections, and enqueue a sync for every
 * active connection x model that is due (per-source pollSeconds) or has a backlog.
 */
export async function runPoll(lane: NangoRecordsLane, tenantId: string): Promise<Record<string, unknown>> {
  const out = { verified: 0, sessionsConnected: 0, healthChecked: 0, enqueued: 0, errors: [] as string[] };
  if (!lane.catalog.sources.length) return out;
  const now = lane.now();
  try {
    const conns = await tenantConnections(lane, tenantId);
    const sources = new Set(conns.map((c) => c.source));
    for (const s of lane.catalog.sources) {
      if (!sources.has(s.source)) continue;
      if ((await refreshVerification(lane, s)) === "checked") out.verified += 1;
    }
    out.sessionsConnected = (await reconcileOpenSessions(lane, tenantId)).connected;

    const current: LaneConnection[] = [];
    for (const c of await tenantConnections(lane, tenantId)) {
      const last = toDate(c.lastReconciledAt);
      if (c.status !== "revoked" && (!last || now.getTime() - last.getTime() > HEALTH_CHECK_INTERVAL_MS)) {
        try {
          current.push(await checkConnectionHealth(lane, c));
          out.healthChecked += 1;
        } catch (error) {
          out.errors.push(safeError(error));
          current.push(c);
        }
      } else current.push(c);
    }

    for (const c of current) {
      if (c.status !== "active") continue;
      const source = sourceOf(lane, c);
      if (!source) continue;
      for (const m of modelsToPoll(source, await loadCapabilities(lane, source))) {
        const due = rows<DueRow>(
          await lane.db.execute(sql`
            SELECT last_attempt_at, backlog FROM nango_records_checkpoints
            WHERE tenant_id = ${tenantId} AND provider_config_key = ${c.providerConfigKey} AND connection_id = ${c.connectionId} AND model = ${m.model}
          `),
        )[0];
        const last = toDate(due?.last_attempt_at);
        if (due && !due.backlog && last && now.getTime() - last.getTime() < source.pollSeconds * 1000 - POLL_DUE_SLACK_MS) continue;
        if (await enqueueSync(lane, { tenantId, providerConfigKey: c.providerConfigKey, connectionId: c.connectionId, model: m.model })) out.enqueued += 1;
      }
    }
    await lane.db.execute(sql`
      INSERT INTO nango_records_tenant_state (tenant_id, last_poll_at) VALUES (${tenantId}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET last_poll_at = now()
    `);
  } catch (error) {
    const msg = safeError(error);
    await lane.db.execute(sql`
      INSERT INTO nango_records_tenant_state (tenant_id, last_poll_error, last_poll_error_at) VALUES (${tenantId}, ${msg}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET last_poll_error = EXCLUDED.last_poll_error, last_poll_error_at = now()
    `);
    throw error;
  }
  return out;
}

export async function enqueueReconcile(lane: NangoRecordsLane, conn: Pick<LaneConnection, "tenantId" | "providerConfigKey" | "connectionId">): Promise<string | null> {
  return enqueueTask(
    {
      queue: "sync",
      tenantId: conn.tenantId,
      groupKey: syncGroupKey(conn.tenantId, conn.providerConfigKey, conn.connectionId),
      kind: RECONCILE_TASK,
      payload: { tenantId: conn.tenantId, providerConfigKey: conn.providerConfigKey, connectionId: conn.connectionId },
      dedupeKey: ["nango-records", "reconcile", conn.tenantId, conn.providerConfigKey, conn.connectionId].join(":"),
    },
    lane.db,
  );
}

export function laneTaskHandlers(lane: () => NangoRecordsLane): Record<string, TaskHandler> {
  return {
    [POLL_TASK]: async (payload, ctx) => {
      const tenantId = typeof payload.tenantId === "string" && payload.tenantId ? payload.tenantId : ctx.task.tenantId;
      if (tenantId !== ctx.task.tenantId) throw new Error(`${POLL_TASK} payload tenant does not match the task tenant`);
      return runPoll(lane(), tenantId);
    },
    [SYNC_TASK]: async (payload, ctx) => {
      const p = parseSyncPayload(payload);
      if (p.tenantId !== ctx.task.tenantId) throw new Error(`${SYNC_TASK} payload tenant does not match the task tenant`);
      return runSync(lane(), p, { holder: ctx.task.id, heartbeat: ctx.heartbeat });
    },
    [RECONCILE_TASK]: async (payload, ctx) => {
      const l = lane();
      const pck = typeof payload.providerConfigKey === "string" ? payload.providerConfigKey : "";
      const id = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const conn = await getConnection(l, pck, id);
      if (!conn || conn.tenantId !== ctx.task.tenantId) return { skipped: "connection is not bound to this tenant" };
      const next = await checkConnectionHealth(l, conn);
      return { status: next.status };
    },
  };
}
