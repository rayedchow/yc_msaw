import { adfToMarkdown } from "../../../integrations/atlassian/adf.js";
import { storageFormatToMarkdown } from "../../../integrations/atlassian/storage-format.js";
import type { ObjectRow, RecordRow } from "./store.js";

/**
 * Readable projections of the deep lane. Bodies go through the donor
 * converters unchanged: storage-format XHTML via storageFormatToMarkdown
 * (src/integrations/atlassian/storage-format.ts) and, when only ADF is
 * available, adfToMarkdown (adf.ts). Layout and comment semantics follow the
 * donor materializer: "- Label: value" metadata, reply threading by
 * parentCommentId with orphans at top level, inline-comment highlighted text
 * and resolution status, latest live version per comment.
 */

type Rec = Record<string, unknown>;

export function obj(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

export function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function inline(v: string): string {
  return v.replace(/\s+/gu, " ").trim();
}

function heading(v: string): string {
  return inline(v) || "Untitled";
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function meta(rows: Array<[string, string | null | undefined]>): string {
  return rows
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

/** Storage-format body of a v2 page/blogpost/comment payload (body.storage.value), else null. */
export function storageBody(payload: Rec): string | null {
  const body = obj(payload.body);
  const storage = obj(body?.storage);
  return str(storage?.value) ?? str(payload.bodyStorage) ?? str(body?.value);
}

/** ADF document from a stored ADF column or a payload's body.atlas_doc_format.value (a JSON string in v2). */
export function adfDocument(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const o = obj(value);
  if (!o) return null;
  if (o.type === "doc") return o;
  const nested = obj(obj(o.body)?.atlas_doc_format)?.value ?? obj(o.atlas_doc_format)?.value ?? o.value;
  return nested !== undefined && nested !== value ? adfDocument(nested) : null;
}

export function renderBody(payload: Rec, adf: unknown): { markdown: string; format: "storage" | "atlas_doc_format" | "none" } {
  const storage = storageBody(payload);
  if (storage) return { markdown: storageFormatToMarkdown(storage), format: "storage" };
  const doc = adfDocument(adf) ?? adfDocument(payload);
  if (doc) return { markdown: adfToMarkdown(doc), format: "atlas_doc_format" };
  return { markdown: "", format: "none" };
}

function versionOf(payload: Rec): Rec | null {
  return obj(payload.version);
}

function webui(payload: Rec, siteUrl: string | null): string | null {
  const links = obj(payload._links);
  const rel = str(links?.webui);
  if (!rel) return null;
  if (/^https:\/\//iu.test(rel)) return rel;
  const base = str(links?.base) ?? (siteUrl ? `${siteUrl.replace(/\/+$/u, "")}/wiki` : null);
  return base ? `${base}${rel.startsWith("/") ? "" : "/"}${rel}` : null;
}

export interface SiteView {
  cloudId: string;
  connectionId: string;
  siteUrl: string | null;
  siteName: string | null;
}

export interface AttachmentView {
  id: string;
  title: string | null;
  mediaType: string | null;
  fileSize: number | null;
  version: number | null;
  binaryStatus: string | null;
  relPath: string | null;
}

export function renderContainer(
  o: ObjectRow,
  site: SiteView,
  extra: { attachments: AttachmentView[]; liveComments: number; restrictionsSummary: string | null },
): string {
  const p = o.raw;
  const v = versionOf(p);
  const body = renderBody(p, o.adf);
  const kind = o.content_type === "page" ? "Page" : "Blog post";
  const lines = [
    `# ${heading(o.title ?? str(p.title) ?? o.content_id)}`,
    "",
    meta([
      ["Source", "Confluence"],
      ["Site", site.siteUrl ?? site.cloudId],
      // Space name/key live in ../../_space.md (a rename must not leave stale copies here).
      ["Space ID", o.space_id],
      [`${kind} ID`, o.content_id],
      ["Status", o.status],
      ["Version", o.version_number !== null ? `v${o.version_number}` : null],
      ["Version created", iso(v?.createdAt) ?? iso(o.version_created_at)],
      ["Version message", str(v?.message)],
      ["Minor edit", typeof v?.minorEdit === "boolean" ? String(v.minorEdit) : null],
      ["Version author", str(v?.authorId)],
      ["Author", str(p.authorId)],
      ["Owner", str(p.ownerId)],
      ["Created", iso(p.createdAt)],
      ["Parent", str(p.parentId) ? `${str(p.parentType) ?? "page"} ${str(p.parentId)}` : null],
      ["URL", webui(p, site.siteUrl)],
      ["Body format", body.format === "none" ? null : body.format],
      ["Comments", extra.liveComments ? String(extra.liveComments) : null],
      ["Restrictions", extra.restrictionsSummary],
      ["Inaccessible since", iso(o.inaccessible_at)],
    ]),
    "",
    "## Content",
    "",
    body.markdown.trim() || `_No ${kind.toLowerCase()} body was captured in this record._`,
  ];
  if (extra.attachments.length) {
    lines.push("", "## Attachments", "");
    for (const a of extra.attachments) {
      const status = a.binaryStatus === "stored" ? null : `bytes ${a.binaryStatus ?? "pending"}`;
      const details = [a.mediaType, a.fileSize !== null ? `${a.fileSize} bytes` : null, a.version !== null ? `v${a.version}` : null, status].filter(Boolean).join(", ");
      lines.push(`- ${a.relPath ? `[${inline(a.title ?? a.id)}](${a.relPath})` : inline(a.title ?? a.id)} (${details}) - attachment ${a.id}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderVersion(container: ObjectRow, record: RecordRow, site: SiteView): string {
  const p = record.raw;
  const v = versionOf(p);
  const body = renderBody(p, null);
  const kind = container.content_type === "page" ? "Page" : "Blog post";
  return `${[
    `# ${heading(str(p.title) ?? container.title ?? container.content_id)} (v${record.version_number})`,
    "",
    meta([
      ["Source", "Confluence"],
      ["Site", site.siteUrl ?? site.cloudId],
      [`${kind} ID`, container.content_id],
      ["Version", `v${record.version_number}`],
      ["Version created", iso(v?.createdAt)],
      ["Version message", str(v?.message)],
      ["Minor edit", typeof v?.minorEdit === "boolean" ? String(v.minorEdit) : null],
      ["Version author", str(v?.authorId)],
      ["Status", str(p.status)],
      ["Captured", iso(record.observed_at)],
      ["Captured from", record.endpoint],
    ]),
    "",
    "## Content",
    "",
    body.markdown.trim() || "_This version's body was not returned by the version API._",
  ].join("\n")}\n`;
}

export function renderSpace(o: ObjectRow, site: SiteView, permissionsSummary: string | null): string {
  const p = o.raw;
  const description = obj(obj(p.description)?.plain)?.value ?? obj(obj(p.description)?.view)?.value;
  return `${[
    `# ${heading(str(p.name) ?? o.space_key ?? o.content_id)}`,
    "",
    meta([
      ["Source", "Confluence"],
      ["Site", site.siteUrl ?? site.cloudId],
      ["Space key", str(p.key) ?? o.space_key],
      ["Space ID", o.content_id],
      ["Type", str(p.type)],
      ["Status", o.status],
      ["Homepage", str(p.homepageId)],
      ["Created", iso(p.createdAt)],
      ["Author", str(p.authorId)],
      ["URL", webui(p, site.siteUrl)],
      ["Permissions", permissionsSummary],
      ["Inaccessible since", iso(o.inaccessible_at)],
    ]),
    "",
    str(description) ? `## Description\n\n${inline(str(description)!)}` : "",
  ].join("\n").trimEnd()}\n`;
}

// ------------------------------------------------------------------ comments

interface CommentNode {
  o: ObjectRow;
  replies: CommentNode[];
}

/** Threads by parentCommentId; a reply whose parent is not live renders at top level (donor rule). */
export function commentThreads(comments: readonly ObjectRow[]): CommentNode[] {
  const sorted = [...comments].sort((a, b) => (iso(a.raw.createdAt) ?? "").localeCompare(iso(b.raw.createdAt) ?? "") || a.content_id.localeCompare(b.content_id));
  const nodes = new Map<string, CommentNode>();
  for (const c of sorted) nodes.set(c.content_id, { o: c, replies: [] });
  const roots: CommentNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.o.parent_comment_id ?? str(node.o.raw.parentCommentId);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

function renderComment(node: CommentNode, depth: number): string {
  const c = node.o;
  const p = c.raw;
  const v = versionOf(p);
  const isInline = c.content_type === "inline_comment";
  const props = obj(p.properties);
  const selection = str(props?.inlineOriginalSelection) ?? str(props?.["inline-original-selection"]) ?? str(p.inlineOriginalSelection);
  const parts = [
    `${"#".repeat(Math.min(depth, 6))} ${heading(`Comment ${c.content_id}`)}`,
    "",
    meta([
      ["Type", isInline ? "Inline comment" : "Footer comment"],
      ["Author", str(v?.authorId) ?? str(p.authorId)],
      ["Created", iso(p.createdAt)],
      ["Updated", iso(v?.createdAt)],
      ["Version", c.version_number !== null ? `v${c.version_number}` : null],
      ["Resolution", isInline ? str(p.resolutionStatus) : null],
      ["Highlighted text", selection ? `"${inline(selection)}"` : null],
    ]),
    "",
    renderBody(p, null).markdown.trim() || "_No comment body was captured in this record._",
  ];
  for (const reply of node.replies) parts.push("", renderComment(reply, depth + 1));
  return parts.join("\n");
}

export function renderComments(container: ObjectRow, site: SiteView, comments: readonly ObjectRow[]): string {
  const threads = commentThreads(comments);
  const kind = container.content_type === "page" ? "Page ID" : "Blog post ID";
  return `${[
    `# ${heading(`Comments: ${container.title ?? container.content_id}`)}`,
    "",
    meta([
      ["Source", "Confluence"],
      ["Site", site.siteUrl ?? site.cloudId],
      ["Space ID", container.space_id],
      [kind, container.content_id],
      ["Comments", String(comments.length)],
    ]),
    "",
    "## Comments",
    "",
    threads.map((t) => renderComment(t, 3)).join("\n\n"),
  ].join("\n")}\n`;
}

/** One line summary of v1 restriction payloads ({read:{restrictions:{user:{results}, group:{results}}}, update:...}). */
export function restrictionsSummary(restrictions: unknown, status: string | null): string | null {
  if (status && status !== "captured") return status;
  const list = Array.isArray(restrictions) ? restrictions : obj(restrictions)?.results;
  if (!Array.isArray(list)) return null;
  const parts: string[] = [];
  for (const item of list) {
    const o = obj(item);
    const op = str(o?.operation);
    const r = obj(o?.restrictions);
    const users = Array.isArray(obj(r?.user)?.results) ? (obj(r?.user)!.results as unknown[]).length : 0;
    const groups = Array.isArray(obj(r?.group)?.results) ? (obj(r?.group)!.results as unknown[]).length : 0;
    if (op && (users || groups)) parts.push(`${op}: ${users} user(s), ${groups} group(s)`);
  }
  return parts.length ? parts.join("; ") : "none";
}

export function permissionsSummary(permissions: unknown, status: string | null): string | null {
  if (status && status !== "captured") return status;
  return Array.isArray(permissions) ? `${permissions.length} assignment(s) captured` : null;
}
