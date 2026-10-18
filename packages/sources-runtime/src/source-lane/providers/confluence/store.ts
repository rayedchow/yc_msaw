import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import {
  contentHash,
  objectRowKey,
  observationRowKey,
  sha256Hex,
  siteRowKey,
  versionRowKey,
  type ConfluenceContentType,
  type SiteRef,
} from "./identity.js";

/**
 * Durable state of the Confluence deep lane (drizzle/9200). Every statement is
 * scoped by tenant_id plus the (connection, cloudId) site; nothing is keyed by
 * a value a caller can choose.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows) ? ((result as { rows: T[] }).rows ?? []) : [];
}

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoOrNull(v: unknown): string | null {
  return toDate(v)?.toISOString() ?? null;
}

function jsonParam(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export interface SiteScope extends SiteRef {
  tenantId: string;
}

// ------------------------------------------------------------------ sites

export interface SiteRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  provider_config_key: string;
  cloud_id: string;
  site_url: string | null;
  site_name: string | null;
  scopes: unknown;
  status: string;
  status_reason: string | null;
  first_seen_at: unknown;
  last_seen_at: unknown;
  updated_at: unknown;
}

export async function upsertSite(
  db: DbExecutor,
  input: SiteScope & { providerConfigKey: string; siteUrl: string | null; siteName: string | null; scopes: string[]; status: string; statusReason?: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO confluence_source_sites (tenant_id, row_key, connection_id, provider_config_key, cloud_id, site_url, site_name, scopes, status, status_reason)
    VALUES (${input.tenantId}, ${siteRowKey(input)}, ${input.connectionId}, ${input.providerConfigKey}, ${input.cloudId}, ${input.siteUrl}, ${input.siteName},
            ${jsonParam([...input.scopes].sort())}::jsonb, ${input.status}, ${input.statusReason ?? null})
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET
      provider_config_key = EXCLUDED.provider_config_key,
      site_url = EXCLUDED.site_url,
      site_name = EXCLUDED.site_name,
      scopes = EXCLUDED.scopes,
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      last_seen_at = now(),
      updated_at = now()
  `);
}

export async function listSites(db: DbExecutor, tenantId: string, connectionId?: string): Promise<SiteRow[]> {
  return rowsOf<SiteRow>(
    await db.execute(sql`
      SELECT * FROM confluence_source_sites
      WHERE tenant_id = ${tenantId} ${connectionId !== undefined ? sql`AND connection_id = ${connectionId}` : sql``}
      ORDER BY connection_id, cloud_id
    `),
  );
}

/** Sites no longer returned by accessible-resources: access was removed, content is NOT deleted. */
export async function markSitesRemoved(db: DbExecutor, tenantId: string, connectionId: string, keep: readonly string[], reason: string): Promise<number> {
  return rowsOf(
    await db.execute(sql`
      UPDATE confluence_source_sites SET status = 'removed', status_reason = ${reason}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND status <> 'removed'
        ${keep.length ? sql`AND cloud_id NOT IN (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : sql``}
      RETURNING cloud_id
    `),
  ).length;
}

export async function setSiteStatus(db: DbExecutor, scope: SiteScope, status: string, reason: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_sites SET status = ${status}, status_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND row_key = ${siteRowKey(scope)} AND (status IS DISTINCT FROM ${status} OR status_reason IS DISTINCT FROM ${reason})
  `);
}

export async function recordDiscovery(db: DbExecutor, tenantId: string, connectionId: string, status: "ok" | "blocked" | "error", reason: string | null, sites: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO confluence_source_connections (tenant_id, connection_id, status, reason, sites, checked_at)
    VALUES (${tenantId}, ${connectionId}, ${status}, ${reason}, ${sites}, now())
    ON CONFLICT (tenant_id, connection_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, sites = EXCLUDED.sites, checked_at = now()
  `);
}

export async function getDiscovery(db: DbExecutor, tenantId: string, connectionId: string): Promise<{ status: string; reason: string | null; sites: number; checked_at: unknown } | null> {
  return (
    rowsOf<{ status: string; reason: string | null; sites: number; checked_at: unknown }>(
      await db.execute(sql`SELECT status, reason, sites, checked_at FROM confluence_source_connections WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId}`),
    )[0] ?? null
  );
}

// ------------------------------------------------------------------ sync state

export interface SyncStateRow {
  tenant_id: string;
  connection_id: string;
  cloud_id: string;
  provider_config_key: string;
  quota_key: string;
  generation: number;
  generation_phase: "scan" | "confirm" | "closed";
  generation_reason: string | null;
  generation_started_at: unknown;
  generation_finished_at: unknown;
  generation_failed_items: number;
  generation_inaccessible_items: number;
  full_complete_generation: number | null;
  full_complete_at: unknown;
  delta_watermark: unknown;
  delta_checked_at: unknown;
  blocked_code: string | null;
  blocked_reason: string | null;
  last_error: string | null;
  last_error_at: unknown;
  error_streak: number;
  last_success_at: unknown;
  last_run_at: unknown;
}

export async function ensureSyncState(db: DbExecutor, scope: SiteScope & { providerConfigKey: string; quotaKey: string }): Promise<SyncStateRow> {
  await db.execute(sql`
    INSERT INTO confluence_source_sync_state (tenant_id, connection_id, cloud_id, provider_config_key, quota_key)
    VALUES (${scope.tenantId}, ${scope.connectionId}, ${scope.cloudId}, ${scope.providerConfigKey}, ${scope.quotaKey})
    ON CONFLICT (tenant_id, connection_id, cloud_id) DO UPDATE SET
      provider_config_key = EXCLUDED.provider_config_key, quota_key = EXCLUDED.quota_key
    WHERE confluence_source_sync_state.provider_config_key IS DISTINCT FROM EXCLUDED.provider_config_key
       OR confluence_source_sync_state.quota_key IS DISTINCT FROM EXCLUDED.quota_key
  `);
  return (await getSyncState(db, scope))!;
}

export async function getSyncState(db: DbExecutor, scope: SiteScope): Promise<SyncStateRow | null> {
  const r = rowsOf<SyncStateRow>(
    await db.execute(sql`
      SELECT * FROM confluence_source_sync_state
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `),
  )[0];
  return r ? { ...r, generation: Number(r.generation), generation_failed_items: Number(r.generation_failed_items), generation_inaccessible_items: Number(r.generation_inaccessible_items), error_streak: Number(r.error_streak), full_complete_generation: r.full_complete_generation === null ? null : Number(r.full_complete_generation) } : null;
}

export async function listSyncStates(db: DbExecutor, tenantId: string): Promise<SyncStateRow[]> {
  const rs = rowsOf<SyncStateRow>(await db.execute(sql`SELECT * FROM confluence_source_sync_state WHERE tenant_id = ${tenantId} ORDER BY connection_id, cloud_id`));
  return rs.map((r) => ({ ...r, generation: Number(r.generation), generation_failed_items: Number(r.generation_failed_items), generation_inaccessible_items: Number(r.generation_inaccessible_items), error_streak: Number(r.error_streak), full_complete_generation: r.full_complete_generation === null ? null : Number(r.full_complete_generation) }));
}

export async function startGeneration(db: DbExecutor, scope: SiteScope, reason: string): Promise<number> {
  const r = rowsOf<{ generation: number }>(
    await db.execute(sql`
      UPDATE confluence_source_sync_state SET
        generation = generation + 1,
        generation_phase = 'scan',
        generation_reason = ${reason},
        generation_started_at = now(),
        generation_finished_at = NULL,
        generation_failed_items = 0,
        generation_inaccessible_items = 0,
        -- The first pass also starts the delta window: changes after this instant are found by CQL.
        delta_watermark = COALESCE(delta_watermark, now()),
        updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
      RETURNING generation
    `),
  )[0];
  return Number(r?.generation ?? 0);
}

export async function setGenerationPhase(db: DbExecutor, scope: SiteScope, generation: number, phase: "confirm" | "closed", complete: boolean): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_sync_state SET
      generation_phase = ${phase},
      generation_finished_at = CASE WHEN ${phase} = 'closed' THEN now() ELSE generation_finished_at END,
      full_complete_generation = CASE WHEN ${complete} THEN ${generation} ELSE full_complete_generation END,
      full_complete_at = CASE WHEN ${complete} THEN now() ELSE full_complete_at END,
      updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND generation = ${generation}
  `);
}

