import { adfToMarkdown } from "../../../integrations/atlassian/adf.js";
import type { ObjectRow, RecordRow } from "./store.js";

/**
 * Readable projections of the Jira deep lane. ADF bodies (description,
 * comments, rich-text custom fields) go through the donor converter unchanged
 * (src/integrations/atlassian/adf.ts adfToMarkdown); plain strings are kept as
 * is. Layout follows the donor materializer's Jira issue file
 * (renderJiraIssue): "- Label: value" metadata, "## Description",
 * "## Comments" with one "### Comment <id>" section per comment ordered by
 * creation time, explicit "Comments omitted" when fewer than the reported
 * total are captured. Additions over the donor: site/id identity, access
 * state, attachments with links to their exact bytes, and a full changelog.
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

/** ADF document -> markdown via the donor converter; strings (API v2 / plain fields) pass through. */
export function adfOrText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return adfToMarkdown(value);
}

export function named(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const r = obj(value);
  return str(r?.name) ?? str(r?.displayName) ?? str(r?.value) ?? str(r?.key) ?? str(r?.id);
}

export function person(value: unknown): string | null {
  const r = obj(value);
  if (!r) return str(value);
  const name = str(r.displayName) ?? str(r.name) ?? str(r.publicName);
  const email = str(r.emailAddress) ?? str(r.email);
  if (name && email) return `${inline(name)} <${email}>`;
  return name ?? email ?? str(r.accountId) ?? str(r.id);
}

export interface SiteView {
  cloudId: string;
  connectionId: string;
  siteUrl: string | null;
  siteName: string | null;
}

export interface AttachmentView {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  created: string | null;
  author: string | null;
  binaryStatus: string | null;
  /** Relative to the issue directory when the bytes are stored. */
  relPath: string | null;
}

function accessLine(o: ObjectRow): string | null {
  if (!o.inaccessible_at) return null;
  return `no longer readable by this connection since ${iso(o.inaccessible_at)} (${o.inaccessible_reason ?? "access lost"}); this is the last captured state, not a deletion`;
}

function commentAnchor(c: Rec, index: number): string {
  return `Comment ${str(c.id) ?? index + 1}`;
}

function renderComment(c: ObjectRow, index: number): string {
  const raw = c.raw;
  const visibility = obj(raw.visibility);
  return [
    `### ${commentAnchor(raw, index)}`,
    "",
    meta([
      ["Author", person(raw.author ?? raw.updateAuthor)],
      ["Updated", iso(raw.updated ?? raw.created)],
      ["Created", iso(raw.created)],
      ["Edited by", str(raw.updated) && str(raw.updated) !== str(raw.created) ? person(raw.updateAuthor) : null],
      ["Visibility", visibility ? `${str(visibility.type) ?? "restricted"}: ${str(visibility.value) ?? str(visibility.identifier) ?? "?"}` : null],
      ["Access", accessLine(c)],
    ]),
    "",
    adfOrText(raw.body) || "_No comment body._",
  ].join("\n");
}

/** Comments ordered like the donor (created, then id); deleted comments are never passed in. */
export function sortComments(rows: ObjectRow[]): ObjectRow[] {
  return [...rows].sort((a, b) => (iso(a.raw.created ?? a.raw.updated) ?? "").localeCompare(iso(b.raw.created ?? b.raw.updated) ?? "") || a.content_id.localeCompare(b.content_id, undefined, { numeric: true }));
}

