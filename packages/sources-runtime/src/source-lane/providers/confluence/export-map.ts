import { sql } from "drizzle-orm";
import { defaultEventChanges, defaultMirrorChanges, encodeSegment } from "../../export/mapping.js";
import type {
  ActivityEventRow,
  ExportContext,
  ExtraTableExport,
  JournalInfo,
  MirrorFileRow,
  SourceChunkedContent,
  SourceFileChange,
  SourcePutFile,
} from "../../core/types.js";
import type { SourceProviderRegistry } from "../../registry.js";
import { objectRowKey, parseObjectRowKey, type ContainerType } from "./identity.js";
import {
  attachmentDir,
  attachmentFileName,
  containerDir,
  containerFileBase,
  parseDonorMirrorPath,
  PROVIDER,
  rawObservationPath,
  rawVersionPath,
  siteFilePath,
  spaceDir,
  versionProjectionPath,
} from "./paths.js";
import { permissionsSummary, renderComments, renderContainer, renderSpace, renderVersion, restrictionsSummary, type AttachmentView, type SiteView } from "./render.js";
import { getBlob, getObject, getRecord, isoOrNull, listObjects, loadChunk, rowsOf, type ObjectRow, type RecordRow, type SiteRow } from "./store.js";

/**
 * Exporters for the Confluence deep-lane tables (drizzle/9200) and the
 * export-time cleanup of the donor mirror.
 *
 * Each map reads the CURRENT row (tenant scoped) and returns every file the
 * row owns; a row that stops producing a path deletes it with the Confluence
 * reason (trashed, not_found, space_not_found, container_*), so projections
 * never keep a stale placement. `_raw/` files are append-only: they are only
 * removed if their ledger row itself disappears.
 */

const T_SITES = "confluence_source_sites";
const T_OBJECTS = "confluence_source_objects";
const T_RECORDS = "confluence_source_records";

function jsonFile(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** JSON document whose `raw` member is the stored jsonb text spliced verbatim (no JavaScript re-encoding). */
function docWithRaw(head: Record<string, unknown>, rawText: string, tail: Record<string, unknown> = {}): Buffer {
  const headJson = JSON.stringify(head, null, 2).slice(0, -2);
  const tailJson = Object.keys(tail).length ? `,\n${JSON.stringify(tail, null, 2).slice(2, -2)}` : "";
  return Buffer.from(`${headJson},\n  "raw": ${rawText}${tailJson}\n}\n`, "utf8");
}

function capturedAt(rowTime: unknown, journal: JournalInfo): string {
  return journal.op === "INSERT" ? (isoOrNull(rowTime) ?? journal.enqueuedAt) : journal.enqueuedAt;
}

function deletes(paths: readonly string[], keep: ReadonlySet<string>, reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return paths.filter((p) => !keep.has(p)).map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

async function siteView(ctx: ExportContext, connectionId: string, cloudId: string): Promise<SiteView> {
  const s = rowsOf<SiteRow>(
    await ctx.executor.execute(sql`SELECT * FROM confluence_source_sites WHERE tenant_id = ${ctx.tenantId} AND connection_id = ${connectionId} AND cloud_id = ${cloudId}`),
  )[0];
  return { cloudId, connectionId, siteUrl: s?.site_url ?? null, siteName: s?.site_name ?? null };
}

function versionRef(n: number | null): { sourceVersion?: { ref: string; ordinal: number } } {
  return n !== null ? { sourceVersion: { ref: `v${n}`, ordinal: n } } : {};
}

// ------------------------------------------------------------------ sites

export async function mapSiteRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const row = rowsOf<SiteRow>(await ctx.executor.execute(sql`SELECT * FROM confluence_source_sites WHERE tenant_id = ${ctx.tenantId} AND row_key = ${rowKey}`))[0];
  const prov = { provider: PROVIDER, table: T_SITES, rowKey };
  if (!row) return deletes(previousPaths, new Set(), "row_deleted", journal.enqueuedAt, prov);
  return [
    {
      op: "put",
      path: siteFilePath(row.cloud_id, row.connection_id),
      kind: "projection",
      contentType: "application/json",
      content: jsonFile({
        schema: "procmem.confluence-site/v1",
        cloudId: row.cloud_id,
        connectionId: row.connection_id,
        providerConfigKey: row.provider_config_key,
        siteUrl: row.site_url,
        siteName: row.site_name,
        grantedScopes: row.scopes,
        status: row.status,
        statusReason: row.status_reason,
        firstSeenAt: isoOrNull(row.first_seen_at),
      }),
      sourceUpdatedAt: null,
      capturedAt: capturedAt(row.updated_at, journal),
      provenance: prov,
    },
  ];
}

// ------------------------------------------------------------------ objects

export async function mapObjectRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const o = await getObject(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_OBJECTS, rowKey };
  if (!o) return deletes(previousPaths, new Set(), "row_deleted", journal.enqueuedAt, prov);
  const provenance = { ...prov, connectionId: o.connection_id, cloudId: o.cloud_id, contentType: o.content_type, contentId: o.content_id, version: o.version_number };
  const at = capturedAt(o.updated_at, journal);
  switch (o.content_type) {
    case "space":
      return mapSpace(ctx, o, at, previousPaths, provenance);
    case "page":
    case "blogpost":
      return mapContainer(ctx, o, at, previousPaths, provenance);
    case "attachment":
      return mapAttachment(ctx, o, at, previousPaths, provenance);
    default:
      // Comments are rendered into their container's comments.md; their raw lives in _raw/.
      return deletes(previousPaths, new Set(), "comment_projection_owned_by_container", at, provenance);
  }
}

