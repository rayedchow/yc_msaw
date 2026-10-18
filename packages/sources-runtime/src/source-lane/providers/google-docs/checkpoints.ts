/**
 * Durable per-file checkpoints for the Docs/Drive source lane
 * (`gdocs_file_checkpoints`, migration 9100). One row per (tenant, Drive file).
 *
 * Only `db.execute(sql)` is used so these helpers run on postgres-js, PGlite,
 * and the donor tests' mocked `db` (where an empty result means "no prior
 * state" and every caller degrades to the donor's original behaviour).
 */
import { sql } from "drizzle-orm";
import { resolveDb, rowsOf, type SqlDatabase, type StoreDeps } from "./store.js";

export type ContentState = "pending" | "complete" | "partial" | "blocked" | "error" | "unsupported";
export type HistoryState = "pending" | "complete" | "partial" | "blocked" | "error" | "not_applicable";
export type LifecycleState = "active" | "trashed" | "removed";

export interface FileCheckpoint {
  tenantId: string;
  fileId: string;
  mailbox: string | null;
  mimeType: string | null;
  name: string | null;
  parents: string[] | null;
  exportDirectory: string | null;
  driveVersion: string | null;
  driveModifiedAt: string | null;
  contentState: ContentState;
  contentReason: string | null;
  contentVersion: string | null;
  contentExportedAt: string | null;
  contentRetryAt: string | null;
  contentAttempts: number;
  historyState: HistoryState;
  historyReason: string | null;
  historyCompleteEntries: number;
  historyCompleteAt: string | null;
  historyFetchedEntries: number | null;
  historyAttemptedAt: string | null;
  historyRetryAt: string | null;
  historyAttempts: number;
  lifecycleState: LifecycleState;
  lifecycleKind: string | null;
  lifecycleGeneration: number;
  lifecycleChangedAt: string | null;
  rematerializePending: boolean;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalize(row: Record<string, unknown>): FileCheckpoint {
  const parents = typeof row.parents === "string" ? JSON.parse(row.parents) : row.parents;
  return {
    tenantId: String(row.tenant_id),
    fileId: String(row.file_id),
    mailbox: (row.mailbox as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    parents: Array.isArray(parents) ? parents.map(String) : null,
    exportDirectory: (row.export_directory as string | null) ?? null,
    driveVersion: (row.drive_version as string | null) ?? null,
    driveModifiedAt: iso(row.drive_modified_at),
    contentState: (row.content_state as ContentState) ?? "pending",
    contentReason: (row.content_reason as string | null) ?? null,
    contentVersion: (row.content_version as string | null) ?? null,
    contentExportedAt: iso(row.content_exported_at),
    contentRetryAt: iso(row.content_retry_at),
    contentAttempts: Number(row.content_attempts ?? 0),
    historyState: (row.history_state as HistoryState) ?? "pending",
    historyReason: (row.history_reason as string | null) ?? null,
    historyCompleteEntries: Number(row.history_complete_entries ?? 0),
    historyCompleteAt: iso(row.history_complete_at),
    historyFetchedEntries: row.history_fetched_entries == null ? null : Number(row.history_fetched_entries),
    historyAttemptedAt: iso(row.history_attempted_at),
    historyRetryAt: iso(row.history_retry_at),
    historyAttempts: Number(row.history_attempts ?? 0),
    lifecycleState: (row.lifecycle_state as LifecycleState) ?? "active",
    lifecycleKind: (row.lifecycle_kind as string | null) ?? null,
    lifecycleGeneration: Number(row.lifecycle_generation ?? 0),
    lifecycleChangedAt: iso(row.lifecycle_changed_at),
    rematerializePending: row.rematerialize_pending === true,
  };
}

export async function getCheckpoint(tenantId: string, fileId: string, deps?: StoreDeps): Promise<FileCheckpoint | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_file_checkpoints WHERE tenant_id = ${tenantId} AND file_id = ${fileId}
  `));
  return row ? normalize(row) : null;
}

export interface DriveFileSeen {
  fileId: string;
  mailbox: string | null;
  mimeType: string;
  name: string | null;
  parents?: string[] | null;
  /** headRevisionId ?? md5Checksum ?? modifiedTime. */
  version: string | null;
  modifiedTime: string | null;
}

/**
 * Record that the changes feed saw a live file version. A newer version resets
 * content state to `pending` (re-export needed); an older/out-of-order change
 * (modifiedTime before the stored one) never rolls the checkpoint back.
 */
export async function recordDriveFileSeen(tenantId: string, seen: DriveFileSeen, deps?: StoreDeps): Promise<void> {
  const db = await resolveDb(deps);
  await db.execute(sql`
    INSERT INTO gdocs_file_checkpoints (
      tenant_id, file_id, mailbox, mime_type, name, parents, drive_version, drive_modified_at, drive_seen_at, updated_at
    ) VALUES (
      ${tenantId}, ${seen.fileId}, ${seen.mailbox}, ${seen.mimeType}, ${seen.name},
      ${seen.parents ? JSON.stringify(seen.parents) : null}::jsonb, ${seen.version}, ${seen.modifiedTime}::timestamptz, now(), now()
    )
    ON CONFLICT (tenant_id, file_id) DO UPDATE SET
      mailbox = COALESCE(EXCLUDED.mailbox, gdocs_file_checkpoints.mailbox),
      mime_type = EXCLUDED.mime_type,
      name = CASE WHEN gdocs_file_checkpoints.drive_modified_at IS NULL OR EXCLUDED.drive_modified_at IS NULL
                    OR EXCLUDED.drive_modified_at >= gdocs_file_checkpoints.drive_modified_at
                  THEN COALESCE(EXCLUDED.name, gdocs_file_checkpoints.name) ELSE gdocs_file_checkpoints.name END,
      parents = CASE WHEN gdocs_file_checkpoints.drive_modified_at IS NULL OR EXCLUDED.drive_modified_at IS NULL
                       OR EXCLUDED.drive_modified_at >= gdocs_file_checkpoints.drive_modified_at
                     THEN COALESCE(EXCLUDED.parents, gdocs_file_checkpoints.parents) ELSE gdocs_file_checkpoints.parents END,
      content_state = CASE
        WHEN EXCLUDED.drive_version IS DISTINCT FROM gdocs_file_checkpoints.drive_version
         AND (gdocs_file_checkpoints.drive_modified_at IS NULL OR EXCLUDED.drive_modified_at IS NULL
              OR EXCLUDED.drive_modified_at >= gdocs_file_checkpoints.drive_modified_at)
        THEN 'pending' ELSE gdocs_file_checkpoints.content_state END,
      drive_version = CASE WHEN gdocs_file_checkpoints.drive_modified_at IS NULL OR EXCLUDED.drive_modified_at IS NULL
                             OR EXCLUDED.drive_modified_at >= gdocs_file_checkpoints.drive_modified_at
                           THEN EXCLUDED.drive_version ELSE gdocs_file_checkpoints.drive_version END,
      drive_modified_at = GREATEST(gdocs_file_checkpoints.drive_modified_at, EXCLUDED.drive_modified_at),
      drive_seen_at = now(),
      updated_at = now()
  `);
}

export async function setExportDirectory(
  tenantId: string,
  fileId: string,
  directory: string,
  deps?: StoreDeps,
  meta: { mimeType?: string | null; name?: string | null } = {},
): Promise<void> {
  const db = await resolveDb(deps);
  await db.execute(sql`
    INSERT INTO gdocs_file_checkpoints (tenant_id, file_id, export_directory, mime_type, name, updated_at)
    VALUES (${tenantId}, ${fileId}, ${directory}, ${meta.mimeType ?? null}, ${meta.name ?? null}, now())
    ON CONFLICT (tenant_id, file_id) DO UPDATE SET
      export_directory = EXCLUDED.export_directory,
      mime_type = COALESCE(gdocs_file_checkpoints.mime_type, EXCLUDED.mime_type),
      name = COALESCE(EXCLUDED.name, gdocs_file_checkpoints.name),
      updated_at = now()
  `);
}

export async function setContentState(
  tenantId: string,
  fileId: string,
  update: { state: ContentState; reason?: string | null; version?: string | null; retryAt?: Date | null },
  deps?: StoreDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  const exported = update.state === "complete";
  await db.execute(sql`
    INSERT INTO gdocs_file_checkpoints (tenant_id, file_id, content_state, content_reason, content_version,
      content_exported_at, content_retry_at, content_attempts, updated_at)
    VALUES (${tenantId}, ${fileId}, ${update.state}, ${update.reason ?? null}, ${update.version ?? null},
      ${exported ? new Date().toISOString() : null}::timestamptz, ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz, 1, now())
    ON CONFLICT (tenant_id, file_id) DO UPDATE SET
      content_state = EXCLUDED.content_state,
      content_reason = EXCLUDED.content_reason,
      content_version = COALESCE(EXCLUDED.content_version, gdocs_file_checkpoints.content_version),
      content_exported_at = COALESCE(EXCLUDED.content_exported_at, gdocs_file_checkpoints.content_exported_at),
      content_retry_at = EXCLUDED.content_retry_at,
      content_attempts = CASE WHEN EXCLUDED.content_state = 'complete' THEN 0 ELSE gdocs_file_checkpoints.content_attempts + 1 END,
      updated_at = now()
  `);
}

/**
 * History (OT changelog) checkpoint. `completeEntries` only advances when the
 * caller passes it (a COMPLETE capture); partial/blocked/error results keep
 * the last complete count, record what was fetched, and schedule a retry.
 */
export async function setHistoryState(
  tenantId: string,
  fileId: string,
  update: {
    state: HistoryState;
    reason?: string | null;
    completeEntries?: number | null;
    fetchedEntries?: number | null;
    retryAt?: Date | null;
  },
  deps?: StoreDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  // Callers pass completeEntries ONLY for a complete changelog capture (the
  // history state itself may still be `pending` while recent sessions settle).
  const complete = update.completeEntries != null;
  await db.execute(sql`
    INSERT INTO gdocs_file_checkpoints (tenant_id, file_id, history_state, history_reason, history_complete_entries,
      history_complete_at, history_fetched_entries, history_attempted_at, history_retry_at, history_attempts, updated_at)
    VALUES (${tenantId}, ${fileId}, ${update.state}, ${update.reason ?? null}, ${complete ? update.completeEntries! : 0},
      ${complete ? new Date().toISOString() : null}::timestamptz, ${update.fetchedEntries ?? null}, now(),
      ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz, 1, now())
    ON CONFLICT (tenant_id, file_id) DO UPDATE SET
      history_state = EXCLUDED.history_state,
      history_reason = EXCLUDED.history_reason,
      history_complete_entries = CASE WHEN ${complete}::boolean THEN EXCLUDED.history_complete_entries ELSE gdocs_file_checkpoints.history_complete_entries END,
      history_complete_at = CASE WHEN ${complete}::boolean THEN EXCLUDED.history_complete_at ELSE gdocs_file_checkpoints.history_complete_at END,
      history_fetched_entries = EXCLUDED.history_fetched_entries,
      history_attempted_at = now(),
      history_retry_at = EXCLUDED.history_retry_at,
      history_attempts = CASE WHEN EXCLUDED.history_state IN ('complete', 'not_applicable') THEN 0 ELSE gdocs_file_checkpoints.history_attempts + 1 END,
      updated_at = now()
  `);
}

export interface LifecycleTransition {
  /** Generation of the dead episode this change belongs to (1 = first ever). */
  generation: number;
  previousState: LifecycleState | null;
  state: LifecycleState;
  /** True when this call changed the state (a real transition, not a repeat). */
  changed: boolean;
}

/**
 * Atomic lifecycle transition. Each active -> trashed|removed transition opens
 * a new dead episode (generation + 1); a repeat delivery of the same state, or
 * trashed -> removed inside one episode, keeps the generation. dead -> active
 * is a restore. Returns null when no checkpoint row could be read (mocked db),
 * in which case callers keep the donor's legacy single-tombstone keying.
 */
export async function transitionLifecycle(
  tenantId: string,
  fileId: string,
  next: LifecycleState,
  meta: { mailbox?: string | null; name?: string | null; mimeType?: string | null; kind?: string | null } = {},
  deps?: StoreDeps,
): Promise<LifecycleTransition | null> {
  const db = await resolveDb(deps);
  const run = async (tx: { execute: typeof db.execute }): Promise<LifecycleTransition | null> => {
    // Lock + read the previous state first (a FOR UPDATE CTE in the same
    // statement as the upsert would skip the row the upsert modifies).
    const [prev] = rowsOf<{ lifecycle_state: LifecycleState }>(await tx.execute(sql`
      SELECT lifecycle_state FROM gdocs_file_checkpoints
      WHERE tenant_id = ${tenantId} AND file_id = ${fileId}
      FOR UPDATE
    `));
    const [row] = rowsOf<{ generation: number | string; state: LifecycleState }>(await tx.execute(sql`
      INSERT INTO gdocs_file_checkpoints (tenant_id, file_id, mailbox, name, mime_type, lifecycle_state, lifecycle_kind,
        lifecycle_generation, lifecycle_changed_at, updated_at)
      VALUES (${tenantId}, ${fileId}, ${meta.mailbox ?? null}, ${meta.name ?? null}, ${meta.mimeType ?? null}, ${next}, ${meta.kind ?? null},
        ${next === "active" ? 0 : 1}, now(), now())
      ON CONFLICT (tenant_id, file_id) DO UPDATE SET
        lifecycle_generation = CASE
          WHEN gdocs_file_checkpoints.lifecycle_state = 'active' AND EXCLUDED.lifecycle_state <> 'active'
          THEN gdocs_file_checkpoints.lifecycle_generation + 1
          ELSE gdocs_file_checkpoints.lifecycle_generation END,
        lifecycle_changed_at = CASE WHEN gdocs_file_checkpoints.lifecycle_state <> EXCLUDED.lifecycle_state
          THEN now() ELSE gdocs_file_checkpoints.lifecycle_changed_at END,
        rematerialize_pending = CASE
          WHEN gdocs_file_checkpoints.lifecycle_state <> 'active' AND EXCLUDED.lifecycle_state = 'active' THEN true
          ELSE gdocs_file_checkpoints.rematerialize_pending END,
        content_state = CASE
          WHEN gdocs_file_checkpoints.lifecycle_state <> 'active' AND EXCLUDED.lifecycle_state = 'active' THEN 'pending'
          ELSE gdocs_file_checkpoints.content_state END,
        lifecycle_state = EXCLUDED.lifecycle_state,
        lifecycle_kind = COALESCE(EXCLUDED.lifecycle_kind, gdocs_file_checkpoints.lifecycle_kind),
        mailbox = COALESCE(EXCLUDED.mailbox, gdocs_file_checkpoints.mailbox),
        mime_type = COALESCE(gdocs_file_checkpoints.mime_type, EXCLUDED.mime_type),
        updated_at = now()
      RETURNING lifecycle_generation AS generation, lifecycle_state AS state
    `));
    if (!row) return null;
    const previousState = prev?.lifecycle_state ?? null;
    return {
      generation: Number(row.generation),
      previousState,
      state: row.state,
      changed: previousState !== row.state,
    };
  };
  // Donor-test mocks have no transaction(); they also return no rows, which
  // yields null (legacy keying) either way.
  return typeof (db as Partial<SqlDatabase>).transaction === "function" ? db.transaction(run) : run(db);
}

export async function clearRematerializePending(tenantId: string, fileId: string, deps?: StoreDeps): Promise<void> {
  const db = await resolveDb(deps);
  await db.execute(sql`
    UPDATE gdocs_file_checkpoints SET rematerialize_pending = false, updated_at = now()
    WHERE tenant_id = ${tenantId} AND file_id = ${fileId}
  `);
}

/** Files whose content export or history capture is due for a retry. */
export async function listDueRetries(
  tenantId: string,
  now: Date,
  limit: number,
  deps?: StoreDeps,
  options: { includeDocs?: boolean } = {},
): Promise<FileCheckpoint[]> {
  const db = await resolveDb(deps);
  const includeDocs = options.includeDocs ?? true;
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_file_checkpoints
    WHERE tenant_id = ${tenantId}
      AND lifecycle_state = 'active'
      AND (${includeDocs}::boolean OR mime_type IS DISTINCT FROM 'application/vnd.google-apps.document')
      AND (
        (content_state IN ('pending', 'partial', 'error') AND (content_retry_at IS NULL OR content_retry_at <= ${now.toISOString()}::timestamptz))
        OR (history_state IN ('pending', 'partial', 'error') AND history_retry_at IS NOT NULL AND history_retry_at <= ${now.toISOString()}::timestamptz)
      )
    ORDER BY updated_at
    LIMIT ${limit}
  `)).map(normalize);
}

export async function listCheckpoints(tenantId: string, deps?: StoreDeps): Promise<FileCheckpoint[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_file_checkpoints WHERE tenant_id = ${tenantId} ORDER BY file_id
  `)).map(normalize);
}

/** Exponential backoff with Retry-After as the floor (seconds). */
export function retryDelaySeconds(attempts: number, retryAfterSeconds?: number | null): number {
  const backoff = Math.min(6 * 60 * 60, 120 * 2 ** Math.min(Math.max(attempts, 0), 7));
  return Math.max(backoff, retryAfterSeconds ?? 0);
}
