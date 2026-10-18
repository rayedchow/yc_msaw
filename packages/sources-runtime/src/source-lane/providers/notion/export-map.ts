import type { StoredNotionBlockTree } from "../../../integrations/notion/content.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourcePutFile } from "../../core/types.js";
import { isRecord } from "./api.js";
import {
  connectionFile,
  connectionRoot,
  DATA_SOURCE_FILES,
  DATABASE_FILES,
  deepDir,
  fileDir,
  fileNameSegment,
  MAX_TREE_DEPTH,
  nodeSegment,
  PAGE_FILES,
  rawObservationPath,
  rawTreePath,
} from "./paths.js";
import {
  blockForest,
  renderCommentsMarkdown,
  renderDatabaseMarkdown,
  renderDataSourceMarkdown,
  renderPageMarkdown,
  renderTableCsv,
  renderTableMarkdown,
} from "./render.js";
import {
  blockVersionTexts,
  getBlob,
  getBlock,
  getConnection,
  getConnectionByKey,
  getFile,
  getNode,
  getNodeByKey,
  getRecord,
  isoOrNull,
  listFiles,
  listNodes,
  listPageBlocks,
  listPageComments,
  loadChunk,
  recordTextsBySha,
  type NodeRow,
  type Scope,
} from "./store.js";

/**
 * Exporter mappings for the Notion deep lane's journaled tables (drizzle/9450):
 *   notion_source_connections -> _connection.json
 *   notion_source_nodes       -> readable tree (page.md, _data_source.md, _table.csv, ...) + current raw JSON
 *   notion_source_files       -> exact bytes (kind binary, chunked) + _file.json
 *   notion_source_records     -> immutable raw ledger (_raw/...), composed from stored jsonb text
 *
 * Readable paths follow the Notion hierarchy (paths.ts); when a node moves or is renamed the
 * sweep bumps path_epoch on its subtree, every descendant re-exports at its new path and the
 * exporter deletes the old paths (source_path_changed). Trashed / deleted / unshared nodes
 * delete their readable paths (tombstones keep history in the store); raw ledger files are
 * never deleted.
 */

const DONOR = "askshepherd/aqueduct@b26d3f46236a36d64f841539abff2b1ffdace5cf";
const enc = (s: string) => Buffer.from(s, "utf8");

function iso(v: unknown): string {
  return isoOrNull(v) ?? new Date(0).toISOString();
}

function deletes(previousPaths: readonly string[], reason: string, at: string, journal: JournalInfo, provenance: Record<string, unknown>): SourceFileChange[] {
  return previousPaths.map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: journal.enqueuedAt, provenance: { donor: DONOR, ...provenance } }));
}

function scopeOf(row: { tenant_id: string; connection_id: string }): Scope {
  return { tenantId: row.tenant_id, connectionId: row.connection_id };
}

async function rootFor(ctx: ExportContext, scope: Scope): Promise<string> {
  const conn = await getConnection(ctx.executor, scope);
  return connectionRoot(conn?.workspace_id ?? null, scope.connectionId);
}

export interface ResolvedDir {
  root: string;
  dir: string;
  /** Ancestors, outermost first (title + id), for breadcrumbs. */
  ancestors: Array<{ title: string; objectType: string; objectId: string }>;
}

/**
 * Directory of a node: its known ancestors' segments under the connection root. A parent that
 * was never captured (not shared with the connection) makes the node top-level; a tombstoned
 * parent still places its not-yet-tombstoned children (no churn while trash propagates).
 */
export async function nodeDir(ctx: ExportContext, scope: Scope, node: NodeRow): Promise<ResolvedDir> {
  const root = await rootFor(ctx, scope);
  const chain: NodeRow[] = [node];
  const seen = new Set<string>([node.object_id]);
  let current: NodeRow = node;
  for (let i = 0; i < MAX_TREE_DEPTH + 2; i++) {
    let parentId: string | null = null;
    if (current.parent_type === "block_id" && current.parent_id) {
      parentId = (await getBlock(ctx.executor, scope, current.parent_id))?.page_id ?? null;
    } else if (current.parent_type === "page_id" || current.parent_type === "data_source_id" || current.parent_type === "database_id") {
      parentId = current.parent_id;
    }
    if (!parentId || seen.has(parentId)) break;
    const parent = await getNode(ctx.executor, scope, parentId);
    if (!parent) break;
    seen.add(parentId);
    chain.push(parent);
    current = parent;
  }
  chain.reverse();
  const segs = chain.map((n) => nodeSegment(n.object_type, n.title, n.object_id));
  const dir = segs.length > MAX_TREE_DEPTH ? deepDir(root, segs[segs.length - 1]!) : `${root}/${segs.join("/")}`;
  return { root, dir, ancestors: chain.slice(0, -1).map((n) => ({ title: n.title, objectType: n.object_type, objectId: n.object_id })) };
}