async function mapSpace(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  if (o.tombstoned_at) return deletes(previousPaths, new Set(), `confluence_${o.tombstone_reason ?? "deleted"}`, isoOrNull(o.tombstoned_at) ?? at, provenance);
  const site = await siteView(ctx, o.connection_id, o.cloud_id);
  const dir = spaceDir(o.cloud_id, o.connection_id, o.content_id);
  const base = { kind: "projection" as const, sourceUpdatedAt: null, capturedAt: at, provenance };
  const out: SourcePutFile[] = [
    { ...base, op: "put", path: `${dir}/_space.json`, contentType: "application/json", content: docWithRaw({ schema: "procmem.confluence-space/v1", spaceId: o.content_id, status: o.status }, o.raw_text ?? JSON.stringify(o.raw)) },
    { ...base, op: "put", path: `${dir}/_space.md`, contentType: "text/markdown; charset=utf-8", content: Buffer.from(renderSpace(o, site, permissionsSummary(o.permissions, o.permissions_status)), "utf8") },
  ];
  if (o.permissions_status === "captured") {
    out.push({ ...base, op: "put", path: `${dir}/_permissions.json`, contentType: "application/json", content: jsonFile({ schema: "procmem.confluence-space-permissions/v1", spaceId: o.content_id, assignments: o.permissions }) });
  }
  return out;
}

