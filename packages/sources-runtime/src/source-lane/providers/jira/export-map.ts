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
import { objectRowKey } from "./identity.js";
import {
  attachmentDir,
  attachmentFileName,
  donorSegment,
  issueDir,
  parseDonorMirrorPath,
  projectDir,
  PROVIDER,
  rawChangelogPath,
  rawObservationPath,
  siteFilePath,
} from "./paths.js";
import { person, renderChangelog, renderIssue, renderProject, str, type AttachmentView, type SiteView } from "./render.js";
import { getBlob, getObject, getRecord, getSelection, isoOrNull, listChangelog, listObjects, loadChunk, rowsOf, type ObjectRow, type SiteRow } from "./store.js";

/**
 * Exporters for the Jira deep-lane tables (drizzle/9250) and the export-time
 * cleanup of the donor mirror (sources/jira/<PROJECT>/<KEY>.md).
 *
 * Each map reads the CURRENT row (tenant scoped) and returns every file the
 * row owns. Projections are placed by the issue's current key, so a moved or
 * re-keyed issue writes new paths and deletes the old ones with reason
 * `jira_issue_moved`; a tombstoned issue deletes its projections with the Jira
 * reason (not_found, trashed, project_trashed, outside_selection). `_raw/`
 * files are append-only. Objects that lost access keep exporting their last
 * state, labelled in the projection.
 */

const T_SITES = "jira_source_sites";
const T_OBJECTS = "jira_source_objects";
const T_RECORDS = "jira_source_records";
const MD = "text/markdown; charset=utf-8";

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
  const s = rowsOf<SiteRow>(await ctx.executor.execute(sql`SELECT * FROM jira_source_sites WHERE tenant_id = ${ctx.tenantId} AND connection_id = ${connectionId} AND cloud_id = ${cloudId}`))[0];
  return { cloudId, connectionId, siteUrl: s?.site_url ?? null, siteName: s?.site_name ?? null };
}

function tombstoneReason(o: ObjectRow): string {
  return `jira_${o.tombstone_reason ?? "deleted"}`;
}

// ------------------------------------------------------------------ sites

