import { createHash } from "node:crypto";

/**
 * Identity of Jira objects in the deep lane (drizzle/9250).
 *
 * Jira ids (project, issue, comment, attachment, changelog history) are unique
 * per site only, and an issue KEY is not an identity at all: it changes when the
 * issue moves project or the project key is renamed. Every key is therefore the
 * numeric provider id, scoped by the Nango connection AND the Atlassian cloudId:
 *
 *   site row key       <conn>/<cloud>
 *   object row key     <conn>/<cloud>/<type>/<id>
 *   record row key     <object key>/obs-<sha256(raw)[:24]>   (observed payload)
 *                      <object key>/h-<historyId>            (changelog history entry)
 *
 * Components are percent-encoded (encodeURIComponent), so "/" inside an id can
 * never make two tuples collide.
 */

export const CONTENT_TYPES = ["project", "issue", "comment", "attachment"] as const;
export type JiraContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(v: unknown): v is JiraContentType {
  return typeof v === "string" && (CONTENT_TYPES as readonly string[]).includes(v);
}

export interface SiteRef {
  connectionId: string;
  cloudId: string;
}

const enc = encodeURIComponent;

export function siteRowKey(site: SiteRef): string {
  return `${enc(site.connectionId)}/${enc(site.cloudId)}`;
}

export function objectRowKey(site: SiteRef, type: JiraContentType, id: string): string {
  return `${siteRowKey(site)}/${type}/${enc(id)}`;
}

export function parseObjectRowKey(rowKey: string): (SiteRef & { type: JiraContentType; id: string }) | null {
  const parts = rowKey.split("/");
  if (parts.length !== 4 || !isContentType(parts[2])) return null;
  try {
    return { connectionId: decodeURIComponent(parts[0]!), cloudId: decodeURIComponent(parts[1]!), type: parts[2], id: decodeURIComponent(parts[3]!) };
  } catch {
    return null;
  }
}

export function observationRowKey(objectKey: string, rawSha256: string): string {
  return `${objectKey}/obs-${rawSha256.slice(0, 24)}`;
}

export function changelogRowKey(issueObjectKey: string, historyId: string): string {
  return `${issueObjectKey}/h-${enc(historyId)}`;
}

/**
 * Atlassian applies Jira Cloud REST rate limits per OAuth app per site, so the
 * quota bucket is (Nango integration = OAuth app, cloudId) - never the tenant:
 * two tenants that connected the same site through the same app share it.
 */
export function quotaKeyFor(providerConfigKey: string, cloudId: string): string {
  return `atlassian-jira:${enc(providerConfigKey)}:${enc(cloudId)}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256Hex(stableJson(value));
}