async function mapContainer(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  const type = o.content_type as ContainerType;
  const extra = await donorMirrorCleanupForPage(ctx, o.content_id, at);
  if (o.tombstoned_at) return [...deletes(previousPaths, new Set(), `confluence_${o.tombstone_reason ?? "deleted"}`, isoOrNull(o.tombstoned_at) ?? at, provenance), ...extra];
  const site = await siteView(ctx, o.connection_id, o.cloud_id);
  const scope = { tenantId: ctx.tenantId, connectionId: o.connection_id, cloudId: o.cloud_id };
  const dir = containerDir(o.cloud_id, o.connection_id, o.space_id, type, o.content_id);
  const file = containerFileBase(type);
  const comments = (await listObjects(ctx.executor, scope, { types: ["footer_comment", "inline_comment"], containerId: o.content_id, live: true })).filter((c) => c.container_type === type);
  const attachments = (await listObjects(ctx.executor, scope, { types: ["attachment"], containerId: o.content_id, live: true })).filter((a) => a.container_type === type);
  const views: AttachmentView[] = attachments.map((a) => ({
    id: a.content_id,
    title: a.title,
    mediaType: a.binary_media_type ?? (typeof a.raw.mediaType === "string" ? a.raw.mediaType : null),
    fileSize: typeof a.raw.fileSize === "number" ? a.raw.fileSize : a.binary_size !== null && a.binary_size !== undefined ? Number(a.binary_size) : null,
    version: a.version_number,
    binaryStatus: a.binary_status,
    relPath: a.binary_status === "stored" ? `attachments/${encodeSegment(a.content_id)}/${attachmentFileName(a.title, a.content_id)}` : null,
  }));
  const updated = isoOrNull((o.raw.version as Record<string, unknown> | undefined)?.createdAt) ?? isoOrNull(o.version_created_at);
  const base = { kind: "projection" as const, capturedAt: at, provenance };
  const out: SourceFileChange[] = [
    {
      ...base,
      op: "put",
      path: `${dir}/${file}.md`,
      contentType: "text/markdown; charset=utf-8",
      content: Buffer.from(
        renderContainer(o, site, {
          attachments: views,
          liveComments: comments.length,
          restrictionsSummary: restrictionsSummary(o.restrictions, o.restrictions_status),
        }),
        "utf8",
      ),
      sourceUpdatedAt: updated,
      ...versionRef(o.version_number),
    },
    {
      ...base,
      op: "put",
      path: `${dir}/${file}.json`,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw({ schema: `procmem.confluence-${type}/v1`, id: o.content_id, spaceId: o.space_id, status: o.status, version: o.version_number }, o.raw_text ?? JSON.stringify(o.raw)),
      sourceUpdatedAt: updated,
      ...versionRef(o.version_number),
    },
  ];
  if (o.adf !== null && o.adf !== undefined) {
    out.push({ ...base, op: "put", path: `${dir}/${file}.adf.json`, kind: "raw", contentType: "application/json", content: docWithRaw({ schema: "procmem.confluence-adf/v1", id: o.content_id, version: o.adf_version }, o.adf_text ?? JSON.stringify(o.adf)), sourceUpdatedAt: updated, ...versionRef(o.adf_version) });
  }
  if (o.restrictions_status === "captured") {
    out.push({ ...base, op: "put", path: `${dir}/restrictions.json`, contentType: "application/json", content: jsonFile({ schema: "procmem.confluence-restrictions/v1", id: o.content_id, restrictions: o.restrictions }), sourceUpdatedAt: null });
  }
  if (comments.length) {
    const latest = comments.map((c) => isoOrNull((c.raw.version as Record<string, unknown> | undefined)?.createdAt)).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
    out.push({ ...base, op: "put", path: `${dir}/comments.md`, contentType: "text/markdown; charset=utf-8", content: Buffer.from(renderComments(o, site, comments), "utf8"), sourceUpdatedAt: latest });
  }
  const produced = new Set(out.map((c) => c.path));
  // Files this row produced before but not now (comments all deleted, ADF dropped): delete with the specific reason.
  const stale = previousPaths.filter((p) => !produced.has(p));
  return [...out, ...stale.map((path) => ({ op: "delete" as const, path, deletedAt: at, reason: path.endsWith("/comments.md") ? "confluence_comments_removed" : "source_path_changed", capturedAt: at, provenance })), ...extra];
}

async function mapAttachment(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  const containerType = (o.container_type ?? "page") as ContainerType;
  const container = o.container_id ? await getObject(ctx.executor, ctx.tenantId, objectRowKey({ connectionId: o.connection_id, cloudId: o.cloud_id }, containerType, o.container_id)) : null;
  if (o.tombstoned_at || !container || container.tombstoned_at) {
    const reason = o.tombstoned_at ? `confluence_${o.tombstone_reason ?? "deleted"}` : container ? `confluence_container_${container.tombstone_reason ?? "deleted"}` : "confluence_container_unknown";
    return deletes(previousPaths, new Set(), reason, isoOrNull(o.tombstoned_at) ?? isoOrNull(container?.tombstoned_at) ?? at, provenance);
  }
  const dir = attachmentDir(containerDir(o.cloud_id, o.connection_id, container.space_id, containerType, container.content_id), o.content_id);
  const binary = { status: o.binary_status ?? "pending", sha256: o.binary_sha256, size: o.binary_size === null || o.binary_size === undefined ? null : Number(o.binary_size), version: o.binary_version, mediaType: o.binary_media_type, error: o.binary_error };
  const out: SourceFileChange[] = [
    {
      op: "put",
      path: `${dir}/_attachment.json`,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw({ schema: "procmem.confluence-attachment/v1", id: o.content_id, containerType, containerId: o.container_id, status: o.status, version: o.version_number }, o.raw_text ?? JSON.stringify(o.raw), { binary }),
      sourceUpdatedAt: isoOrNull(o.version_created_at),
      capturedAt: at,
      ...versionRef(o.version_number),
      provenance,
    },
  ];
  if (o.binary_status === "stored" && o.binary_sha256) {
    const blob = await getBlob(ctx.executor, ctx.tenantId, o.binary_sha256);
    if (!blob) throw new Error(`confluence attachment ${o.content_id}: blob ${o.binary_sha256} missing`);
    const chunked: SourceChunkedContent = { sha256: blob.sha256, size: blob.size, chunks: blob.chunks, load: (sha) => loadChunk(ctx.executor, ctx.tenantId, sha) };
    out.push({
      op: "put",
      path: `${dir}/${attachmentFileName(o.title, o.content_id)}`,
      kind: "binary",
      contentType: o.binary_media_type ?? "application/octet-stream",
      content: Buffer.alloc(0),
      chunked,
      sourceUpdatedAt: isoOrNull(o.version_created_at),
      capturedAt: at,
      ...versionRef(o.binary_version),
      provenance: { ...provenance, binaryVersion: o.binary_version, sha256: blob.sha256 },
    });
  }
  return out;
}