export async function bumpGenerationCounter(db: DbExecutor, scope: SiteScope, generation: number, which: "failed" | "inaccessible"): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_sync_state SET
      generation_failed_items = generation_failed_items + ${which === "failed" ? 1 : 0},
      generation_inaccessible_items = generation_inaccessible_items + ${which === "inaccessible" ? 1 : 0},
      updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND generation = ${generation}
  `);
}

export async function recordRunOutcome(
  db: DbExecutor,
  scope: SiteScope,
  outcome: { ok: true } | { ok: false; error: string; blockedCode?: string | null; blockedReason?: string | null },
): Promise<void> {
  if (outcome.ok) {
    await db.execute(sql`
      UPDATE confluence_source_sync_state SET last_success_at = now(), last_run_at = now(), error_streak = 0, blocked_code = NULL, blocked_reason = NULL, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE confluence_source_sync_state SET
      last_error = ${outcome.error.slice(0, 1000)}, last_error_at = now(), last_run_at = now(), error_streak = error_streak + 1,
      blocked_code = ${outcome.blockedCode ?? null}, blocked_reason = ${outcome.blockedReason ?? null}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
  `);
}

export async function setDeltaWatermark(db: DbExecutor, scope: SiteScope, watermark: Date): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_sync_state SET delta_watermark = GREATEST(COALESCE(delta_watermark, ${watermark.toISOString()}::timestamptz), ${watermark.toISOString()}::timestamptz),
      delta_checked_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
  `);
}

