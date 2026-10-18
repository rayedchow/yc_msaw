import { encodeSegment } from "../../export/mapping.js";
import type { JiraContentType } from "./identity.js";

/**
 * File layout of the Jira deep lane. Everything lives under
 * `sources/jira/_sites/` so it never collides with the donor mirror
 * (`sources/jira/<PROJECT>/<KEY>.md`, written by the donor materializer) or the
 * default raw ledger (`sources/jira/_raw/`):
 *
 *   _sites/<cloudId>/<connectionId>/
 *     _site.json                                         site, granted scopes, project selection
 *     _raw/<type>/<id>/observed/obs-<sha>.json           every distinct observed payload (append-only)
 *     _raw/issue/<id>/changelog/h-<historyId>.json       every changelog history entry (append-only)
 *     projects/<projectKey>/_project.json|_project.md
 *     projects/<projectKey>/issues/<issueKey>/issue.md|issue.json|comments.md|comments.json|changelog.md
 *     projects/<projectKey>/issues/<issueKey>/attachments/<attachmentId>/_attachment.json
 *     projects/<projectKey>/issues/<issueKey>/attachments/<attachmentId>/<file name>   exact bytes
 *
 * Projections are placed by the issue's CURRENT key, so a moved or re-keyed
 * issue produces new paths and the exporter deletes the old ones; the stable
 * numeric id is in every file and in provenance. `_raw/` paths are keyed by id
 * only and never move.
 */

export const PROVIDER = "jira";
export const SITES_ROOT = "sources/jira/_sites";
const UNKNOWN_PROJECT = "_unknown-project";

export function siteRoot(cloudId: string, connectionId: string): string {
  return `${SITES_ROOT}/${encodeSegment(cloudId)}/${encodeSegment(connectionId)}`;
}

export function siteFilePath(cloudId: string, connectionId: string): string {
  return `${siteRoot(cloudId, connectionId)}/_site.json`;
}

/** Project keys are path segments; a reserved leading "_" is escaped so a key can never shadow `_raw`/`_site.json`. */
function keySegment(key: string): string {
  const seg = encodeSegment(key);
  return seg.startsWith("_") ? `%5F${seg.slice(1)}` : seg;
}

export function projectDir(cloudId: string, connectionId: string, projectKey: string | null): string {
  return `${siteRoot(cloudId, connectionId)}/projects/${projectKey ? keySegment(projectKey) : UNKNOWN_PROJECT}`;
}

export function issueDir(cloudId: string, connectionId: string, projectKey: string | null, issueKey: string | null, issueId: string): string {
  return `${projectDir(cloudId, connectionId, projectKey)}/issues/${issueKey ? keySegment(issueKey) : `id-${encodeSegment(issueId)}`}`;
}

export function attachmentDir(dir: string, attachmentId: string): string {
  return `${dir}/attachments/${encodeSegment(attachmentId)}`;
}

/** Provider file name as one path segment; names starting with "_" are escaped so they never shadow `_attachment.json`. */
export function attachmentFileName(name: string | null, attachmentId: string): string {
  const seg = encodeSegment((name ?? "").trim() || `attachment-${attachmentId}`);
  return seg.startsWith("_") ? `%5F${seg.slice(1)}` : seg;
}

export function rawObservationPath(cloudId: string, connectionId: string, type: JiraContentType, id: string, rawSha256: string): string {
  return `${siteRoot(cloudId, connectionId)}/_raw/${type}/${encodeSegment(id)}/observed/obs-${rawSha256.slice(0, 24)}.json`;
}

export function rawChangelogPath(cloudId: string, connectionId: string, issueId: string, historyId: string): string {
  return `${siteRoot(cloudId, connectionId)}/_raw/issue/${encodeSegment(issueId)}/changelog/h-${encodeSegment(historyId)}.json`;
}

/** Donor mirror paths: sources/jira/<PROJECT>/<KEY>.md (src/mirror/materializer.ts materializeJiraIssueSourceWiki). */
export function parseDonorMirrorPath(path: string): { projectSegment: string; keySegment: string } | null {
  if (path.startsWith(`${SITES_ROOT}/`) || path.startsWith("sources/jira/_raw/") || path.startsWith("sources/jira/_meta/")) return null;
  const m = /^sources\/jira\/([^/]+)\/([^/]+)\.md$/u.exec(path);
  return m ? { projectSegment: m[1]!, keySegment: m[2]! } : null;
}

/** Donor materializer path segment rule (atlassianPathSegment in src/mirror/materializer.ts). */
export function donorSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}
