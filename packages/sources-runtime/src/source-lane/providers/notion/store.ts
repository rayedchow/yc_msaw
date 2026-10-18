import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";

/**
 * Persistence of the Notion deep lane (drizzle/9450_notion_source_lane.sql). Every
 * statement is scoped by tenant_id AND connection_id (the Notion bot id).
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON (sorted keys) used for content hashes, never for exported raw. */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).filter((k) => r[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(r[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentSha(value: unknown): string {
  return sha256Hex(stableJson(value));
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

/** Percent-encode one row-key segment (row keys are `/`-joined). */
export function keySeg(v: string): string {
  return encodeURIComponent(v);
}

export interface Scope {
  tenantId: string;
  connectionId: string;
}

export type NodeType = "page" | "data_source" | "database";

export function nodeRowKey(connectionId: string, type: NodeType, id: string): string {
  return `${keySeg(connectionId)}/${type}/${keySeg(id)}`;
}

export function fileRowKey(connectionId: string, fileKey: string): string {
  return `${keySeg(connectionId)}/file/${sha256Hex(fileKey).slice(0, 32)}`;
}

export function connectionRowKey(connectionId: string): string {
  return `${keySeg(connectionId)}/connection`;
}

// ------------------------------------------------------------------ connections

export interface ConnectionInput {
  connectionId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  botId: string | null;
  authMode: string | null;
  owner: unknown;
  bot: unknown;
}

export interface ConnectionRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_id: string | null;
  auth_mode: string | null;
  owner: unknown;
  bot: unknown;
  status: string;
  status_reason: string | null;
  capabilities: Record<string, unknown>;
  first_seen_at: unknown;
  checked_at: unknown;
}

export async function upsertConnection(db: DbExecutor, tenantId: string, c: ConnectionInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO notion_source_connections (tenant_id, row_key, connection_id, workspace_id, workspace_name, bot_id, auth_mode, owner, bot, status, status_reason)
    VALUES (${tenantId}, ${connectionRowKey(c.connectionId)}, ${c.connectionId}, ${c.workspaceId}, ${c.workspaceName}, ${c.botId}, ${c.authMode},
            ${jsonParam(c.owner)}::jsonb, ${jsonParam(c.bot)}::jsonb, 'active', NULL)
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET
      workspace_id = COALESCE(EXCLUDED.workspace_id, notion_source_connections.workspace_id),
      workspace_name = COALESCE(EXCLUDED.workspace_name, notion_source_connections.workspace_name),
      bot_id = COALESCE(EXCLUDED.bot_id, notion_source_connections.bot_id),
      auth_mode = COALESCE(EXCLUDED.auth_mode, notion_source_connections.auth_mode),
      owner = COALESCE(EXCLUDED.owner, notion_source_connections.owner),
      bot = COALESCE(EXCLUDED.bot, notion_source_connections.bot),
      status = 'active', status_reason = NULL, checked_at = now(), updated_at = now()
  `);
  // Another bot of the same tenant is no longer the connected one (access to its content is gone; content is kept).
  await db.execute(sql`
    UPDATE notion_source_connections
    SET status = 'replaced', status_reason = ${`tenant now connected through Notion bot ${c.connectionId}`}, checked_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND connection_id <> ${c.connectionId} AND status <> 'replaced'
  `);
}

export async function setConnectionStatus(db: DbExecutor, scope: Scope, status: "active" | "blocked", reason: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO notion_source_connections (tenant_id, row_key, connection_id, status, status_reason)
    VALUES (${scope.tenantId}, ${connectionRowKey(scope.connectionId)}, ${scope.connectionId}, ${status}, ${reason})
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason, checked_at = now(), updated_at = now()
  `);
}

export async function noteCapability(db: DbExecutor, scope: Scope, capability: string, value: string | null): Promise<void> {
  const patch = JSON.stringify({ [capability]: value });
  await db.execute(sql`
    UPDATE notion_source_connections
    SET capabilities = CASE WHEN ${value}::text IS NULL THEN capabilities - ${capability} ELSE capabilities || ${patch}::jsonb END, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
      AND (capabilities -> ${capability}) IS DISTINCT FROM (${patch}::jsonb -> ${capability})
  `);
}

export async function listConnections(db: DbExecutor, tenantId: string): Promise<ConnectionRow[]> {
  return rowsOf<ConnectionRow>(await db.execute(sql`SELECT * FROM notion_source_connections WHERE tenant_id = ${tenantId} ORDER BY connection_id`));
}

export async function getConnectionByKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<ConnectionRow | null> {
  return rowsOf<ConnectionRow>(await db.execute(sql`SELECT * FROM notion_source_connections WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0] ?? null;
}

export async function getConnection(db: DbExecutor, scope: Scope): Promise<ConnectionRow | null> {
  return rowsOf<ConnectionRow>(await db.execute(sql`SELECT * FROM notion_source_connections WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}`))[0] ?? null;
}

// ------------------------------------------------------------------ sync state

export interface SyncStateRow {
  tenant_id: string;
  connection_id: string;
  quota_key: string;
  workspace_quota_key: string | null;
  generation: number;
  generation_phase: string;
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

export async function ensureSyncState(db: DbExecutor, scope: Scope, quotaKey: string, workspaceQuotaKey: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO notion_source_sync_state (tenant_id, connection_id, quota_key, workspace_quota_key)
    VALUES (${scope.tenantId}, ${scope.connectionId}, ${quotaKey}, ${workspaceQuotaKey})
    ON CONFLICT (tenant_id, connection_id) DO UPDATE SET quota_key = EXCLUDED.quota_key,
      workspace_quota_key = COALESCE(EXCLUDED.workspace_quota_key, notion_source_sync_state.workspace_quota_key)
  `);
}

export async function getSyncState(db: DbExecutor, scope: Scope): Promise<SyncStateRow | null> {
  const r = rowsOf<SyncStateRow>(await db.execute(sql`SELECT * FROM notion_source_sync_state WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}`))[0];
  return r ? { ...r, generation: Number(r.generation), generation_failed_items: Number(r.generation_failed_items), generation_inaccessible_items: Number(r.generation_inaccessible_items), full_complete_generation: r.full_complete_generation === null ? null : Number(r.full_complete_generation), error_streak: Number(r.error_streak) } : null;
}

export async function listSyncStates(db: DbExecutor, tenantId: string): Promise<SyncStateRow[]> {
  return rowsOf<SyncStateRow>(await db.execute(sql`SELECT * FROM notion_source_sync_state WHERE tenant_id = ${tenantId} ORDER BY connection_id`));
}

export async function startGeneration(db: DbExecutor, scope: Scope, reason: string): Promise<number> {
  const r = rowsOf<{ generation: number }>(await db.execute(sql`
    UPDATE notion_source_sync_state
    SET generation = generation + 1, generation_phase = 'scan', generation_reason = ${reason}, generation_started_at = now(),
        generation_finished_at = NULL, generation_failed_items = 0, generation_inaccessible_items = 0, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
    RETURNING generation
  `))[0];
  return Number(r!.generation);
}

export async function setGenerationPhase(db: DbExecutor, scope: Scope, generation: number, phase: "confirm" | "closed", complete: boolean): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_sync_state
    SET generation_phase = ${phase},
        generation_finished_at = CASE WHEN ${phase} = 'closed' THEN now() ELSE generation_finished_at END,
        full_complete_generation = CASE WHEN ${complete} THEN generation ELSE full_complete_generation END,
        full_complete_at = CASE WHEN ${complete} THEN now() ELSE full_complete_at END,
        updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND generation = ${generation}
  `);
}

export async function bumpGenerationCounter(db: DbExecutor, scope: Scope, generation: number, which: "failed" | "inaccessible"): Promise<void> {
  const col = which === "failed" ? sql`generation_failed_items = generation_failed_items + 1` : sql`generation_inaccessible_items = generation_inaccessible_items + 1`;
  await db.execute(sql`UPDATE notion_source_sync_state SET ${col}, updated_at = now() WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND generation = ${generation}`);
}

export async function recordRunOutcome(db: DbExecutor, scope: Scope, o: { ok: boolean; error?: string | null; blockedCode?: string | null; blockedReason?: string | null }): Promise<void> {
  if (o.ok) {
    await db.execute(sql`
      UPDATE notion_source_sync_state SET last_success_at = now(), last_run_at = now(), error_streak = 0, blocked_code = NULL, blocked_reason = NULL, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE notion_source_sync_state
    SET last_error = ${o.error ?? null}, last_error_at = now(), last_run_at = now(), error_streak = error_streak + 1,
        blocked_code = ${o.blockedCode ?? null}, blocked_reason = ${o.blockedReason ?? null}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
  `);
}

export async function setDeltaWatermark(db: DbExecutor, scope: Scope, watermark: Date | null): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_sync_state
    SET delta_watermark = CASE WHEN ${isoOrNull(watermark)}::timestamptz IS NULL THEN delta_watermark
                               ELSE GREATEST(COALESCE(delta_watermark, ${isoOrNull(watermark)}::timestamptz), ${isoOrNull(watermark)}::timestamptz) END,
        delta_checked_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
  `);
}

// ------------------------------------------------------------------ work queue

export interface WorkItem {
  itemKey: string;
  kind: string;
  priority: number;
  pageId?: string | null;
  payload: Record<string, unknown>;
}

export interface WorkRow {
  item_key: string;
  kind: string;
  priority: number;
  page_id: string | null;
  payload: Record<string, unknown>;
  generation: number;
  state: string;
  attempts: number;
}

/**
 * Enqueue items. An existing pending item is kept (its checkpoint survives); a finished item
 * is re-armed (`restart` also resets a pending one, used for listings that must start over).
 */
export async function enqueueWork(db: DbExecutor, scope: Scope, generation: number, items: readonly WorkItem[], opts: { restart?: boolean } = {}): Promise<void> {
  for (const it of items) {
    await db.execute(sql`
      INSERT INTO notion_source_work (tenant_id, connection_id, item_key, kind, priority, page_id, payload, generation, state)
      VALUES (${scope.tenantId}, ${scope.connectionId}, ${it.itemKey}, ${it.kind}, ${it.priority}, ${it.pageId ?? null}, ${jsonParam(it.payload)}::jsonb, ${generation}, 'pending')
      ON CONFLICT (tenant_id, connection_id, item_key) DO UPDATE SET
        kind = EXCLUDED.kind, priority = EXCLUDED.priority, page_id = EXCLUDED.page_id,
        payload = CASE WHEN notion_source_work.state = 'pending' AND NOT ${opts.restart ?? false} THEN notion_source_work.payload ELSE EXCLUDED.payload END,
        generation = EXCLUDED.generation,
        attempts = CASE WHEN notion_source_work.state = 'pending' AND NOT ${opts.restart ?? false} THEN notion_source_work.attempts ELSE 0 END,
        not_before = CASE WHEN notion_source_work.state = 'pending' AND NOT ${opts.restart ?? false} THEN notion_source_work.not_before ELSE NULL END,
        state = 'pending', last_error = CASE WHEN notion_source_work.state = 'pending' THEN notion_source_work.last_error ELSE NULL END,
        updated_at = now()
    `);
  }
}

export async function nextWork(db: DbExecutor, scope: Scope, limit: number): Promise<WorkRow[]> {
  return rowsOf<WorkRow>(await db.execute(sql`
    SELECT item_key, kind, priority, page_id, payload, generation, state, attempts
    FROM notion_source_work
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND state = 'pending'
      AND (not_before IS NULL OR not_before <= now())
    ORDER BY priority, created_at, item_key
    LIMIT ${limit}
  `)).map((r) => ({ ...r, generation: Number(r.generation), attempts: Number(r.attempts), payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}

export async function checkpointWork(db: DbExecutor, scope: Scope, itemKey: string, payload: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_work SET payload = ${jsonParam(payload)}::jsonb, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND item_key = ${itemKey}
  `);
}

export async function finishWork(db: DbExecutor, scope: Scope, itemKey: string, state: "done" | "failed" | "inaccessible", outcome: Record<string, unknown> | null, error: string | null = null): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_work SET state = ${state}, outcome = ${jsonParam(outcome)}::jsonb, last_error = ${error}, not_before = NULL, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND item_key = ${itemKey}
  `);
}

export async function retryWorkLater(db: DbExecutor, scope: Scope, itemKey: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: number }>(await db.execute(sql`
    UPDATE notion_source_work SET attempts = attempts + 1, last_error = ${error.slice(0, 2000)},
      not_before = now() + make_interval(secs => ${Math.max(0, delayMs) / 1000}), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND item_key = ${itemKey}
    RETURNING attempts
  `))[0];
  return Number(r?.attempts ?? 0);
}

export async function deferWork(db: DbExecutor, scope: Scope, itemKey: string, delayMs: number): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_work SET not_before = now() + make_interval(secs => ${Math.max(0, delayMs) / 1000}), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND item_key = ${itemKey}
  `);
}

export async function workState(db: DbExecutor, scope: Scope, itemKey: string): Promise<{ state: string; generation: number; payload: Record<string, unknown> } | null> {
  const r = rowsOf<{ state: string; generation: number; payload: unknown }>(await db.execute(sql`
    SELECT state, generation, payload FROM notion_source_work WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND item_key = ${itemKey}
  `))[0];
  return r ? { state: r.state, generation: Number(r.generation), payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown> } : null;
}

export async function pendingItems(db: DbExecutor, scope: Scope, kinds?: readonly string[]): Promise<number> {
  const kindFilter = kinds?.length ? sql`AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const r = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM notion_source_work WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND state = 'pending' ${kindFilter}
  `))[0];
  return Number(r?.n ?? 0);
}

/**
 * Listings of a page that are still pending (block children of any epoch, comments, comment
 * confirmations), and block-children listings of walk `epoch` that failed (a failed listing
 * means unlisted blocks cannot be proven removed).
 */
export async function pageWalkItems(db: DbExecutor, scope: Scope, pageId: string, epoch: number): Promise<{ pending: number; failed: number }> {
  const r = rowsOf<{ pending: number; failed: number }>(await db.execute(sql`
    SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
           count(*) FILTER (WHERE state IN ('failed', 'inaccessible') AND kind = 'children' AND (payload->>'epoch')::int = ${epoch})::int AS failed
    FROM notion_source_work
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId}
      AND kind IN ('children', 'comments', 'comment_confirm')
  `))[0];
  return { pending: Number(r?.pending ?? 0), failed: Number(r?.failed ?? 0) };
}

export async function workCounts(db: DbExecutor, scope: Scope): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of rowsOf<{ state: string; n: number }>(await db.execute(sql`
    SELECT state, count(*)::int AS n FROM notion_source_work WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} GROUP BY state
  `))) out[r.state] = Number(r.n);
  return out;
}

// ------------------------------------------------------------------ nodes

export interface NodeRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  object_type: NodeType;
  object_id: string;
  parent_type: string | null;
  parent_id: string | null;
  database_id: string | null;
  title: string;
  url: string | null;
  created_time: unknown;
  last_edited_time: unknown;
  in_trash: boolean;
  is_archived: boolean;
  is_locked: boolean;
  raw: Record<string, unknown>;
  raw_text: string;
  raw_sha256: string;
  hydrated_properties: Record<string, unknown> | null;
  hydrated_properties_text: string | null;
  properties_status: string | null;
  walk_epoch: number;
  walk_started_at: unknown;
  walked_at: unknown;
  walk_status: string | null;
  walk_error: string | null;
  tree_sha256: string | null;
  content_epoch: number;
  comments_status: string | null;
  comments_checked_at: unknown;
  query_status: string | null;
  query_checked_at: unknown;
  rows_epoch: number;
  seen_generation: number | null;
  last_seen_at: unknown;
  tombstoned_at: unknown;
  tombstone_reason: string | null;
  inaccessible_at: unknown;
  inaccessible_reason: string | null;
  path_epoch: number;
  first_captured_at: unknown;
  updated_at: unknown;
}

const NODE_COLUMNS = sql`*, raw::text AS raw_text, hydrated_properties::text AS hydrated_properties_text`;

function normNode(r: NodeRow): NodeRow {
  return {
    ...r,
    raw: (typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw) as Record<string, unknown>,
    hydrated_properties: typeof r.hydrated_properties === "string" ? JSON.parse(r.hydrated_properties) : r.hydrated_properties,
    walk_epoch: Number(r.walk_epoch),
    content_epoch: Number(r.content_epoch),
    rows_epoch: Number(r.rows_epoch),
    path_epoch: Number(r.path_epoch),
    seen_generation: r.seen_generation === null ? null : Number(r.seen_generation),
  };
}

export async function getNodeByKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<NodeRow | null> {
  const r = rowsOf<NodeRow>(await db.execute(sql`SELECT ${NODE_COLUMNS} FROM notion_source_nodes WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? normNode(r) : null;
}

