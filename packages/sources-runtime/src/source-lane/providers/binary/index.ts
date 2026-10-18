/**
 * Binary provider: donor `binary_documents` rows (bytes in S3, content-addressed at binary/<tenant>/<sha256>)
 * exported as exact binary source files, streamed in verified 8 MiB ranges.
 *
 *   sources/binary/<provider>/<externalId>/meta.json                         capture metadata (projection)
 *   sources/binary/<provider>/<externalId>/current<.ext>                     latest bytes
 *   sources/binary/<provider>/<externalId>/versions/<capturedAt>-<sha16><.ext>  every byte state ever recorded
 *
 * Only `drive-pdf` and `upload` rows are exported here: Gmail attachments are exported by the gmail lane
 * (gmail_source_attachments) and Slack files by the slack lane. A withdrawn (tombstoned) document deletes its
 * files and history; a restore republishes them. The source-only runtime performs no PDF text/OCR extraction,
 * so parse_status stays as captured (normally `pending`).
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourcePutFile, SourceProviderModule } from "../../core/types.js";
import {
  BinaryIntegrityError,
  buildChunkManifest,
  chunkLoader,
  s3BinaryObjectReader,
  type BinaryChunk,
  type BinaryObjectReader,
} from "../../../integrations/binary/source-bytes.js";

export const BINARY_EXPORTED_PROVIDERS: ReadonlySet<string> = new Set(["drive-pdf", "upload"]);
const DONOR = "askshepherd/aqueduct@b26d3f46 src/integrations/binary/intake.ts";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const seg = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/zip": ".zip",
  "application/json": ".json",
};
const ext = (mime: string) => EXTENSIONS[mime] ?? ".bin";

export function binaryBase(provider: string, externalId: string): string {
  return `sources/binary/${seg(provider)}/${seg(externalId)}`;
}
export function binaryVersionPath(provider: string, externalId: string, capturedAt: string, sha256: string, mime: string): string {
  return `${binaryBase(provider, externalId)}/versions/${capturedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${sha256.slice(0, 16)}${ext(mime)}`;
}

interface VersionRow {
  id: string;
  provider: string;
  external_id: string;
  sha256: string;
  size_bytes: string | number | null;
  mime_type: string;
  storage_key: string;
  version_ref: string | null;
  source_updated_at: unknown;
  captured_at: unknown;
  document_tombstoned_at: unknown;
  chunks: BinaryChunk[] | null;
}

type Manifest = { chunks: BinaryChunk[] } | { refused: BinaryIntegrityError["code"] };

/** Chunk manifest of a recorded version, built once and checkpointed; transient object-store errors throw (journal retry). */
async function ensureManifest(ctx: ExportContext, reader: BinaryObjectReader, v: VersionRow): Promise<Manifest> {
  if (v.chunks) return { chunks: v.chunks };
  try {
    const chunks = await buildChunkManifest(reader, {
      tenantId: ctx.tenantId,
      storageKey: v.storage_key,
      sha256: v.sha256,
      sizeBytes: v.size_bytes == null ? null : Number(v.size_bytes),
    });
    await ctx.executor.execute(sql`
      UPDATE binary_document_versions SET chunks = ${JSON.stringify(chunks)}::jsonb, manifest_error = NULL, manifest_at = now(),
             manifest_attempts = manifest_attempts + 1
      WHERE tenant_id = ${ctx.tenantId} AND id = ${v.id}
    `);
    return { chunks };
  } catch (err) {
    const permanent = err instanceof BinaryIntegrityError;
    await ctx.executor.execute(sql`
      UPDATE binary_document_versions SET manifest_error = ${permanent ? err.code : `transient: ${String((err as Error)?.message ?? err).slice(0, 300)}`},
             manifest_at = now(), manifest_attempts = manifest_attempts + 1
      WHERE tenant_id = ${ctx.tenantId} AND id = ${v.id}
    `);
    if (permanent) return { refused: err.code };
    throw err;
  }
}

function bytesPut(path: string, v: VersionRow, chunks: BinaryChunk[], reader: BinaryObjectReader, capturedAt: string, provenance: Record<string, unknown>): SourcePutFile {
  return {
    op: "put",
    path,
    kind: "binary",
    contentType: v.mime_type || "application/octet-stream",
    content: Buffer.alloc(0),
    chunked: { sha256: v.sha256, size: chunks.reduce((n, c) => n + c.size, 0), chunks, load: chunkLoader(reader, v.storage_key, chunks) },
    sourceUpdatedAt: iso(v.source_updated_at),
    capturedAt,
    sourceVersion: { ref: v.version_ref ?? `sha256:${v.sha256}` },
    provenance,
  };
}