// ------------------------------------------------------------------ work queue

export interface WorkItem {
  itemKey: string;
  kind: string;
  priority: number;
  payload: Record<string, unknown>;
}

export interface WorkRow {
  item_key: string;
  kind: string;
  priority: number;
  payload: Record<string, unknown>;
  generation: number;
  state: string;
  attempts: number;
  not_before: unknown;
  last_error: string | null;
}

/**
 * Enqueue items for a generation. An item already pending keeps its checkpoint
 * (cursor) unless `restart` is set; a finished item from an older generation is
 * re-armed for this one; a finished item of the same generation is left alone
 * (idempotent replay of the step that produced it).
 */
export async function enqueueWork(db: DbExecutor, scope: SiteScope, generation: number, items: readonly WorkItem[], opts: { restart?: boolean } = {}): Promise<void> {
  for (const it of items) {
    await db.execute(sql`
      INSERT INTO confluence_source_work (tenant_id, connection_id, cloud_id, item_key, kind, priority, payload, generation)
      VALUES (${scope.tenantId}, ${scope.connectionId}, ${scope.cloudId}, ${it.itemKey}, ${it.kind}, ${it.priority}, ${jsonParam(it.payload)}::jsonb, ${generation})
      ON CONFLICT (tenant_id, connection_id, cloud_id, item_key) DO UPDATE SET
        kind = EXCLUDED.kind,
        priority = EXCLUDED.priority,
        payload = CASE WHEN confluence_source_work.state = 'pending' AND NOT ${opts.restart === true} THEN confluence_source_work.payload ELSE EXCLUDED.payload END,
        generation = GREATEST(confluence_source_work.generation, EXCLUDED.generation),
        state = 'pending',
        attempts = CASE WHEN confluence_source_work.state = 'pending' THEN confluence_source_work.attempts ELSE 0 END,
        not_before = CASE WHEN confluence_source_work.state = 'pending' THEN confluence_source_work.not_before ELSE NULL END,
        last_error = CASE WHEN confluence_source_work.state = 'pending' THEN confluence_source_work.last_error ELSE NULL END,
        updated_at = now()
      WHERE confluence_source_work.state = 'pending'
         OR confluence_source_work.generation < EXCLUDED.generation
         OR ${opts.restart === true}
    `);
  }
}

export async function nextWork(db: DbExecutor, scope: SiteScope, limit: number): Promise<WorkRow[]> {
  return rowsOf<WorkRow>(
    await db.execute(sql`
      SELECT item_key, kind, priority, payload, generation, state, attempts, not_before, last_error
      FROM confluence_source_work
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
        AND state = 'pending' AND (not_before IS NULL OR not_before <= now())
      ORDER BY priority ASC, created_at ASC, item_key ASC
      LIMIT ${limit}
    `),
  ).map((r) => ({ ...r, generation: Number(r.generation), attempts: Number(r.attempts), priority: Number(r.priority) }));
}

/** Persist a listing checkpoint: the item stays pending with its next cursor. */
export async function checkpointWork(db: DbExecutor, scope: SiteScope, itemKey: string, payload: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_work SET payload = ${jsonParam(payload)}::jsonb, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND item_key = ${itemKey}
  `);
}

export async function finishWork(db: DbExecutor, scope: SiteScope, itemKey: string, state: "done" | "failed" | "inaccessible", outcome: Record<string, unknown> | null, error?: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_work SET state = ${state}, outcome = ${jsonParam(outcome)}::jsonb, last_error = ${error ?? null}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND item_key = ${itemKey}
  `);
}

export async function retryWorkLater(db: DbExecutor, scope: SiteScope, itemKey: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: number }>(
    await db.execute(sql`
      UPDATE confluence_source_work SET attempts = attempts + 1, last_error = ${error.slice(0, 1000)},
        not_before = now() + make_interval(secs => ${delayMs / 1000}), updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND item_key = ${itemKey}
      RETURNING attempts
    `),
  )[0];
  return Number(r?.attempts ?? 0);
}

export async function workCounts(db: DbExecutor, scope: SiteScope, generation?: number): Promise<Record<string, number>> {
  const rs = rowsOf<{ state: string; n: number }>(
    await db.execute(sql`
      SELECT state, count(*)::int AS n FROM confluence_source_work
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
        ${generation !== undefined ? sql`AND generation = ${generation}` : sql``}
      GROUP BY state
    `),
  );
  const out: Record<string, number> = { pending: 0, done: 0, failed: 0, inaccessible: 0 };
  for (const r of rs) out[r.state] = Number(r.n);
  return out;
}