export function renderIssue(
  o: ObjectRow,
  site: SiteView,
  ctx: { comments: ObjectRow[]; attachments: AttachmentView[]; changelogStored: number; changelogTotal: number | null; changelogStatus: string | null; commentsTotal: number | null },
): string {
  const raw = o.raw;
  const f = obj(raw.fields) ?? {};
  const key = o.issue_key ?? str(raw.key) ?? o.content_id;
  const summary = str(f.summary) ?? key;
  const labels = Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [];
  const components = Array.isArray(f.components) ? f.components.map(named).filter((x): x is string => Boolean(x)) : [];
  const fixVersions = Array.isArray(f.fixVersions) ? f.fixVersions.map(named).filter((x): x is string => Boolean(x)) : [];
  const parent = obj(f.parent);
  const comments = sortComments(ctx.comments);
  const omitted = Math.max(0, (ctx.commentsTotal ?? comments.length) - comments.length);
  const url = site.siteUrl ? `${site.siteUrl.replace(/\/+$/u, "")}/browse/${encodeURIComponent(key)}` : null;
  const lines = [
    `# ${inline(`${key}: ${summary}`)}`,
    "",
    meta([
      ["Source", "Jira"],
      ["Site", site.siteUrl ?? site.cloudId],
      ["Cloud ID", site.cloudId],
      ["Project", o.project_key ? `${o.project_key}${o.project_id ? ` (id ${o.project_id})` : ""}` : null],
      ["Issue key", key],
      ["Issue ID", o.content_id],
      ["URL", url],
      ["Status", named(f.status)],
      ["Type", named(f.issuetype)],
      ["Priority", named(f.priority)],
      ["Resolution", named(f.resolution)],
      ["Assignee", person(f.assignee)],
      ["Reporter", person(f.reporter)],
      ["Creator", person(f.creator)],
      ["Parent", parent ? `${str(parent.key) ?? str(parent.id)}${str(obj(parent.fields)?.summary) ? `: ${inline(str(obj(parent.fields)?.summary)!)}` : ""}` : null],
      ["Labels", labels.length ? labels.join(", ") : null],
      ["Components", components.length ? components.join(", ") : null],
      ["Fix versions", fixVersions.length ? fixVersions.join(", ") : null],
      ["Security level", named(f.security)],
      ["Created", iso(f.created)],
      ["Updated", iso(f.updated)],
      ["Due", str(f.duedate)],
      ["Comments omitted", omitted > 0 ? String(omitted) : null],
      ["Changelog captured", `${ctx.changelogStored}${ctx.changelogTotal !== null ? ` of ${ctx.changelogTotal}` : ""} history entr${ctx.changelogStored === 1 ? "y" : "ies"} (${ctx.changelogStatus ?? "pending"}; see changelog.md)`],
      ["Access", accessLine(o)],
    ]),
    "",
    "## Description",
    "",
    adfOrText(f.description) || "_No description._",
  ];
  if (ctx.attachments.length) {
    lines.push("", "## Attachments", "");
    for (const a of ctx.attachments) {
      const label = a.filename ?? `attachment ${a.id}`;
      const detail = [a.mimeType, a.size !== null ? `${a.size} bytes` : null, a.author ? `by ${a.author}` : null, a.created].filter(Boolean).join(", ");
      const where = a.relPath ? `[${label}](${a.relPath})` : `${label} (bytes ${a.binaryStatus ?? "pending"})`;
      lines.push(`- ${where}${detail ? ` - ${detail}` : ""}`);
    }
  }
  lines.push("", "## Comments", "", comments.length ? comments.map(renderComment).join("\n\n") : "_No comments captured in this record._");
  return `${lines.join("\n")}\n`;
}

function changeItem(item: Rec): string {
  const field = str(item.field) ?? str(item.fieldId) ?? "field";
  const from = str(item.fromString) ?? str(item.from);
  const to = str(item.toString) ?? str(item.to);
  return `  - ${inline(field)}: ${from !== null ? `"${inline(from)}"` : "(none)"} -> ${to !== null ? `"${inline(to)}"` : "(none)"}`;
}

/** Every stored changelog history entry, oldest first (ids are numeric strings; the raw entries are under _raw/issue/<id>/changelog/). */
export function renderChangelog(o: ObjectRow, histories: RecordRow[], total: number | null, status: string | null): string {
  const key = o.issue_key ?? o.content_id;
  const lines = [
    `# ${inline(`${key}: changelog`)}`,
    "",
    meta([
      ["Issue ID", o.content_id],
      ["Issue key", key],
      ["History entries captured", `${histories.length}${total !== null ? ` of ${total}` : ""}`],
      ["Changelog state", status ?? "pending"],
    ]),
    "",
  ];
  if (!histories.length) lines.push("_No changelog entries captured yet._");
  for (const h of histories) {
    const raw = h.raw;
    const items = Array.isArray(raw.items) ? raw.items.map(obj).filter((x): x is Rec => x !== null) : [];
    lines.push(`## ${iso(raw.created) ?? "unknown time"} - ${person(raw.author) ?? "unknown author"} (history ${h.history_id ?? "?"})`, "", ...(items.length ? items.map(changeItem) : ["  - (no field changes listed)"]), "");
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

export function renderProject(o: ObjectRow, site: SiteView): string {
  const raw = o.raw;
  const issueTypes = Array.isArray(raw.issueTypes) ? raw.issueTypes.map(named).filter((x): x is string => Boolean(x)) : [];
  return `${[
    `# ${inline(`${o.project_key ?? o.content_id}: ${str(raw.name) ?? ""}`)}`,
    "",
    meta([
      ["Source", "Jira"],
      ["Site", site.siteUrl ?? site.cloudId],
      ["Project key", o.project_key],
      ["Project ID", o.content_id],
      ["Type", str(raw.projectTypeKey)],
      ["Style", str(raw.style)],
      ["Lead", person(raw.lead)],
      ["Archived", raw.archived === true ? "yes" : null],
      ["Issue types", issueTypes.length ? issueTypes.join(", ") : null],
      ["Access", accessLine(o)],
    ]),
    "",
    "## Description",
    "",
    adfOrText(raw.description) || "_No description._",
  ].join("\n")}\n`;
}