const deletes = (paths: readonly string[], reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] =>
  paths.map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));

export function binaryDocumentsExport(reader: BinaryObjectReader = s3BinaryObjectReader()): ExtraTableExport {
  return {
    table: "binary_documents",
    tenantColumn: "tenant_id",
    keyColumn: "id",
    async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
      const [d] = rowsOf<Record<string, any>>(await ctx.executor.execute(sql`
        SELECT d.id::text AS id, d.provider, d.external_id, d.sha256, d.mime_type, d.size_bytes, d.storage_key, d.version_ref,
               d.source_updated_at, d.author_email, d.source_acl::text AS source_acl_text, d.parse_status, d.tombstoned_at,
               d.created_at, d.updated_at, v.id AS version_id
        FROM binary_documents d
        LEFT JOIN binary_document_versions v ON v.document_id = d.id AND v.sha256 = d.sha256
        WHERE d.tenant_id = ${ctx.tenantId} AND d.id::text = ${key}
      `));
      const provenance = { table: "binary_documents", rowKey: key, donor: DONOR, ...(d ? { provider: d.provider, externalId: d.external_id } : {}) };
      if (!d) return deletes(prev, "binary_row_deleted", j.enqueuedAt, provenance);
      if (!BINARY_EXPORTED_PROVIDERS.has(d.provider)) return deletes(prev, "binary_provider_owned_elsewhere", j.enqueuedAt, provenance);
      if (d.tombstoned_at) return deletes(prev, "binary_tombstoned", iso(d.tombstoned_at)!, provenance);

      const capturedAt = iso(d.updated_at) ?? j.enqueuedAt;
      const base = binaryBase(d.provider, d.external_id);
      const changes: SourceFileChange[] = [];
      let bytes: Record<string, unknown> = { state: "none", reason: `parse_status ${d.parse_status}: no bytes were captured` };
      if (d.sha256 && d.storage_key) {
        const [v] = d.version_id
          ? rowsOf<VersionRow>(await ctx.executor.execute(sql`SELECT * FROM binary_document_versions WHERE tenant_id = ${ctx.tenantId} AND id = ${d.version_id}`))
          : [];
        if (!v) throw new Error(`binary document ${key}: version row for its current sha256 is missing`);
        const m = await ensureManifest(ctx, reader, v);
        if ("chunks" in m) {
          changes.push(bytesPut(`${base}/current${ext(d.mime_type)}`, v, m.chunks, reader, capturedAt, provenance));
          bytes = { state: "exported", path: `current${ext(d.mime_type)}`, sha256: d.sha256, size: m.chunks.reduce((n, c) => n + c.size, 0), chunks: m.chunks.length };
        } else {
          bytes = { state: "refused", reason: m.refused };
        }
      }
      const meta = {
        provider: d.provider,
        externalId: d.external_id,
        mimeType: d.mime_type,
        sizeBytes: d.size_bytes == null ? null : Number(d.size_bytes),
        sha256: d.sha256,
        versionRef: d.version_ref,
        sourceUpdatedAt: iso(d.source_updated_at),
        authorEmail: d.author_email,
        sourceAcl: JSON.parse(d.source_acl_text ?? "{}"),
        parseStatus: d.parse_status,
        textExtraction: "not performed by the source-only runtime",
        bytes,
        history: "versions/",
        createdAt: iso(d.created_at),
        updatedAt: iso(d.updated_at),
      };
      changes.unshift({
        op: "put", path: `${base}/meta.json`, kind: "projection", contentType: "application/json",
        content: Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8"),
        sourceUpdatedAt: iso(d.source_updated_at), capturedAt, provenance,
      });
      return changes;
    },
  };
}