export async function getNode(db: DbExecutor, scope: Scope, objectId: string): Promise<NodeRow | null> {
  const r = rowsOf<NodeRow>(await db.execute(sql`
    SELECT ${NODE_COLUMNS} FROM notion_source_nodes WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id = ${objectId}
  `))[0];
  return r ? normNode(r) : null;
}

export interface NodeFilter {
  types?: readonly NodeType[];
  parentId?: string;
  live?: boolean;
  unseenBefore?: number;
  databaseId?: string;
}

export async function listNodes(db: DbExecutor, scope: Scope, f: NodeFilter = {}): Promise<NodeRow[]> {
  const conds: SQL[] = [sql`tenant_id = ${scope.tenantId}`, sql`connection_id = ${scope.connectionId}`];
  if (f.types?.length) conds.push(sql`object_type IN (${sql.join(f.types.map((t) => sql`${t}`), sql`, `)})`);
  if (f.parentId !== undefined) conds.push(sql`parent_id = ${f.parentId}`);
  if (f.databaseId !== undefined) conds.push(sql`database_id = ${f.databaseId}`);
  if (f.live) conds.push(sql`tombstoned_at IS NULL AND inaccessible_at IS NULL`);
  if (f.unseenBefore !== undefined) conds.push(sql`COALESCE(seen_generation, 0) < ${f.unseenBefore}`);
  return rowsOf<NodeRow>(await db.execute(sql`SELECT ${NODE_COLUMNS} FROM notion_source_nodes WHERE ${sql.join(conds, sql` AND `)} ORDER BY object_type, object_id`)).map(normNode);
}