/** Pending items that belong to the full pass (the delta item is perpetual and excluded). */
export async function pendingScanItems(db: DbExecutor, scope: SiteScope, generation: number): Promise<number> {
  const r = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM confluence_source_work
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
        AND state = 'pending' AND generation <= ${generation} AND kind <> 'delta'
    `),
  )[0];
  return Number(r?.n ?? 0);
}

export async function workState(db: DbExecutor, scope: SiteScope, itemKey: string): Promise<{ state: string; generation: number } | null> {
  const r = rowsOf<{ state: string; generation: number }>(
    await db.execute(sql`
      SELECT state, generation FROM confluence_source_work
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId} AND item_key = ${itemKey}
    `),
  )[0];
  return r ? { state: r.state, generation: Number(r.generation) } : null;
}

// ------------------------------------------------------------------ objects

export interface ObjectRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  cloud_id: string;
  content_type: ConfluenceContentType;
  content_id: string;
  space_id: string | null;
  space_key: string | null;
  container_type: string | null;
  container_id: string | null;
  parent_comment_id: string | null;
  status: string | null;
  title: string | null;
  version_number: number | null;
  version_created_at: unknown;
  raw: Record<string, unknown>;
  raw_text?: string;
  raw_sha256: string;
  adf: unknown;
  adf_text?: string | null;
  adf_version: number | null;
  restrictions: unknown;
  restrictions_status: string | null;
  permissions: unknown;
  permissions_status: string | null;
  binary_status: string | null;
  binary_sha256: string | null;
  binary_size: unknown;
  binary_version: number | null;
  binary_media_type: string | null;
  binary_error: string | null;
  history_through: number | null;
  seen_generation: number | null;
  last_seen_at: unknown;
  inaccessible_at: unknown;
  inaccessible_reason: string | null;
  tombstoned_at: unknown;
  tombstone_reason: string | null;
  children_epoch: number;
  parent_epoch: number;
  first_captured_at: unknown;
  updated_at: unknown;
}

function normObject(r: ObjectRow): ObjectRow {
  return {
    ...r,
    version_number: r.version_number === null ? null : Number(r.version_number),
    adf_version: r.adf_version === null ? null : Number(r.adf_version),
    binary_version: r.binary_version === null ? null : Number(r.binary_version),
    history_through: r.history_through === null ? null : Number(r.history_through),
    seen_generation: r.seen_generation === null ? null : Number(r.seen_generation),
    children_epoch: Number(r.children_epoch),
    parent_epoch: Number(r.parent_epoch),
  };
}

export async function getObject(db: DbExecutor, tenantId: string, rowKey: string): Promise<ObjectRow | null> {
  const r = rowsOf<ObjectRow>(
    await db.execute(sql`
      SELECT *, raw::text AS raw_text, adf::text AS adf_text FROM confluence_source_objects WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}
    `),
  )[0];
  return r ? normObject(r) : null;
}

export async function findObject(db: DbExecutor, scope: SiteScope, type: ConfluenceContentType, id: string): Promise<ObjectRow | null> {
  return getObject(db, scope.tenantId, objectRowKey(scope, type, id));
}

export async function listObjects(
  db: DbExecutor,
  scope: SiteScope,
  filter: { types: readonly ConfluenceContentType[]; spaceId?: string; containerId?: string; live?: boolean; unseenBefore?: number },
): Promise<ObjectRow[]> {
  return rowsOf<ObjectRow>(
    await db.execute(sql`
      SELECT *, raw::text AS raw_text, adf::text AS adf_text FROM confluence_source_objects
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
        AND content_type IN (${sql.join(filter.types.map((t) => sql`${t}`), sql`, `)})
        ${filter.spaceId !== undefined ? sql`AND space_id = ${filter.spaceId}` : sql``}
        ${filter.containerId !== undefined ? sql`AND container_id = ${filter.containerId}` : sql``}
        ${filter.live ? sql`AND tombstoned_at IS NULL` : sql``}
        ${filter.unseenBefore !== undefined ? sql`AND (seen_generation IS NULL OR seen_generation < ${filter.unseenBefore})` : sql``}
      ORDER BY content_type, content_id
    `),
  ).map(normObject);
}

export interface ObjectInput {
  type: ConfluenceContentType;
  id: string;
  spaceId: string | null;
  spaceKey?: string | null;
  containerType?: string | null;
  containerId?: string | null;
  parentCommentId?: string | null;
  status: string | null;
  title: string | null;
  versionNumber: number | null;
  versionCreatedAt: string | null;
  /** Redacted provider payload. */
  raw: Record<string, unknown>;
  /** Provider says trashed/deleted: written in the same statement, so no transient live state is ever exported. */
  tombstoneReason?: string | null;
}

export interface UpsertObjectResult {
  rowKey: string;
  created: boolean;
  /** raw payload / status / placement changed (a new state to export). */
  changed: boolean;
  versionChanged: boolean;
  /** space or container changed: dependent rows need new paths. */
  moved: boolean;
  /** was tombstoned and is live again. */
  restored: boolean;
  previous: ObjectRow | null;
}

/** Upsert the current state of one object, marking it seen in `generation`. */
export async function upsertObject(db: DbExecutor, scope: SiteScope, input: ObjectInput, generation: number | null): Promise<UpsertObjectResult> {
  const rowKey = objectRowKey(scope, input.type, input.id);
  const previous = await getObject(db, scope.tenantId, rowKey);
  const rawSha = contentHash(input.raw);
  const tomb = input.tombstoneReason ?? null;
  const moved = previous !== null && ((previous.space_id ?? null) !== (input.spaceId ?? null) || (previous.container_id ?? null) !== (input.containerId ?? null));
  const restored = previous !== null && previous.tombstoned_at !== null && tomb === null;
  const tombChanged = previous !== null && (previous.tombstone_reason ?? null) !== tomb;
  const changed = previous === null || previous.raw_sha256 !== rawSha || moved || restored || tombChanged || previous.status !== input.status || previous.inaccessible_at !== null;
  const versionChanged = previous === null || previous.version_number !== input.versionNumber;
  if (previous === null) {
    await db.execute(sql`
      INSERT INTO confluence_source_objects (tenant_id, row_key, connection_id, cloud_id, content_type, content_id, space_id, space_key, container_type, container_id,
        parent_comment_id, status, title, version_number, version_created_at, raw, raw_sha256, seen_generation, last_seen_at, tombstoned_at, tombstone_reason)
      VALUES (${scope.tenantId}, ${rowKey}, ${scope.connectionId}, ${scope.cloudId}, ${input.type}, ${input.id}, ${input.spaceId}, ${input.spaceKey ?? null},
        ${input.containerType ?? null}, ${input.containerId ?? null}, ${input.parentCommentId ?? null}, ${input.status}, ${input.title}, ${input.versionNumber},
        ${input.versionCreatedAt}::timestamptz, ${jsonParam(input.raw)}::jsonb, ${rawSha}, ${generation}, now(),
        ${tomb !== null ? sql`now()` : sql`NULL`}, ${tomb})
      ON CONFLICT (tenant_id, row_key) DO NOTHING
    `);
  } else if (changed) {
    await db.execute(sql`
      UPDATE confluence_source_objects SET
        space_id = ${input.spaceId}, space_key = COALESCE(${input.spaceKey ?? null}, space_key), container_type = ${input.containerType ?? null},
        container_id = ${input.containerId ?? null}, parent_comment_id = ${input.parentCommentId ?? null}, status = ${input.status}, title = ${input.title},
        version_number = ${input.versionNumber}, version_created_at = ${input.versionCreatedAt}::timestamptz, raw = ${jsonParam(input.raw)}::jsonb, raw_sha256 = ${rawSha},
        tombstoned_at = ${tomb !== null ? sql`COALESCE(CASE WHEN tombstone_reason = ${tomb} THEN tombstoned_at END, now())` : sql`NULL`}, tombstone_reason = ${tomb},
        inaccessible_at = NULL, inaccessible_reason = NULL,
        seen_generation = COALESCE(${generation}, seen_generation), last_seen_at = now(), updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND row_key = ${rowKey}
    `);
  } else {
    await markSeen(db, scope.tenantId, rowKey, generation);
  }
  return { rowKey, created: previous === null, changed, versionChanged, moved, restored, previous };
}

export async function markSeen(db: DbExecutor, tenantId: string, rowKey: string, generation: number | null): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_objects SET seen_generation = GREATEST(COALESCE(seen_generation, 0), COALESCE(${generation}, seen_generation, 0)), last_seen_at = now()
    WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}
  `);
}

