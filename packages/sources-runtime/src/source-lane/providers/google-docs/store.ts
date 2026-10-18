/**
 * Google Docs/Drive source-lane file store (runtime side).
 *
 * Provider captures write exact bytes here; the source-lane exporter publishes
 * every `gdocs_source_file_versions` row, in id order, to the yc_msaw
 * SourceStore. Nothing here interprets content: bytes go in and come out
 * unchanged, chunked at 8 MiB (the SourceStore's chunk size) and addressed by
 * sha256.
 *
 * Version guard per path (deterministic, mirrors SourceStore apply rules):
 *   - same op + same sha as the head          => `unchanged` (repeat polls)
 *   - incoming source_order older than head    => `stale` (out-of-order polls)
 *   - otherwise                                => new version seq+1
 * Deletes never remove rows: they append a `delete` version so history stays.
 *
 * Every statement is tenant-scoped by `tenant_id`, which callers take from the
 * donor task's tenant (server-assigned), never from provider payloads.
 */
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

export const SOURCE_CHUNK_BYTES = 8 * 1024 * 1024;
export const GOOGLE_DOCS_PROVIDER_ID = "google-docs";
export const GOOGLE_DOCS_SOURCE_ROOT = `sources/${GOOGLE_DOCS_PROVIDER_ID}`;

export type SourceFileKind = "projection" | "raw" | "binary" | "tombstone";

/** The subset of a drizzle database (postgres-js or PGlite) this module uses. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}
export interface SqlDatabase extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface StoreDeps {
  db?: SqlDatabase;
}

let defaultDbPromise: Promise<SqlDatabase> | null = null;

export async function resolveDb(deps?: StoreDeps): Promise<SqlDatabase> {
  if (deps?.db) return deps.db;
  defaultDbPromise ??= import("../../../db/client.js").then((m) => m.db as unknown as SqlDatabase);
  return defaultDbPromise;
}

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface StoredBlob {
  sha256: string;
  size: number;
  chunks: string[];
}

// ---------------------------------------------------------------------------
// Path rules (same constraints the yc_msaw SourceStore enforces)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function assertSourcePath(path: string): void {
  const segments = path.split("/");
  if (segments.length < 3 || segments.length > 64) throw new Error(`invalid source path depth: ${path}`);
  if (segments[0] !== "sources" || segments[1] !== GOOGLE_DOCS_PROVIDER_ID) {
    throw new Error(`source path outside sources/${GOOGLE_DOCS_PROVIDER_ID}/: ${path}`);
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") throw new Error(`invalid source path segment in ${path}`);
    if (segment.includes("\\") || CONTROL_CHARS.test(segment)) throw new Error(`invalid character in source path ${path}`);
    if (Buffer.byteLength(segment, "utf8") > 255) throw new Error(`source path segment too long in ${path}`);
  }
}

/**
 * Make a provider identifier (tab id, image object id, file name) safe as one
 * path segment without losing identity: unsafe characters are replaced and a
 * short hash of the original is appended whenever anything was changed.
 */