export interface NodeInput {
  type: NodeType;
  id: string;
  parentType: string | null;
  parentId: string | null;
  databaseId: string | null;
  title: string;
  url: string | null;
  createdTime: string | null;
  lastEditedTime: string | null;
  inTrash: boolean;
  isArchived: boolean;
  isLocked: boolean;
  /** Redacted provider object. */
  raw: Record<string, unknown>;
}

export interface UpsertNodeResult {
  row: NodeRow;
  created: boolean;
  /** Raw payload differs from the stored one. */
  changed: boolean;
  /** last_edited_time moved (or new). */
  edited: boolean;
  /** title or parent changed: dependent paths move. */
  pathChanged: boolean;
  /** Was tombstoned / inaccessible and is live again. */
  restored: boolean;
  /** Parent before this observation when it changed (the page moved away from it). */
  previousParent: { type: string | null; id: string | null } | null;
}

/**
 * Insert or refresh a node with the observed provider state. A live observation clears
 * a previous inaccessible mark; trash/archive state is part of the node and the caller
 * decides about tombstones (tombstoneNode / restore through this call with inTrash=false).
 */
export async function upsertNode(db: DbExecutor, scope: Scope, n: NodeInput, generation: number | null): Promise<UpsertNodeResult> {
  const before = await getNode(db, scope, n.id);
  const sha = contentSha(n.raw);
  const live = !n.inTrash && !n.isArchived;
  await db.execute(sql`
    INSERT INTO notion_source_nodes (tenant_id, row_key, connection_id, object_type, object_id, parent_type, parent_id, database_id, title, url,
      created_time, last_edited_time, in_trash, is_archived, is_locked, raw, raw_sha256, seen_generation, last_seen_at)
    VALUES (${scope.tenantId}, ${nodeRowKey(scope.connectionId, n.type, n.id)}, ${scope.connectionId}, ${n.type}, ${n.id}, ${n.parentType}, ${n.parentId}, ${n.databaseId},
      ${n.title}, ${n.url}, ${n.createdTime}::timestamptz, ${n.lastEditedTime}::timestamptz, ${n.inTrash}, ${n.isArchived}, ${n.isLocked},
      ${jsonParam(n.raw)}::jsonb, ${sha}, ${generation}, now())
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET
      parent_type = EXCLUDED.parent_type, parent_id = EXCLUDED.parent_id, database_id = EXCLUDED.database_id, title = EXCLUDED.title, url = EXCLUDED.url,
      created_time = EXCLUDED.created_time, last_edited_time = EXCLUDED.last_edited_time, in_trash = EXCLUDED.in_trash, is_archived = EXCLUDED.is_archived,
      is_locked = EXCLUDED.is_locked,
      raw = CASE WHEN notion_source_nodes.raw_sha256 = EXCLUDED.raw_sha256 THEN notion_source_nodes.raw ELSE EXCLUDED.raw END,
      raw_sha256 = EXCLUDED.raw_sha256,
      seen_generation = GREATEST(COALESCE(notion_source_nodes.seen_generation, 0), COALESCE(EXCLUDED.seen_generation, 0)),
      last_seen_at = now(),
      inaccessible_at = NULL, inaccessible_reason = NULL,
      tombstoned_at = CASE WHEN ${live} THEN NULL ELSE notion_source_nodes.tombstoned_at END,
      tombstone_reason = CASE WHEN ${live} THEN NULL ELSE notion_source_nodes.tombstone_reason END,
      updated_at = now()
  `);
  const row = (await getNode(db, scope, n.id))!;
  const wasGone = before ? before.tombstoned_at !== null || before.inaccessible_at !== null : false;
  return {
    row,
    created: !before,
    changed: !before || before.raw_sha256 !== sha,
    edited: !before || isoOrNull(before.last_edited_time) !== isoOrNull(n.lastEditedTime),
    pathChanged: !!before && (before.title !== n.title || before.parent_id !== n.parentId || before.parent_type !== n.parentType || before.database_id !== n.databaseId),
    restored: wasGone && live,
    previousParent: before && (before.parent_id !== n.parentId || before.parent_type !== n.parentType) ? { type: before.parent_type, id: before.parent_id } : null,
  };
}