export async function setObjectFields(
  db: DbExecutor,
  tenantId: string,
  rowKey: string,
  fields: Partial<{
    adf: unknown;
    adfVersion: number | null;
    restrictions: unknown;
    restrictionsStatus: string | null;
    permissions: unknown;
    permissionsStatus: string | null;
    binaryStatus: string | null;
    binarySha256: string | null;
    binarySize: number | null;
    binaryVersion: number | null;
    binaryMediaType: string | null;
    binaryError: string | null;
    historyThrough: number | null;
  }>,
): Promise<void> {
  const sets = [];
  if ("adf" in fields) sets.push(sql`adf = ${jsonParam(fields.adf)}::jsonb`);
  if ("adfVersion" in fields) sets.push(sql`adf_version = ${fields.adfVersion ?? null}`);
  if ("restrictions" in fields) sets.push(sql`restrictions = ${jsonParam(fields.restrictions)}::jsonb`);
  if ("restrictionsStatus" in fields) sets.push(sql`restrictions_status = ${fields.restrictionsStatus ?? null}`);
  if ("permissions" in fields) sets.push(sql`permissions = ${jsonParam(fields.permissions)}::jsonb`);
  if ("permissionsStatus" in fields) sets.push(sql`permissions_status = ${fields.permissionsStatus ?? null}`);
  if ("binaryStatus" in fields) sets.push(sql`binary_status = ${fields.binaryStatus ?? null}`);
  if ("binarySha256" in fields) sets.push(sql`binary_sha256 = ${fields.binarySha256 ?? null}`);
  if ("binarySize" in fields) sets.push(sql`binary_size = ${fields.binarySize ?? null}`);
  if ("binaryVersion" in fields) sets.push(sql`binary_version = ${fields.binaryVersion ?? null}`);
  if ("binaryMediaType" in fields) sets.push(sql`binary_media_type = ${fields.binaryMediaType ?? null}`);
  if ("binaryError" in fields) sets.push(sql`binary_error = ${fields.binaryError ?? null}`);
  if ("historyThrough" in fields) sets.push(sql`history_through = ${fields.historyThrough ?? null}`);
  if (!sets.length) return;
  await db.execute(sql`UPDATE confluence_source_objects SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`);
}

