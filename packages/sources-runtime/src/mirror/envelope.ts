/**
 * Staged-document envelope (docs/source-pipeline-plan.md §3) - the jsonb
 * payload written to `mirror_files.meta` alongside every staged markdown
 * file. This is the frozen plane boundary the graph picks up (§4): stable
 * IMMUTABLE `externalId` (never names/titles/paths), version identity,
 * identity contributions (`aliases`), and the per-section raw drill-down map
 * (`sourceRefs`, §5). Renderers populate only what they genuinely have in
 * hand at render time - missing fields stay absent, never guessed.
 */

// "comments" marks aggregated per-container comment docs (e.g. Confluence
// page comments); "transcript" selects clock-aware transcript chunking.
export type StagedDocumentKind =
  | "document"
  | "conversation_window"
  | "transcript"
  | "code_file"
  | "comments";

export type StagedDocumentAlias = {
  /** e.g. "email", "slack_uid", "gcal_event", "jira_key". */
  kind: string;
  value: string;
};

export type StagedDocumentSourceRef = {
  /** Stable pointer into the rendered doc (section heading / message ts). */
  anchor: string;
  sourceEventId?: string;
  sha256?: string;
  url?: string;
};

export type StagedDocumentRepresentedType =
  | "Person"
  | "Organization"
  | "Team"
  | "Document"
  | "Meeting"
  | "Message"
  | "Repository"
  | "Project"
  | "Topic"
  | "Product"
  | "Event"
  | "CodeSymbol"
  | "Issue";

export type StagedDocumentSourceLinkRole = "PARENT" | "REPLY_TO" | "ATTACHED_TO" | "INSTANCE_OF";

export type StagedDocumentSourceLink = {
  role: StagedDocumentSourceLinkRole;
  target: {
    provider: string;
    namespace: string;
    id: string;
  };
};

export type StagedDocumentMeta = {
  provider: string;
  /** IMMUTABLE native id - never a name, title, path, or issue key. */
  externalId: string;
  /** Immutable provider authority scope; never a mutable parent or path. */
  sourceNamespace?: string;
  /** Canonical type represented by this single native source object. */
  representedType?: StagedDocumentRepresentedType;
  kind: StagedDocumentKind;
  title?: string;
  /** Version identity matching raw version-append; content sha fallback. */
  versionRef?: string;
  sourceUpdatedAt?: string;
  /** Meeting start used only to resolve meeting-relative transcript offsets. */
  meetingStartTime?: string;
  /** Access/classification metadata only; source containment belongs in sourceLinks. */
  sourceAcl: Record<string, unknown>;
  authorEmail?: string;
  authorName?: string;
  updatedByEmail?: string;
  aliases: StagedDocumentAlias[];
  sourceRefs: StagedDocumentSourceRef[];
  sourceLinks?: StagedDocumentSourceLink[];
};

/**
 * Normalize a partially-populated envelope: trims strings, drops empty
 * optionals, dedupes aliases and sourceRefs, defaults the mandatory
 * collections. `versionRef` is left absent when unknown - the mirror write
 * path falls back to the file's content sha.
 */
export function stagedDocumentMeta(input: {
  provider: string;
  externalId: string;
  sourceNamespace?: string | null;
  representedType?: StagedDocumentRepresentedType | null;
  kind: StagedDocumentKind;
  title?: string | null;
  versionRef?: string | null;
  sourceUpdatedAt?: string | Date | null;
  meetingStartTime?: string | Date | null;
  sourceAcl?: Record<string, unknown> | null;
  authorEmail?: string | null;
  authorName?: string | null;
  updatedByEmail?: string | null;
  aliases?: Array<StagedDocumentAlias | null | undefined> | null;
  sourceRefs?: Array<StagedDocumentSourceRef | null | undefined> | null;
  sourceLinks?: Array<StagedDocumentSourceLink | null | undefined> | null;
}): StagedDocumentMeta {
  return normalizeStagedDocumentMeta(input, { preserveLegacyDualEvidenceRefs: false });
}