export function safeSegment(value: string, fallback = "item"): string {
  const trimmed = value.trim();
  let out = trimmed
    .replace(/[/\\]/gu, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ");
  if (!out || out === "." || out === "..") out = fallback;
  if (Buffer.byteLength(out, "utf8") > 180) out = Buffer.from(out, "utf8").subarray(0, 180).toString("utf8").replace(/�+$/u, "");
  if (out !== trimmed) out = `${out}-${sha256Hex(Buffer.from(value, "utf8")).slice(0, 8)}`;
  return out;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

async function putChunk(tx: SqlExecutor, tenantId: string, bytes: Uint8Array): Promise<string> {
  const chunkSha = sha256Hex(bytes);
  await tx.execute(sql`
    INSERT INTO gdocs_source_chunks (tenant_id, chunk_sha256, size, bytes)
    VALUES (${tenantId}, ${chunkSha}, ${bytes.byteLength}, ${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)})
    ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
  `);
  return chunkSha;
}

async function recordBlob(tx: SqlExecutor, tenantId: string, blob: StoredBlob): Promise<void> {
  await tx.execute(sql`
    INSERT INTO gdocs_source_blobs (tenant_id, sha256, size, chunks)
    VALUES (${tenantId}, ${blob.sha256}, ${blob.size}, ${JSON.stringify(blob.chunks)}::jsonb)
    ON CONFLICT (tenant_id, sha256) DO NOTHING
  `);
}

/** Store an in-memory byte array exactly. */
export async function storeBytes(tenantId: string, bytes: Uint8Array, deps?: StoreDeps): Promise<StoredBlob> {
  const db = await resolveDb(deps);
  const chunks: string[] = [];
  if (bytes.byteLength === 0) chunks.push(await putChunk(db, tenantId, bytes));
  for (let offset = 0; offset < bytes.byteLength; offset += SOURCE_CHUNK_BYTES) {
    chunks.push(await putChunk(db, tenantId, bytes.subarray(offset, Math.min(bytes.byteLength, offset + SOURCE_CHUNK_BYTES))));
  }
  const blob = { sha256: sha256Hex(bytes), size: bytes.byteLength, chunks };
  await recordBlob(db, tenantId, blob);
  return blob;
}

export type StreamStoreResult =
  | ({ status: "stored" } & StoredBlob)
  | { status: "over_limit"; bytesRead: number; limit: number };

/**
 * Stream a response body into chunks without holding the whole file in
 * memory. Aborts (and stores no blob record) once `maxBytes` is crossed, so a
 * file above the explicit export limit is reported, never silently truncated.
 */
export async function storeStream(
  tenantId: string,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  deps?: StoreDeps,
): Promise<StreamStoreResult> {
  const db = await resolveDb(deps);
  const whole = createHash("sha256");
  const chunks: string[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;

  const flush = async (final: boolean) => {
    while (pendingBytes >= SOURCE_CHUNK_BYTES || (final && (pendingBytes > 0 || chunks.length === 0))) {
      const merged = Buffer.concat(pending);
      const take = Math.min(SOURCE_CHUNK_BYTES, merged.byteLength);
      chunks.push(await putChunk(db, tenantId, merged.subarray(0, take)));
      const rest = merged.subarray(take);
      pending = rest.byteLength > 0 ? [rest] : [];
      pendingBytes = rest.byteLength;
      if (final && pendingBytes === 0) break;
    }
  };

  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: "over_limit", bytesRead: total, limit: maxBytes };
      }
      whole.update(value);
      pending.push(value);
      pendingBytes += value.byteLength;
      await flush(false);
    }
  }
  await flush(true);
  const blob = { sha256: whole.digest("hex"), size: total, chunks };
  await recordBlob(db, tenantId, blob);
  return { status: "stored", ...blob };
}

export async function readChunk(tenantId: string, chunkSha: string, deps?: StoreDeps): Promise<Buffer> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<{ bytes: Uint8Array }>(await db.execute(sql`
    SELECT bytes FROM gdocs_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha}
  `));
  if (!row) throw new Error(`missing gdocs source chunk ${chunkSha}`);
  return Buffer.from(row.bytes);
}

/** Chunk sizes without reading bytes (lets the exporter stream large files chunk by chunk). */
export async function readChunkSizes(tenantId: string, chunks: string[], deps?: StoreDeps): Promise<number[]> {
  const db = await resolveDb(deps);
  const sizes: number[] = [];
  for (const chunk of chunks) {
    const [row] = rowsOf<{ size: number | string }>(await db.execute(sql`
      SELECT size FROM gdocs_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunk}
    `));
    if (!row) throw new Error(`missing gdocs source chunk ${chunk}`);
    sizes.push(Number(row.size));
  }
  return sizes;
}

export async function readBlobBytes(tenantId: string, chunks: string[], deps?: StoreDeps): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of chunks) parts.push(await readChunk(tenantId, chunk, deps));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Versioned files
// ---------------------------------------------------------------------------