/** Provider deletion/trash: the object (and, for containers, everything it contains) stops being live. */
export async function tombstoneObject(db: DbExecutor, tenantId: string, rowKey: string, reason: string, at: Date = new Date()): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE confluence_source_objects SET tombstoned_at = ${at.toISOString()}::timestamptz, tombstone_reason = ${reason}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND row_key = ${rowKey} AND (tombstoned_at IS NULL OR tombstone_reason IS DISTINCT FROM ${reason})
        RETURNING row_key
      `),
    ).length > 0
  );
}

/** Access lost (403): keep the last captured state; this is never treated as a deletion. */
export async function markInaccessible(db: DbExecutor, tenantId: string, rowKey: string, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_objects SET inaccessible_at = COALESCE(inaccessible_at, now()), inaccessible_reason = ${reason}, last_seen_at = now()
    WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}
  `);
}

/** Comments/attachments of a container changed: re-export the container's aggregated files. */
export async function bumpChildrenEpoch(db: DbExecutor, scope: SiteScope, type: ConfluenceContentType, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_objects SET children_epoch = children_epoch + 1, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND row_key = ${objectRowKey(scope, type, id)}
  `);
}

/**
 * A container moved space, was tombstoned or restored: every dependent row (its
 * comments, attachments and version records) is re-journaled so the exporter
 * re-derives their paths (moves delete the old path, tombstones delete projections).
 * Dependent objects follow the container's space.
 */
export async function touchDependents(db: DbExecutor, scope: SiteScope, containerType: ConfluenceContentType, containerId: string, spaceId: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE confluence_source_objects SET parent_epoch = parent_epoch + 1, space_id = ${spaceId}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
      AND container_type = ${containerType} AND container_id = ${containerId}
  `);
  await db.execute(sql`
    UPDATE confluence_source_records SET parent_epoch = parent_epoch + 1, space_id = ${spaceId}
    WHERE tenant_id = ${scope.tenantId} AND object_key = ${objectRowKey(scope, containerType, containerId)}
  `);
}

/** Cascade a container tombstone to its comments and attachments (reason `container_<reason>`). */
export async function tombstoneDependents(db: DbExecutor, scope: SiteScope, containerType: ConfluenceContentType, containerId: string, reason: string, at: Date = new Date()): Promise<number> {
  return rowsOf(
    await db.execute(sql`
      UPDATE confluence_source_objects SET tombstoned_at = ${at.toISOString()}::timestamptz, tombstone_reason = ${`container_${reason}`}, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
        AND container_type = ${containerType} AND container_id = ${containerId} AND tombstoned_at IS NULL
      RETURNING row_key
    `),
  ).length;
}

// ------------------------------------------------------------------ append-only records

export interface RecordRow {
  tenant_id: string;
  row_key: string;
  object_key: string;
  connection_id: string;
  cloud_id: string;
  content_type: ConfluenceContentType;
  content_id: string;
  record_kind: "observation" | "version";
  version_number: number | null;
  raw: Record<string, unknown>;
  raw_text: string;
  raw_sha256: string;
  endpoint: string | null;
  space_id: string | null;
  parent_epoch: number;
  observed_at: unknown;
}

/** Store an observed payload once per distinct content (repeat polls are no-ops). */
export async function insertObservation(db: DbExecutor, scope: SiteScope, type: ConfluenceContentType, id: string, raw: Record<string, unknown>, endpoint: string, versionNumber: number | null, spaceId: string | null): Promise<boolean> {
  const objectKey = objectRowKey(scope, type, id);
  const rawSha = contentHash(raw);
  return insertRecord(db, scope, { rowKey: observationRowKey(objectKey, rawSha), objectKey, type, id, kind: "observation", versionNumber, raw, rawSha, endpoint, spaceId });
}