export async function markNodeSeen(db: DbExecutor, scope: Scope, objectId: string, generation: number): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_nodes SET seen_generation = GREATEST(COALESCE(seen_generation, 0), ${generation}), last_seen_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id = ${objectId}
  `);
}

export async function setNodeFields(db: DbExecutor, scope: Scope, objectId: string, fields: {
  walkEpoch?: number;
  walkStartedAt?: Date | null;
  walkedAt?: Date | null;
  walkStatus?: string | null;
  walkError?: string | null;
  treeSha256?: string | null;
  bumpContentEpoch?: boolean;
  bumpRowsEpoch?: boolean;
  commentsStatus?: string | null;
  commentsCheckedAt?: Date | null;
  queryStatus?: string | null;
  queryCheckedAt?: Date | null;
  hydratedProperties?: Record<string, unknown> | null;
  propertiesStatus?: string | null;
}): Promise<void> {
  const sets: SQL[] = [];
  if (fields.walkEpoch !== undefined) sets.push(sql`walk_epoch = ${fields.walkEpoch}`);
  if (fields.walkStartedAt !== undefined) sets.push(sql`walk_started_at = ${isoOrNull(fields.walkStartedAt)}::timestamptz`);
  if (fields.walkedAt !== undefined) sets.push(sql`walked_at = ${isoOrNull(fields.walkedAt)}::timestamptz`);
  if (fields.walkStatus !== undefined) sets.push(sql`walk_status = ${fields.walkStatus}`);
  if (fields.walkError !== undefined) sets.push(sql`walk_error = ${fields.walkError}`);
  if (fields.treeSha256 !== undefined) sets.push(sql`tree_sha256 = ${fields.treeSha256}`);
  if (fields.bumpContentEpoch) sets.push(sql`content_epoch = content_epoch + 1`);
  if (fields.bumpRowsEpoch) sets.push(sql`rows_epoch = rows_epoch + 1`);
  if (fields.commentsStatus !== undefined) sets.push(sql`comments_status = ${fields.commentsStatus}`);
  if (fields.commentsCheckedAt !== undefined) sets.push(sql`comments_checked_at = ${isoOrNull(fields.commentsCheckedAt)}::timestamptz`);
  if (fields.queryStatus !== undefined) sets.push(sql`query_status = ${fields.queryStatus}`);
  if (fields.queryCheckedAt !== undefined) sets.push(sql`query_checked_at = ${isoOrNull(fields.queryCheckedAt)}::timestamptz`);
  if (fields.hydratedProperties !== undefined) {
    sets.push(sql`hydrated_properties = CASE WHEN hydrated_properties IS NOT DISTINCT FROM ${jsonParam(fields.hydratedProperties)}::jsonb THEN hydrated_properties ELSE ${jsonParam(fields.hydratedProperties)}::jsonb END`);
  }
  if (fields.propertiesStatus !== undefined) sets.push(sql`properties_status = ${fields.propertiesStatus}`);
  if (!sets.length) return;
  sets.push(sql`updated_at = now()`);
  await db.execute(sql`UPDATE notion_source_nodes SET ${sql.join(sets, sql`, `)} WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id = ${objectId}`);
}

/** Trash / archive / confirmed 404: readable paths go away, raw ledger stays. Returns true when newly tombstoned. */
export async function tombstoneNode(db: DbExecutor, scope: Scope, objectId: string, reason: string, at: Date = new Date()): Promise<boolean> {
  return rowsOf(await db.execute(sql`
    UPDATE notion_source_nodes SET tombstoned_at = ${at.toISOString()}::timestamptz, tombstone_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id = ${objectId}
      AND (tombstoned_at IS NULL OR tombstone_reason IS DISTINCT FROM ${reason})
    RETURNING 1
  `)).length > 0;
}

/** 403 restricted_resource on a node: kept (never treated as deleted), excluded from current paths. */
export async function markNodeInaccessible(db: DbExecutor, scope: Scope, objectId: string, reason: string): Promise<boolean> {
  return rowsOf(await db.execute(sql`
    UPDATE notion_source_nodes SET inaccessible_at = now(), inaccessible_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id = ${objectId} AND inaccessible_at IS NULL
    RETURNING 1
  `)).length > 0;
}

/**
 * Node ids of every descendant of `rootId` in the stored hierarchy (pages under pages or
 * under blocks of those pages, databases, their data sources, their rows), BFS, cycle-safe.
 */
export async function descendantIds(db: DbExecutor, scope: Scope, rootId: string, max = 100_000): Promise<string[]> {
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier = [rootId];
  while (frontier.length && out.length < max) {
    const ids = sql.join(frontier.map((id) => sql`${id}`), sql`, `);
    const kids = rowsOf<{ object_id: string }>(await db.execute(sql`
      SELECT object_id FROM notion_source_nodes n
      WHERE n.tenant_id = ${scope.tenantId} AND n.connection_id = ${scope.connectionId}
        AND (n.parent_id IN (${ids})
             OR (n.parent_type = 'block_id' AND n.parent_id IN (
                   SELECT b.block_id FROM notion_source_blocks b
                   WHERE b.tenant_id = ${scope.tenantId} AND b.connection_id = ${scope.connectionId} AND b.page_id IN (${ids}))))
    `));
    frontier = [];
    for (const k of kids) {
      if (seen.has(k.object_id)) continue;
      seen.add(k.object_id);
      out.push(k.object_id);
      frontier.push(k.object_id);
    }
  }
  return out;
}

/** Re-journal every descendant node and file (their readable paths depend on this node's path). */
export async function touchDescendants(db: DbExecutor, scope: Scope, rootId: string): Promise<number> {
  const ids = await descendantIds(db, scope, rootId);
  const all = [rootId, ...ids];
  for (let i = 0; i < all.length; i += 500) {
    const slice = sql.join(all.slice(i, i + 500).map((id) => sql`${id}`), sql`, `);
    if (i > 0 || ids.length) {
      await db.execute(sql`
        UPDATE notion_source_nodes SET path_epoch = path_epoch + 1, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_id IN (${slice}) AND object_id <> ${rootId}
      `);
    }
    await db.execute(sql`
      UPDATE notion_source_files SET path_epoch = path_epoch + 1, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id IN (${slice})
    `);
  }
  return ids.length;
}

// ------------------------------------------------------------------ blocks

export interface BlockInput {
  id: string;
  parentId: string;
  parentType: string | null;
  position: number;
  depth: number;
  type: string;
  hasChildren: boolean;
  lastEditedTime: string | null;
  raw: Record<string, unknown>;
}

export interface BlockRow {
  block_id: string;
  page_id: string;
  parent_id: string;
  parent_type: string | null;
  position: number;
  depth: number;
  block_type: string;
  has_children: boolean;
  raw_text: string;
  raw_sha256: string;
  last_edited_time: unknown;
  seen_epoch: number;
  comments_checked_at: unknown;
  tombstoned_at: unknown;
}

/** Store one listed page of children; returns ids whose payload or placement changed (incl. new ones). */
export async function upsertBlocks(db: DbExecutor, scope: Scope, pageId: string, epoch: number, blocks: readonly BlockInput[]): Promise<{ changed: string[]; created: string[] }> {
  const changed: string[] = [];
  const created: string[] = [];
  for (const b of blocks) {
    const sha = contentSha(b.raw);
    const r = rowsOf<{ inserted: boolean; old_sha: string | null; old_parent: string | null; old_pos: number | null; old_page: string | null; old_tomb: unknown }>(await db.execute(sql`
      WITH old AS (
        SELECT raw_sha256, parent_id, position, page_id, tombstoned_at FROM notion_source_blocks
        WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND block_id = ${b.id}
      ), up AS (
        INSERT INTO notion_source_blocks (tenant_id, connection_id, block_id, page_id, parent_id, parent_type, position, depth, block_type, has_children, raw, raw_sha256, last_edited_time, seen_epoch)
        VALUES (${scope.tenantId}, ${scope.connectionId}, ${b.id}, ${pageId}, ${b.parentId}, ${b.parentType}, ${b.position}, ${b.depth}, ${b.type}, ${b.hasChildren},
                ${jsonParam(b.raw)}::jsonb, ${sha}, ${b.lastEditedTime}::timestamptz, ${epoch})
        ON CONFLICT (tenant_id, connection_id, block_id) DO UPDATE SET
          page_id = EXCLUDED.page_id, parent_id = EXCLUDED.parent_id, parent_type = EXCLUDED.parent_type, position = EXCLUDED.position, depth = EXCLUDED.depth,
          block_type = EXCLUDED.block_type, has_children = EXCLUDED.has_children,
          raw = CASE WHEN notion_source_blocks.raw_sha256 = EXCLUDED.raw_sha256 THEN notion_source_blocks.raw ELSE EXCLUDED.raw END,
          raw_sha256 = EXCLUDED.raw_sha256, last_edited_time = EXCLUDED.last_edited_time, seen_epoch = EXCLUDED.seen_epoch,
          tombstoned_at = NULL, tombstone_reason = NULL, updated_at = now()
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM old) = 0 AS inserted, (SELECT raw_sha256 FROM old) AS old_sha, (SELECT parent_id FROM old) AS old_parent,
             (SELECT position FROM old) AS old_pos, (SELECT page_id FROM old) AS old_page, (SELECT tombstoned_at FROM old) AS old_tomb, (SELECT count(*) FROM up) AS n
    `))[0]!;
    await db.execute(sql`
      INSERT INTO notion_source_block_versions (tenant_id, connection_id, block_id, raw_sha256, raw)
      VALUES (${scope.tenantId}, ${scope.connectionId}, ${b.id}, ${sha}, ${jsonParam(b.raw)}::jsonb)
      ON CONFLICT DO NOTHING
    `);
    if (r.inserted) {
      created.push(b.id);
      changed.push(b.id);
    } else if (r.old_sha !== sha || r.old_parent !== b.parentId || Number(r.old_pos) !== b.position || r.old_page !== pageId || r.old_tomb !== null) {
      changed.push(b.id);
    }
  }
  return { changed, created };
}

/** Blocks of `pageId` not seen in walk `epoch` (removed from the page, moved out, or deleted). */
export async function tombstoneUnseenBlocks(db: DbExecutor, scope: Scope, pageId: string, epoch: number, reason: string): Promise<string[]> {
  return rowsOf<{ block_id: string }>(await db.execute(sql`
    UPDATE notion_source_blocks SET tombstoned_at = now(), tombstone_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId} AND seen_epoch < ${epoch} AND tombstoned_at IS NULL
    RETURNING block_id
  `)).map((r) => r.block_id);
}

export async function tombstonePageBlocks(db: DbExecutor, scope: Scope, pageId: string, reason: string): Promise<number> {
  return rowsOf(await db.execute(sql`
    UPDATE notion_source_blocks SET tombstoned_at = now(), tombstone_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId} AND tombstoned_at IS NULL
    RETURNING 1
  `)).length;
}

export async function listPageBlocks(db: DbExecutor, scope: Scope, pageId: string): Promise<BlockRow[]> {
  return rowsOf<BlockRow>(await db.execute(sql`
    SELECT block_id, page_id, parent_id, parent_type, position, depth, block_type, has_children, raw::text AS raw_text, raw_sha256, last_edited_time,
           seen_epoch, comments_checked_at, tombstoned_at
    FROM notion_source_blocks
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId} AND tombstoned_at IS NULL
    ORDER BY depth, parent_id, position, block_id
  `)).map((r) => ({ ...r, position: Number(r.position), depth: Number(r.depth), seen_epoch: Number(r.seen_epoch) }));
}

export async function getBlock(db: DbExecutor, scope: Scope, blockId: string): Promise<BlockRow | null> {
  return rowsOf<BlockRow>(await db.execute(sql`
    SELECT block_id, page_id, parent_id, parent_type, position, depth, block_type, has_children, raw::text AS raw_text, raw_sha256, last_edited_time,
           seen_epoch, comments_checked_at, tombstoned_at
    FROM notion_source_blocks WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND block_id = ${blockId}
  `))[0] ?? null;
}

export async function blockVersionTexts(db: DbExecutor, scope: Scope, refs: ReadonlyArray<{ id: string; sha: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < refs.length; i += 500) {
    const slice = refs.slice(i, i + 500);
    const rows = rowsOf<{ block_id: string; raw_sha256: string; raw_text: string }>(await db.execute(sql`
      SELECT block_id, raw_sha256, raw::text AS raw_text FROM notion_source_block_versions
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
        AND (block_id, raw_sha256) IN (${sql.join(slice.map((r) => sql`(${r.id}, ${r.sha})`), sql`, `)})
    `));
    for (const r of rows) out.set(`${r.block_id}\u0000${r.raw_sha256}`, r.raw_text);
  }
  return out;
}

export async function markBlockCommentsChecked(db: DbExecutor, scope: Scope, blockId: string): Promise<void> {
  await db.execute(sql`UPDATE notion_source_blocks SET comments_checked_at = now() WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND block_id = ${blockId}`);
}

// ------------------------------------------------------------------ comments

export interface CommentRow {
  comment_id: string;
  page_id: string;
  block_id: string | null;
  discussion_id: string | null;
  raw_text: string;
  raw_sha256: string;
  created_time: unknown;
  last_edited_time: unknown;
  status: string;
  missing_since: unknown;
  deleted_at: unknown;
  deleted_reason: string | null;
}

/** Store comments of one listing; returns ids that are new, edited or re-opened. */
export async function upsertComments(db: DbExecutor, scope: Scope, pageId: string, blockId: string | null, comments: ReadonlyArray<{ id: string; discussionId: string | null; createdTime: string | null; lastEditedTime: string | null; raw: Record<string, unknown> }>): Promise<string[]> {
  const changed: string[] = [];
  for (const c of comments) {
    const sha = contentSha(c.raw);
    const old = rowsOf<{ raw_sha256: string; status: string }>(await db.execute(sql`
      SELECT raw_sha256, status FROM notion_source_comments WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND comment_id = ${c.id}
    `))[0];
    await db.execute(sql`
      INSERT INTO notion_source_comments (tenant_id, connection_id, comment_id, page_id, block_id, discussion_id, raw, raw_sha256, created_time, last_edited_time, status)
      VALUES (${scope.tenantId}, ${scope.connectionId}, ${c.id}, ${pageId}, ${blockId}, ${c.discussionId}, ${jsonParam(c.raw)}::jsonb, ${sha},
              ${c.createdTime}::timestamptz, ${c.lastEditedTime}::timestamptz, 'open')
      ON CONFLICT (tenant_id, connection_id, comment_id) DO UPDATE SET
        page_id = EXCLUDED.page_id, block_id = EXCLUDED.block_id, discussion_id = EXCLUDED.discussion_id,
        raw = CASE WHEN notion_source_comments.raw_sha256 = EXCLUDED.raw_sha256 THEN notion_source_comments.raw ELSE EXCLUDED.raw END,
        raw_sha256 = EXCLUDED.raw_sha256, created_time = EXCLUDED.created_time, last_edited_time = EXCLUDED.last_edited_time,
        status = 'open', missing_since = NULL, deleted_at = NULL, deleted_reason = NULL, updated_at = now()
    `);
    if (!old || old.raw_sha256 !== sha || old.status !== "open") changed.push(c.id);
  }
  return changed;
}

/** Open comments of a listing target (page-level when blockId is null) that the latest complete listing did not return. */
export async function missingOpenComments(db: DbExecutor, scope: Scope, pageId: string, blockId: string | null, listed: ReadonlySet<string>): Promise<string[]> {
  const rows = rowsOf<{ comment_id: string }>(await db.execute(sql`
    SELECT comment_id FROM notion_source_comments
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId}
      AND ${blockId === null ? sql`block_id IS NULL` : sql`block_id = ${blockId}`} AND status = 'open'
  `));
  return rows.map((r) => r.comment_id).filter((id) => !listed.has(id));
}

export async function setCommentStatus(db: DbExecutor, scope: Scope, commentId: string, status: "resolved" | "deleted" | "open", reason: string | null, raw?: Record<string, unknown>): Promise<boolean> {
  const sha = raw ? contentSha(raw) : null;
  return rowsOf(await db.execute(sql`
    UPDATE notion_source_comments SET status = ${status},
      deleted_at = CASE WHEN ${status} = 'deleted' THEN COALESCE(deleted_at, now()) ELSE NULL END,
      deleted_reason = CASE WHEN ${status} = 'deleted' THEN ${reason} ELSE NULL END,
      missing_since = CASE WHEN ${status} = 'open' THEN NULL ELSE COALESCE(missing_since, now()) END,
      raw = CASE WHEN ${sha}::text IS NULL OR raw_sha256 = ${sha} THEN raw ELSE ${jsonParam(raw ?? null)}::jsonb END,
      raw_sha256 = COALESCE(${sha}, raw_sha256),
      updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND comment_id = ${commentId}
      AND (status IS DISTINCT FROM ${status} OR (${sha}::text IS NOT NULL AND raw_sha256 <> ${sha}))
    RETURNING 1
  `)).length > 0;
}

export async function getComment(db: DbExecutor, scope: Scope, commentId: string): Promise<CommentRow | null> {
  return rowsOf<CommentRow>(await db.execute(sql`
    SELECT comment_id, page_id, block_id, discussion_id, raw::text AS raw_text, raw_sha256, created_time, last_edited_time, status, missing_since, deleted_at, deleted_reason
    FROM notion_source_comments WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND comment_id = ${commentId}
  `))[0] ?? null;
}

export async function listPageComments(db: DbExecutor, scope: Scope, pageId: string): Promise<CommentRow[]> {
  return rowsOf<CommentRow>(await db.execute(sql`
    SELECT comment_id, page_id, block_id, discussion_id, raw::text AS raw_text, raw_sha256, created_time, last_edited_time, status, missing_since, deleted_at, deleted_reason
    FROM notion_source_comments WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND page_id = ${pageId}
    ORDER BY created_time NULLS LAST, comment_id
  `));
}

// ------------------------------------------------------------------ files

export interface FileRefInput {
  fileKey: string;
  ownerType: "block" | "page" | "data_source" | "database" | "comment";
  ownerId: string;
  pageId: string;
  slot: string;
  sourceType: string;
  name: string | null;
  urlHost: string | null;
  urlPath: string | null;
  fileUploadId: string | null;
  ownerLastEditedTime: string | null;
}

export interface FileRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  file_key: string;
  owner_type: string;
  owner_id: string;
  page_id: string;
  slot: string;
  source_type: string;
  name: string | null;
  url_host: string | null;
  url_path: string | null;
  file_upload_id: string | null;
  status: string;
  sha256: string | null;
  size: number | null;
  media_type: string | null;
  error: string | null;
  attempts: number;
  owner_last_edited_time: unknown;
  fetched_at: unknown;
  tombstoned_at: unknown;
  tombstone_reason: string | null;
  path_epoch: number;
  first_captured_at: unknown;
  updated_at: unknown;
}

/**
 * Record a file reference. Returns whether its bytes must be (re)fetched: Notion-hosted
 * files that are not stored yet or whose stable location (host + path) changed.
 */
export async function upsertFileRef(db: DbExecutor, scope: Scope, f: FileRefInput): Promise<{ row: FileRow; needsFetch: boolean }> {
  const fetchable = f.sourceType === "file";
  const initial = fetchable ? "pending" : f.sourceType === "external" ? "external" : "unsupported";
  await db.execute(sql`
    INSERT INTO notion_source_files (tenant_id, row_key, connection_id, file_key, owner_type, owner_id, page_id, slot, source_type, name, url_host, url_path,
      file_upload_id, status, owner_last_edited_time)
    VALUES (${scope.tenantId}, ${fileRowKey(scope.connectionId, f.fileKey)}, ${scope.connectionId}, ${f.fileKey}, ${f.ownerType}, ${f.ownerId}, ${f.pageId}, ${f.slot},
      ${f.sourceType}, ${f.name}, ${f.urlHost}, ${f.urlPath}, ${f.fileUploadId}, ${initial}, ${f.ownerLastEditedTime}::timestamptz)
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET
      owner_type = EXCLUDED.owner_type, owner_id = EXCLUDED.owner_id, page_id = EXCLUDED.page_id, slot = EXCLUDED.slot, name = EXCLUDED.name,
      file_upload_id = EXCLUDED.file_upload_id, owner_last_edited_time = EXCLUDED.owner_last_edited_time,
      status = CASE
        WHEN notion_source_files.source_type IS DISTINCT FROM EXCLUDED.source_type
          OR notion_source_files.url_host IS DISTINCT FROM EXCLUDED.url_host
          OR notion_source_files.url_path IS DISTINCT FROM EXCLUDED.url_path THEN EXCLUDED.status
        ELSE notion_source_files.status END,
      attempts = CASE
        WHEN notion_source_files.url_path IS DISTINCT FROM EXCLUDED.url_path THEN 0 ELSE notion_source_files.attempts END,
      source_type = EXCLUDED.source_type, url_host = EXCLUDED.url_host, url_path = EXCLUDED.url_path,
      tombstoned_at = NULL, tombstone_reason = NULL, updated_at = now()
  `);
  const row = (await getFile(db, scope.tenantId, fileRowKey(scope.connectionId, f.fileKey)))!;
  return { row, needsFetch: fetchable && (row.status === "pending" || row.status === "failed") };
}

export async function getFile(db: DbExecutor, tenantId: string, rowKey: string): Promise<FileRow | null> {
  const r = rowsOf<FileRow>(await db.execute(sql`SELECT * FROM notion_source_files WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? { ...r, size: r.size === null ? null : Number(r.size), attempts: Number(r.attempts), path_epoch: Number(r.path_epoch) } : null;
}

