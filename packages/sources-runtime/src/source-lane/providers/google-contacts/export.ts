import { sql } from "drizzle-orm";
import { DONOR } from "../../core/donor.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange } from "../../core/types.js";
import { compactTimestamp, documentWithRaw, laneSegment } from "../calendar/export.js";
import { isoOrNull, jsonDiff, queryRows } from "../calendar/google-lane.js";
import type { ContactEndpoint, PeoplePerson } from "./sync.js";

/**
 * sources/google-contacts/accounts/<mailbox>/
 *   connections/<id>.json | other-contacts/<id>.json   current People API payload (post-redaction, exact jsonb text)
 *   connections/<id>.md   | other-contacts/<id>.md     readable contact card
 *   changes/<yyyy-mm>/<observedAt>--<endpoint>--<id>--r<n>.json   append-only revisions with raw diff
 * Deleted, merged-away and no-longer-listed contacts are tombstoned (reason `deleted`,
 * `merged_into:<resourceName>`, `removed_from_full_listing`); their history stays.
 */

export const CONTACTS_ROOT = "sources/google-contacts";
const PROVENANCE = { donor: `${DONOR.repo}@${DONOR.commit}`, lane: "calendar-contacts" } as const;

export function endpointDir(endpoint: ContactEndpoint): string {
  return endpoint === "connections" ? "connections" : "other-contacts";
}

/** people/c123 -> c123, otherContacts/c456 -> c456 (resource ids are unique per endpoint and mailbox). */
export function contactId(resourceName: string): string {
  const slash = resourceName.indexOf("/");
  return laneSegment(slash >= 0 ? resourceName.slice(slash + 1) : resourceName);
}

export function contactPaths(mailbox: string, endpoint: ContactEndpoint, resourceName: string): { json: string; md: string } {
  const base = `${CONTACTS_ROOT}/accounts/${laneSegment(mailbox)}/${endpointDir(endpoint)}/${contactId(resourceName)}`;
  return { json: `${base}.json`, md: `${base}.md` };
}

export function contactRevisionPath(mailbox: string, endpoint: ContactEndpoint, resourceName: string, observedAt: string, revisionId: string | number): string {
  return `${CONTACTS_ROOT}/accounts/${laneSegment(mailbox)}/changes/${observedAt.slice(0, 7)}/${compactTimestamp(observedAt)}--${endpointDir(endpoint)}--${contactId(resourceName)}--r${revisionId}.json`;
}

function line(label: string, values: string[]): string[] {
  return values.length ? [`- **${label}:** ${values.join("; ")}`] : [];
}

function strings(items: unknown, pick: (item: Record<string, unknown>) => string | null): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object")
    .map(pick)
    .filter((v): v is string => Boolean(v));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function typed(value: string | null, type: unknown): string | null {
  if (!value) return null;
  const t = str(type);
  return t ? `${value} (${t})` : value;
}

/** Readable contact card (projection of the stored payload; the .json beside it is the exact raw). */
export function renderContactMarkdown(person: PeoplePerson, input: { mailbox: string; endpoint: ContactEndpoint; resourceName: string; sourceUpdatedAt: string | null }): string {
  const names = strings(person.names, (n) => str(n.displayName));
  const title = names[0] ?? strings(person.emailAddresses, (e) => str(e.value))[0] ?? input.resourceName;
  const lines = [
    `# ${title}`,
    "",
    ...line("Names", names),
    ...line("Nicknames", strings(person.nicknames, (n) => str(n.value))),
    ...line("Emails", strings(person.emailAddresses, (e) => typed(str(e.value), e.type))),
    ...line("Phones", strings(person.phoneNumbers, (p) => typed(str(p.value), p.type))),
    ...line("Organizations", strings(person.organizations, (o) => [str(o.title), str(o.name), str(o.department)].filter(Boolean).join(", ") || null)),
    ...line("Groups", strings(person.memberships, (m) => str((m.contactGroupMembership as Record<string, unknown> | undefined)?.contactGroupResourceName))),
    "",
    `- Source: ${input.endpoint === "connections" ? "saved contact" : "other contact (auto-collected)"} of ${input.mailbox}`,
    `- Resource: \`${input.resourceName}\``,
    ...(input.sourceUpdatedAt ? [`- Updated: ${input.sourceUpdatedAt}`] : []),
    "",
  ];
  return lines.join("\n");
}

