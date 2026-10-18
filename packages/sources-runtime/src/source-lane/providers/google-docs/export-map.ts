/**
 * extraTables mapping: one immutable `gdocs_source_file_versions` row => one
 * put/delete change with the exact stored bytes. Rows are append-only, so the
 * mapping of a key never changes; a missing row (never expected) deletes what
 * that row previously produced.
 */
import type { ExportContext, ExtraTableExport, JournalInfo, SourceChunkedContent, SourceFileChange } from "../../core/types.js";
import { getVersionRow, readBlobBytes, readChunk, readChunkSizes, type SqlDatabase, type SourceFileVersionRow } from "./store.js";
import { DONOR } from "../../core/donor.js";

export const GDOCS_VERSIONS_TABLE = "gdocs_source_file_versions";

export async function versionRowToChange(row: SourceFileVersionRow, ctx: ExportContext): Promise<SourceFileChange> {
  const provenance = {
    ...row.provenance,
    runtime: "google-docs source lane",
    donor: `${DONOR.repo}@${DONOR.commit}`,
    externalId: row.fileId,
    versionSeq: row.seq,
    ...(row.sourceVersion ? { versionRef: row.sourceVersion } : {}),
  };
  if (row.op === "delete") {
    return {
      op: "delete",
      path: row.path,
      deletedAt: row.capturedAt,
      reason: row.deletedReason ?? "deleted",
      capturedAt: row.capturedAt,
      provenance,
    };
  }
  const deps = { db: ctx.executor as unknown as SqlDatabase };
  const chunkShas = row.chunks ?? [];
  let content: Buffer;
  let chunked: SourceChunkedContent | undefined;
  if (row.sha256 && row.size != null && chunkShas.length > 1) {
    // Large file: hand the stored chunk list to the exporter, which streams and verifies chunk by chunk.
    const sizes = await readChunkSizes(row.tenantId, chunkShas, deps);
    const total = sizes.reduce((n, x) => n + x, 0);
    if (total !== row.size) throw new Error(`gdocs source blob for ${row.path} seq ${row.seq} is ${total} bytes, expected ${row.size}`);
    content = Buffer.alloc(0);
    chunked = {
      sha256: row.sha256,
      size: row.size,
      chunks: chunkShas.map((sha, i) => ({ sha256: sha, size: sizes[i] as number })),
      load: (sha) => readChunk(row.tenantId, sha, deps),
    };
  } else {
    content = await readBlobBytes(row.tenantId, chunkShas, deps);
    if (row.sha256 && row.size != null && (content.byteLength !== row.size)) {
      throw new Error(`gdocs source blob for ${row.path} seq ${row.seq} is ${content.byteLength} bytes, expected ${row.size}`);
    }
  }
  return {
    op: "put",
    path: row.path,
    kind: row.kind === "tombstone" ? "raw" : row.kind,
    contentType: row.contentType ?? "application/octet-stream",
    content,
    ...(chunked ? { chunked } : {}),
    sourceUpdatedAt: row.sourceUpdatedAt,
    capturedAt: row.capturedAt,
    sourceVersion: { ref: row.sourceVersion ?? `seq:${row.seq}`, ordinal: row.seq },
    provenance,
  };
}

export const gdocsVersionsExport: ExtraTableExport = {
  table: GDOCS_VERSIONS_TABLE,
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
    const row = await getVersionRow(ctx.tenantId, rowKey, { db: ctx.executor as unknown as SqlDatabase });
    if (!row) {
      return previousPaths.map((path) => ({
        op: "delete" as const,
        path,
        deletedAt: journal.enqueuedAt,
        reason: "version_row_deleted",
        capturedAt: journal.enqueuedAt,
      }));
    }
    return [await versionRowToChange(row, ctx)];
  },
};