/** Store the body of one historical version (immutable; the first capture wins). */
export async function insertVersion(db: DbExecutor, scope: SiteScope, type: ConfluenceContentType, id: string, versionNumber: number, raw: Record<string, unknown>, endpoint: string, spaceId: string | null): Promise<boolean> {
  const objectKey = objectRowKey(scope, type, id);
  return insertRecord(db, scope, { rowKey: versionRowKey(objectKey, versionNumber), objectKey, type, id, kind: "version", versionNumber, raw, rawSha: contentHash(raw), endpoint, spaceId });
}

async function insertRecord(
  db: DbExecutor,
  scope: SiteScope,
  r: { rowKey: string; objectKey: string; type: ConfluenceContentType; id: string; kind: "observation" | "version"; versionNumber: number | null; raw: Record<string, unknown>; rawSha: string; endpoint: string; spaceId: string | null },
): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        INSERT INTO confluence_source_records (tenant_id, row_key, object_key, connection_id, cloud_id, content_type, content_id, record_kind, version_number, raw, raw_sha256, endpoint, space_id)
        VALUES (${scope.tenantId}, ${r.rowKey}, ${r.objectKey}, ${scope.connectionId}, ${scope.cloudId}, ${r.type}, ${r.id}, ${r.kind}, ${r.versionNumber},
                ${jsonParam(r.raw)}::jsonb, ${r.rawSha}, ${r.endpoint}, ${r.spaceId})
        ON CONFLICT (tenant_id, row_key) DO NOTHING
        RETURNING row_key
      `),
    ).length > 0
  );
}

export async function getRecord(db: DbExecutor, tenantId: string, rowKey: string): Promise<RecordRow | null> {
  const r = rowsOf<RecordRow>(
    await db.execute(sql`SELECT *, raw::text AS raw_text FROM confluence_source_records WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`),
  )[0];
  return r ? { ...r, version_number: r.version_number === null ? null : Number(r.version_number), parent_epoch: Number(r.parent_epoch) } : null;
}

export async function storedVersionNumbers(db: DbExecutor, tenantId: string, objectKey: string): Promise<Set<number>> {
  return new Set(
    rowsOf<{ version_number: number }>(
      await db.execute(sql`SELECT version_number FROM confluence_source_records WHERE tenant_id = ${tenantId} AND object_key = ${objectKey} AND record_kind = 'version'`),
    ).map((r) => Number(r.version_number)),
  );
}

/** Largest n such that versions 1..n are all stored (0 when version 1 is missing). */
export async function contiguousHistory(db: DbExecutor, tenantId: string, objectKey: string): Promise<number> {
  const have = await storedVersionNumbers(db, tenantId, objectKey);
  let n = 0;
  while (have.has(n + 1)) n += 1;
  return n;
}

// ------------------------------------------------------------------ blobs

export interface BlobRow {
  sha256: string;
  size: number;
  chunks: Array<{ sha256: string; size: number }>;
  media_type: string | null;
}

/** Accumulates streamed bytes into <= 8 MiB chunks written as they fill (bounded memory). */
export class ChunkWriter {
  readonly chunks: Array<{ sha256: string; size: number }> = [];
  #pending: Buffer[] = [];
  #pendingSize = 0;

  constructor(
    private readonly db: DbExecutor,
    private readonly tenantId: string,
  ) {}

  async write(piece: Buffer): Promise<void> {
    let rest = piece;
    while (rest.length > 0) {
      const take = Math.min(rest.length, CHUNK_BYTES - this.#pendingSize);
      this.#pending.push(rest.subarray(0, take));
      this.#pendingSize += take;
      rest = rest.subarray(take);
      if (this.#pendingSize === CHUNK_BYTES) await this.#flush();
    }
  }

  async finish(sha256: string, size: number, mediaType: string | null): Promise<BlobRow> {
    if (this.#pendingSize > 0 || this.chunks.length === 0) await this.#flush();
    const total = this.chunks.reduce((n, c) => n + c.size, 0);
    if (total !== size) throw new Error(`attachment byte count mismatch (${total} != ${size})`);
    await this.db.execute(sql`
      INSERT INTO confluence_source_blobs (tenant_id, sha256, size, chunks, media_type)
      VALUES (${this.tenantId}, ${sha256}, ${size}, ${jsonParam(this.chunks)}::jsonb, ${mediaType})
      ON CONFLICT (tenant_id, sha256) DO NOTHING
    `);
    return { sha256, size, chunks: this.chunks, media_type: mediaType };
  }

  async #flush(): Promise<void> {
    const bytes = Buffer.concat(this.#pending, this.#pendingSize);
    this.#pending = [];
    this.#pendingSize = 0;
    const sha = sha256Hex(bytes);
    await this.db.execute(sql`
      INSERT INTO confluence_source_chunks (tenant_id, chunk_sha256, size, bytes)
      VALUES (${this.tenantId}, ${sha}, ${bytes.length}, ${bytes})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    this.chunks.push({ sha256: sha, size: bytes.length });
  }
}