function normalizeStagedDocumentMeta(input: {
  provider: string;
  externalId: string;
  sourceNamespace?: string | null;
  representedType?: StagedDocumentRepresentedType | null;
  kind: StagedDocumentKind;
  title?: string | null;
  versionRef?: string | null;
  sourceUpdatedAt?: string | Date | null;
  meetingStartTime?: string | Date | null;
  sourceAcl?: Record<string, unknown> | null;
  authorEmail?: string | null;
  authorName?: string | null;
  updatedByEmail?: string | null;
  aliases?: Array<StagedDocumentAlias | null | undefined> | null;
  sourceRefs?: Array<StagedDocumentSourceRef | null | undefined> | null;
  sourceLinks?: Array<StagedDocumentSourceLink | null | undefined> | null;
}, options: { preserveLegacyDualEvidenceRefs: boolean }): StagedDocumentMeta {
  const provider = trimmed(input.provider);
  const externalId = trimmed(input.externalId);
  if (!provider || !externalId) throw new Error("staged document requires native provider and externalId");
  const sourceNamespace = trimmed(input.sourceNamespace);
  if (input.representedType && !sourceNamespace) {
    throw new Error("representedType requires sourceNamespace");
  }
  const meta: StagedDocumentMeta = {
    provider,
    externalId,
    kind: input.kind,
    sourceAcl: compactSourceAcl(input.sourceAcl),
    aliases: dedupeAliases(input.aliases),
    sourceRefs: dedupeSourceRefs(input.sourceRefs, options),
  };
  if (sourceNamespace) meta.sourceNamespace = sourceNamespace;
  if (input.representedType) meta.representedType = input.representedType;
  const sourceLinks = dedupeSourceLinks([
    ...(input.sourceLinks ?? []),
    ...containmentSourceLinks(provider, input.sourceAcl),
  ]);
  if (sourceLinks.length > 0) meta.sourceLinks = sourceLinks;
  const title = trimmed(input.title);
  if (title) meta.title = title;
  const versionRef = trimmed(input.versionRef);
  if (versionRef) meta.versionRef = versionRef;
  const sourceUpdatedAt = isoDate(input.sourceUpdatedAt);
  if (sourceUpdatedAt) meta.sourceUpdatedAt = sourceUpdatedAt;
  const meetingStartTime = isoDate(input.meetingStartTime);
  if (meetingStartTime) meta.meetingStartTime = meetingStartTime;
  const authorEmail = emailValue(input.authorEmail);
  if (authorEmail) meta.authorEmail = authorEmail;
  const authorName = trimmed(input.authorName);
  if (authorName) meta.authorName = authorName;
  const updatedByEmail = emailValue(input.updatedByEmail);
  if (updatedByEmail) meta.updatedByEmail = updatedByEmail;
  return meta;
}

/** Validate and normalize an envelope loaded from jsonb/task payload data. */
export function parseStagedDocumentMeta(value: unknown): StagedDocumentMeta | null {
  if (!isRecord(value)) return null;
  if (!nonEmpty(value.provider) || !nonEmpty(value.externalId) || !stagedDocumentKind(value.kind)) return null;
  const representedType = stagedDocumentRepresentedType(value.representedType) ? value.representedType : null;
  if (value.representedType != null && !representedType) return null;
  if (representedType && !nonEmpty(value.sourceNamespace)) return null;
  return normalizeStagedDocumentMeta({
    provider: value.provider,
    externalId: value.externalId,
    sourceNamespace: optionalText(value.sourceNamespace),
    representedType,
    kind: value.kind,
    title: optionalText(value.title),
    versionRef: optionalText(value.versionRef),
    sourceUpdatedAt: optionalText(value.sourceUpdatedAt),
    meetingStartTime: optionalText(value.meetingStartTime),
    sourceAcl: isRecord(value.sourceAcl) ? value.sourceAcl : {},
    authorEmail: optionalText(value.authorEmail),
    authorName: optionalText(value.authorName),
    updatedByEmail: optionalText(value.updatedByEmail),
    aliases: Array.isArray(value.aliases)
      ? value.aliases.flatMap((entry) => isRecord(entry)
        ? [{ kind: optionalText(entry.kind) ?? "", value: optionalText(entry.value) ?? "" }]
        : [])
      : [],
    sourceRefs: Array.isArray(value.sourceRefs)
      ? value.sourceRefs.flatMap((entry) => isRecord(entry)
        ? [{
          anchor: optionalText(entry.anchor) ?? "",
          sourceEventId: optionalText(entry.sourceEventId) ?? undefined,
          sha256: optionalText(entry.sha256) ?? undefined,
          url: optionalText(entry.url) ?? undefined,
        }]
        : [])
      : [],
    sourceLinks: Array.isArray(value.sourceLinks)
      ? value.sourceLinks.flatMap((entry) => {
        if (!isRecord(entry) || !sourceLinkRole(entry.role) || !isRecord(entry.target)) return [];
        return [{
          role: entry.role,
          target: {
            provider: optionalText(entry.target.provider) ?? "",
            namespace: optionalText(entry.target.namespace) ?? "",
            id: optionalText(entry.target.id) ?? "",
          },
        }];
      })
      : [],
  }, { preserveLegacyDualEvidenceRefs: true });
}