export function binaryVersionsExport(reader: BinaryObjectReader = s3BinaryObjectReader()): ExtraTableExport {
  return {
    table: "binary_document_versions",
    tenantColumn: "tenant_id",
    keyColumn: "id",
    async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
      const [v] = rowsOf<VersionRow>(await ctx.executor.execute(sql`SELECT * FROM binary_document_versions WHERE tenant_id = ${ctx.tenantId} AND id = ${key}`));
      const provenance = { table: "binary_document_versions", rowKey: key, donor: DONOR, ...(v ? { provider: v.provider, externalId: v.external_id, sha256: v.sha256 } : {}) };
      if (!v) return deletes(prev, "binary_row_deleted", j.enqueuedAt, provenance);
      if (!BINARY_EXPORTED_PROVIDERS.has(v.provider)) return deletes(prev, "binary_provider_owned_elsewhere", j.enqueuedAt, provenance);
      if (v.document_tombstoned_at) return deletes(prev, "binary_tombstoned", iso(v.document_tombstoned_at)!, provenance);
      const m = await ensureManifest(ctx, reader, v);
      if (!("chunks" in m)) return deletes(prev, `binary_integrity_${m.refused}`, j.enqueuedAt, provenance);
      const capturedAt = iso(v.captured_at)!;
      return [bytesPut(binaryVersionPath(v.provider, v.external_id, capturedAt, v.sha256, v.mime_type), v, m.chunks, reader, capturedAt, provenance)];
    },
  };
}

export async function binaryCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const stats = rowsOf<Record<string, any>>(await ctx.executor.execute(sql`
    SELECT d.provider,
           count(*) FILTER (WHERE d.tombstoned_at IS NULL) AS live,
           count(*) FILTER (WHERE d.tombstoned_at IS NULL AND d.sha256 IS NOT NULL) AS stored,
           count(*) FILTER (WHERE d.tombstoned_at IS NULL AND d.parse_status = 'failed_fetch') AS failed_fetch,
           count(*) FILTER (WHERE d.tombstoned_at IS NULL AND d.parse_status = 'failed_unsupported') AS unsupported,
           count(*) FILTER (WHERE d.tombstoned_at IS NOT NULL) AS tombstoned,
           (SELECT count(*) FROM binary_document_versions v WHERE v.tenant_id = ${ctx.tenantId} AND v.provider = d.provider
              AND v.chunks IS NULL AND v.manifest_error IS NOT NULL) AS refused,
           max(d.updated_at) AS last_capture
    FROM binary_documents d WHERE d.tenant_id = ${ctx.tenantId} GROUP BY d.provider ORDER BY d.provider
  `));
  const [{ pending }] = rowsOf<{ pending: string }>(await ctx.executor.execute(sql`
    SELECT count(*) AS pending FROM source_lane_journal
    WHERE tenant_id = ${ctx.tenantId} AND table_name IN ('binary_documents', 'binary_document_versions')
  `));
  const out: CoverageReport[] = [];
  for (const s of stats) {
    if (!BINARY_EXPORTED_PROVIDERS.has(s.provider)) continue;
    const counts = Object.fromEntries(["live", "stored", "failed_fetch", "unsupported", "tombstoned", "refused"].map((k) => [k, Number(s[k])]));
    const problems = [
      counts.failed_fetch ? `${counts.failed_fetch} fetch failure(s) without bytes` : "",
      counts.unsupported ? `${counts.unsupported} unsupported-type row(s) recorded metadata-only` : "",
      counts.refused ? `${counts.refused} version(s) refused or awaiting retry (missing object, size/sha mismatch, non-tenant storage key)` : "",
      Number(pending) ? `${pending} binary change(s) awaiting export` : "",
    ].filter(Boolean);
    out.push({
      provider: "binary",
      scope: `provider:${s.provider}`,
      state: problems.length ? "partial" : "complete",
      reason: problems.length
        ? problems.join("; ")
        : "every captured document is exported with verified bytes; capture completeness is reported by the producing lane",
      lastSuccessAt: iso(s.last_capture) ?? undefined,
      counts,
    });
  }
  if (!out.length) {
    out.push({
      provider: "binary",
      scope: "documents",
      state: "pending",
      reason: "no drive-pdf or upload binary documents captured (Drive PDFs arrive through the google-docs Drive inventory; the source-only runtime has no upload route)",
    });
  }
  return out;
}

export function createBinaryProvider(reader?: BinaryObjectReader): SourceProviderModule {
  return {
    id: "binary",
    eventSources: [],
    mirrorRoots: ["sources/binary/"],
    connectionProviders: [],
    extraTables: [binaryDocumentsExport(reader), binaryVersionsExport(reader)],
    coverage: binaryCoverage,
  };
}

export const binaryProvider: SourceProviderModule = createBinaryProvider();