export async function listFiles(db: DbExecutor, scope: Scope, f: { pageId?: string; live?: boolean; ownerIds?: readonly string[] } = {}): Promise<FileRow[]> {
  const conds: SQL[] = [sql`tenant_id = ${scope.tenantId}`, sql`connection_id = ${scope.connectionId}`];
  if (f.pageId !== undefined) conds.push(sql`page_id = ${f.pageId}`);
  if (f.live) conds.push(sql`tombstoned_at IS NULL`);
  if (f.ownerIds) {
    if (!f.ownerIds.length) return [];
    conds.push(sql`owner_id IN (${sql.join(f.ownerIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  return rowsOf<FileRow>(await db.execute(sql`SELECT * FROM notion_source_files WHERE ${sql.join(conds, sql` AND `)} ORDER BY file_key`)).map((r) => ({ ...r, size: r.size === null ? null : Number(r.size), attempts: Number(r.attempts) }));
}

export async function setFileStored(db: DbExecutor, tenantId: string, rowKey: string, blob: { sha256: string; size: number; mediaType: string | null }): Promise<void> {
  await db.execute(sql`
    UPDATE notion_source_files SET status = 'stored', sha256 = ${blob.sha256}, size = ${blob.size}, media_type = ${blob.mediaType}, error = NULL, fetched_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}
  `);
}

export async function setFileFailed(db: DbExecutor, tenantId: string, rowKey: string, status: "failed" | "too_large" | "host_refused", error: string): Promise<number> {
  const r = rowsOf<{ attempts: number }>(await db.execute(sql`
    UPDATE notion_source_files SET status = ${status}, error = ${error.slice(0, 1000)}, attempts = attempts + 1, updated_at = now()
    WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}
    RETURNING attempts
  `))[0];
  return Number(r?.attempts ?? 0);
}

/** Files whose owner (block / page slot) is no longer referenced. */
export async function tombstoneFiles(db: DbExecutor, scope: Scope, where: { pageId: string; keepKeys?: ReadonlySet<string>; ownerIds?: readonly string[] }, reason: string): Promise<number> {
  const rows = await listFiles(db, scope, { pageId: where.pageId, live: true, ownerIds: where.ownerIds });
  let n = 0;
  for (const r of rows) {
    if (where.keepKeys?.has(r.file_key)) continue;
    await db.execute(sql`UPDATE notion_source_files SET tombstoned_at = now(), tombstone_reason = ${reason}, updated_at = now() WHERE tenant_id = ${scope.tenantId} AND row_key = ${r.row_key}`);
    n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ records (append-only ledger)

export interface RecordRow {
  tenant_id: string;
  row_key: string;
  connection_id: string;
  object_type: string;
  object_id: string;
  record_kind: string;
  raw: Record<string, unknown>;
  raw_text: string;
  raw_sha256: string;
  endpoint: string | null;
  observed_at: unknown;
}

export function recordRowKey(connectionId: string, objectType: string, objectId: string, kind: string, sha: string): string {
  return `${keySeg(connectionId)}/${objectType}/${keySeg(objectId)}/${kind}/${sha.slice(0, 32)}`;
}

/** Append a distinct payload to the ledger (no-op when the same content was recorded before). Returns true when new. */
export async function insertRecord(db: DbExecutor, scope: Scope, objectType: string, objectId: string, kind: "observation" | "tree", raw: Record<string, unknown>, endpoint: string | null, sha = contentSha(raw)): Promise<boolean> {
  return rowsOf(await db.execute(sql`
    INSERT INTO notion_source_records (tenant_id, row_key, connection_id, object_type, object_id, record_kind, raw, raw_sha256, endpoint)
    VALUES (${scope.tenantId}, ${recordRowKey(scope.connectionId, objectType, objectId, kind, sha)}, ${scope.connectionId}, ${objectType}, ${objectId}, ${kind},
            ${jsonParam(raw)}::jsonb, ${sha}, ${endpoint})
    ON CONFLICT (tenant_id, row_key) DO NOTHING
    RETURNING 1
  `)).length > 0;
}

export async function getRecord(db: DbExecutor, tenantId: string, rowKey: string): Promise<RecordRow | null> {
  const r = rowsOf<RecordRow>(await db.execute(sql`SELECT *, raw::text AS raw_text FROM notion_source_records WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? { ...r, raw: (typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw) as Record<string, unknown> } : null;
}