export async function mapSiteRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const row = rowsOf<SiteRow>(await ctx.executor.execute(sql`SELECT * FROM jira_source_sites WHERE tenant_id = ${ctx.tenantId} AND row_key = ${rowKey}`))[0];
  const prov = { provider: PROVIDER, table: T_SITES, rowKey };
  if (!row) return deletes(previousPaths, new Set(), "row_deleted", journal.enqueuedAt, prov);
  const selection = await getSelection(ctx.executor, { tenantId: ctx.tenantId, connectionId: row.connection_id, cloudId: row.cloud_id });
  return [
    {
      op: "put",
      path: siteFilePath(row.cloud_id, row.connection_id),
      kind: "projection",
      contentType: "application/json",
      content: jsonFile({
        schema: "procmem.jira-site/v1",
        cloudId: row.cloud_id,
        connectionId: row.connection_id,
        providerConfigKey: row.provider_config_key,
        siteUrl: row.site_url,
        siteName: row.site_name,
        grantedScopes: row.scopes,
        status: row.status,
        statusReason: row.status_reason,
        projectSelection: { mode: selection.mode, projects: selection.projects, source: selection.source },
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
  const provenance = { ...prov, connectionId: o.connection_id, cloudId: o.cloud_id, contentType: o.content_type, contentId: o.content_id, externalId: o.content_id, issueKey: o.issue_key };
  const at = capturedAt(o.updated_at, journal);
  switch (o.content_type) {
    case "project":
      return mapProject(ctx, o, at, previousPaths, provenance);
    case "issue":
      return mapIssue(ctx, o, at, previousPaths, provenance);
    case "attachment":
      return mapAttachment(ctx, o, at, previousPaths, provenance);
    default:
      // Comments are rendered into their issue's issue.md / comments.json; their raw lives in _raw/.
      return deletes(previousPaths, new Set(), "comment_projection_owned_by_issue", at, provenance);
  }
}

async function mapProject(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  if (o.tombstoned_at) return deletes(previousPaths, new Set(), tombstoneReason(o), isoOrNull(o.tombstoned_at) ?? at, provenance);
  const dir = projectDir(o.cloud_id, o.connection_id, o.project_key);
  const base = { kind: "projection" as const, sourceUpdatedAt: null, capturedAt: at, provenance };
  const out: SourcePutFile[] = [
    { ...base, op: "put", kind: "raw", path: `${dir}/_project.json`, contentType: "application/json", content: docWithRaw({ schema: "procmem.jira-project/v1", projectId: o.content_id, projectKey: o.project_key, status: o.status, inaccessibleReason: o.inaccessible_reason }, o.raw_text ?? JSON.stringify(o.raw)) },
    { ...base, op: "put", path: `${dir}/_project.md`, contentType: MD, content: Buffer.from(renderProject(o, await siteView(ctx, o.connection_id, o.cloud_id)), "utf8") },
  ];
  const produced = new Set(out.map((c) => c.path));
  return [...out, ...deletes(previousPaths, produced, "jira_project_rekeyed", at, provenance)];
}

async function mapIssue(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  const donor = await donorMirrorCleanupForIssue(ctx, o.content_id, at);
  if (o.tombstoned_at) return [...deletes(previousPaths, new Set(), tombstoneReason(o), isoOrNull(o.tombstoned_at) ?? at, provenance), ...donor];
  const site = await siteView(ctx, o.connection_id, o.cloud_id);
  const scope = { tenantId: ctx.tenantId, connectionId: o.connection_id, cloudId: o.cloud_id };
  const dir = issueDir(o.cloud_id, o.connection_id, o.project_key, o.issue_key, o.content_id);
  const comments = await listObjects(ctx.executor, scope, { types: ["comment"], containerId: o.content_id, live: true });
  const attachments = await listObjects(ctx.executor, scope, { types: ["attachment"], containerId: o.content_id, live: true });
  const histories = await listChangelog(ctx.executor, ctx.tenantId, o.row_key);
  const views: AttachmentView[] = attachments.map((a) => ({
    id: a.content_id,
    filename: a.title,
    mimeType: str(a.raw.mimeType) ?? a.binary_media_type,
    size: typeof a.raw.size === "number" ? a.raw.size : a.binary_size !== null && a.binary_size !== undefined ? Number(a.binary_size) : null,
    created: isoOrNull(a.raw.created),
    author: person(a.raw.author),
    binaryStatus: a.binary_status,
    relPath: a.binary_status === "stored" ? `attachments/${encodeSegment(a.content_id)}/${attachmentFileName(a.title, a.content_id)}` : null,
  }));
  const updated = isoOrNull(o.source_updated_at);
  const version = updated ? { sourceVersion: { ref: updated } } : {};
  const base = { kind: "projection" as const, capturedAt: at, provenance };
  const changelogTotal = o.changelog_total;
  const out: SourceFileChange[] = [
    {
      ...base,
      op: "put",
      path: `${dir}/issue.md`,
      contentType: MD,
      content: Buffer.from(renderIssue(o, site, { comments, attachments: views, changelogStored: histories.length, changelogTotal, changelogStatus: o.changelog_status, commentsTotal: o.comments_total }), "utf8"),
      sourceUpdatedAt: updated,
      ...version,
    },
    {
      ...base,
      op: "put",
      path: `${dir}/issue.json`,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw({ schema: "procmem.jira-issue/v1", issueId: o.content_id, issueKey: o.issue_key, projectId: o.project_id, projectKey: o.project_key, cloudId: o.cloud_id, inaccessibleReason: o.inaccessible_reason }, o.raw_text ?? JSON.stringify(o.raw)),
      sourceUpdatedAt: updated,
      ...version,
    },
    {
      ...base,
      op: "put",
      path: `${dir}/changelog.md`,
      contentType: MD,
      content: Buffer.from(renderChangelog(o, histories, changelogTotal, o.changelog_status), "utf8"),
      sourceUpdatedAt: updated,
    },
  ];
  if (comments.length) {
    const ordered = [...comments].sort((a, b) => a.content_id.localeCompare(b.content_id, undefined, { numeric: true }));
    const body = `{\n  "schema": "procmem.jira-comments/v1",\n  "issueId": ${JSON.stringify(o.content_id)},\n  "comments": [\n${ordered.map((c) => `    ${c.raw_text ?? JSON.stringify(c.raw)}`).join(",\n")}\n  ]\n}\n`;
    out.push({ ...base, op: "put", path: `${dir}/comments.json`, kind: "raw", contentType: "application/json", content: Buffer.from(body, "utf8"), sourceUpdatedAt: comments.map((c) => isoOrNull(c.source_updated_at)).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null });
  }
  const produced = new Set(out.map((c) => c.path));
  const moved = previousPaths.filter((p) => !produced.has(p) && !p.startsWith(`${dir}/`));
  const stale = previousPaths.filter((p) => !produced.has(p) && p.startsWith(`${dir}/`));
  return [
    ...out,
    ...deletes(moved, new Set(), "jira_issue_moved", at, { ...provenance, movedTo: dir }),
    ...deletes(stale, new Set(), "jira_comments_removed", at, provenance),
    ...donor,
  ];
}

async function mapAttachment(ctx: ExportContext, o: ObjectRow, at: string, previousPaths: readonly string[], provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  const issue = o.container_id ? await getObject(ctx.executor, ctx.tenantId, objectRowKey({ connectionId: o.connection_id, cloudId: o.cloud_id }, "issue", o.container_id)) : null;
  if (o.tombstoned_at || !issue || issue.tombstoned_at) {
    const reason = o.tombstoned_at ? tombstoneReason(o) : issue ? `jira_issue_${issue.tombstone_reason ?? "deleted"}` : "jira_issue_unknown";
    return deletes(previousPaths, new Set(), reason, isoOrNull(o.tombstoned_at) ?? isoOrNull(issue?.tombstoned_at) ?? at, provenance);
  }
  const dir = attachmentDir(issueDir(o.cloud_id, o.connection_id, issue.project_key, issue.issue_key, issue.content_id), o.content_id);
  const binary = { status: o.binary_status ?? "pending", sha256: o.binary_sha256, size: o.binary_size === null || o.binary_size === undefined ? null : Number(o.binary_size), mediaType: o.binary_media_type, error: o.binary_error };
  const created = isoOrNull(o.raw.created);
  const out: SourceFileChange[] = [
    {
      op: "put",
      path: `${dir}/_attachment.json`,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw({ schema: "procmem.jira-attachment/v1", attachmentId: o.content_id, issueId: o.container_id, issueKey: issue.issue_key, inaccessibleReason: o.inaccessible_reason }, o.raw_text ?? JSON.stringify(o.raw), { binary }),
      sourceUpdatedAt: created,
      capturedAt: at,
      provenance,
    },
  ];
  if (o.binary_status === "stored" && o.binary_sha256) {
    const blob = await getBlob(ctx.executor, ctx.tenantId, o.binary_sha256);
    if (!blob) throw new Error(`jira attachment ${o.content_id}: blob ${o.binary_sha256} missing`);
    const chunked: SourceChunkedContent = { sha256: blob.sha256, size: blob.size, chunks: blob.chunks, load: (sha) => loadChunk(ctx.executor, ctx.tenantId, sha) };
    out.push({
      op: "put",
      path: `${dir}/${attachmentFileName(o.title, o.content_id)}`,
      kind: "binary",
      contentType: o.binary_media_type ?? "application/octet-stream",
      content: Buffer.alloc(0),
      chunked,
      sourceUpdatedAt: created,
      capturedAt: at,
      provenance: { ...provenance, sha256: blob.sha256 },
    });
  }
  const produced = new Set(out.map((c) => c.path));
  return [...out, ...deletes(previousPaths, produced, previousPaths.some((p) => !p.startsWith(`${dir}/`)) ? "jira_issue_moved" : "source_path_changed", at, provenance)];
}

// ------------------------------------------------------------------ records

export async function mapRecordRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const r = await getRecord(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_RECORDS, rowKey };
  if (!r) return deletes(previousPaths, new Set(), "raw_row_deleted", journal.enqueuedAt, prov);
  const at = capturedAt(r.observed_at, journal);
  const provenance = { ...prov, connectionId: r.connection_id, cloudId: r.cloud_id, contentType: r.content_type, contentId: r.content_id, externalId: r.content_id, recordKind: r.record_kind, endpoint: r.endpoint };
  const head = {
    schema: "procmem.jira-record/v1",
    recordKind: r.record_kind,
    connectionId: r.connection_id,
    cloudId: r.cloud_id,
    contentType: r.content_type,
    contentId: r.content_id,
    historyId: r.history_id,
    endpoint: r.endpoint,
    observedAt: isoOrNull(r.observed_at),
    rawSha256: r.raw_sha256,
  };
  if (r.record_kind === "changelog") {
    return [{ op: "put", path: rawChangelogPath(r.cloud_id, r.connection_id, r.content_id, r.history_id ?? "unknown"), kind: "raw", contentType: "application/json", content: docWithRaw(head, r.raw_text), sourceUpdatedAt: isoOrNull(r.history_created), capturedAt: at, provenance }];
  }
  const fields = r.raw.fields as Record<string, unknown> | undefined;
  const sourceUpdatedAt = isoOrNull(fields?.updated ?? r.raw.updated ?? r.raw.created);
  return [{ op: "put", path: rawObservationPath(r.cloud_id, r.connection_id, r.content_type, r.content_id, r.raw_sha256), kind: "raw", contentType: "application/json", content: docWithRaw(head, r.raw_text), sourceUpdatedAt, capturedAt: at, provenance }];
}

export const JIRA_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: T_SITES, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapSiteRow },
  { table: T_OBJECTS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapObjectRow },
  { table: T_RECORDS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapRecordRow },
];