function deletes(paths: readonly string[], reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return paths.map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

interface SnapshotRow {
  id: string;
  mailbox: string;
  endpoint: ContactEndpoint;
  resource_name: string;
  etag: string | null;
  state: "active" | "deleted" | "merged" | "removed";
  merged_into: string | null;
  content_hash: string;
  raw_payload_text: string;
  source_updated_at: string | null;
  state_changed_at: string | null;
  first_seen_at: string;
  updated_at: string;
}

export function tombstoneReason(row: Pick<SnapshotRow, "state" | "merged_into">): string {
  if (row.state === "merged") return `merged_into:${row.merged_into ?? "unknown"}`;
  if (row.state === "removed") return "removed_from_full_listing";
  return "deleted";
}

export async function mapContactSnapshot(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const [row] = await queryRows<SnapshotRow>(sql`
    SELECT id::text, mailbox, endpoint, resource_name, etag, state, merged_into, content_hash, raw_payload::text AS raw_payload_text,
           source_updated_at, state_changed_at, first_seen_at, updated_at
    FROM google_contact_snapshots WHERE id = ${rowKey}::uuid AND tenant_id = ${ctx.tenantId}
  `, ctx.executor);
  const provenance = { ...PROVENANCE, table: "google_contact_snapshots", snapshotId: rowKey };
  if (!row) return deletes(previousPaths, "snapshot_deleted", journal.enqueuedAt, provenance);
  const paths = contactPaths(row.mailbox, row.endpoint, row.resource_name);
  const capturedAt = isoOrNull(row.updated_at) ?? journal.enqueuedAt;
  const stale = previousPaths.filter((p) => p !== paths.json && p !== paths.md);
  const full = { ...provenance, externalId: row.resource_name, mailbox: row.mailbox, endpoint: row.endpoint, contentHash: row.content_hash };
  if (row.state !== "active") {
    const at = isoOrNull(row.state_changed_at) ?? capturedAt;
    return deletes([paths.json, paths.md, ...stale], tombstoneReason(row), at, { ...full, state: row.state, mergedInto: row.merged_into });
  }
  const sourceUpdatedAt = isoOrNull(row.source_updated_at);
  const person = JSON.parse(row.raw_payload_text) as PeoplePerson;
  const version = row.etag ? { sourceVersion: { ref: row.etag } } : {};
  return [
    {
      op: "put",
      path: paths.json,
      kind: "raw",
      contentType: "application/json",
      content: documentWithRaw({
        schema: "procmem.google-contacts.person-snapshot/v1",
        mailbox: row.mailbox,
        endpoint: row.endpoint,
        resourceName: row.resource_name,
        etag: row.etag,
        contentHash: row.content_hash,
        sourceUpdatedAt,
        firstSeenAt: isoOrNull(row.first_seen_at),
        observedAt: capturedAt,
      }, "person", row.raw_payload_text),
      sourceUpdatedAt,
      capturedAt,
      ...version,
      provenance: full,
    },
    {
      op: "put",
      path: paths.md,
      kind: "projection",
      contentType: "text/markdown; charset=utf-8",
      content: Buffer.from(renderContactMarkdown(person, { mailbox: row.mailbox, endpoint: row.endpoint, resourceName: row.resource_name, sourceUpdatedAt }), "utf8"),
      sourceUpdatedAt,
      capturedAt,
      ...version,
      provenance: { ...full, projectionOf: paths.json },
    },
    ...deletes(stale, "source_path_changed", capturedAt, full),
  ];
}

interface RevisionRow {
  id: string;
  snapshot_id: string;
  mailbox: string;
  endpoint: ContactEndpoint;
  resource_name: string;
  op: string;
  state: string;
  merged_into: string | null;
  content_hash: string;
  previous_content_hash: string | null;
  source_updated_at: string | null;
  raw_payload_text: string;
  observed_at: string;
}

export async function mapContactRevision(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const [row] = await queryRows<RevisionRow>(sql`
    SELECT id::text, snapshot_id::text, mailbox, endpoint, resource_name, op, state, merged_into, content_hash, previous_content_hash,
           source_updated_at, raw_payload::text AS raw_payload_text, observed_at
    FROM google_contact_revisions WHERE id = ${rowKey}::bigint AND tenant_id = ${ctx.tenantId}
  `, ctx.executor);
  if (!row) return deletes(previousPaths, "revision_deleted", journal.enqueuedAt, { ...PROVENANCE, table: "google_contact_revisions" });
  const observedAt = isoOrNull(row.observed_at) ?? journal.enqueuedAt;
  const [prev] = await queryRows<{ id: string; raw_payload_text: string }>(sql`
    SELECT id::text, raw_payload::text AS raw_payload_text FROM google_contact_revisions
    WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${row.mailbox} AND endpoint = ${row.endpoint} AND resource_name = ${row.resource_name}
      AND id < ${row.id}::bigint
    ORDER BY id DESC LIMIT 1
  `, ctx.executor);
  const contentChanged = row.content_hash !== row.previous_content_hash;
  const diff = prev && contentChanged ? jsonDiff(JSON.parse(prev.raw_payload_text), JSON.parse(row.raw_payload_text)) : [];
  return [{
    op: "put",
    path: contactRevisionPath(row.mailbox, row.endpoint, row.resource_name, observedAt, row.id),
    kind: "raw",
    contentType: "application/json",
    content: documentWithRaw({
      schema: "procmem.google-contacts.person-revision/v1",
      revisionId: Number(row.id),
      op: row.op,
      state: row.state,
      mergedInto: row.merged_into,
      mailbox: row.mailbox,
      endpoint: row.endpoint,
      resourceName: row.resource_name,
      contentHash: row.content_hash,
      previousContentHash: row.previous_content_hash,
      previousRevisionId: prev ? Number(prev.id) : null,
      sourceUpdatedAt: isoOrNull(row.source_updated_at),
      observedAt,
    }, "person", contentChanged || !prev ? row.raw_payload_text : null, { diff }),
    sourceUpdatedAt: isoOrNull(row.source_updated_at),
    capturedAt: observedAt,
    sourceVersion: { ref: `r${row.id}`, ordinal: Number(row.id) },
    provenance: { ...PROVENANCE, table: "google_contact_revisions", revisionId: row.id, snapshotId: row.snapshot_id, externalId: row.resource_name },
  }];
}

export const contactsExtraTables: readonly ExtraTableExport[] = [
  { table: "google_contact_snapshots", tenantColumn: "tenant_id", keyColumn: "id", map: mapContactSnapshot },
  { table: "google_contact_revisions", tenantColumn: "tenant_id", keyColumn: "id", map: mapContactRevision },
];