// ------------------------------------------------------------------ records

export async function mapRecordRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const r = await getRecord(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_RECORDS, rowKey };
  if (!r) return deletes(previousPaths, new Set(), "raw_row_deleted", journal.enqueuedAt, prov);
  const at = capturedAt(r.observed_at, journal);
  const provenance = { ...prov, connectionId: r.connection_id, cloudId: r.cloud_id, contentType: r.content_type, contentId: r.content_id, recordKind: r.record_kind, version: r.version_number, endpoint: r.endpoint };
  const head = {
    schema: "procmem.confluence-record/v1",
    recordKind: r.record_kind,
    connectionId: r.connection_id,
    cloudId: r.cloud_id,
    contentType: r.content_type,
    contentId: r.content_id,
    versionNumber: r.version_number,
    endpoint: r.endpoint,
    observedAt: isoOrNull(r.observed_at),
    rawSha256: r.raw_sha256,
  };
  const sourceUpdatedAt = isoOrNull((r.raw.version as Record<string, unknown> | undefined)?.createdAt);
  if (r.record_kind === "observation") {
    return [{ op: "put", path: rawObservationPath(r.cloud_id, r.connection_id, r.content_type, r.content_id, r.raw_sha256), kind: "raw", contentType: "application/json", content: docWithRaw(head, r.raw_text), sourceUpdatedAt, capturedAt: at, provenance }];
  }
  const out: SourceFileChange[] = [
    { op: "put", path: rawVersionPath(r.cloud_id, r.connection_id, r.content_type, r.content_id, r.version_number ?? 0), kind: "raw", contentType: "application/json", content: docWithRaw(head, r.raw_text), sourceUpdatedAt, capturedAt: at, provenance },
  ];
  const container = await getObject(ctx.executor, ctx.tenantId, r.object_key);
  const parsed = parseObjectRowKey(r.object_key);
  if (container && parsed && (parsed.type === "page" || parsed.type === "blogpost") && r.version_number !== null) {
    const projection = versionProjectionPath(containerDir(r.cloud_id, r.connection_id, container.space_id, parsed.type, r.content_id), r.version_number);
    if (container.tombstoned_at) {
      out.push(...deletes(previousPaths.filter((p) => p === projection || p.includes("/versions/v") && p.endsWith(".md")), new Set(), `confluence_container_${container.tombstone_reason ?? "deleted"}`, isoOrNull(container.tombstoned_at) ?? at, provenance));
    } else {
      out.push({ op: "put", path: projection, kind: "projection", contentType: "text/markdown; charset=utf-8", content: Buffer.from(renderVersion(container, r, await siteView(ctx, r.connection_id, r.cloud_id)), "utf8"), sourceUpdatedAt, capturedAt: at, provenance });
    }
  }
  return out;
}

export const CONFLUENCE_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: T_SITES, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapSiteRow },
  { table: T_OBJECTS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapObjectRow },
  { table: T_RECORDS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapRecordRow },
];

// ------------------------------------------------------------------ donor mirror cleanup at export

/** Donor materializer path segment rule (atlassianPathSegment in src/mirror/materializer.ts). */
export function donorSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

/**
 * Donor mirror files are keyed by <spaceId>/<pageId> with no site, so id-based
 * cleanup is only sound when the tenant has exactly one Confluence connection
 * and at most one deep-lane site (otherwise the same page id can exist twice).
 */
async function singleSiteTenant(ctx: ExportContext): Promise<boolean> {
  const r = rowsOf<{ conns: number; sites: number }>(
    await ctx.executor.execute(sql`
      SELECT (SELECT count(*)::int FROM connections WHERE tenant_id = ${ctx.tenantId} AND provider = 'confluence') AS conns,
             (SELECT count(*)::int FROM confluence_source_sites WHERE tenant_id = ${ctx.tenantId}) AS sites
    `),
  )[0];
  return Number(r?.conns ?? 0) <= 1 && Number(r?.sites ?? 0) <= 1;
}

