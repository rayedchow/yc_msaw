import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { runRecordedSourceSyncTask } from "../source-sync-task.js";
import type { TaskHandler } from "../../queue/queue.js";
import { NangoClient, NangoRequestError, type NangoListRecordsResult } from "./client.js";
import { reconcileNangoConnectionsForTenant } from "./reconcile.js";
import {
  NANGO_PROXY_DETAILS_TASK,
  handleNangoProxyDetailsTask,
  type NangoProxyDetailsOptions,
} from "./proxy-details.js";
import {
  NANGO_PROXY_ISSUES_TASK,
  handleNangoProxyIssuesTask,
  type NangoProxyIssuesOptions,
} from "./proxy-issues.js";
import {
  enqueueNangoSyncFanout,
  NANGO_SYNC_RECORDS_TASK,
  nangoSyncDedupeKey,
  type NangoSyncRecordsPayload,
} from "./sync-enqueue.js";
import { dispatchRecords, registeredModelsForProvider, type NangoExecutor } from "./types.js";

export const NANGO_POLL_TASK = "nango.poll";
export { NANGO_SYNC_RECORDS_TASK, nangoSyncDedupeKey };
export type { NangoSyncRecordsPayload };
export { NANGO_PROXY_ISSUES_TASK };
export { NANGO_PROXY_DETAILS_TASK };
export const NANGO_TASK_KINDS = [NANGO_SYNC_RECORDS_TASK, NANGO_PROXY_ISSUES_TASK, NANGO_PROXY_DETAILS_TASK];
export const MAX_NANGO_SYNC_PAGES = 2000;

export interface RegisterNangoTaskOptions {
  client?: Pick<NangoClient, "listRecords">;
  reconcileClient?: Pick<NangoClient, "listConnections">;
  issuesClient?: NangoProxyIssuesOptions["client"];
  detailsClient?: NangoProxyDetailsOptions["client"];
}

export interface NangoPollPayload {
  tenantId: string;
  provider: string;
}

export function registerNangoTasks(options: RegisterNangoTaskOptions = {}): Record<string, TaskHandler> {
  return {
    [NANGO_POLL_TASK]: async (payload, ctx) => {
      return handleNangoPollTask(db, {
        tenantId: requiredString(payload.tenantId ?? ctx.task.tenantId, "nango.poll payload requires tenantId"),
        provider: requiredString(payload.provider, "nango.poll payload requires provider"),
      }, options);
    },
    [NANGO_SYNC_RECORDS_TASK]: async (payload, ctx) => {
      const parsed = parseSyncRecordsPayload(payload);
      return runRecordedSourceSyncTask({
        tenantId: parsed.tenantId,
        provider: parsed.provider,
        taskKind: NANGO_SYNC_RECORDS_TASK,
        taskKinds: NANGO_TASK_KINDS,
        metadata: {
          taskId: ctx.task.id,
          queue: ctx.task.queue,
          providerConfigKey: parsed.providerConfigKey,
          connectionId: parsed.connectionId,
          model: parsed.model,
        },
      }, () => handleNangoSyncRecordsTask(db, parsed, options));
    },
    [NANGO_PROXY_ISSUES_TASK]: async (payload, ctx) => {
      const tenantId = requiredString(payload.tenantId ?? ctx.task.tenantId, "nango.proxy_issues payload requires tenantId");
      const provider = requiredString(payload.provider, "nango.proxy_issues payload requires provider");
      return runRecordedSourceSyncTask({
        tenantId,
        provider,
        taskKind: NANGO_PROXY_ISSUES_TASK,
        taskKinds: [NANGO_PROXY_ISSUES_TASK],
        metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
      }, () => handleNangoProxyIssuesTask(db, { tenantId, provider }, { client: options.issuesClient }));
    },
    [NANGO_PROXY_DETAILS_TASK]: async (payload, ctx) => {
      const tenantId = requiredString(payload.tenantId ?? ctx.task.tenantId, "nango.proxy_details payload requires tenantId");
      const provider = requiredString(payload.provider, "nango.proxy_details payload requires provider");
      return runRecordedSourceSyncTask({
        tenantId,
        provider,
        taskKind: NANGO_PROXY_DETAILS_TASK,
        taskKinds: [NANGO_PROXY_DETAILS_TASK],
        metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
      }, () => handleNangoProxyDetailsTask(db, { tenantId, provider }, { client: options.detailsClient }));
    },
  };
}

