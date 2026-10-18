import type { Hono } from "hono";
import type { db } from "../../db/client.js";
import type { TaskHandler } from "../../queue/queue.js";

/**
 * Shared types of the source lane (exporter, provider modules, publish client).
 * The wire format these map to is yc_msaw's publish protocol
 * (AUDIT/implementation/CONTRACT.md §3, yc_msaw src/sources/http.ts).
 */

export type DbExecutor = Pick<typeof db, "execute">;

export type SourceKind = "projection" | "raw" | "binary";

/** Provider-native version identity. `ordinal` must be monotonic per file when present (e.g. Confluence version.number). */
export interface SourceVersionRef {
  ref: string;
  ordinal?: number;
}

export interface SourcePutFile {
  op: "put";
  /** Full wire path `sources/<provider>/<rel>`; must be canonical (no empty/./.. segments). */
  path: string;
  kind: SourceKind;
  contentType: string;
  /** Exact bytes; never re-encoded by the exporter. May be empty when `chunked` is given. */
  content: Buffer;
  /**
   * Pre-chunked stored content (provider stores that already keep files as ordered chunks, e.g. google-docs
   * `gdocs_source_file_versions`). The exporter then uploads chunk by chunk (each loaded on demand and verified
   * against its sha) instead of materialising the whole file; `content` is ignored.
   */
  chunked?: SourceChunkedContent;
  sourceUpdatedAt: Date | string | null;
  /** When the runtime observed this state (row updated_at / created_at), not when it is exported. */
  capturedAt: Date | string;
  sourceVersion?: SourceVersionRef;
  provenance?: Record<string, unknown>;
}

export interface SourceChunkedContent {
  /** Whole-file sha256 / size; verified incrementally while the chunks stream. */
  sha256: string;
  size: number;
  /** In order; every chunk <= 8 MiB (the yc_msaw blob limit). */
  chunks: ReadonlyArray<{ sha256: string; size: number }>;
  load(chunkSha256: string): Promise<Buffer>;
}

export interface SourceDeleteFile {
  op: "delete";
  path: string;
  deletedAt: Date | string;
  reason: string;
  capturedAt: Date | string;
  provenance?: Record<string, unknown>;
}

export type SourceFileChange = SourcePutFile | SourceDeleteFile;

/** activity_events row as exported (lifecycle-only columns processing_status / wiki_eligibility_at are excluded). */
export interface ActivityEventRow {
  id: string;
  user_id: string;
  source: string;
  source_namespace: string | null;
  source_object_id: string | null;
  record_kind: string | null;
  event_type: string;
  timestamp: string;
  source_updated_at: string | null;
  raw_payload: unknown;
  /** raw_payload exactly as PostgreSQL renders the stored jsonb (no JavaScript number re-encoding). */
  raw_payload_text: string;
  extracted_entities: unknown;
  extracted_entities_text: string | null;
  source_event_id: string;
  created_at: string;
}

export interface MirrorFileRow {
  path: string;
  user_id: string;
  content: string;
  content_sha: string | null;
  meta: Record<string, unknown> | null;
  meta_sha: string | null;
  updated_at: string;
}

export interface ExportContext {
  tenantId: string;
  /** Database access for reading current row state (each statement sees the latest committed state). */
  executor: DbExecutor;
}

/** The journal entry that triggered this mapping (latest one when several coalesced). */
export interface JournalInfo {
  op: "INSERT" | "UPDATE" | "DELETE";
  /** When the change was committed to the journal (use as capturedAt for updates and deletes). */
  enqueuedAt: string;
}

export type CoverageState = "complete" | "partial" | "blocked" | "pending";

export interface CoverageReport {
  provider: string;
  scope: string;
  state: CoverageState;
  reason?: string;
  cursor?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  counts?: Record<string, number>;
}

/**
 * Extra provider table exported through the journal. The provider's migration installs
 * `CREATE TRIGGER ... EXECUTE FUNCTION source_lane_journal_row('<table>', '<tenant column>', '<key expression column>')`
 * (see drizzle/9000_source_lane_export.sql); `map` receives the row key and must read the
 * current row (absent = deleted) inside ctx.executor.
 */
export interface ExtraTableExport {
  table: string;
  /** Columns the journal trigger uses; when both are set the exporter can backfill existing rows generically. */
  tenantColumn?: string;
  keyColumn?: string;
  /**
   * Current state of (tenant, rowKey) as changes. For a deleted row, emit deletes for the
   * paths previously exported for it: `previousPaths` lists them (from source_lane_exported).
   */
  map(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]>;
}

export interface InternalRouteDeps {
  /** Resolve the yc_msaw-assigned tenant for an internal request (already service-authenticated). */
  tenantOf(c: { req: { param(name: string): string | undefined } }): string;
}

export interface SourceProviderModule {
  /** Directory under sources/ this module owns. */
  id: string;
  /** activity_events.source values exported under sources/<id>/_raw/. */
  eventSources: readonly string[];
  /** Mirror path prefixes (`sources/<id>/`) whose mirror_files rows belong to this provider. */
  mirrorRoots: readonly string[];
  /** connections.provider values that feed this module (default: [id]; Google's DWD connection feeds gmail, calendar, google-docs). */
  connectionProviders?: readonly string[];
  /** Replace the default raw-event mapping; return null to keep the default. */
  mapEvent?(row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> | SourceFileChange[] | null;
  /** Replace the default projection mapping for a mirror row (null row = deleted); return null to keep the default. */
  mapMirror?(path: string, row: MirrorFileRow | null, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> | SourceFileChange[] | null;
  /** Additional tables exported through journal triggers (snapshots, images, native stores, binaries). */
  extraTables?: readonly ExtraTableExport[];
  /** Truthful coverage per scope; reported to yc_msaw after each export pass. */
  coverage?(ctx: ExportContext): Promise<CoverageReport[]>;
  /** Provider-facing public routes (OAuth callbacks, webhooks, device uploaders); each must authenticate itself. */
  publicRoutes?(app: Hono): void;
  /** yc_msaw → runtime routes, mounted under /internal/v1 behind the service token. */
  internalRoutes?(app: Hono, deps: InternalRouteDeps): void;
  /** Task handlers added by this module (donor integration handlers are registered separately). */
  taskHandlers?(): Record<string, TaskHandler>;
}