export async function recordTextsBySha(db: DbExecutor, scope: Scope, objectType: string, refs: ReadonlyArray<{ id: string; sha: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < refs.length; i += 500) {
    const slice = refs.slice(i, i + 500);
    const rows = rowsOf<{ object_id: string; raw_sha256: string; raw_text: string }>(await db.execute(sql`
      SELECT object_id, raw_sha256, raw::text AS raw_text FROM notion_source_records
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND object_type = ${objectType} AND record_kind = 'observation'
        AND (object_id, raw_sha256) IN (${sql.join(slice.map((r) => sql`(${r.id}, ${r.sha})`), sql`, `)})
    `));
    for (const r of rows) out.set(`${r.object_id}\u0000${r.raw_sha256}`, r.raw_text);
  }
  return out;
}

// ------------------------------------------------------------------ bytes

export interface BlobRow {
  sha256: string;
  size: number;
  chunks: Array<{ sha256: string; size: number }>;
  media_type: string | null;
}

/** Streams file bytes into <= 8 MiB chunks (per tenant, content-addressed). */
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
      this.#pending.push(Buffer.from(rest.subarray(0, take)));
      this.#pendingSize += take;
      rest = rest.subarray(take);
      if (this.#pendingSize === CHUNK_BYTES) await this.#flush();
    }
  }

  async finish(sha256: string, size: number, mediaType: string | null): Promise<BlobRow> {
    if (this.#pendingSize > 0 || this.chunks.length === 0) await this.#flush();
    const total = this.chunks.reduce((n, c) => n + c.size, 0);
    if (total !== size) throw new Error(`file byte count mismatch (${total} != ${size})`);
    await this.db.execute(sql`
      INSERT INTO notion_source_blobs (tenant_id, sha256, size, chunks, media_type)
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
      INSERT INTO notion_source_chunks (tenant_id, chunk_sha256, size, bytes)
      VALUES (${this.tenantId}, ${sha}, ${bytes.length}, ${bytes})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    this.chunks.push({ sha256: sha, size: bytes.length });
  }
}

export async function getBlob(db: DbExecutor, tenantId: string, sha256: string): Promise<BlobRow | null> {
  const r = rowsOf<{ sha256: string; size: unknown; chunks: unknown; media_type: string | null }>(
    await db.execute(sql`SELECT sha256, size, chunks, media_type FROM notion_source_blobs WHERE tenant_id = ${tenantId} AND sha256 = ${sha256}`),
  )[0];
  if (!r) return null;
  const chunks = (typeof r.chunks === "string" ? JSON.parse(r.chunks) : r.chunks) as Array<{ sha256: string; size: number }>;
  return { sha256: r.sha256, size: Number(r.size), chunks: chunks.map((c) => ({ sha256: c.sha256, size: Number(c.size) })), media_type: r.media_type };
}

export async function loadChunk(db: DbExecutor, tenantId: string, chunkSha256: string): Promise<Buffer> {
  const r = rowsOf<{ bytes: unknown }>(
    await db.execute(sql`SELECT bytes FROM notion_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha256}`),
  )[0];
  if (!r) throw new Error(`notion chunk ${chunkSha256} is missing`);
  const b = r.bytes;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (typeof b === "string" && b.startsWith("\\x")) return Buffer.from(b.slice(2), "hex");
  throw new Error("unexpected bytea encoding");
}

// ------------------------------------------------------------------ quota

export async function quotaBlockedUntil(db: DbExecutor, keys: readonly string[]): Promise<Date | null> {
  if (!keys.length) return null;
  const r = rowsOf<{ until: unknown }>(await db.execute(sql`
    SELECT max(blocked_until) AS until FROM notion_source_quota
    WHERE quota_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) AND blocked_until > now()
  `))[0];
  return toDate(r?.until);
}

/** Persist a cooldown: Retry-After when given, else exponential backoff from `defaultBackoffMs` (capped at 1h). */
export async function recordRateLimited(db: DbExecutor, quotaKey: string, input: { retryAfterMs: number | null; status: number; reason: string; defaultBackoffMs: number }): Promise<Date> {
  const r = rowsOf<{ until: unknown }>(await db.execute(sql`
    INSERT INTO notion_source_quota (quota_key, blocked_until, rate_limit_streak, last_status, last_retry_after_ms, last_reason)
    VALUES (${quotaKey}, now() + make_interval(secs => ${(input.retryAfterMs ?? input.defaultBackoffMs) / 1000}), 1, ${input.status}, ${input.retryAfterMs}, ${input.reason.slice(0, 500)})
    ON CONFLICT (quota_key) DO UPDATE SET
      rate_limit_streak = notion_source_quota.rate_limit_streak + 1,
      blocked_until = GREATEST(COALESCE(notion_source_quota.blocked_until, now()), now() + make_interval(secs => (
        CASE WHEN ${input.retryAfterMs}::bigint IS NOT NULL THEN ${input.retryAfterMs ?? 0}::bigint
             ELSE LEAST(3600000, ${input.defaultBackoffMs}::bigint * (2 ^ LEAST(notion_source_quota.rate_limit_streak, 7))::bigint) END) / 1000.0)),
      last_status = EXCLUDED.last_status, last_retry_after_ms = EXCLUDED.last_retry_after_ms, last_reason = EXCLUDED.last_reason, updated_at = now()
    RETURNING blocked_until AS until
  `))[0];
  return toDate(r?.until) ?? new Date(Date.now() + (input.retryAfterMs ?? input.defaultBackoffMs));
}

export async function clearRateStreak(db: DbExecutor, keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  await db.execute(sql`UPDATE notion_source_quota SET rate_limit_streak = 0, updated_at = now() WHERE quota_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) AND rate_limit_streak <> 0`);
}

export async function acquireQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return rowsOf(await db.execute(sql`
    INSERT INTO notion_source_quota (quota_key, lease_owner, lease_until) VALUES (${quotaKey}, ${owner}, now() + make_interval(secs => ${leaseSeconds}))
    ON CONFLICT (quota_key) DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = now()
      WHERE notion_source_quota.lease_until IS NULL OR notion_source_quota.lease_until < now() OR notion_source_quota.lease_owner = ${owner}
    RETURNING 1
  `)).length > 0;
}

export async function renewQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return rowsOf(await db.execute(sql`
    UPDATE notion_source_quota SET lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
    WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}
    RETURNING 1
  `)).length > 0;
}

export async function releaseQuotaLease(db: DbExecutor, quotaKey: string, owner: string): Promise<void> {
  await db.execute(sql`UPDATE notion_source_quota SET lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}`);
}