interface DonorFate {
  reason: string;
  at: string;
}

/**
 * Whether a donor mirror page (or comments doc) at <spaceSegment>/<pageSegment>
 * is stale: the newest captured donor record for that page/blog post is a
 * tombstone (covers tombstones without spaceId, which the donor never removes,
 * and blog-post deletes that leave the comments doc), or it now lives in
 * another space (moved page), or the deep lane confirmed it trashed/deleted
 * after this mirror row was written.
 */
export async function donorMirrorFate(ctx: ExportContext, spaceSegment: string, pageSegment: string, comments: boolean, mirrorUpdatedAt: string | null): Promise<DonorFate | null> {
  if (!(await singleSiteTenant(ctx))) return null;
  const types = comments ? ["page", "page.deleted", "blog_post", "blog_post.deleted"] : ["page", "page.deleted"];
  const latest = rowsOf<{ event_type: string; raw_payload: unknown; at: unknown }>(
    await ctx.executor.execute(sql`
      SELECT event_type, raw_payload, COALESCE(source_updated_at, timestamp) AS at
      FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'confluence'
        AND event_type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
        AND (raw_payload->>'id' = ${pageSegment} OR raw_payload->>'pageId' = ${pageSegment})
      ORDER BY COALESCE(source_updated_at, timestamp) DESC, created_at DESC, id DESC
      LIMIT 1
    `),
  )[0];
  if (latest) {
    const at = isoOrNull(latest.at) ?? new Date(0).toISOString();
    if (latest.event_type.endsWith(".deleted")) return { reason: latest.event_type.startsWith("blog_post") ? "confluence_blog_post_deleted" : "confluence_page_deleted", at };
    const p = (typeof latest.raw_payload === "string" ? JSON.parse(latest.raw_payload) : latest.raw_payload) as Record<string, unknown>;
    const space = (p.space ?? null) as Record<string, unknown> | null;
    const sid = [p.spaceId, p.space_id, space?.id, space?.key].find((v) => (typeof v === "string" && v.trim()) || typeof v === "number");
    // The newest record decides the page's current placement; any other space's file is stale.
    if (sid !== undefined && donorSegment(String(sid)) !== spaceSegment) return { reason: "confluence_page_moved", at };
  }
  const deep = rowsOf<{ tombstoned_at: unknown; tombstone_reason: string | null; space_id: string | null }>(
    await ctx.executor.execute(sql`
      SELECT tombstoned_at, tombstone_reason, space_id FROM confluence_source_objects
      WHERE tenant_id = ${ctx.tenantId} AND content_type IN ('page', 'blogpost') AND content_id = ${pageSegment}
    `),
  );
  if (deep.length === 1 && deep[0]!.tombstoned_at) {
    const at = isoOrNull(deep[0]!.tombstoned_at)!;
    if (!mirrorUpdatedAt || at >= mirrorUpdatedAt) return { reason: `confluence_${deep[0]!.tombstone_reason ?? "deleted"}`, at };
  }
  return null;
}

async function exportedDonorPathsForPage(ctx: ExportContext, pageSegment: string): Promise<string[]> {
  return rowsOf<{ path: string }>(
    await ctx.executor.execute(sql`
      SELECT DISTINCT path FROM source_lane_exported
      WHERE tenant_id = ${ctx.tenantId} AND table_name = 'mirror_files'
        AND (path LIKE ${`sources/confluence/%/${pageSegment}.md`} OR path LIKE ${`sources/confluence/%/${pageSegment}-comments.md`})
    `),
  )
    .map((r) => r.path)
    .filter((p) => parseDonorMirrorPath(p)?.pageSegment === pageSegment);
}

async function mirrorUpdatedAt(ctx: ExportContext, path: string): Promise<string | null | undefined> {
  const r = rowsOf<{ updated_at: unknown }>(await ctx.executor.execute(sql`SELECT updated_at FROM mirror_files WHERE user_id = ${ctx.tenantId} AND path = ${path}`))[0];
  return r ? isoOrNull(r.updated_at) : undefined;
}