// ------------------------------------------------------------------ donor mirror cleanup at export

/**
 * Donor mirror files are keyed by <PROJECT>/<KEY> with no site, and the donor
 * ledger ids carry no cloudId, so id-based cleanup is only sound for a tenant
 * with one Jira site (the connections table allows one Jira connection per
 * tenant; a connection can still reach several sites).
 */
async function singleSiteTenant(ctx: ExportContext): Promise<boolean> {
  const r = rowsOf<{ sites: number }>(
    await ctx.executor.execute(sql`SELECT count(DISTINCT cloud_id)::int AS sites FROM jira_source_sites WHERE tenant_id = ${ctx.tenantId}`),
  )[0];
  return Number(r?.sites ?? 0) <= 1;
}

interface DonorFate {
  reason: string;
  at: string;
}

function payloadOf(v: unknown): Record<string, unknown> | null {
  const p = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

/** Donor materializer's project key rule (jiraProjectKey in src/mirror/materializer.ts). */
function donorProjectKey(p: Record<string, unknown>, key: string): string {
  const fields = payloadOf(p.fields);
  const project = payloadOf(p.project) ?? payloadOf(fields?.project);
  return str(p.projectKey) ?? str(p.project_key) ?? str(project?.key) ?? key.split("-")[0] ?? "UNKNOWN";
}

/**
 * Whether the donor mirror file <projectSegment>/<keySegment>.md of issue `issueId`
 * is stale: the newest donor record for that id (by provider update time, not the
 * lexicographically largest key) is a tombstone or carries another key/project
 * (moved / re-keyed issue), or the deep lane holds the issue under another key, or
 * confirmed its deletion after the mirror row was written. Lost access never
 * removes a donor file.
 */
export async function donorMirrorFate(ctx: ExportContext, issueId: string, projectSegment: string, keySegment: string, mirrorUpdatedAt: string | null): Promise<DonorFate | null> {
  if (!(await singleSiteTenant(ctx))) return null;
  const latest = rowsOf<{ event_type: string; raw_payload: unknown; at: unknown }>(
    await ctx.executor.execute(sql`
      SELECT event_type, raw_payload, COALESCE(source_updated_at, timestamp) AS at
      FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'jira'
        AND event_type IN ('issue', 'issue_detail', 'issue.deleted', 'issue_detail.deleted')
        AND (raw_payload->>'id' = ${issueId} OR raw_payload->>'issueId' = ${issueId})
      ORDER BY COALESCE(source_updated_at, timestamp) DESC, created_at DESC, id DESC
      LIMIT 1
    `),
  )[0];
  // Current placement = the newer of the donor's latest record and the deep lane's current row.
  let current: { key: string; project: string; at: string } | null = null;
  if (latest) {
    const at = isoOrNull(latest.at) ?? new Date(0).toISOString();
    if (latest.event_type.endsWith(".deleted")) return { reason: "jira_issue_deleted", at };
    const p = payloadOf(latest.raw_payload);
    const key = p ? str(p.key) ?? str(p.issueKey) ?? str(p.issue_key) : null;
    if (p && key) current = { key, project: donorProjectKey(p, key), at };
  }
  const deep = rowsOf<{ issue_key: string | null; project_key: string | null; tombstoned_at: unknown; tombstone_reason: string | null; source_updated_at: unknown }>(
    await ctx.executor.execute(sql`
      SELECT issue_key, project_key, tombstoned_at, tombstone_reason, source_updated_at FROM jira_source_objects
      WHERE tenant_id = ${ctx.tenantId} AND content_type = 'issue' AND content_id = ${issueId}
    `),
  );
  if (deep.length === 1) {
    const d = deep[0]!;
    if (d.tombstoned_at && ["not_found", "trashed", "project_trashed"].includes(d.tombstone_reason ?? "")) {
      const at = isoOrNull(d.tombstoned_at)!;
      if (!mirrorUpdatedAt || at >= mirrorUpdatedAt) return { reason: d.tombstone_reason === "not_found" ? "jira_issue_deleted" : `jira_${d.tombstone_reason}`, at };
    }
    const deepAt = isoOrNull(d.source_updated_at);
    if (!d.tombstoned_at && d.issue_key && deepAt && (!current || deepAt > current.at)) {
      current = { key: d.issue_key, project: d.project_key ?? d.issue_key.split("-")[0] ?? "UNKNOWN", at: deepAt };
    }
  }
  if (current && (donorSegment(current.key) !== keySegment || donorSegment(current.project) !== projectSegment)) return { reason: "jira_issue_moved", at: current.at };
  return null;
}

/** Donor mirror rows of one issue id (the donor envelope's externalId is the numeric issue id). */
async function donorMirrorPathsForIssue(ctx: ExportContext, issueId: string): Promise<Array<{ path: string; updated_at: unknown }>> {
  return rowsOf<{ path: string; updated_at: unknown }>(
    await ctx.executor.execute(sql`
      SELECT path, updated_at FROM mirror_files
      WHERE user_id = ${ctx.tenantId} AND path LIKE 'sources/jira/%' AND meta->>'externalId' = ${issueId}
    `),
  ).filter((r) => parseDonorMirrorPath(r.path) !== null);
}

/** Deletes for this issue's donor mirror files that are now stale (re-evaluated when a donor or deep record of the issue changes). */
export async function donorMirrorCleanupForIssue(ctx: ExportContext, issueId: string, at: string): Promise<SourceFileChange[]> {
  const out: SourceFileChange[] = [];
  for (const row of await donorMirrorPathsForIssue(ctx, issueId)) {
    const parsed = parseDonorMirrorPath(row.path)!;
    const fate = await donorMirrorFate(ctx, issueId, parsed.projectSegment, parsed.keySegment, isoOrNull(row.updated_at));
    if (fate) out.push({ op: "delete", path: row.path, deletedAt: fate.at > at ? at : fate.at, reason: fate.reason, capturedAt: at, provenance: { provider: PROVIDER, donorMirrorCleanup: true, issueId } });
  }
  return out;
}

/** defaultEventChanges only asks the registry for the raw directory of this event source (avoids a registry import cycle). */
const JIRA_RAW_DIR = { forEventSource: () => ({ id: PROVIDER }) } as unknown as SourceProviderRegistry;

/**
 * Donor mirror rows sources/jira/<PROJECT>/<KEY>.md: the default projection
 * mapping, or a delete when the issue was deleted or now lives under another key
 * (see donorMirrorFate). The donor never removes the old-key file of a moved
 * issue, so without this the same issue would be listed twice.
 */
export async function mapJiraMirror(path: string, row: MirrorFileRow | null, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> {
  const parsed = parseDonorMirrorPath(path);
  if (!parsed || !row) return null;
  const issueId = typeof row.meta?.externalId === "string" && /^\d+$/u.test(row.meta.externalId) ? row.meta.externalId : null;
  if (!issueId) return null;
  const fate = await donorMirrorFate(ctx, issueId, parsed.projectSegment, parsed.keySegment, isoOrNull(row.updated_at));
  if (fate) {
    return [{ op: "delete", path, deletedAt: fate.at < journal.enqueuedAt ? fate.at : journal.enqueuedAt, reason: fate.reason, capturedAt: journal.op === "INSERT" ? (isoOrNull(row.updated_at) ?? journal.enqueuedAt) : journal.enqueuedAt, provenance: { provider: PROVIDER, table: "mirror_files", donorMirrorCleanup: true, issueId } }];
  }
  return defaultMirrorChanges(path, row, journal.enqueuedAt);
}

/**
 * Donor raw rows keep the default raw layout. Issue records (slim sync,
 * proxy detail, tombstones) additionally re-evaluate the donor mirror files of
 * that issue id, so the old-key file of a moved issue is removed at export.
 */
export async function mapJiraEvent(row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[] | null> {
  if (!["issue", "issue_detail", "issue.deleted", "issue_detail.deleted"].includes(row.event_type)) return null;
  const base = defaultEventChanges(JIRA_RAW_DIR, row, journal);
  const payload = payloadOf(row.raw_payload);
  const id = payload ? str(payload.id) ?? str(payload.issueId) : null;
  if (!id || !/^\d+$/u.test(id)) return base;
  return [...base, ...(await donorMirrorCleanupForIssue(ctx, id, journal.enqueuedAt))];
}