export async function getBlob(db: DbExecutor, tenantId: string, sha256: string): Promise<BlobRow | null> {
  const r = rowsOf<{ sha256: string; size: unknown; chunks: unknown; media_type: string | null }>(
    await db.execute(sql`SELECT sha256, size, chunks, media_type FROM confluence_source_blobs WHERE tenant_id = ${tenantId} AND sha256 = ${sha256}`),
  )[0];
  if (!r) return null;
  const chunks = (typeof r.chunks === "string" ? JSON.parse(r.chunks) : r.chunks) as Array<{ sha256: string; size: number }>;
  return { sha256: r.sha256, size: Number(r.size), chunks: chunks.map((c) => ({ sha256: c.sha256, size: Number(c.size) })), media_type: r.media_type };
}

export async function loadChunk(db: DbExecutor, tenantId: string, chunkSha256: string): Promise<Buffer> {
  const r = rowsOf<{ bytes: unknown }>(
    await db.execute(sql`SELECT bytes FROM confluence_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha256}`),
  )[0];
  if (!r) throw new Error(`confluence chunk ${chunkSha256} is missing`);
  const b = r.bytes;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (typeof b === "string" && b.startsWith("\\x")) return Buffer.from(b.slice(2), "hex");
  throw new Error("unexpected bytea encoding");
}

// ------------------------------------------------------------------ quota

export async function quotaBlockedUntil(db: DbExecutor, quotaKey: string): Promise<Date | null> {
  const r = rowsOf<{ blocked_until: unknown }>(
    await db.execute(sql`SELECT blocked_until FROM confluence_source_quota WHERE quota_key = ${quotaKey} AND blocked_until > now()`),
  )[0];
  return toDate(r?.blocked_until);
}

/**
 * Persist a cooldown for the Atlassian bucket. With a provider hint the cooldown is
 * exactly Retry-After; without one it backs off exponentially per consecutive 429
 * (60s, 120s, ... capped at 1h). Never shortens an existing cooldown.
 */
export async function recordRateLimited(db: DbExecutor, quotaKey: string, input: { retryAfterMs: number | null; status: number; reason: string; defaultBackoffMs: number }): Promise<Date> {
  const r = rowsOf<{ blocked_until: unknown }>(
    await db.execute(sql`
      INSERT INTO confluence_source_quota (quota_key, blocked_until, rate_limit_streak, last_status, last_retry_after_ms, last_reason, updated_at)
      VALUES (${quotaKey}, now() + make_interval(secs => ${(input.retryAfterMs ?? input.defaultBackoffMs) / 1000}), 1, ${input.status}, ${input.retryAfterMs}, ${input.reason}, now())
      ON CONFLICT (quota_key) DO UPDATE SET
        rate_limit_streak = confluence_source_quota.rate_limit_streak + 1,
        blocked_until = GREATEST(
          COALESCE(confluence_source_quota.blocked_until, now()),
          now() + make_interval(secs => ${input.retryAfterMs !== null ? input.retryAfterMs / 1000 : null}::double precision),
          CASE WHEN ${input.retryAfterMs === null} THEN now() + make_interval(secs => LEAST(3600, ${input.defaultBackoffMs / 1000} * power(2, confluence_source_quota.rate_limit_streak))) END
        ),
        last_status = EXCLUDED.last_status,
        last_retry_after_ms = EXCLUDED.last_retry_after_ms,
        last_reason = EXCLUDED.last_reason,
        updated_at = now()
      RETURNING blocked_until
    `),
  )[0];
  return toDate(r?.blocked_until) ?? new Date(Date.now() + (input.retryAfterMs ?? input.defaultBackoffMs));
}

export async function clearRateStreak(db: DbExecutor, quotaKey: string): Promise<void> {
  await db.execute(sql`UPDATE confluence_source_quota SET rate_limit_streak = 0, updated_at = now() WHERE quota_key = ${quotaKey} AND rate_limit_streak <> 0`);
}

/** One active sweep per Atlassian bucket across all workers and tenants. */
export async function acquireQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  await db.execute(sql`INSERT INTO confluence_source_quota (quota_key) VALUES (${quotaKey}) ON CONFLICT (quota_key) DO NOTHING`);
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE confluence_source_quota SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE quota_key = ${quotaKey} AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_until IS NULL OR lease_until < now())
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function renewQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE confluence_source_quota SET lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function releaseQuotaLease(db: DbExecutor, quotaKey: string, owner: string): Promise<void> {
  await db.execute(sql`UPDATE confluence_source_quota SET lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}`);
}
