import type { NotionBlock, NotionComment } from "../../../integrations/notion/client.js";
import {
  renderNotionPropertyValue,
  renderStoredNotionBlocks,
  renderStoredNotionComments,
  type StoredNotionBlockTree,
} from "../../../integrations/notion/content.js";
import { isRecord, type JsonObject } from "./api.js";
import { fileRelativePath, nodeSegment } from "./paths.js";
import type { BlockRow, CommentRow, FileRow, NodeRow } from "./store.js";

/**
 * Readable projections of the Notion deep lane. Block markdown, property values and
 * comments are rendered by the donor walker's own functions (content.ts:
 * renderStoredNotionBlocks / renderNotionPropertyValue / renderStoredNotionComments), so
 * the projections match what the donor lane renders for the same blocks; this module only
 * adds front matter, the property table, the native table export and links to the
 * captured file bytes.
 */

export interface BlockForest {
  roots: StoredNotionBlockTree[];
  /** Exact raw JSON text of the nested forest (stored jsonb text spliced, never re-serialized). */
  rawText: string;
  blockIds: string[];
}

/** Build the ordered block forest of a page from its stored blocks (children by parent, Notion order). */
export function blockForest(pageId: string, blocks: readonly BlockRow[], syncedSources?: ReadonlyMap<string, StoredNotionBlockTree[]>): BlockForest {
  const byParent = new Map<string, BlockRow[]>();
  for (const b of blocks) {
    const list = byParent.get(b.parent_id) ?? [];
    list.push(b);
    byParent.set(b.parent_id, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position || a.block_id.localeCompare(b.block_id));
  const ids: string[] = [];
  const seen = new Set<string>();
  const build = (parentId: string): { trees: StoredNotionBlockTree[]; text: string } => {
    const kids = (byParent.get(parentId) ?? []).filter((b) => !seen.has(b.block_id));
    const trees: StoredNotionBlockTree[] = [];
    const texts: string[] = [];
    for (const b of kids) {
      seen.add(b.block_id);
      ids.push(b.block_id);
      const child = build(b.block_id);
      const block = JSON.parse(b.raw_text) as NotionBlock;
      const synced = syncedSources?.get(b.block_id);
      trees.push({ block, children: child.trees, ...(synced ? { syncedSourceChildren: synced } : {}) });
      texts.push(`{"block":${b.raw_text},"children":${child.text}}`);
    }
    return { trees, text: `[${texts.join(",")}]` };
  };
  const top = build(pageId);
  return { roots: top.trees, rawText: top.text, blockIds: ids };
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

function frontMatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return `---\n${lines.join("\n")}\n---`;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function personName(v: unknown): string | null {
  if (!isRecord(v)) return null;
  return (typeof v.name === "string" && v.name) || (typeof v.id === "string" ? v.id : null);
}

/**
 * Property object with hydrated items (paginated property endpoint results) merged in,
 * using the donor walker's payload rules (items' `<type>` values; rollup/formula take the
 * terminal property_item value).
 */
export function hydratedProperty(prop: JsonObject, hydrated: unknown): JsonObject {
  if (!isRecord(hydrated) || !Array.isArray(hydrated.results)) return prop;
  const type = typeof prop.type === "string" ? prop.type : null;
  if (!type) return prop;
  const terminal = isRecord(hydrated.property_item) ? hydrated.property_item : null;
  if (type === "rollup" && terminal && isRecord(terminal.rollup)) return { ...prop, rollup: { ...(isRecord(prop.rollup) ? prop.rollup : {}), ...terminal.rollup } };
  if (type === "formula" && terminal && isRecord(terminal.formula)) return { ...prop, formula: terminal.formula };
  if (type === "formula" || type === "rollup") {
    const single = hydrated.results.find((r) => isRecord(r) && isRecord(r[type]));
    if (isRecord(single)) return { ...prop, [type]: single[type] };
    return prop;
  }
  return { ...prop, [type]: hydrated.results.map((r) => (isRecord(r) && type in r ? r[type] : r)), has_more: false };
}

export function propertyRows(raw: JsonObject, hydrated: Record<string, unknown> | null): Array<{ name: string; type: string; value: string; id: string | null }> {
  if (!isRecord(raw.properties)) return [];
  const out: Array<{ name: string; type: string; value: string; id: string | null }> = [];
  for (const [name, p] of Object.entries(raw.properties)) {
    if (!isRecord(p)) continue;
    const id = typeof p.id === "string" ? p.id : null;
    const prop = id && hydrated && id in hydrated ? hydratedProperty(p, hydrated[id]) : p;
    out.push({ name, type: typeof p.type === "string" ? p.type : "unknown", value: renderNotionPropertyValue(prop, { fallbackTitle: "" }), id });
  }
  return out;
}

function cell(v: string): string {
  return v.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

export interface PageRenderInput {
  node: NodeRow;
  forest: BlockForest;
  comments: readonly CommentRow[];
  files: readonly FileRow[];
  childPagePaths: ReadonlyMap<string, string>;
  breadcrumb: Array<{ title: string; objectType: string; objectId: string }>;
}

export function renderPageMarkdown(input: PageRenderInput): string {
  const { node } = input;
  const raw = node.raw;
  const byBlock = new Map<string, NotionComment[]>();
  const pageComments: NotionComment[] = [];
  for (const c of input.comments) {
    if (c.status !== "open") continue;
    const parsed = JSON.parse(c.raw_text) as NotionComment;
    if (c.block_id) byBlock.set(c.block_id, [...(byBlock.get(c.block_id) ?? []), parsed]);
    else pageComments.push(parsed);
  }
  const rendered = renderStoredNotionBlocks({
    roots: input.forest.roots,
    commentsByBlockId: byBlock,
    childPagePaths: input.childPagePaths,
    breadcrumbTrail: input.breadcrumb.map((b) => ({ objectType: b.objectType as "page", objectId: b.objectId, title: b.title, url: null, parentType: null, parentId: null })),
  });
  const parts: string[] = [];
  parts.push(frontMatter({
    notion_id: node.object_id,
    notion_object: "page",
    title: node.title,
    url: node.url,
    parent_type: node.parent_type,
    parent_id: node.parent_id,
    database_id: node.object_type === "page" ? node.database_id : undefined,
    created_time: iso(node.created_time),
    created_by: personName(raw.created_by),
    last_edited_time: iso(node.last_edited_time),
    last_edited_by: personName(raw.last_edited_by),
    locked: node.is_locked,
    blocks: input.forest.blockIds.length,
    open_comments: input.comments.filter((c) => c.status === "open").length,
  }));
  parts.push(`# ${node.title || "Untitled"}`);
  if (input.breadcrumb.length) parts.push(`_Path: ${input.breadcrumb.map((b) => b.title || "Untitled").join(" / ")}_`);
  const props = propertyRows(raw, node.hydrated_properties).filter((p) => p.type !== "title");
  if (props.length) {
    parts.push(["## Properties", "", "| Property | Type | Value |", "| --- | --- | --- |", ...props.map((p) => `| ${cell(p.name)} | ${p.type} | ${cell(p.value)} |`)].join("\n"));
  }
  if (rendered.markdown.trim()) parts.push(rendered.markdown.trim());
  else parts.push("_This page has no content blocks._");
  const pageCommentText = renderStoredNotionComments(pageComments);
  if (pageCommentText) parts.push(`## Page comments\n\n${pageCommentText}`);
  const files = input.files.filter((f) => !f.tombstoned_at);
  if (files.length) parts.push(["## Files", "", ...files.map(fileLine)].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

function fileLine(f: FileRow): string {
  const label = `${f.name ?? "file"} (${f.owner_type} ${f.owner_id}${f.slot === "block" ? "" : `, ${f.slot}`})`;
  if (f.status === "stored") return `- [${label}](${fileRelativePath(f.file_key, f.name)}) - ${f.size ?? 0} bytes, ${f.media_type ?? "unknown type"}`;
  if (f.status === "external") return `- ${label} - external link to ${f.url_host ?? "unknown host"} (not archived)`;
  return `- ${label} - bytes not archived (${f.status}${f.error ? `: ${f.error}` : ""})`;
}

export function renderCommentsMarkdown(node: NodeRow, comments: readonly CommentRow[], blockLabels: ReadonlyMap<string, string>): string {
  const groups = new Map<string, CommentRow[]>();
  for (const c of comments) {
    const key = c.discussion_id ?? `comment:${c.comment_id}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const parts = [`# Comments on ${node.title || "Untitled"}`];
  for (const [key, list] of groups) {
    const first = list[0]!;
    const target = first.block_id ? `block ${first.block_id}${blockLabels.get(first.block_id) ? ` (${blockLabels.get(first.block_id)})` : ""}` : "page";
    parts.push(`## Discussion ${key.startsWith("comment:") ? first.comment_id : key}\n\n- Anchored to: ${target}`);
    for (const c of list) {
      const rawComment = JSON.parse(c.raw_text) as NotionComment;
      const body = renderStoredNotionComments([rawComment]) || "- _No text_";
      const status = c.status === "deleted"
        ? `deleted (detected ${iso(c.deleted_at) ?? "unknown"}${c.deleted_reason ? `, ${c.deleted_reason}` : ""})`
        : c.status;
      parts.push(`### Comment ${c.comment_id}\n\n- Status: ${status}\n- Created: ${iso(c.created_time) ?? "unknown"}\n- Last edited: ${iso(c.last_edited_time) ?? "unknown"}\n\n${body}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

export function renderDatabaseMarkdown(node: NodeRow, dataSources: readonly NodeRow[]): string {
  const parts = [
    frontMatter({
      notion_id: node.object_id,
      notion_object: "database",
      title: node.title,
      url: node.url,
      parent_type: node.parent_type,
      parent_id: node.parent_id,
      inline: node.raw.is_inline === true,
      locked: node.is_locked,
      created_time: iso(node.created_time),
      last_edited_time: iso(node.last_edited_time),
    }),
    `# ${node.title || "Untitled database"}`,
  ];
  const listed = Array.isArray(node.raw.data_sources) ? node.raw.data_sources.filter(isRecord) : [];
  const lines = listed.map((ds) => {
    const id = String(ds.id ?? "");
    const captured = dataSources.find((d) => d.object_id.replace(/-/gu, "") === id.replace(/-/gu, ""));
    const title = captured?.title || (typeof ds.name === "string" ? ds.name : "") || "Untitled data source";
    return captured && !captured.tombstoned_at
      ? `- [${title}](${encodeURI(nodeSegment("data_source", captured.title, captured.object_id))}/_data_source.md)`
      : `- ${title} (${id}, not captured)`;
  });
  parts.push(["## Data sources", "", ...(lines.length ? lines : ["_None listed._"])].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

export function renderDataSourceMarkdown(node: NodeRow, rowCount: number, queryStatus: string | null): string {
  const schema = isRecord(node.raw.properties) ? Object.entries(node.raw.properties).filter(([, p]) => isRecord(p)) as Array<[string, JsonObject]> : [];
  const rows = schema.map(([name, p]) => `| ${cell(name)} | ${String(p.type ?? "")} | ${cell(schemaDetail(p))} |`);
  return [
    frontMatter({
      notion_id: node.object_id,
      notion_object: "data_source",
      title: node.title,
      url: node.url,
      database_id: node.database_id,
      created_time: iso(node.created_time),
      last_edited_time: iso(node.last_edited_time),
      rows: rowCount,
      rows_query: queryStatus ?? "not queried",
    }),
    `# ${node.title || "Untitled data source"}`,
    ["## Schema", "", "| Property | Type | Configuration |", "| --- | --- | --- |", ...rows].join("\n"),
    `Rows: ${rowCount} (see [_table.csv](_table.csv); each row is a page directory here).`,
  ].join("\n\n") + "\n";
}

function schemaDetail(p: JsonObject): string {
  const type = typeof p.type === "string" ? p.type : "";
  const conf = isRecord(p[type]) ? p[type] as JsonObject : {};
  if (Array.isArray(conf.options)) return conf.options.filter(isRecord).map((o) => String(o.name ?? "")).join(", ");
  if (type === "relation") return `-> data source ${String(conf.data_source_id ?? conf.database_id ?? "")}`;
  if (type === "formula" && isRecord(conf) && typeof conf.expression === "string") return conf.expression;
  if (type === "rollup") return `${String(conf.relation_property_name ?? "")}.${String(conf.rollup_property_name ?? "")} (${String(conf.function ?? "")})`;
  if (type === "number" && typeof conf.format === "string") return conf.format;
  return "";
}

function csvField(v: string): string {
  return /[",\r\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
}

/** Native table export of a data source: one row per live row page, columns in schema order. */
/** Schema property names, title property first (Notion does not guarantee key order). */
export function schemaColumns(ds: NodeRow): string[] {
  if (!isRecord(ds.raw.properties)) return [];
  const entries = Object.entries(ds.raw.properties);
  const title = entries.filter(([, p]) => isRecord(p) && p.type === "title").map(([n]) => n);
  return [...title, ...entries.map(([n]) => n).filter((n) => !title.includes(n))];
}

export function renderTableCsv(ds: NodeRow, rows: readonly NodeRow[]): string {
  const schema = schemaColumns(ds);
  const header = ["notion_id", ...schema, "created_time", "last_edited_time", "path"];
  const lines = [header.map(csvField).join(",")];
  for (const r of rows) {
    const values = new Map(propertyRows(r.raw, r.hydrated_properties).map((p) => [p.name, p.value]));
    lines.push([
      r.object_id,
      ...schema.map((name) => values.get(name) ?? ""),
      iso(r.created_time) ?? "",
      iso(r.last_edited_time) ?? "",
      `${nodeSegment("page", r.title, r.object_id)}/page.md`,
    ].map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const TABLE_MARKDOWN_MAX_ROWS = 500;

export function renderTableMarkdown(ds: NodeRow, rows: readonly NodeRow[]): string {
  const schema = schemaColumns(ds);
  const parts = [`# ${ds.title || "Untitled data source"} (table)`];
  if (rows.length > TABLE_MARKDOWN_MAX_ROWS) {
    parts.push(`${rows.length} rows: too many for a markdown table; the complete table is [_table.csv](_table.csv).`);
    return `${parts.join("\n\n")}\n`;
  }
  const head = `| ${schema.map(cell).join(" | ")} |`;
  const sep = `| ${schema.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => {
    const values = new Map(propertyRows(r.raw, r.hydrated_properties).map((p) => [p.name, p.value]));
    return `| ${schema.map((name, i) => {
      const v = cell(values.get(name) ?? "");
      return i === 0 ? `[${v || "Untitled"}](${encodeURI(nodeSegment("page", r.title, r.object_id))}/page.md)` : v;
    }).join(" | ")} |`;
  });
  parts.push(schema.length ? [head, sep, ...body].join("\n") : "_No schema._");
  return `${parts.join("\n\n")}\n`;
}