/** Build `{kind: "email"}` aliases out of address-bearing header strings ("Name <a@b>, c@d"). */
export function emailAliases(...values: Array<string | null | undefined>): StagedDocumentAlias[] {
  const aliases: StagedDocumentAlias[] = [];
  for (const value of values) {
    for (const email of extractEmails(value)) {
      aliases.push({ kind: "email", value: email });
    }
  }
  return aliases;
}

/** All RFC-ish addresses found in a free-form header string, lowercased. */
export function extractEmails(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const matches = value.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
  return matches.map((email) => email.toLowerCase());
}

/** First address in a header-ish string, or null. */
export function firstEmail(value: string | null | undefined): string | null {
  return extractEmails(value)[0] ?? null;
}

function dedupeAliases(
  values: Array<StagedDocumentAlias | null | undefined> | null | undefined,
): StagedDocumentAlias[] {
  const seen = new Set<string>();
  const aliases: StagedDocumentAlias[] = [];
  for (const alias of values ?? []) {
    const kind = trimmed(alias?.kind);
    const value = trimmed(alias?.value);
    if (!kind || !value) continue;
    const key = `${kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push({ kind, value });
  }
  return aliases;
}

function dedupeSourceRefs(
  values: Array<StagedDocumentSourceRef | null | undefined> | null | undefined,
  options: { preserveLegacyDualEvidenceRefs: boolean },
): StagedDocumentSourceRef[] {
  const seen = new Set<string>();
  const refs: StagedDocumentSourceRef[] = [];
  for (const raw of values ?? []) {
    const anchor = trimmed(raw?.anchor);
    if (!anchor) continue;
    const sourceEventId = trimmed(raw?.sourceEventId);
    const sha256 = trimmed(raw?.sha256);
    if (!sourceEventId && !sha256) continue;
    // New staged projections must identify one exact raw record. Keep legacy
    // dual-valued rows readable rather than silently reinterpreting them.
    if (sourceEventId && sha256 && !options.preserveLegacyDualEvidenceRefs) continue;
    const ref: StagedDocumentSourceRef = { anchor };
    if (sourceEventId) ref.sourceEventId = sourceEventId;
    if (sha256) ref.sha256 = sha256;
    const url = trimmed(raw?.url);
    if (url) ref.url = url;
    const key = JSON.stringify([ref.anchor, ref.sourceEventId ?? "", ref.sha256 ?? "", ref.url ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function dedupeSourceLinks(
  values: Array<StagedDocumentSourceLink | null | undefined> | null | undefined,
): StagedDocumentSourceLink[] {
  const seen = new Set<string>();
  const links: StagedDocumentSourceLink[] = [];
  for (const raw of values ?? []) {
    if (!raw || !sourceLinkRole(raw.role)) continue;
    const provider = trimmed(raw.target?.provider);
    const namespace = trimmed(raw.target?.namespace);
    const id = trimmed(raw.target?.id);
    if (!provider || !namespace || !id) continue;
    const key = JSON.stringify([raw.role, provider, namespace, id]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ role: raw.role, target: { provider, namespace, id } });
  }
  return links;
}

const SOURCE_ACL_KEYS = new Set([
  "access",
  "audience",
  "domains",
  "driveFolderIds",
  "groups",
  // A privacy-preserving Calendar classification signal, never attendee data.
  "hasHumanAttendee",
  "permissions",
  "private",
  "public",
  "readers",
  "restricted",
  "roles",
  "users",
  "visibility",
  "writers",
]);

function compactSourceAcl(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SOURCE_ACL_KEYS.has(key)) continue;
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "string" && !entry.trim()) continue;
    record[key] = entry;
  }
  return record;
}

/**
 * Containment is not access control: recognized container identity that
 * renderers historically parked in `sourceAcl` moves into `sourceLinks`
 * (PARENT role) instead of being dropped by the ACL whitelist. Only immutable
 * container identity is lifted - mutable names/paths (repoFullName,
 * projectName) never become link targets. Promotion reads these links;
 * legacy persisted envelopes keep their old ACL keys as a read fallback.
 */
function containmentSourceLinks(
  provider: string,
  acl: Record<string, unknown> | null | undefined,
): StagedDocumentSourceLink[] {
  if (!acl || typeof acl !== "object") return [];
  const cloudId = trimmed(asText(acl.cloudId)) ?? trimmed(asText(acl.cloud_id));
  const links: StagedDocumentSourceLink[] = [];
  switch (provider) {
    case "jira": {
      if (!cloudId) break;
      const projectKey = trimmed(asText(acl.projectKey));
      links.push(parentLink(provider, `site:${cloudId}`, projectKey ? `project:${projectKey}` : `site:${cloudId}`));
      break;
    }
    case "confluence": {
      if (!cloudId) break;
      const spaceId = trimmed(asText(acl.spaceId));
      links.push(parentLink(provider, `site:${cloudId}`, spaceId ? `space:${spaceId}` : `site:${cloudId}`));
      break;
    }
    case "github": {
      const repoKey = trimmed(asText(acl.repoKey));
      if (repoKey) links.push(parentLink(provider, "global", `repository:${repoKey}`));
      break;
    }
    case "bitbucket": {
      const repoUuid = trimmed(asText(acl.repoUuid));
      if (repoUuid) links.push(parentLink(provider, "global", `repository:${repoUuid}`));
      break;
    }
    case "notion": {
      const parentType = trimmed(asText(acl.parentType));
      const parentId = trimmed(asText(acl.parentId));
      if (parentType && parentId) links.push(parentLink(provider, "tenant", `${parentType}:${parentId}`));
      break;
    }
    default:
      break;
  }
  return links;
}

function parentLink(provider: string, namespace: string, id: string): StagedDocumentSourceLink {
  return { role: "PARENT", target: { provider, namespace, id } };
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function trimmed(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emailValue(value: string | null | undefined): string | null {
  return firstEmail(value);
}

function isoDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stagedDocumentKind(value: unknown): value is StagedDocumentKind {
  return value === "document"
    || value === "conversation_window"
    || value === "transcript"
    || value === "code_file"
    || value === "comments";
}

function stagedDocumentRepresentedType(value: unknown): value is StagedDocumentRepresentedType {
  return value === "Person" || value === "Organization" || value === "Team"
    || value === "Document" || value === "Meeting" || value === "Message"
    || value === "Repository" || value === "Project" || value === "Topic"
    || value === "Product" || value === "Event" || value === "CodeSymbol" || value === "Issue";
}

function sourceLinkRole(value: unknown): value is StagedDocumentSourceLinkRole {
  return value === "PARENT" || value === "REPLY_TO" || value === "ATTACHED_TO" || value === "INSTANCE_OF";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalText(value: unknown): string | null {
  return nonEmpty(value) ? value.trim() : null;
}