/** Deletes for exported donor mirror paths of one page that are now stale (called when a donor or deep record changes). */
async function donorMirrorCleanupForPage(ctx: ExportContext, pageId: string, at: string): Promise<SourceFileChange[]> {
  const seg = donorSegment(pageId);
  if (seg !== pageId) return [];
  const out: SourceFileChange[] = [];
  for (const path of await exportedDonorPathsForPage(ctx, seg)) {
    const parsed = parseDonorMirrorPath(path)!;
    const updated = await mirrorUpdatedAt(ctx, path);
    if (updated === undefined) continue; // mirror row already gone: its own journal entry deletes it
    const fate = await donorMirrorFate(ctx, parsed.spaceSegment, parsed.pageSegment, parsed.comments, updated);
    if (fate) out.push({ op: "delete", path, deletedAt: fate.at > at ? at : fate.at, reason: fate.reason, capturedAt: at, provenance: { provider: PROVIDER, donorMirrorCleanup: true, pageId } });
  }
  return out;
}

/** defaultEventChanges only asks the registry for the raw directory of this event source (avoids a registry import cycle). */
const CONFLUENCE_RAW_DIR = { forEventSource: () => ({ id: PROVIDER }) } as unknown as SourceProviderRegistry;

function withOrdinal(changes: SourceFileChange[]): SourceFileChange[] {
  return changes.map((c) => {
    if (c.op !== "put" || !c.sourceVersion) return c;
    const m = /^v(\d+)$/u.exec(c.sourceVersion.ref);
    return m ? { ...c, sourceVersion: { ref: c.sourceVersion.ref, ordinal: Number(m[1]) } } : c;
  });
}

/**
 * Donor mirror rows under sources/confluence/<space>/<page>{,-comments}.md:
 * default projection mapping, plus the page version number as an ordinal (the
 * donor upsert has no version guard, so a replayed older record must not
 * overwrite a newer page in yc_msaw), and a delete instead of a put when the
 * page was deleted or moved (see donorMirrorFate).
 */
export async function mapConfluenceMirror(path: string, row: MirrorFileRow | null, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> {
  const parsed = parseDonorMirrorPath(path);
  if (!parsed || !row) return null;
  const fate = await donorMirrorFate(ctx, parsed.spaceSegment, parsed.pageSegment, parsed.comments, isoOrNull(row.updated_at));
  if (fate) {
    return [{ op: "delete", path, deletedAt: fate.at < journal.enqueuedAt ? fate.at : journal.enqueuedAt, reason: fate.reason, capturedAt: journal.op === "INSERT" ? (isoOrNull(row.updated_at) ?? journal.enqueuedAt) : journal.enqueuedAt, provenance: { provider: PROVIDER, table: "mirror_files", donorMirrorCleanup: true } }];
  }
  const changes = withOrdinal(defaultMirrorChanges(path, row, journal.enqueuedAt));
  // final-audit M2: a comments doc is an aggregate whose donor time is the newest LIVE comment's, so deleting the
  // newest comment moves it backwards and the store would refuse the re-render as stale (the deleted comment stays
  // visible). Aggregates are ordered by capture (mirror row / journal order) instead; the time stays in provenance.
  if (!parsed.comments) return changes;
  return changes.map((c) =>
    c.op === "put"
      ? { ...c, sourceUpdatedAt: null, sourceVersion: undefined, provenance: { ...(c.provenance ?? {}), aggregateNewestLiveItemAt: c.sourceUpdatedAt ?? null, orderedBy: "capture" } }
      : c,
  );
}

/**
 * Donor raw rows keep the default raw layout (journal-retained history of what
 * Nango returned, latest-state-per-poll). Page / blog post records additionally
 * re-evaluate already exported donor mirror files for that id, so a tombstone
 * without spaceId or a move removes the stale file at export time.
 */
export async function mapConfluenceEvent(row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> {
  if (!["page", "page.deleted", "blog_post", "blog_post.deleted"].includes(row.event_type)) return null;
  const base = defaultEventChanges(CONFLUENCE_RAW_DIR, row, journal);
  const payload = (typeof row.raw_payload === "string" ? JSON.parse(row.raw_payload) : row.raw_payload) as Record<string, unknown> | null;
  const id = payload ? [payload.id, payload.pageId].find((v) => typeof v === "string" || typeof v === "number") : undefined;
  if (id === undefined) return base;
  return [...base, ...(await donorMirrorCleanupForPage(ctx, String(id), journal.enqueuedAt))];
}

export type { RecordRow };