function put(path: string, kind: SourcePutFile["kind"], contentType: string, content: Buffer, sourceUpdatedAt: string | null, capturedAt: string, ref: string | null, provenance: Record<string, unknown>): SourcePutFile {
  return {
    op: "put",
    path,
    kind,
    contentType,
    content,
    sourceUpdatedAt,
    capturedAt,
    ...(ref ? { sourceVersion: { ref } } : {}),
    provenance: { donor: DONOR, ...provenance },
  };
}

// ------------------------------------------------------------------ connections

async function mapConnection(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const row = await getConnectionByKey(ctx.executor, ctx.tenantId, rowKey);
  if (!row) return deletes(previousPaths, "notion_connection_removed", journal.enqueuedAt, journal, { table: "notion_source_connections", rowKey });
  const root = connectionRoot(row.workspace_id, row.connection_id);
  const body = {
    schema: "notion-source/connection@1",
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    botId: row.bot_id,
    authMode: row.auth_mode,
    owner: row.owner,
    bot: row.bot,
    status: row.status,
    statusReason: row.status_reason,
    capabilityDenials: row.capabilities,
    firstSeenAt: isoOrNull(row.first_seen_at),
    notionVersion: "2026-03-11",
  };
  return [put(connectionFile(root), "raw", "application/json", enc(`${JSON.stringify(body, null, 2)}\n`), null, journal.enqueuedAt, null, { table: "notion_source_connections", rowKey })];
}

// ------------------------------------------------------------------ nodes

async function mapNode(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const node = await getNodeByKey(ctx.executor, ctx.tenantId, rowKey);
  const prov = { table: "notion_source_nodes", rowKey };
  if (!node) return deletes(previousPaths, "notion_row_removed", journal.enqueuedAt, journal, prov);
  if (node.tombstoned_at) return deletes(previousPaths, node.tombstone_reason ?? "notion_tombstoned", iso(node.tombstoned_at), journal, { ...prov, externalId: node.object_id });
  const scope = scopeOf(node);
  const { dir, ancestors } = await nodeDir(ctx, scope, node);
  const capturedAt = iso(node.updated_at);
  const edited = isoOrNull(node.last_edited_time);
  const p = { ...prov, externalId: node.object_id, objectType: node.object_type, notionUrl: node.url };
  if (node.object_type === "page") return mapPage(ctx, scope, node, dir, ancestors, capturedAt, edited, p);
  if (node.object_type === "data_source") return mapDataSource(ctx, scope, node, dir, capturedAt, edited, p);
  const dataSources = await listNodes(ctx.executor, scope, { types: ["data_source"], databaseId: node.object_id });
  return [
    put(`${dir}/${DATABASE_FILES.markdown}`, "projection", "text/markdown", enc(renderDatabaseMarkdown(node, dataSources)), edited, capturedAt, edited, p),
    put(`${dir}/${DATABASE_FILES.raw}`, "raw", "application/json", enc(rawNodeJson(node)), edited, capturedAt, edited, p),
  ];
}

function rawNodeJson(node: NodeRow): string {
  return `{"schema":"notion-source/${node.object_type}@1","objectId":${JSON.stringify(node.object_id)},"connectionId":${JSON.stringify(node.connection_id)},`
    + `"lastEditedTime":${JSON.stringify(isoOrNull(node.last_edited_time))},"observedAt":${JSON.stringify(isoOrNull(node.updated_at))},`
    + `"inaccessible":${node.inaccessible_at ? JSON.stringify(node.inaccessible_reason ?? "inaccessible") : "null"},`
    + `"raw":${node.raw_text}`
    + (node.object_type === "page" ? `,"hydratedProperties":${node.hydrated_properties_text ?? "null"},"propertiesStatus":${JSON.stringify(node.properties_status)}` : "")
    + "}\n";
}

