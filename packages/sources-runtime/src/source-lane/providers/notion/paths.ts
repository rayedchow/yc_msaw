import { createHash } from "node:crypto";

/**
 * Wire paths of the Notion deep lane. Everything lives under
 *
 *   sources/notion/_workspaces/<workspaceId>/<connectionId>/
 *     _connection.json
 *     <Page title>--<id32>/page.md|page.json|blocks.json|comments.md|comments.json
 *     <Page title>--<id32>/<Child page>--<id32>/...          (hierarchy mirrors Notion)
 *     <Database>--<id32>/_database.md|database.json
 *     <Database>--<id32>/<Data source>--<id32>/_data_source.md|data_source.json|_table.csv|_table.md
 *     <Database>--<id32>/<Data source>--<id32>/<Row title>--<id32>/page.md ...
 *     <container>/files/<key16>/<file name> + _file.json      (exact bytes of Notion-hosted files)
 *     _raw/<type>s/<id>/observed/<ts>-<sha12>.json             (append-only, never moves)
 *     _raw/pages/<id>/trees/<ts>-<sha12>.json
 *
 * Readable segments keep the Notion title (sanitized) and always end in `--<32 hex id>`,
 * so two pages with the same title never collide and a title never collides with the
 * reserved names (`_raw`, `_deep`, `files`, `_connection.json`, ...). The donor lane's
 * `sources/notion/<Title>-page-<id>/content.md` projections never start with `_`.
 */

export const NOTION_PROVIDER_ID = "notion";
export const WORKSPACES_ROOT = "sources/notion/_workspaces";
/** Ancestor levels kept in a readable path; deeper pages are placed under `_deep/` (store limit is 64 segments). */
export const MAX_TREE_DEPTH = 40;
const MAX_TITLE_CHARS = 80;

/** One path segment from an opaque identifier. */
export function idSegment(value: string): string {
  const cleaned = value.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]+/gu, "-").trim();
  const safe = cleaned === "" || cleaned === "." || cleaned === ".." ? `id-${sha12(value)}` : cleaned;
  return Buffer.byteLength(safe) > 200 ? `id-${sha12(value)}` : safe;
}

export function compactId(id: string): string {
  const hex = id.toLowerCase().replace(/-/gu, "");
  return /^[0-9a-f]{32}$/u.test(hex) ? hex : idSegment(id);
}

/** Readable, store-safe title: no separators/control chars, no leading dots/underscores, bounded length. */
export function titleSegment(title: string, fallback: string): string {
  let t = title.normalize("NFC").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/[/\\]+/gu, "-").replace(/\s+/gu, " ").trim();
  t = t.replace(/^[._\s-]+/u, "").replace(/[.\s]+$/u, "");
  if (!t) t = fallback;
  const chars = [...t];
  if (chars.length > MAX_TITLE_CHARS) t = `${chars.slice(0, MAX_TITLE_CHARS).join("").trimEnd()}…`;
  while (Buffer.byteLength(t) > 180) t = [...t].slice(0, -2).join("");
  return t;
}

export function nodeSegment(type: "page" | "data_source" | "database", title: string, id: string): string {
  const fallback = type === "page" ? "Untitled" : type === "database" ? "Untitled database" : "Untitled data source";
  return `${titleSegment(title, fallback)}--${compactId(id)}`;
}

export function connectionRoot(workspaceId: string | null, connectionId: string): string {
  return `${WORKSPACES_ROOT}/${idSegment(workspaceId ?? "unknown-workspace")}/${idSegment(connectionId)}`;
}

export function connectionFile(root: string): string {
  return `${root}/_connection.json`;
}

export function deepDir(root: string, segment: string): string {
  return `${root}/_deep/${segment}`;
}

export const PAGE_FILES = {
  markdown: "page.md",
  raw: "page.json",
  blocks: "blocks.json",
  commentsMarkdown: "comments.md",
  commentsRaw: "comments.json",
} as const;

export const DATA_SOURCE_FILES = {
  markdown: "_data_source.md",
  raw: "data_source.json",
  csv: "_table.csv",
  table: "_table.md",
} as const;

export const DATABASE_FILES = {
  markdown: "_database.md",
  raw: "database.json",
} as const;

/** Store-safe file name for a Notion file (keeps the extension; never empty). */
export function fileNameSegment(name: string | null, fallback: string): string {
  const base = (name ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]+/gu, "_").trim().replace(/^\.+/u, "");
  let n = base || fallback;
  if (n.startsWith("_")) n = `f${n}`;
  if (Buffer.byteLength(n) > 180) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
    n = `${[...n.slice(0, dot > 0 ? dot : n.length)].slice(0, 100).join("")}${ext}`;
  }
  return n === "." || n === ".." ? fallback : n;
}

export function fileDir(containerDir: string, fileKey: string): string {
  return `${containerDir}/files/${sha256(fileKey).slice(0, 16)}`;
}

/** Relative link from a page/data source directory to one of its files. */
export function fileRelativePath(fileKey: string, name: string | null): string {
  return `files/${sha256(fileKey).slice(0, 16)}/${fileNameSegment(name, "file")}`;
}

/** `20261017T120000.000Z` from an ISO time (sortable, path-safe). */
export function compactTime(iso: string): string {
  return iso.replace(/[-:]/gu, "");
}

export function rawObservationPath(root: string, objectType: string, objectId: string, observedAt: string, sha: string): string {
  return `${root}/_raw/${objectType}s/${idSegment(objectId)}/observed/${compactTime(observedAt)}-${sha.slice(0, 12)}.json`;
}

export function rawTreePath(root: string, pageId: string, observedAt: string, sha: string): string {
  return `${root}/_raw/pages/${idSegment(pageId)}/trees/${compactTime(observedAt)}-${sha.slice(0, 12)}.json`;
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function sha12(v: string): string {
  return sha256(v).slice(0, 12);
}