export async function handleNangoSyncRecordsTask(
  executor: NangoExecutor,
  payload: NangoSyncRecordsPayload,
  options: RegisterNangoTaskOptions = {},
): Promise<Record<string, unknown>> {
  const client = options.client ?? new NangoClient();
  let cursor = await loadStoredCursor(executor, payload);
  let usingStoredCursor = Boolean(cursor);
  if (!cursor) cursor = payload.cursor ?? null;

  let pages = 0;
  let fetched = 0;
  let processed = 0;
  let skipped = 0;
  let matched = 0;
  let generic = 0;
  let finalCursor = cursor;
  let cursorInvalidated = false;
  const notes: string[] = [];

  while (true) {
    if (pages >= MAX_NANGO_SYNC_PAGES) {
      throw new Error(`nango.sync_records exceeded ${MAX_NANGO_SYNC_PAGES} record pages for ${payload.connectionId}/${payload.model}`);
    }

    let page: NangoListRecordsResult;
    try {
      page = await client.listRecords({
        providerConfigKey: payload.providerConfigKey,
        connectionId: payload.connectionId,
        model: payload.model,
        cursor,
      });
    } catch (err) {
      if (cursor && usingStoredCursor && isCursorInvalidationError(err)) {
        await clearStoredCursor(executor, payload);
        notes.push(`Stored Nango cursor was rejected for ${payload.connectionId}/${payload.model}; restarted from null.`);
        cursorInvalidated = true;
        usingStoredCursor = false;
        cursor = null;
        finalCursor = null;
        continue;
      }
      throw err;
    }

    pages += 1;
    fetched += page.records.length;

    const dispatch = await dispatchRecords(executor, {
      provider: payload.provider,
      model: payload.model,
      records: page.records,
      ctx: {
        tenantId: payload.tenantId,
        providerConfigKey: payload.providerConfigKey,
        connectionId: payload.connectionId,
      },
    });
    processed += dispatch.processed;
    skipped += dispatch.skipped;
    matched += dispatch.matched;
    generic += dispatch.generic;

    if (page.nextCursor) {
      if (page.nextCursor === cursor) {
        console.warn(`nango.sync_records stopped on non-advancing cursor for ${payload.connectionId}/${payload.model}`);
        finalCursor = page.nextCursor;
        break;
      }
      await saveStoredCursor(executor, payload, page.nextCursor);
      finalCursor = page.nextCursor;
      cursor = page.nextCursor;
      usingStoredCursor = false;
      continue;
    }
    break;
  }

  return {
    pages,
    fetched,
    processed,
    skipped,
    matched,
    generic,
    cursor: finalCursor,
    cursorInvalidated,
    notes,
    exhausted: true,
    capHit: pages >= MAX_NANGO_SYNC_PAGES,
  };
}

/**
 * Scheduled polling floor: enqueue one nango.sync_records task per active
 * connection x registered model. The sync task itself resumes from the STORED
 * cursor, so a floor run is a cheap incremental no-op when nothing changed.
 * The dedupe key matches the webhook enqueue path (cursor-less payloads hash
 * to the same key), so floor and webhook enqueues collapse to one task.
 */
export async function handleNangoPollTask(
  executor: NangoExecutor,
  payload: NangoPollPayload,
  options: RegisterNangoTaskOptions = {},
): Promise<Record<string, unknown>> {
  const models = registeredModelsForProvider(payload.provider);
  if (models.length === 0) {
    // Not a real Nango provider - skip reconcile + fan-out entirely (no DB hit).
    console.warn(`[nango] poll floor has no registered models for ${payload.provider}; nothing enqueued`);
    return { connections: 0, models: 0, enqueued: 0 };
  }

  try {
    await reconcileNangoConnectionsForTenant(executor, payload.tenantId, payload.provider, {
      ...(options.reconcileClient ? { client: options.reconcileClient } : {}),
    });
  } catch (err) {
    console.warn(`[nango] poll reconcile failed for ${payload.tenantId}/${payload.provider}: ${errorMessage(err)}`);
  }

  const rows = rowsFromExecute<{
    external_account_id: string | null;
    nango_connection_id: string | null;
    provider_config_key: string | null;
  }>(await executor.execute(sql`
    SELECT
      external_account_id,
      metadata->>'nangoConnectionId' AS nango_connection_id,
      metadata->>'providerConfigKey' AS provider_config_key
    FROM connections
    WHERE tenant_id = ${payload.tenantId}
      AND provider = ${payload.provider}
      AND status = 'active'
  `));

  let connections = 0;
  let enqueued = 0;
  for (const row of rows) {
    const connectionId = optionalString(row.external_account_id) ?? optionalString(row.nango_connection_id);
    if (!connectionId) continue;
    connections += 1;
    const providerConfigKey = optionalString(row.provider_config_key) ?? payload.provider;
    const fanout = await enqueueNangoSyncFanout(executor, {
      tenantId: payload.tenantId,
      provider: payload.provider,
      providerConfigKey,
      connectionId,
    });
    enqueued += fanout.enqueued;
  }

  return { connections, models: models.length, enqueued };
}