async function syncedSourceSubtrees(ctx: ExportContext, scope: Scope, blocks: ReadonlyArray<{ block_id: string; raw_text: string }>): Promise<Map<string, StoredNotionBlockTree[]>> {
  const out = new Map<string, StoredNotionBlockTree[]>();
  let resolved = 0;
  for (const b of blocks) {
    if (resolved >= 50) break;
    if (!b.raw_text.includes('"synced_from"')) continue;
    const raw = JSON.parse(b.raw_text) as Record<string, unknown>;
    const sb = isRecord(raw.synced_block) ? raw.synced_block : null;
    const from = sb && isRecord(sb.synced_from) && typeof sb.synced_from.block_id === "string" ? sb.synced_from.block_id : null;
    if (!from) continue;
    const original = await getBlock(ctx.executor, scope, from);
    if (!original || original.tombstoned_at) continue;
    const forest = blockForest(original.block_id, await listPageBlocks(ctx.executor, scope, original.page_id));
    out.set(b.block_id, forest.roots);
    resolved += 1;
  }
  return out;
}

async function mapPage(ctx: ExportContext, scope: Scope, node: NodeRow, dir: string, ancestors: ResolvedDir["ancestors"], capturedAt: string, edited: string | null, p: Record<string, unknown>): Promise<SourceFileChange[]> {
  const blocks = await listPageBlocks(ctx.executor, scope, node.object_id);
  const forest = blockForest(node.object_id, blocks, await syncedSourceSubtrees(ctx, scope, blocks));
  const comments = await listPageComments(ctx.executor, scope, node.object_id);
  const files = await listFiles(ctx.executor, scope, { pageId: node.object_id, live: true });
  const childPagePaths = new Map<string, string>();
  for (const b of blocks) {
    if (b.block_type !== "child_page") continue;
    const child = await getNode(ctx.executor, scope, b.block_id);
    if (child && !child.tombstoned_at) childPagePaths.set(b.block_id, `${encodeURI(nodeSegment("page", child.title, child.object_id))}/page.md`);
  }
  const out: SourceFileChange[] = [
    put(`${dir}/${PAGE_FILES.markdown}`, "projection", "text/markdown", enc(renderPageMarkdown({ node, forest, comments, files, childPagePaths, breadcrumb: ancestors })), edited, capturedAt, edited, p),
    put(`${dir}/${PAGE_FILES.raw}`, "raw", "application/json", enc(rawNodeJson(node)), edited, capturedAt, edited, p),
    put(`${dir}/${PAGE_FILES.blocks}`, "raw", "application/json", enc(
      `{"schema":"notion-source/blocks@1","pageId":${JSON.stringify(node.object_id)},"walkStatus":${JSON.stringify(node.walk_status)},`
      + `"walkedAt":${JSON.stringify(isoOrNull(node.walked_at))},"blockCount":${forest.blockIds.length},"blocks":${forest.rawText}}\n`,
    ), edited, capturedAt, edited, p),
  ];
  if (comments.length) {
    const labels = new Map(blocks.map((b) => [b.block_id, b.block_type]));
    out.push(put(`${dir}/${PAGE_FILES.commentsMarkdown}`, "projection", "text/markdown", enc(renderCommentsMarkdown(node, comments, labels)), edited, capturedAt, null, p));
    const items = comments.map((c) => `{"status":${JSON.stringify(c.status)},"blockId":${JSON.stringify(c.block_id)},"discussionId":${JSON.stringify(c.discussion_id)},`
      + `"deletedAt":${JSON.stringify(isoOrNull(c.deleted_at))},"deletedReason":${JSON.stringify(c.deleted_reason)},"comment":${c.raw_text}}`);
    out.push(put(`${dir}/${PAGE_FILES.commentsRaw}`, "raw", "application/json", enc(`{"schema":"notion-source/comments@1","pageId":${JSON.stringify(node.object_id)},"comments":[${items.join(",")}]}\n`), edited, capturedAt, null, p));
  }
  return out;
}

