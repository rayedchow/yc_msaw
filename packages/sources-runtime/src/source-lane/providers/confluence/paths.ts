import { encodeSegment } from "../../export/mapping.js";
import type { ConfluenceContentType } from "./identity.js";

/**
 * File layout of the Confluence deep lane. Everything lives under
 * `sources/confluence/_sites/` so it can never collide with the donor mirror
 * (`sources/confluence/<spaceId>/<pageId>.md`, owned by the donor
 * materializer) or the default raw ledger (`sources/confluence/_raw/`):
 *
 *   _sites/<cloudId>/<connectionId>/
 *     _site.json                                  site, granted scopes, connection
 *     _raw/<type>/<id>/observed/obs-<sha>.json    every distinct observed payload (never deleted)
 *     _raw/<type>/<id>/versions/v000007.json      version-API body of version 7 (never deleted)
 *     spaces/<spaceId>/_space.json|_space.md|_permissions.json
 *     spaces/<spaceId>/pages/<pageId>/page.md|page.json|page.adf.json|restrictions.json|comments.md
 *     spaces/<spaceId>/pages/<pageId>/versions/v000007.md
 *     spaces/<spaceId>/pages/<pageId>/attachments/<attachmentId>/_attachment.json
 *     spaces/<spaceId>/pages/<pageId>/attachments/<attachmentId>/<file name>   exact bytes
 *     spaces/<spaceId>/blogposts/<blogPostId>/...  (same shape, blogpost.md|blogpost.json)
 *
 * The connection is part of the root because two connections to one site can
 * see different content (permissions); ids are path segments, titles are data.
 * Projections live under the container's CURRENT space, so a move re-derives
 * them (the exporter deletes the old paths); `_raw/` paths never depend on
 * placement and are append-only.
 */

export const PROVIDER = "confluence";
export const SITES_ROOT = "sources/confluence/_sites";
const UNKNOWN_SPACE = "_unknown-space";

export function siteRoot(cloudId: string, connectionId: string): string {
  return `${SITES_ROOT}/${encodeSegment(cloudId)}/${encodeSegment(connectionId)}`;
}

export function siteFilePath(cloudId: string, connectionId: string): string {
  return `${siteRoot(cloudId, connectionId)}/_site.json`;
}

export function spaceDir(cloudId: string, connectionId: string, spaceId: string | null): string {
  return `${siteRoot(cloudId, connectionId)}/spaces/${spaceId ? encodeSegment(spaceId) : UNKNOWN_SPACE}`;
}

export function containerDir(cloudId: string, connectionId: string, spaceId: string | null, type: "page" | "blogpost", id: string): string {
  return `${spaceDir(cloudId, connectionId, spaceId)}/${type === "page" ? "pages" : "blogposts"}/${encodeSegment(id)}`;
}

export function containerFileBase(type: "page" | "blogpost"): string {
  return type === "page" ? "page" : "blogpost";
}

export function versionProjectionPath(dir: string, versionNumber: number): string {
  return `${dir}/versions/v${String(versionNumber).padStart(6, "0")}.md`;
}

export function attachmentDir(dir: string, attachmentId: string): string {
  return `${dir}/attachments/${encodeSegment(attachmentId)}`;
}

/** Provider file name as one path segment; names starting with "_" are escaped so they never shadow `_attachment.json`. */
export function attachmentFileName(title: string | null, attachmentId: string): string {
  const name = (title ?? "").trim() || `attachment-${attachmentId}`;
  const seg = encodeSegment(name);
  return seg.startsWith("_") ? `%5F${seg.slice(1)}` : seg;
}

export function rawObservationPath(cloudId: string, connectionId: string, type: ConfluenceContentType, id: string, rawSha256: string): string {
  return `${siteRoot(cloudId, connectionId)}/_raw/${type}/${encodeSegment(id)}/observed/obs-${rawSha256.slice(0, 24)}.json`;
}

export function rawVersionPath(cloudId: string, connectionId: string, type: ConfluenceContentType, id: string, versionNumber: number): string {
  return `${siteRoot(cloudId, connectionId)}/_raw/${type}/${encodeSegment(id)}/versions/v${String(versionNumber).padStart(6, "0")}.json`;
}

/** Donor mirror paths (src/mirror/materializer.ts confluence page + comments docs). */
export const DONOR_MIRROR_RE = /^sources\/confluence\/([^/]+)\/([^/]+?)(-comments)?\.md$/u;

export function parseDonorMirrorPath(path: string): { spaceSegment: string; pageSegment: string; comments: boolean } | null {
  if (path.startsWith(`${SITES_ROOT}/`) || path.startsWith("sources/confluence/_raw/") || path.startsWith("sources/confluence/_meta/")) return null;
  const m = DONOR_MIRROR_RE.exec(path);
  return m ? { spaceSegment: m[1]!, pageSegment: m[2]!, comments: Boolean(m[3]) } : null;
}