export type PutOutcome = "created" | "updated" | "unchanged" | "stale";
export type DeleteOutcome = "deleted" | "absent" | "stale";

export interface SourceFileVersionMeta {
  tenantId: string;
  path: string;
  /** Provider identity (Drive file id) - survives renames/moves. */
  fileId: string;
  sourceVersion?: string | null;
  /** Monotonic ordering key (e.g. modifiedTime ms, changelog entry count). */
  sourceOrder?: number | null;
  sourceUpdatedAt?: string | Date | null;
  capturedAt?: string | Date;
  provenance?: Record<string, unknown>;
}

export interface PutSourceFileInput extends SourceFileVersionMeta {
  kind: Exclude<SourceFileKind, "tombstone">;
  contentType: string;
  bytes?: Uint8Array;
  blob?: StoredBlob;
}

interface HeadRow {
  seq: number;
  op: "put" | "delete";
  sha256: string | null;
  source_order: string | number | null;
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isStale(head: HeadRow | undefined, incoming: number | null | undefined): boolean {
  if (!head || head.source_order == null || incoming == null) return false;
  return Number(incoming) < Number(head.source_order);
}

async function lockHead(tx: SqlExecutor, tenantId: string, path: string): Promise<HeadRow | undefined> {
  const [head] = rowsOf<HeadRow>(await tx.execute(sql`
    SELECT seq, op, sha256, source_order FROM gdocs_source_file_heads
    WHERE tenant_id = ${tenantId} AND path = ${path}
    FOR UPDATE
  `));
  return head;
}

export async function putSourceFile(input: PutSourceFileInput, deps?: StoreDeps): Promise<PutOutcome> {
  assertSourcePath(input.path);
  const blob = input.blob ?? (input.bytes ? await storeBytes(input.tenantId, input.bytes, deps) : null);
  if (!blob) throw new Error(`putSourceFile ${input.path}: bytes or blob required`);
  const db = await resolveDb(deps);
  return db.transaction(async (tx) => {
    const head = await lockHead(tx, input.tenantId, input.path);
    if (isStale(head, input.sourceOrder)) return "stale";
    if (head && head.op === "put" && head.sha256 === blob.sha256) {
      // Same bytes: only advance the ordering key so later out-of-order
      // writes are still recognised as stale.
      if (input.sourceOrder != null && (head.source_order == null || Number(input.sourceOrder) > Number(head.source_order))) {
        await tx.execute(sql`
          UPDATE gdocs_source_file_heads SET source_order = ${input.sourceOrder}, updated_at = now()
          WHERE tenant_id = ${input.tenantId} AND path = ${input.path}
        `);
      }
      return "unchanged";
    }
    const seq = (head?.seq ?? 0) + 1;
    await tx.execute(sql`
      INSERT INTO gdocs_source_file_versions (
        tenant_id, path, seq, op, kind, content_type, sha256, size, chunks, file_id,
        source_version, source_order, source_updated_at, captured_at, provenance
      ) VALUES (
        ${input.tenantId}, ${input.path}, ${seq}, 'put', ${input.kind}, ${input.contentType},
        ${blob.sha256}, ${blob.size}, ${JSON.stringify(blob.chunks)}::jsonb, ${input.fileId},
        ${input.sourceVersion ?? null}, ${input.sourceOrder ?? null}, ${isoOrNull(input.sourceUpdatedAt)}::timestamptz,
        ${isoOrNull(input.capturedAt ?? new Date())}::timestamptz, ${JSON.stringify(input.provenance ?? {})}::jsonb
      )
    `);
    await tx.execute(sql`
      INSERT INTO gdocs_source_file_heads (tenant_id, path, file_id, seq, op, sha256, source_version, source_order, updated_at)
      VALUES (${input.tenantId}, ${input.path}, ${input.fileId}, ${seq}, 'put', ${blob.sha256}, ${input.sourceVersion ?? null}, ${input.sourceOrder ?? null}, now())
      ON CONFLICT (tenant_id, path) DO UPDATE SET
        file_id = EXCLUDED.file_id, seq = EXCLUDED.seq, op = EXCLUDED.op, sha256 = EXCLUDED.sha256,
        source_version = EXCLUDED.source_version,
        source_order = COALESCE(EXCLUDED.source_order, gdocs_source_file_heads.source_order),
        updated_at = now()
    `);
    return head ? "updated" : "created";
  });
}

export async function deleteSourceFile(
  input: SourceFileVersionMeta & { reason: string },
  deps?: StoreDeps,
): Promise<DeleteOutcome> {
  assertSourcePath(input.path);
  const db = await resolveDb(deps);
  return db.transaction(async (tx) => {
    const head = await lockHead(tx, input.tenantId, input.path);
    if (!head || head.op === "delete") return "absent";
    if (isStale(head, input.sourceOrder)) return "stale";
    const seq = head.seq + 1;
    await tx.execute(sql`
      INSERT INTO gdocs_source_file_versions (
        tenant_id, path, seq, op, kind, file_id, source_version, source_order,
        source_updated_at, captured_at, deleted_reason, provenance
      ) VALUES (
        ${input.tenantId}, ${input.path}, ${seq}, 'delete', 'tombstone', ${input.fileId},
        ${input.sourceVersion ?? null}, ${input.sourceOrder ?? null}, ${isoOrNull(input.sourceUpdatedAt)}::timestamptz,
        ${isoOrNull(input.capturedAt ?? new Date())}::timestamptz, ${input.reason}, ${JSON.stringify(input.provenance ?? {})}::jsonb
      )
    `);
    await tx.execute(sql`
      UPDATE gdocs_source_file_heads
      SET seq = ${seq}, op = 'delete', sha256 = NULL,
          source_order = COALESCE(${input.sourceOrder ?? null}, source_order), updated_at = now()
      WHERE tenant_id = ${input.tenantId} AND path = ${input.path}
    `);
    return "deleted";
  });
}

export interface LiveHead {
  path: string;
  seq: number;
  sha256: string;
}

/** Current (non-deleted) exported paths for one provider file. */
export async function listLiveHeads(tenantId: string, fileId: string, deps?: StoreDeps): Promise<LiveHead[]> {
  const db = await resolveDb(deps);
  return rowsOf<LiveHead>(await db.execute(sql`
    SELECT path, seq, sha256 FROM gdocs_source_file_heads
    WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND op = 'put'
    ORDER BY path
  `));
}

/**
 * Tombstone every live exported path of a file (trash/removal/access loss).
 * Optional `underDirectory` limits the sweep (used for moves).
 */
export async function deleteFileExports(
  input: { tenantId: string; fileId: string; reason: string; capturedAt?: string | Date; underDirectory?: string; keepPaths?: Set<string> },
  deps?: StoreDeps,
): Promise<number> {
  const heads = await listLiveHeads(input.tenantId, input.fileId, deps);
  let deleted = 0;
  for (const head of heads) {
    if (input.underDirectory && !head.path.startsWith(`${input.underDirectory}/`)) continue;
    if (input.keepPaths?.has(head.path)) continue;
    const outcome = await deleteSourceFile({
      tenantId: input.tenantId,
      path: head.path,
      fileId: input.fileId,
      reason: input.reason,
      capturedAt: input.capturedAt,
    }, deps);
    if (outcome === "deleted") deleted++;
  }
  return deleted;
}

/**
 * Re-home a file's exported tree after a rename (the export directory is
 * title-derived, like the donor mirror). The current bytes are re-put at the
 * new path (same blob, no re-fetch) and the old path gets a `moved` tombstone,
 * so the old path's history is kept and no stale copy stays live.
 */
export async function moveFileExports(
  input: { tenantId: string; fileId: string; fromDirectory: string; toDirectory: string; capturedAt?: string | Date },
  deps?: StoreDeps,
): Promise<number> {
  if (input.fromDirectory === input.toDirectory) return 0;
  const db = await resolveDb(deps);
  const rows = rowsOf<{
    path: string; kind: Exclude<SourceFileKind, "tombstone">; content_type: string; sha256: string; size: string | number;
    chunks: string[] | string; source_version: string | null; source_order: string | number | null;
    source_updated_at: string | Date | null; provenance: Record<string, unknown> | string;
  }>(await db.execute(sql`
    SELECT v.path, v.kind, v.content_type, v.sha256, v.size, v.chunks, v.source_version, v.source_order,
           v.source_updated_at, v.provenance
    FROM gdocs_source_file_heads h
    JOIN gdocs_source_file_versions v ON v.tenant_id = h.tenant_id AND v.path = h.path AND v.seq = h.seq
    WHERE h.tenant_id = ${input.tenantId} AND h.file_id = ${input.fileId} AND h.op = 'put'
      AND h.path LIKE ${`${input.fromDirectory}/%`}
    ORDER BY h.path
  `));
  let moved = 0;
  for (const row of rows) {
    const rel = row.path.slice(input.fromDirectory.length);
    const chunks = typeof row.chunks === "string" ? JSON.parse(row.chunks) as string[] : row.chunks;
    const provenance = typeof row.provenance === "string" ? JSON.parse(row.provenance) as Record<string, unknown> : row.provenance;
    await putSourceFile({
      tenantId: input.tenantId,
      path: `${input.toDirectory}${rel}`,
      fileId: input.fileId,
      kind: row.kind,
      contentType: row.content_type,
      blob: { sha256: row.sha256, size: Number(row.size), chunks },
      sourceVersion: row.source_version,
      sourceOrder: row.source_order == null ? null : Number(row.source_order),
      sourceUpdatedAt: row.source_updated_at,
      capturedAt: input.capturedAt,
      provenance: { ...provenance, movedFrom: row.path },
    }, deps);
    await deleteSourceFile({
      tenantId: input.tenantId,
      path: row.path,
      fileId: input.fileId,
      reason: "moved",
      capturedAt: input.capturedAt,
      provenance: { movedTo: `${input.toDirectory}${rel}` },
    }, deps);
    moved++;
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Exporter read side
// ---------------------------------------------------------------------------

export interface SourceFileVersionRow {
  id: string;
  tenantId: string;
  path: string;
  seq: number;
  op: "put" | "delete";
  kind: SourceFileKind;
  contentType: string | null;
  sha256: string | null;
  size: number | null;
  chunks: string[] | null;
  fileId: string;
  sourceVersion: string | null;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  deletedReason: string | null;
  provenance: Record<string, unknown>;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export function normalizeVersionRow(row: Record<string, unknown>): SourceFileVersionRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    path: String(row.path),
    seq: Number(row.seq),
    op: row.op as "put" | "delete",
    kind: row.kind as SourceFileKind,
    contentType: (row.content_type as string | null) ?? null,
    sha256: (row.sha256 as string | null) ?? null,
    size: row.size == null ? null : Number(row.size),
    chunks: parseJson<string[] | null>(row.chunks, null),
    fileId: String(row.file_id),
    sourceVersion: (row.source_version as string | null) ?? null,
    sourceUpdatedAt: toIso(row.source_updated_at),
    capturedAt: toIso(row.captured_at) ?? new Date(0).toISOString(),
    deletedReason: (row.deleted_reason as string | null) ?? null,
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
  };
}

export async function getVersionRow(tenantId: string, id: string, deps?: StoreDeps): Promise<SourceFileVersionRow | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_source_file_versions WHERE tenant_id = ${tenantId} AND id = ${id}
  `));
  return row ? normalizeVersionRow(row) : null;
}

/** Versions after `afterId` for one tenant, in publish order. */
export async function listVersionsAfter(
  tenantId: string,
  afterId: string | number,
  limit = 500,
  deps?: StoreDeps,
): Promise<SourceFileVersionRow[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_source_file_versions
    WHERE tenant_id = ${tenantId} AND id > ${String(afterId)}::bigint
    ORDER BY id
    LIMIT ${limit}
  `)).map(normalizeVersionRow);
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