async function mapDataSource(ctx: ExportContext, scope: Scope, node: NodeRow, dir: string, capturedAt: string, edited: string | null, p: Record<string, unknown>): Promise<SourceFileChange[]> {
  const rows = (await listNodes(ctx.executor, scope, { types: ["page"], parentId: node.object_id, live: true }))
    .sort((a, b) => iso(a.created_time).localeCompare(iso(b.created_time)) || a.object_id.localeCompare(b.object_id));
  const tableUpdated = [edited, ...rows.map((r) => isoOrNull(r.last_edited_time))].filter((x): x is string => !!x).sort().pop() ?? null;
  return [
    put(`${dir}/${DATA_SOURCE_FILES.markdown}`, "projection", "text/markdown", enc(renderDataSourceMarkdown(node, rows.length, node.query_status)), edited, capturedAt, null, p),
    put(`${dir}/${DATA_SOURCE_FILES.raw}`, "raw", "application/json", enc(rawNodeJson(node)), edited, capturedAt, edited, p),
    put(`${dir}/${DATA_SOURCE_FILES.csv}`, "projection", "text/csv", enc(renderTableCsv(node, rows)), tableUpdated, capturedAt, null, p),
    put(`${dir}/${DATA_SOURCE_FILES.table}`, "projection", "text/markdown", enc(renderTableMarkdown(node, rows)), tableUpdated, capturedAt, null, p),
  ];
}

// ------------------------------------------------------------------ files