/**
 * Disable the polling schedules for one tenant x provider (disconnect/revoke):
 * the record-sync floor AND the proxy sweeps (issues: github/bitbucket;
 * details: jira/github/bitbucket; a no-op UPDATE for providers without one).
 */
export async function disableNangoPollSchedule(
  executor: NangoExecutor,
  tenantId: string,
  provider: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE task_schedules
    SET enabled = false, updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND kind IN (${NANGO_POLL_TASK}, ${NANGO_PROXY_ISSUES_TASK}, ${NANGO_PROXY_DETAILS_TASK})
      AND group_key = ${`${tenantId}:nango:${provider}`}
  `);
}

export async function loadStoredCursor(
  executor: NangoExecutor,
  payload: Pick<NangoSyncRecordsPayload, "tenantId" | "provider" | "connectionId" | "model">,
): Promise<string | null> {
  const rows = rowsFromExecute<{ last_seen_ts: string | null }>(await executor.execute(sql`
    SELECT last_seen_ts
    FROM conversation_watermarks
    WHERE user_id = ${payload.tenantId}
      AND provider = ${payload.provider}
      AND conversation_id = ${cursorConversationId(payload)}
      AND is_active = true
    LIMIT 1
  `));
  return rows[0]?.last_seen_ts ?? null;
}

export async function saveStoredCursor(
  executor: NangoExecutor,
  payload: Pick<NangoSyncRecordsPayload, "tenantId" | "provider" | "connectionId" | "model">,
  cursor: string,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO conversation_watermarks (
      user_id, provider, conversation_id, conversation_type, conversation_name,
      last_seen_ts, last_polled_at, is_active
    )
    VALUES (
      ${payload.tenantId},
      ${payload.provider},
      ${cursorConversationId(payload)},
      'nango_sync_cursor',
      ${payload.model},
      ${cursor},
      now(),
      true
    )
    ON CONFLICT (user_id, provider, conversation_id) DO UPDATE
    SET last_seen_ts = EXCLUDED.last_seen_ts,
        last_polled_at = now(),
        is_active = true
  `);
}

export async function clearStoredCursor(
  executor: NangoExecutor,
  payload: Pick<NangoSyncRecordsPayload, "tenantId" | "provider" | "connectionId" | "model">,
): Promise<void> {
  await executor.execute(sql`
    UPDATE conversation_watermarks
    SET last_seen_ts = NULL,
        last_polled_at = now(),
        is_active = true
    WHERE user_id = ${payload.tenantId}
      AND provider = ${payload.provider}
      AND conversation_id = ${cursorConversationId(payload)}
  `);
}

export function cursorConversationId(
  payload: Pick<NangoSyncRecordsPayload, "connectionId" | "model">,
): string {
  return `${payload.connectionId}:${payload.model}`;
}

function parseSyncRecordsPayload(payload: Record<string, unknown>): NangoSyncRecordsPayload {
  return {
    tenantId: requiredString(payload.tenantId, "nango.sync_records payload requires tenantId"),
    provider: requiredString(payload.provider, "nango.sync_records payload requires provider"),
    providerConfigKey: requiredString(payload.providerConfigKey, "nango.sync_records payload requires providerConfigKey"),
    connectionId: requiredString(payload.connectionId, "nango.sync_records payload requires connectionId"),
    model: requiredString(payload.model, "nango.sync_records payload requires model"),
    cursor: optionalString(payload.cursor) ?? undefined,
  };
}

function isCursorInvalidationError(error: unknown): boolean {
  if (!(error instanceof NangoRequestError)) return false;
  if (error.status !== undefined && error.status !== 400 && error.status !== 404 && error.status !== 410) return false;
  return /cursor|invalid|expired|not found/iu.test(error.message);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