async function mapFile(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const f = await getFile(ctx.executor, ctx.tenantId, rowKey);
  const prov = { table: "notion_source_files", rowKey };
  if (!f) return deletes(previousPaths, "notion_row_removed", journal.enqueuedAt, journal, prov);
  if (f.tombstoned_at) return deletes(previousPaths, f.tombstone_reason ?? "notion_file_removed", iso(f.tombstoned_at), journal, prov);
  const scope = scopeOf(f);
  const container = await getNode(ctx.executor, scope, f.page_id);
  if (!container || container.tombstoned_at) return deletes(previousPaths, "notion_container_removed", journal.enqueuedAt, journal, prov);
  const { dir } = await nodeDir(ctx, scope, container);
  const fdir = fileDir(dir, f.file_key);
  const capturedAt = iso(f.updated_at);
  const ownerEdited = isoOrNull(f.owner_last_edited_time);
  const p = { ...prov, externalId: f.file_key, ownerType: f.owner_type, ownerId: f.owner_id };
  const meta = {
    schema: "notion-source/file@1",
    fileKey: f.file_key,
    ownerType: f.owner_type,
    ownerId: f.owner_id,
    containerId: f.page_id,
    slot: f.slot,
    sourceType: f.source_type,
    name: f.name,
    location: f.url_host ? { host: f.url_host, path: f.url_path } : null,
    fileUploadId: f.file_upload_id,
    bytes: { status: f.status, sha256: f.sha256, size: f.size, mediaType: f.media_type, error: f.error, fetchedAt: isoOrNull(f.fetched_at) },
    ownerLastEditedTime: ownerEdited,
    note: f.source_type === "file"
      ? "Notion-hosted file: bytes fetched from a one-hour signed URL that is never stored."
      : f.source_type === "external" ? "External link: not fetched (arbitrary host)." : "File upload reference: not attached to a Notion-hosted file.",
  };
  const out: SourceFileChange[] = [put(`${fdir}/_file.json`, "raw", "application/json", enc(`${JSON.stringify(meta, null, 2)}\n`), ownerEdited, capturedAt, null, p)];
  if (f.status === "stored" && f.sha256) {
    const blob = await getBlob(ctx.executor, ctx.tenantId, f.sha256);
    if (blob) {
      const tenantId = ctx.tenantId;
      const executor = ctx.executor;
      out.push({
        op: "put",
        path: `${fdir}/${fileNameSegment(f.name, "file")}`,
        kind: "binary",
        contentType: f.media_type ?? "application/octet-stream",
        content: Buffer.alloc(0),
        chunked: { sha256: blob.sha256, size: blob.size, chunks: blob.chunks, load: (sha) => loadChunk(executor, tenantId, sha) },
        sourceUpdatedAt: ownerEdited,
        capturedAt: iso(f.fetched_at ?? f.updated_at),
        sourceVersion: { ref: blob.sha256 },
        provenance: { donor: DONOR, ...p, sha256: blob.sha256 },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ raw ledger

async function mapRecord(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const r = await getRecord(ctx.executor, ctx.tenantId, rowKey);
  const prov = { table: "notion_source_records", rowKey };
  if (!r) return deletes(previousPaths, "raw_row_deleted", journal.enqueuedAt, journal, prov);
  const scope = scopeOf(r);
  const root = await rootFor(ctx, scope);
  const observedAt = iso(r.observed_at);
  const p = { ...prov, externalId: r.object_id, recordKind: r.record_kind };
  if (r.record_kind === "observation") {
    const text = `{"schema":"notion-source/observation@1","objectType":${JSON.stringify(r.object_type)},"objectId":${JSON.stringify(r.object_id)},`
      + `"connectionId":${JSON.stringify(r.connection_id)},"observedAt":${JSON.stringify(observedAt)},"endpoint":${JSON.stringify(r.endpoint)},`
      + `"rawSha256":${JSON.stringify(r.raw_sha256)},"raw":${r.raw_text}}\n`;
    return [put(rawObservationPath(root, r.object_type, r.object_id, observedAt, r.raw_sha256), "raw", "application/json", enc(text), observedAt, observedAt, null, p)];
  }
  return [put(rawTreePath(root, r.object_id, observedAt, r.raw_sha256), "raw", "application/json", enc(await composeTree(ctx, scope, r.raw, observedAt, r.raw_sha256)), observedAt, observedAt, null, p)];
}

interface TreeNodeRef { id: string; sha: string; children?: TreeNodeRef[] }

/** Exact page state from a tree record: every referenced payload spliced from its stored jsonb text. */
async function composeTree(ctx: ExportContext, scope: Scope, tree: Record<string, unknown>, observedAt: string, sha: string): Promise<string> {
  const page = isRecord(tree.page) ? tree.page as unknown as TreeNodeRef : null;
  const blocks = Array.isArray(tree.blocks) ? tree.blocks as TreeNodeRef[] : [];
  const comments = Array.isArray(tree.comments) ? tree.comments as Array<TreeNodeRef & { blockId: string | null; status: string }> : [];
  const flat: TreeNodeRef[] = [];
  const walk = (list: TreeNodeRef[]) => list.forEach((b) => { flat.push(b); walk(b.children ?? []); });
  walk(blocks);
  const blockTexts = await blockVersionTexts(ctx.executor, scope, flat.map((b) => ({ id: b.id, sha: b.sha })));
  const pageTexts = page ? await recordTextsBySha(ctx.executor, scope, "page", [{ id: page.id, sha: page.sha }]) : new Map<string, string>();
  const commentTexts = await recordTextsBySha(ctx.executor, scope, "comment", comments.map((c) => ({ id: c.id, sha: c.sha })));
  const missing = (s: string) => `{"missing":true,"sha256":${JSON.stringify(s)}}`;
  const render = (list: TreeNodeRef[]): string => `[${list.map((b) => `{"block":${blockTexts.get(`${b.id}\u0000${b.sha}`) ?? missing(b.sha)},"children":${render(b.children ?? [])}}`).join(",")}]`;
  const pageText = page ? pageTexts.get(`${page.id}\u0000${page.sha}`) ?? missing(page.sha) : "null";
  const commentText = comments.map((c) => `{"status":${JSON.stringify(c.status)},"blockId":${JSON.stringify(c.blockId)},"comment":${commentTexts.get(`${c.id}\u0000${c.sha}`) ?? missing(c.sha)}}`);
  return `{"schema":"notion-source/tree@1","pageId":${JSON.stringify(page?.id ?? null)},"observedAt":${JSON.stringify(observedAt)},"treeSha256":${JSON.stringify(sha)},`
    + `"page":${pageText},"blocks":${render(blocks)},"comments":[${commentText.join(",")}]}\n`;
}

export const NOTION_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: "notion_source_connections", tenantColumn: "tenant_id", keyColumn: "row_key", map: mapConnection },
  { table: "notion_source_nodes", tenantColumn: "tenant_id", keyColumn: "row_key", map: mapNode },
  { table: "notion_source_files", tenantColumn: "tenant_id", keyColumn: "row_key", map: mapFile },
  { table: "notion_source_records", tenantColumn: "tenant_id", keyColumn: "row_key", map: mapRecord },
];
