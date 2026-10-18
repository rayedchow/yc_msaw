import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Tenancy
//
// A tenant is the unit of isolation: one customer org (or one end user of a
// customer, for pooled B2C-style setups). Ported connector code uses the
// column name `user_id` for the tenant-scoped subject; in this repo that value
// IS the tenant id - tenancy is explicit parameters, no ambient context.
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    metadata: jsonb("metadata").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("uq_tenant_slug").on(table.slug)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull().default(""),
    /** SHA-256(pepper + raw key). Raw keys are never stored. */
    keyHash: text("key_hash").notNull(),
    /** First 8 chars of the raw key, for operator identification. */
    keyPrefix: text("key_prefix").notNull().default(""),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_api_key_hash").on(table.keyHash),
    index("idx_api_key_tenant").on(table.tenantId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    returnTo: text("return_to"),
    state: text("state").notNull(),
    status: text("status").notNull().default("pending"),
    workosUser: jsonb("workos_user"),
    workosOrganization: jsonb("workos_organization"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_auth_session_state").on(table.state),
    index("idx_auth_session_status_created").on(table.status, table.createdAt),
    check("ck_auth_session_status", sql`${table.status} IN ('pending', 'authenticated', 'consumed', 'failed')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    workosUserId: text("workos_user_id").notNull(),
    workosOrganizationId: text("workos_organization_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    organizationName: text("organization_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_sessions_tenant").on(table.tenantId),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

/**
 * One row per (tenant, provider, external account) connection: status +
 * non-secret metadata. Secret material lives in integration_tokens, owned by
 * the vault module.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("active"),
    externalAccountId: text("external_account_id"),
    metadata: jsonb("metadata").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connection_tenant_provider_external_account").on(
      table.tenantId,
      table.provider,
      sql`COALESCE(${table.externalAccountId}, '')`,
    ),
    index("idx_connection_provider").on(table.provider),
    check("ck_connection_status", sql`${table.status} IN ('pending', 'active', 'paused', 'revoked', 'error')`),
  ],
);

// ---------------------------------------------------------------------------
// Vault (provider token secrets - access only through src/vault)
// ---------------------------------------------------------------------------

export const integrationTokens = pgTable(
  "integration_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    /** AES-256-GCM ciphertext (iv:tag:ciphertext hex). */
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_token_user_provider").on(table.userId, table.provider),
    index("idx_integration_tokens_provider").on(table.provider),
  ],
);

// ---------------------------------------------------------------------------
// Raw event store
// ---------------------------------------------------------------------------

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    sourceNamespace: text("source_namespace"),
    sourceObjectId: text("source_object_id"),
    recordKind: text("record_kind"),
    eventType: text("event_type").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    wikiEligibilityAt: timestamp("wiki_eligibility_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload").notNull(),
    extractedEntities: jsonb("extracted_entities"),
    sourceEventId: text("source_event_id").notNull(),
    /** Slim lifecycle: collected -> mirrored (no downstream pipeline states). */
    processingStatus: text("processing_status").notNull().default("collected"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_event_user_source").on(table.userId, table.sourceEventId),
    index("idx_event_user_ts").on(table.userId, table.timestamp),
    index("idx_event_user_source_ts").on(table.userId, table.source, table.timestamp),
    index("idx_event_object_history").on(
      table.userId,
      table.source,
      table.sourceNamespace,
      table.sourceObjectId,
      table.timestamp,
    ).where(sql`${table.sourceNamespace} IS NOT NULL AND ${table.sourceObjectId} IS NOT NULL`),
    check("ck_activity_event_record_kind", sql`${table.recordKind} IS NULL OR ${table.recordKind} IN ('snapshot', 'activity', 'tombstone')`),
    check(
      "ck_activity_event_source_object",
      sql`(${table.sourceNamespace} IS NULL AND ${table.sourceObjectId} IS NULL)
        OR (${table.sourceNamespace} IS NOT NULL AND ${table.sourceObjectId} IS NOT NULL
          AND length(btrim(${table.sourceNamespace})) > 0 AND length(btrim(${table.sourceObjectId})) > 0)`,
    ),
  ],
);

export const binaryDocuments = pgTable(
  "binary_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    sha256: text("sha256"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    storageKey: text("storage_key"),
    versionRef: text("version_ref"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    authorEmail: text("author_email"),
    sourceAcl: jsonb("source_acl").notNull().default("{}"),
    parseStatus: text("parse_status").notNull().default("pending"),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_binary_document_origin").on(table.tenantId, table.provider, table.externalId),
    index("idx_binary_document_tenant_parse_status").on(table.tenantId, table.parseStatus),
    check("ck_binary_document_provider", sql`${table.provider} IN ('drive-pdf', 'upload', 'slack', 'gmail-attachment')`),
    check("ck_binary_document_parse_status", sql`${table.parseStatus} IN ('pending', 'parsed', 'failed_fetch', 'failed_unsupported', 'stored')`),
  ],
);

export const conversationWatermarks = pgTable(
  "conversation_watermarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    conversationId: text("conversation_id").notNull(),
    conversationType: text("conversation_type"),
    conversationName: text("conversation_name"),
    lastSeenTs: text("last_seen_ts"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("uq_watermark_user_provider_convo").on(table.userId, table.provider, table.conversationId),
    index("idx_watermark_user_provider_active").on(table.userId, table.provider, table.isActive),
  ],
);

export const threadWatermarks = pgTable(
  "thread_watermarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    lastReplyTs: text("last_reply_ts"),
    replyCount: text("reply_count"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_thread_watermark_user_channel_thread").on(table.userId, table.channelId, table.threadTs),
    index("idx_thread_watermark_user_active").on(table.userId, table.isActive),
    index("idx_thread_watermark_channel_active").on(table.userId, table.channelId, table.isActive),
  ],
);

export const sourceSyncRuns = pgTable(
  "source_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("queued"),
    phase: text("phase").notNull().default("queued"),
    requestedBy: text("requested_by").notNull().default("api"),
    coverageFrom: timestamp("coverage_from", { withTimezone: true }),
    coverageTo: timestamp("coverage_to", { withTimezone: true }).notNull(),
    exhausted: boolean("exhausted").notNull().default(false),
    capHit: boolean("cap_hit").notNull().default(false),
    result: jsonb("result").notNull().default("{}"),
    metadata: jsonb("metadata").notNull().default("{}"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_source_sync_runs_user_provider_status").on(table.userId, table.provider, table.status),
    index("idx_source_sync_runs_status_updated").on(table.status, table.updatedAt),
    check("ck_source_sync_status", sql`${table.status} IN ('queued', 'running', 'completed', 'blocked', 'failed')`),
  ],
);

/**
 * Per-tenant, per-repo GitHub sync selection. Capture-everything default: a
 * repo with NO row here syncs; a row with `syncing = false` stops FUTURE
 * proxy sweeps for that repo only - already-captured activity_events /
 * mirror_files / binary_documents are never deleted by stopping.
 */
export const githubRepoSync = pgTable(
  "github_repo_sync",
  {
    tenantId: text("tenant_id").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    syncing: boolean("syncing").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.repoFullName] }),
  ],
);

// ---------------------------------------------------------------------------
// Mirror - the product surface: the `sources/` file tree, one row per file.
// ---------------------------------------------------------------------------

export const mirrorFiles = pgTable(
  "mirror_files",
  {
    path: text("path").notNull(),
    userId: text("user_id").notNull(),
    content: text("content").notNull().default(""),
    contentSha: text("content_sha"),
    /** Staged-document envelope (docs/source-pipeline-plan.md §3); null until the renderer regenerates the row. */
    meta: jsonb("meta"),
    /** SHA-256 of the normalized envelope only (never content). */
    metaSha: text("meta_sha"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_mirror_file_user_path").on(table.userId, table.path),
    index("idx_mirror_file_path").on(table.path),
    index("idx_mirror_file_user_content_sha").on(table.userId, table.contentSha),
  ],
);

// ---------------------------------------------------------------------------
// Google Calendar connector state
// ---------------------------------------------------------------------------

export const googleCalendarSyncStates = pgTable(
  "google_calendar_sync_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    delegatedEmail: text("delegated_email").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceKey: text("resource_key").notNull(),
    calendarId: text("calendar_id"),
    calendarSummary: text("calendar_summary"),
    calendarAccessRole: text("calendar_access_role"),
    calendarTimeZone: text("calendar_time_zone"),
    calendarPrimary: boolean("calendar_primary").notNull().default(false),
    syncToken: text("sync_token"),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    lastIncrementalSyncAt: timestamp("last_incremental_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_calendar_sync_state").on(table.userId, table.delegatedEmail, table.resourceType, table.resourceKey),
    index("idx_google_calendar_sync_state_user_type").on(table.userId, table.resourceType),
    check("ck_google_calendar_sync_resource_type", sql`${table.resourceType} IN ('calendar_list', 'events')`),
  ],
);

export const googleCalendarWatchChannels = pgTable(
  "google_calendar_watch_channels",
  {
    channelId: text("channel_id").primaryKey(),
    userId: text("user_id").notNull(),
    delegatedEmail: text("delegated_email").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceKey: text("resource_key").notNull(),
    calendarId: text("calendar_id"),
    resourceId: text("resource_id").notNull(),
    resourceUri: text("resource_uri"),
    tokenHash: text("token_hash").notNull(),
    eventTypes: jsonb("event_types").notNull().default("[]"),
    expiration: timestamp("expiration", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    lastMessageNumber: text("last_message_number"),
    lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_google_calendar_watch_user_status").on(table.userId, table.status),
    index("idx_google_calendar_watch_resource").on(table.userId, table.delegatedEmail, table.resourceType, table.resourceKey, table.status),
    index("idx_google_calendar_watch_expiration").on(table.expiration),
    index("idx_google_calendar_watch_resource_id").on(table.resourceId),
    check("ck_google_calendar_watch_resource_type", sql`${table.resourceType} IN ('calendar_list', 'events')`),
    check("ck_google_calendar_watch_status", sql`${table.status} IN ('active', 'superseded', 'stopped', 'expired')`),
  ],
);

export const googleCalendarEventSnapshots = pgTable(
  "google_calendar_event_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    delegatedEmail: text("delegated_email").notNull(),
    calendarId: text("calendar_id").notNull(),
    eventId: text("event_id").notNull(),
    iCalUID: text("ical_uid"),
    recurringEventId: text("recurring_event_id"),
    eventType: text("event_type"),
    status: text("status"),
    summary: text("summary"),
    start: jsonb("start"),
    end: jsonb("end"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    contentHash: text("content_hash").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_calendar_event_snapshot").on(table.userId, table.delegatedEmail, table.calendarId, table.eventId),
    index("idx_google_calendar_event_snapshot_user_calendar").on(table.userId, table.delegatedEmail, table.calendarId),
    index("idx_google_calendar_event_snapshot_user_updated").on(table.userId, table.sourceUpdatedAt),
    index("idx_google_calendar_event_snapshot_ical_uid").on(table.userId, table.iCalUID),
  ],
);

// ---------------------------------------------------------------------------
// Google Docs connector state (doc catalog for the mirror backfill)
// ---------------------------------------------------------------------------

export const documentSummaries = pgTable(
  "document_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    title: text("title").notNull().default(""),
    overview: text("overview").notNull().default(""),
    tabSummaries: jsonb("tab_summaries").notNull().default("{}"),
    contributors: jsonb("contributors").notNull().default("[]"),
    lastSynthesisEntry: integer("last_synthesis_entry").notNull().default(0),
    pendingBuffer: jsonb("pending_buffer").notNull().default("[]"),
    dirtyAt: timestamp("dirty_at", { withTimezone: true }),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_docsummary_user_doc").on(table.userId, table.docId),
    index("idx_docsummary_dirty").on(table.dirtyAt),
  ],
);

/**
 * Google People identity cache: Drive Activity person IDs resolved to
 * email/name. Rows are user-scoped because People API visibility is
 * per-requester - user A seeing an email says nothing about user B.
 *
 * status: "resolved" (email visible) | "partial" (display name only -
 * out-of-domain or restricted profile) | "unresolved" (nothing visible).
 * Partial/unresolved rows carry nextRetryAt backoff so actors Google will
 * never reveal aren't re-fetched on every poll cycle.
 */
export const googleActorIdentities = pgTable(
  "google_actor_identities",
  {
    userId: text("user_id").notNull(),
    personId: text("person_id").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_actor_identity").on(table.userId, table.personId),
    index("idx_google_actor_identity_retry").on(table.userId, table.nextRetryAt),
  ],
);

/**
 * Google Contacts name enrichment: email -> display name from the People API
 * (`people.connections.list` saved contacts + `otherContacts.list` auto-
 * collected correspondents), aggregated across every Google-connected
 * workspace user of the tenant. One row per (tenant, email); 'connections'
 * beats 'other_contacts' on upsert, newer sync wins within the same source.
 * Names only - never phone numbers, photos, or raw payloads
 * (docs/integrations/google-contacts.md).
 */
export const googleContactNames = pgTable(
  "google_contact_names",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    source: text("source").notNull(),
    ownerEmail: text("owner_email").notNull(),
    resourceName: text("resource_name").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_google_contact_name_tenant_email").on(table.tenantId, table.email),
    check("ck_google_contact_name_source", sql`${table.source} IN ('connections', 'other_contacts')`),
  ],
);

/**
 * Deterministic Google Docs suggestion cards, synced from the OT changelog
 * (`gdocs.suggestion-sync` job). One row per (user, doc, suggestion), upserted
 * each sync to hold current state. `changelog_resolved` is false when only the
 * Docs API content/placement was available (reader role, or the undocumented
 * endpoint was down) - then author/status/timestamps are null.
 */
export const googleDocSuggestions = pgTable(
  "google_doc_suggestions",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    suggestionId: text("suggestion_id").notNull(),
    tabId: text("tab_id"),
    tabName: text("tab_name"),
    insertedText: text("inserted_text").notNull().default(""),
    deletedText: text("deleted_text").notNull().default(""),
    contextBefore: text("context_before").notNull().default(""),
    contextAfter: text("context_after").notNull().default(""),
    authorUserId: text("author_user_id"),
    authorName: text("author_name"),
    status: text("status").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),
    modificationCount: integer("modification_count").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByName: text("resolved_by_name"),
    changelogResolved: boolean("changelog_resolved").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_suggestion").on(table.userId, table.docId, table.suggestionId),
    index("idx_google_doc_suggestion_doc").on(table.userId, table.docId),
  ],
);

/**
 * Attributed Google Docs tab-change events, extracted from the OT changelog
 * (`gdocs.suggestion-sync` job - it fetches the changelog once and derives both
 * suggestions and tab changes). One row per (doc, tab, event, changelogIndex),
 * upserted. `actor_*` is null when the changelog wasn't available (view-only /
 * endpoint down) - but tab events only exist when the changelog was read, so in
 * practice attribution is present.
 */
export const googleDocTabEvents = pgTable(
  "google_doc_tab_events",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    tabId: text("tab_id").notNull(),
    /** created | renamed | moved | deleted */
    eventType: text("event_type").notNull(),
    /** Position in the changelog - makes the event row deterministically keyed. */
    changelogIndex: integer("changelog_index").notNull(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    oldName: text("old_name"),
    newName: text("new_name"),
    /** Hierarchy position arrays ([2] = top-level, [2,0] = subtab). */
    fromPosition: jsonb("from_position"),
    toPosition: jsonb("to_position"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_tab_event").on(table.userId, table.docId, table.tabId, table.eventType, table.changelogIndex),
    index("idx_google_doc_tab_event_doc").on(table.userId, table.docId),
  ],
);

/**
 * Current Google Docs tab tree, reconstructed each sync. One row per (doc, tab),
 * upserted; `deleted_at` set when the tab is gone. Position encodes both order
 * and nesting ([2] top-level, [2,0] subtab).
 */
export const googleDocTabs = pgTable(
  "google_doc_tabs",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    tabId: text("tab_id").notNull(),
    name: text("name"),
    position: jsonb("position"),
    parentTabId: text("parent_tab_id"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_tab").on(table.userId, table.docId, table.tabId),
    index("idx_google_doc_tab_doc").on(table.userId, table.docId),
  ],
);

/**
 * Immutable Google Docs tab-content snapshots, captured when the Drive change
 * feed reports a doc changed (`gdocs.content-snapshot` task). Version-append:
 * one row per (doc, tab, revision) - a new `revisionId` inserts new rows,
 * never overwrites. `content` is the same rendered per-tab representation the
 * mirror backfill produces (markdown projection + pending suggestions +
 * `suggestionsAccessible`), rendered from the REDACTED raw JSON so
 * requester-scoped `contentUri`s can never land in a row (see
 * google_doc_images for the security rule).
 */
export const googleDocTabSnapshots = pgTable(
  "google_doc_tab_snapshots",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    tabId: text("tab_id").notNull(),
    /** Docs API `revisionId` at fetch time. */
    revisionId: text("revision_id").notNull(),
    /** Tab title at capture time (display-only; `tab_id` is the stable key). */
    title: text("title").notNull().default(""),
    /** { content, suggestions, suggestionsAccessible, parentTabId }. */
    content: jsonb("content").notNull(),
    contentSha: text("content_sha").notNull(),
    /** Drive `modifiedTime` of the change that triggered the capture. */
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_tab_snapshot").on(table.userId, table.docId, table.tabId, table.revisionId),
    index("idx_google_doc_tab_snapshot_doc").on(table.userId, table.docId, table.capturedAt),
  ],
);

/**
 * Per-doc changelog-sync watermark. Records the doc's `last_seen_ts`
 * (= modifiedTime) at the last SUCCESSFUL sync, so the hourly full sweep can
 * skip docs that haven't changed since - avoiding a Docs `documents.get` (and
 * possibly a changelog fetch) for unchanged docs. Only advanced on success
 * (skip when the changelog was needed but returned null) so transient failures
 * retry. Suggestions/tab changes bump modifiedTime, so an unadvanced watermark
 * means nothing to sync - no info lost.
 */
/**
 * Per-mailbox Google sync cursors (gmail historyId, Drive changes token,
 * backfill/poll watermarks). One row per delegated mailbox per tenant; the
 * roster of mailboxes itself is the set of active `connections` rows for
 * provider 'google'. Replaces the single-mailbox cursors that lived on the
 * integration_tokens metadata blob. bigint watermarks are Date.now() ms.
 */
export const googleMailboxSyncState = pgTable(
  "google_mailbox_sync_state",
  {
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    historyId: text("history_id"),
    lastBackfillAt: bigint("last_backfill_at", { mode: "number" }),
    drivePageToken: text("drive_page_token"),
    lastEditPollAt: text("last_edit_poll_at"),
    lastCommentPollAt: text("last_comment_poll_at"),
    lastDocsBackfillAt: bigint("last_docs_backfill_at", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.email] })],
);

export const googleDocSyncState = pgTable(
  "google_doc_sync_state",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    lastSyncedSeenTs: text("last_synced_seen_ts"),
    folderIds: text("folder_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    mirrorPathPrefix: text("mirror_path_prefix"),
    driveLineageSyncedAt: timestamp("drive_lineage_synced_at", { withTimezone: true }),
    driveLineageFailureCount: integer("drive_lineage_failure_count").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_sync_state").on(table.userId, table.docId),
    index("idx_google_doc_sync_state_folder_ids").using("gin", table.folderIds),
    index("idx_google_doc_sync_state_mirror_path").on(table.userId, table.mirrorPathPrefix),
  ],
);

/**
 * Google Docs embedded-image bytes, fetched at sync time within the
 * `contentUri`'s ~30-minute window and stored as base64. SECURITY RULE: the
 * `contentUri` itself is NEVER persisted anywhere - it is tagged with the
 * requester's account and grants requester-scoped access to whoever holds it.
 * Bytes are capped per image and per doc; Postgres is the store until an
 * object store exists (revisit at scale).
 */
export const googleDocImages = pgTable(
  "google_doc_images",
  {
    userId: text("user_id").notNull(),
    docId: text("doc_id").notNull(),
    /** The inlineObjects/positionedObjects map key (kix object id). */
    objectId: text("object_id").notNull(),
    /** image | drawing | chart */
    kind: text("kind").notNull().default("image"),
    altText: text("alt_text"),
    mimeType: text("mime_type"),
    sha256: text("sha256"),
    sizeBytes: integer("size_bytes"),
    dataBase64: text("data_base64"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_google_doc_image").on(table.userId, table.docId, table.objectId),
    index("idx_google_doc_image_doc").on(table.userId, table.docId),
  ],
);

// ---------------------------------------------------------------------------
// Notion connector state
// ---------------------------------------------------------------------------

export const notionPageSummaries = pgTable(
  "notion_page_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    pageId: text("page_id").notNull(),
    title: text("title").notNull().default(""),
    url: text("url"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    dataSourceId: text("data_source_id"),
    overview: text("overview").notNull().default(""),
    sectionSummaries: jsonb("section_summaries").notNull().default("{}"),
    properties: jsonb("properties").notNull().default("{}"),
    pageMetadata: jsonb("page_metadata").notNull().default("{}"),
    contentHash: text("content_hash"),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    dirtyAt: timestamp("dirty_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    markdownTruncated: boolean("markdown_truncated").notNull().default(false),
    unknownBlockIds: jsonb("unknown_block_ids").notNull().default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_page_summary_user_page").on(table.userId, table.pageId),
    index("idx_notion_page_summary_dirty").on(table.dirtyAt),
    index("idx_notion_page_summary_user_edited").on(table.userId, table.lastEditedTime),
  ],
);

// ---------------------------------------------------------------------------
// Notion native snapshot store (src/integrations/notion/snapshot.ts).
// One normalized row set per synced page: objects (the union view), edges
// (parent/child relations), plus per-type snapshots. All writes go through
// raw SQL upserts in snapshot.ts - the ON CONFLICT targets below must match
// its conflict clauses exactly.
// ---------------------------------------------------------------------------

export const notionObjects = pgTable(
  "notion_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    objectId: text("object_id").notNull(),
    /** page | block | data_source | database | view | data_source_template | comment */
    objectType: text("object_type").notNull(),
    title: text("title").notNull().default(""),
    url: text("url"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    dataSourceId: text("data_source_id"),
    databaseId: text("database_id"),
    blockType: text("block_type"),
    hasChildren: boolean("has_children").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    inTrash: boolean("in_trash").notNull().default(false),
    plainText: text("plain_text").notNull().default(""),
    objectHash: text("object_hash").notNull(),
    properties: jsonb("properties").notNull().default("{}"),
    metadata: jsonb("metadata").notNull().default("{}"),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastEditedBy: jsonb("last_edited_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_object_user_object").on(table.userId, table.objectId),
    index("idx_notion_object_user_type").on(table.userId, table.objectType),
  ],
);

export const notionObjectEdges = pgTable(
  "notion_object_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    parentObjectId: text("parent_object_id").notNull(),
    childObjectId: text("child_object_id").notNull(),
    relationType: text("relation_type").notNull(),
    position: integer("position").notNull().default(0),
    /** The page whose sync produced this edge (prune scope). */
    sourceObjectId: text("source_object_id"),
    metadata: jsonb("metadata").notNull().default("{}"),
    childHash: text("child_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_object_edge").on(table.userId, table.parentObjectId, table.childObjectId, table.relationType),
    index("idx_notion_object_edge_child").on(table.userId, table.childObjectId),
    index("idx_notion_object_edge_source").on(table.userId, table.sourceObjectId),
  ],
);

export const notionBlockSnapshots = pgTable(
  "notion_block_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    blockId: text("block_id").notNull(),
    pageId: text("page_id"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    blockType: text("block_type").notNull(),
    hasChildren: boolean("has_children").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    inTrash: boolean("in_trash").notNull().default(false),
    plainText: text("plain_text").notNull().default(""),
    markdown: text("markdown").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    childrenHash: text("children_hash").notNull(),
    tableCellRichText: jsonb("table_cell_rich_text"),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastEditedBy: jsonb("last_edited_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_block_snapshot_user_block").on(table.userId, table.blockId),
    index("idx_notion_block_snapshot_page").on(table.userId, table.pageId),
  ],
);

export const notionDataSourceSnapshots = pgTable(
  "notion_data_source_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    dataSourceId: text("data_source_id").notNull(),
    databaseId: text("database_id"),
    title: text("title").notNull().default(""),
    description: jsonb("description"),
    url: text("url"),
    publicUrl: text("public_url"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    isInline: boolean("is_inline").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    inTrash: boolean("in_trash").notNull().default(false),
    icon: jsonb("icon"),
    cover: jsonb("cover"),
    properties: jsonb("properties").notNull().default("{}"),
    propertyHash: text("property_hash").notNull(),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastEditedBy: jsonb("last_edited_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_data_source_snapshot").on(table.userId, table.dataSourceId),
  ],
);

export const notionDatabaseSnapshots = pgTable(
  "notion_database_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    databaseId: text("database_id").notNull(),
    title: text("title").notNull().default(""),
    description: jsonb("description"),
    url: text("url"),
    publicUrl: text("public_url"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    isInline: boolean("is_inline").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    inTrash: boolean("in_trash").notNull().default(false),
    icon: jsonb("icon"),
    cover: jsonb("cover"),
    properties: jsonb("properties").notNull().default("{}"),
    dataSources: jsonb("data_sources").notNull().default("[]"),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastEditedBy: jsonb("last_edited_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_database_snapshot").on(table.userId, table.databaseId),
  ],
);

export const notionViewSnapshots = pgTable(
  "notion_view_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    viewId: text("view_id").notNull(),
    databaseId: text("database_id"),
    dataSourceId: text("data_source_id"),
    name: text("name").notNull().default(""),
    viewType: text("view_type").notNull(),
    url: text("url"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    dashboardViewId: text("dashboard_view_id"),
    filter: jsonb("filter"),
    sorts: jsonb("sorts"),
    quickFilters: jsonb("quick_filters"),
    configuration: jsonb("configuration"),
    // Optional view-query snapshot; only overwritten when a write carries a
    // fresh query_fetched_at (see upsertViews in snapshot.ts).
    queryResultPageIds: jsonb("query_result_page_ids").notNull().default("[]"),
    queryTotalCount: integer("query_total_count"),
    queryHasMore: boolean("query_has_more").notNull().default(false),
    queryNextCursor: text("query_next_cursor"),
    queryRequestStatus: jsonb("query_request_status"),
    queryExpiresAt: timestamp("query_expires_at", { withTimezone: true }),
    queryFetchedAt: timestamp("query_fetched_at", { withTimezone: true }),
    queryRaw: jsonb("query_raw"),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastEditedBy: jsonb("last_edited_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_view_snapshot").on(table.userId, table.viewId),
    index("idx_notion_view_snapshot_data_source").on(table.userId, table.dataSourceId),
  ],
);

export const notionCommentSnapshots = pgTable(
  "notion_comment_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    commentId: text("comment_id").notNull(),
    pageId: text("page_id"),
    blockId: text("block_id"),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    discussionId: text("discussion_id"),
    plainText: text("plain_text").notNull().default(""),
    richText: jsonb("rich_text").notNull().default("[]"),
    retrievalRequestStatus: jsonb("retrieval_request_status"),
    retrievalComplete: boolean("retrieval_complete"),
    retrievalHasMore: boolean("retrieval_has_more"),
    retrievalNextCursor: text("retrieval_next_cursor"),
    raw: jsonb("raw").notNull().default("{}"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    lastEditedTime: timestamp("last_edited_time", { withTimezone: true }),
    createdBy: jsonb("created_by"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notion_comment_snapshot").on(table.userId, table.commentId),
    index("idx_notion_comment_snapshot_page").on(table.userId, table.pageId),
  ],
);

// ---------------------------------------------------------------------------
// Task engine (Nango-style Postgres queue) - see src/queue/
// ---------------------------------------------------------------------------

export const taskQueue = pgTable(
  "task_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Logical queue lane, e.g. "sync" | "backfill" | "outbox". */
    queue: text("queue").notNull(),
    tenantId: text("tenant_id").notNull(),
    /** Serialization group, `tenant:connector`; max 1 running per group. */
    groupKey: text("group_key").notNull(),
    /** Handler name registered on the worker. */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default("{}"),
    /** Idempotency key: at most one queued/running task per key. */
    dedupeKey: text("dedupe_key"),
    state: text("state").notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    priority: integer("priority").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    heartbeatTimeoutSeconds: integer("heartbeat_timeout_seconds").notNull().default(120),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    output: jsonb("output"),
    errorMessage: text("error_message"),
    /** Denormalized pointer to the previous run for this group+kind (Nango's scaling lesson). */
    prevRunId: uuid("prev_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_task_dequeue").on(table.queue, table.state, table.runAt),
    index("idx_task_group_state").on(table.groupKey, table.state),
    index("idx_task_tenant_state").on(table.tenantId, table.state),
    index("idx_task_running_heartbeat").on(table.state, table.lastHeartbeatAt),
    uniqueIndex("uq_task_dedupe_active")
      .on(table.dedupeKey)
      .where(sql`state IN ('queued', 'running') AND dedupe_key IS NOT NULL`),
    check("ck_task_state", sql`${table.state} IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled')`),
  ],
);

export const taskSchedules = pgTable(
  "task_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    queue: text("queue").notNull().default("sync"),
    groupKey: text("group_key").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default("{}"),
    /** Interval between runs; the sweeper enqueues when due_at <= now(). */
    frequencySeconds: integer("frequency_seconds").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean("enabled").notNull().default(true),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    deferredSince: timestamp("deferred_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_task_schedule_group_kind").on(table.groupKey, table.kind),
    index("idx_task_schedule_due").on(table.enabled, table.dueAt),
    check("ck_task_schedule_frequency", sql`${table.frequencySeconds} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Transactional outbox -> customer webhooks - see src/outbox/
// ---------------------------------------------------------------------------

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    /** e.g. "mirror.file.changed", "connection.updated", "event.collected". */
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default("{}"),
    /** Ordering key for per-endpoint serialized delivery (usually group_key). */
    orderingKey: text("ordering_key"),
    state: text("state").notNull().default("pending"),
    /** Endpoint ids that already accepted this event; retries skip them. */
    deliveredEndpointIds: jsonb("delivered_endpoint_ids").notNull().default("[]"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_outbox_dispatch").on(table.state, table.nextAttemptAt),
    index("idx_outbox_tenant_created").on(table.tenantId, table.createdAt),
    check("ck_outbox_state", sql`${table.state} IN ('pending', 'delivering', 'delivered', 'dead')`),
  ],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    url: text("url").notNull(),
    /** HMAC-SHA256 signing secret (encrypted at rest via vault encryption). */
    secret: text("secret").notNull(),
    /** Event-type prefixes this endpoint subscribes to; empty = all. */
    eventTypes: jsonb("event_types").notNull().default("[]"),
    enabled: boolean("enabled").notNull().default(true),
    // Circuit breaker state (per endpoint).
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true }),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_webhook_endpoint_tenant").on(table.tenantId, table.enabled)],
);

// ---------------------------------------------------------------------------
// Knowledge graph core
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
});

export const kbContainers = pgTable(
  "kb_containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    settings: jsonb("settings").notNull().default("{}"),
    graphVersion: text("graph_version").notNull().default("v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_kb_container_tenant_slug").on(table.tenantId, table.slug),
    check("ck_kb_containers_graph_version", sql`${table.graphVersion} IN ('v1', 'v2')`),
  ],
);

export const kbMembers = pgTable(
  "kb_members",
  {
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectId: text("subject_id").notNull(),
    role: text("role").notNull(),
  },
  (table) => [
    uniqueIndex("uq_kb_member_subject").on(table.kbId, table.subjectId),
    check("ck_kb_member_role", sql`${table.role} IN ('admin', 'sme', 'member')`),
  ],
);

export const kbSources = pgTable(
  "kb_sources",
  {
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    provider: text("provider").notNull(),
    selector: jsonb("selector").notNull().default("{}"),
    selectorHash: text("selector_hash").notNull(),
  },
  (table) => [
    uniqueIndex("uq_kb_source_provider_selector").on(table.kbId, table.provider, table.selectorHash),
  ],
);

// ---------------------------------------------------------------------------
// Graph lineage bridge
// ---------------------------------------------------------------------------

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    sourceNamespace: text("source_namespace"),
    sourceObjectId: text("source_object_id"),
    representedType: text("represented_type"),
    title: text("title"),
    mirrorPath: text("mirror_path"),
    contentSha: text("content_sha"),
    sourceAcl: jsonb("source_acl"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    authorEmail: text("author_email"),
    authorName: text("author_name"),
    updatedByEmail: text("updated_by_email"),
    aliases: jsonb("aliases").notNull().default("[]"),
    sourceRefs: jsonb("source_refs").notNull().default("[]"),
    sourceLinks: jsonb("source_links").notNull().default("[]"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    versionRef: text("version_ref"),
    replayOfDocumentId: uuid("replay_of_document_id").references((): AnyPgColumn => sourceDocuments.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("uq_source_document_kb_provider_namespace_external_kind")
      .on(table.kbId, table.provider, table.sourceNamespace, table.externalId, table.kind),
    uniqueIndex("uq_source_document_kb_replay_source")
      .on(table.kbId, table.replayOfDocumentId)
      .where(sql`${table.replayOfDocumentId} IS NOT NULL`),
    check("ck_source_document_kind", sql`${table.kind} IN ('document', 'conversation_window', 'transcript', 'code_file', 'comments', 'synthesis')`),
    check("ck_source_document_source_links", sql`jsonb_typeof(${table.sourceLinks}) = 'array'`),
    check(
      "ck_source_document_source_object",
      sql`(${table.sourceNamespace} IS NULL AND ${table.sourceObjectId} IS NULL)
        OR (${table.sourceNamespace} IS NOT NULL AND ${table.sourceObjectId} IS NOT NULL
          AND length(btrim(${table.sourceNamespace})) > 0 AND length(btrim(${table.sourceObjectId})) > 0)`,
    ),
    check(
      "ck_source_document_represented_type",
      sql`${table.representedType} IS NULL OR (
        ${table.representedType} IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
        AND length(btrim(${table.provider})) > 0
        AND length(btrim(${table.sourceNamespace})) > 0
        AND length(btrim(${table.externalId})) > 0
      )`,
    ),
  ],
);

export const documentEmbeddings = pgTable(
  "document_embeddings",
  {
    documentId: uuid("document_id").primaryKey().references(() => sourceDocuments.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    embeddingInputsHash: text("embedding_inputs_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_document_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("idx_document_embeddings_kb").on(table.kbId),
  ],
);

export const codeFileParses = pgTable(
  "code_file_parses",
  {
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    repo: text("repo").notNull(),
    path: text("path").notNull(),
    contentSha: text("content_sha").notNull(),
    parserVersion: text("parser_version").notNull(),
    parseHealth: jsonb("parse_health").notNull().default("{}"),
    symbols: jsonb("symbols").notNull().default("[]"),
    imports: jsonb("imports").notNull().default("[]"),
    callSites: jsonb("call_sites").notNull().default("[]"),
    indexedCommit: text("indexed_commit").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_code_file_parse_kb_repo_path").on(table.kbId, table.repo, table.path),
    index("idx_code_file_parse_kb_repo_commit").on(table.kbId, table.repo, table.indexedCommit),
    index("idx_code_file_parse_kb_repo_live").on(table.kbId, table.repo).where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const codeRepos = pgTable(
  "code_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    repo: text("repo").notNull(),
    cloneUrl: text("clone_url"),
    localDir: text("local_dir"),
    trackedRef: text("tracked_ref").notNull().default("main"),
    includeGlobs: jsonb("include_globs").notNull().default("[]"),
    excludeGlobs: jsonb("exclude_globs").notNull().default("[]"),
    macroDenylist: jsonb("macro_denylist").notNull().default("[]"),
    lastIndexedCommit: text("last_indexed_commit"),
    lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_code_repo_kb_repo").on(table.kbId, table.repo),
    index("idx_code_repo_tenant_status").on(table.tenantId, table.status),
    index("idx_code_repo_kb_status").on(table.kbId, table.status),
    check("ck_code_repo_status", sql`${table.status} IN ('active', 'paused', 'error')`),
    check("ck_code_repo_clone_or_local", sql`${table.cloneUrl} IS NOT NULL OR ${table.localDir} IS NOT NULL`),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    documentId: uuid("document_id").notNull().references(() => sourceDocuments.id),
    ordinal: integer("ordinal").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    text: text("text").notNull(),
    meta: jsonb("meta").notNull().default("{}"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    replayOfChunkId: uuid("replay_of_chunk_id").references((): AnyPgColumn => chunks.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("uq_chunk_document_ordinal_live")
      .on(table.documentId, table.ordinal)
      .where(sql`${table.supersededAt} IS NULL`),
    uniqueIndex("uq_chunk_claim_provenance").on(table.id, table.documentId, table.kbId, table.chunkHash),
    uniqueIndex("uq_chunk_kb_replay_source")
      .on(table.kbId, table.replayOfChunkId)
      .where(sql`${table.replayOfChunkId} IS NOT NULL`),
    index("idx_chunk_document_hash").on(table.documentId, table.chunkHash),
  ],
);

// ---------------------------------------------------------------------------
// Graph entities
// ---------------------------------------------------------------------------

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    type: text("type").notNull(),
    name: text("name").notNull(),
    canonicalId: uuid("canonical_id").references((): AnyPgColumn => entities.id),
    status: text("status").notNull().default("active"),
    scopeTags: jsonb("scope_tags").notNull().default("{}"),
    summary: text("summary"),
    summaryInputsHash: text("summary_inputs_hash"),
    lastSweptAt: timestamp("last_swept_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_entity_kb_type").on(table.kbId, table.type),
    index("idx_entity_kb_canonical").on(table.kbId, table.canonicalId),
    // Bare canonical_id index for FK delete triggers during KB reset.
    index("idx_entities_canonical_id").on(table.canonicalId),
    index("idx_entities_kb_last_swept").on(table.kbId, table.lastSweptAt.asc().nullsFirst()),
    check("ck_entity_status", sql`${table.status} IN ('active', 'merged', 'archived')`),
  ],
);

export const entitySummaryEmbeddings = pgTable(
  "entity_summary_embeddings",
  {
    entityId: uuid("entity_id").primaryKey().references(() => entities.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    embeddingInputsHash: text("embedding_inputs_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_entity_summary_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("idx_entity_summary_embeddings_kb").on(table.kbId),
  ],
);

export const entityAliases = pgTable(
  "entity_aliases",
  {
    entityId: uuid("entity_id").notNull().references(() => entities.id),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_entity_alias_kind_value").on(table.entityId, table.kind, table.value),
    index("idx_entity_alias_kind_value").on(table.kind, table.value),
  ],
);

export const entityLinks = pgTable(
  "entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    aEntityId: uuid("a_entity_id").notNull().references(() => entities.id),
    bEntityId: uuid("b_entity_id").notNull().references(() => entities.id),
    score: real("score"),
    method: text("method").notNull(),
    state: text("state").notNull().default("pending"),
    adjudicatingAt: timestamp("adjudicating_at", { withTimezone: true }),
    deferCount: integer("defer_count").notNull().default(0),
    deferredUntil: timestamp("deferred_until", { withTimezone: true }),
    verdictRationale: text("verdict_rationale"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_entity_link_pair").on(table.aEntityId, table.bEntityId),
    index("idx_entity_links_kb_state_created").on(table.kbId, table.state, table.createdAt),
    check("ck_entity_link_state", sql`${table.state} IN ('pending', 'adjudicating', 'merged', 'rejected', 'needs_human_review')`),
  ],
);

export const erDecisions = pgTable(
  "er_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    mentionName: text("mention_name").notNull(),
    mentionType: text("mention_type").notNull(),
    method: text("method").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    topCandidateScore: real("top_candidate_score"),
    adjudicatorConfidence: real("adjudicator_confidence"),
    resolvedEntityId: uuid("resolved_entity_id").references(() => entities.id),
    createdEntity: boolean("created_entity").notNull().default(false),
    pendingLinkCount: integer("pending_link_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_er_decisions_kb_method").on(table.kbId, table.method, table.createdAt),
    check(
      "ck_er_decision_method",
      sql`${table.method} IN ('identifier', 'name_exact', 'adjudicated', 'created', 'created_flagged', 'ambiguous_names')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Graph claims
// ---------------------------------------------------------------------------

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    text: text("text").notNull(),
    kind: text("kind").notNull(),
    subjectEntityId: uuid("subject_entity_id").references(() => entities.id),
    predicate: text("predicate"),
    objectEntityId: uuid("object_entity_id").references(() => entities.id),
    objectValue: text("object_value"),
    documentId: uuid("document_id").notNull().references(() => sourceDocuments.id),
    chunkId: uuid("chunk_id").references(() => chunks.id),
    chunkHash: text("chunk_hash").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    sourceAcl: jsonb("source_acl"),
    trustTier: smallint("trust_tier").notNull(),
    salience: smallint("salience"),
    modality: text("modality").notNull().default("asserted"),
    confidence: real("confidence"),
    eventAt: timestamp("event_at", { withTimezone: true }),
    firstIngestedAt: timestamp("first_ingested_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    invalidAt: timestamp("invalid_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => claims.id),
    invalidationReason: text("invalidation_reason"),
    synthesisGrade: text("synthesis_grade"),
    conclusionCarriedFrom: uuid("conclusion_carried_from").references((): AnyPgColumn => claims.id),
    tsv: tsvector("tsv").notNull(),
  },
  (table) => [
    index("idx_claim_subject_predicate_live")
      .on(table.kbId, table.subjectEntityId, table.predicate)
      .where(sql`${table.invalidAt} IS NULL`),
    index("idx_claim_chunk").on(table.kbId, table.chunkId),
    index("idx_claim_document_live").on(table.documentId).where(sql`${table.invalidAt} IS NULL`),
    index("idx_claim_tsv").using("gin", table.tsv),
    // Self-referencing FK columns: without indexes, mass deletes (KB reset)
    // fire per-row FK triggers that seq-scan claims itself — O(n^2).
    index("idx_claims_superseded_by").on(table.supersededBy),
    index("idx_claims_conclusion_carried_from").on(table.conclusionCarriedFrom),
    uniqueIndex("uq_claim_extraction_live")
      .on(table.chunkId, table.extractorVersion, table.text)
      .where(sql`${table.chunkId} IS NOT NULL AND ${table.invalidAt} IS NULL`),
    foreignKey({
      columns: [table.chunkId, table.documentId, table.kbId, table.chunkHash],
      foreignColumns: [chunks.id, chunks.documentId, chunks.kbId, chunks.chunkHash],
      name: "fk_claim_chunk_provenance",
    }),
    check("ck_claim_kind", sql`${table.kind} IN ('fact', 'relation', 'summary', 'compiled', 'procedure_check', 'synthesis')`),
    check("ck_claim_salience", sql`${table.salience} IS NULL OR ${table.salience} BETWEEN 0 AND 100`),
    check("ck_claim_modality", sql`${table.modality} IN ('asserted', 'believed', 'planned', 'speculated', 'reported')`),
    check("ck_claim_synthesis_grade", sql`${table.synthesisGrade} IS NULL OR ${table.synthesisGrade} IN ('restatement', 'interpretive')`),
    check(
      "ck_claim_invalidation_reason",
      sql`${table.invalidationReason} IS NULL OR ${table.invalidationReason} IN ('chunk_changed', 'contradicted', 'sme_correction', 'source_deleted', 'extractor_upgraded', 'file_changed', 'input_superseded', 'resynthesized', 'file_deleted')`,
    ),
  ],
);

export const contradictionVerdicts = pgTable(
  "contradiction_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    newClaimId: uuid("new_claim_id").notNull().references(() => claims.id),
    existingClaimId: uuid("existing_claim_id").notNull().references(() => claims.id),
    verdict: text("verdict").notNull(),
    confident: boolean("confident"),
    superseded: boolean("superseded").notNull().default(false),
    escalationState: text("escalation_state").notNull().default("none"),
    escalatingAt: timestamp("escalating_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationVerdictId: uuid("escalation_verdict_id").references((): AnyPgColumn => contradictionVerdicts.id),
    escalationAttempts: integer("escalation_attempts").notNull().default(0),
    escalationNextAttemptAt: timestamp("escalation_next_attempt_at", { withTimezone: true }),
    suspectClaimId: uuid("suspect_claim_id").references(() => claims.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_contradiction_verdicts_kb_verdict_created").on(table.kbId, table.verdict, table.createdAt),
    index("idx_contradiction_verdicts_kb_escalation_active")
      .on(table.kbId, table.escalationState)
      .where(sql`${table.escalationState} IN ('pending', 'escalating')`),
    index("idx_contradiction_verdicts_kb_escalation_due")
      .on(table.kbId, table.escalationState, table.escalationNextAttemptAt)
      .where(sql`${table.escalationState} IN ('pending', 'escalating')`),
    // Self-referencing FK column; unindexed it made KB-reset deletes O(n^2).
    index("idx_contradiction_verdicts_escalation_verdict_id").on(table.escalationVerdictId),
    check(
      "ck_contradiction_verdict",
      sql`${table.verdict} IN ('supersedes', 'coexists', 'unrelated', 'unrated', 'supersedes_downward_softened', 'tier_guarded', 'extraction_error', 'human_pinned')`,
    ),
    check(
      "ck_contradiction_verdict_escalation_state",
      sql`${table.escalationState} IN ('none', 'pending', 'escalating', 'done')`,
    ),
  ],
);

export const resolutionOverrides = pgTable(
  "resolution_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    claimAId: uuid("claim_a_id").notNull().references(() => claims.id),
    claimBId: uuid("claim_b_id").notNull().references(() => claims.id),
    action: text("action").notNull(),
    reinstatedClaimId: uuid("reinstated_claim_id").references(() => claims.id),
    actor: text("actor").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_resolution_override_pair").on(table.kbId, table.claimAId, table.claimBId),
    check("ck_resolution_override_action", sql`${table.action} IN ('reinstate', 'confirm')`),
    check("ck_resolution_override_normalized_pair", sql`${table.claimAId} < ${table.claimBId}`),
  ],
);

export const contradictionNominations = pgTable(
  "contradiction_nominations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    claimAId: uuid("claim_a_id").notNull().references(() => claims.id),
    claimBId: uuid("claim_b_id").notNull().references(() => claims.id),
    source: text("source").notNull(),
    state: text("state").notNull().default("pending"),
    adjudicatingAt: timestamp("adjudicating_at", { withTimezone: true }),
    verdictId: uuid("verdict_id").references(() => contradictionVerdicts.id),
    dismissReason: text("dismiss_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_contradiction_nomination_pair").on(table.kbId, table.claimAId, table.claimBId),
    index("idx_contradiction_nominations_kb_state_created").on(table.kbId, table.state, table.createdAt),
    index("idx_contradiction_nominations_verdict_id").on(table.verdictId),
    check("ck_contradiction_nomination_source", sql`${table.source} IN ('read_time', 'sweep', 'merge')`),
    check("ck_contradiction_nomination_state", sql`${table.state} IN ('pending', 'adjudicating', 'resolved', 'dismissed')`),
    check("ck_contradiction_nomination_distinct_claims", sql`${table.claimAId} <> ${table.claimBId}`),
    check("ck_contradiction_nomination_normalized_pair", sql`${table.claimAId} < ${table.claimBId}`),
  ],
);

export const sweepRuns = pgTable(
  "sweep_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    entityId: uuid("entity_id").notNull().references(() => entities.id),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    claimsSeen: integer("claims_seen").notNull(),
    claimsTruncated: integer("claims_truncated").notNull().default(0),
    hops: integer("hops").notNull().default(0),
    nominationsEmitted: integer("nominations_emitted").notNull(),
    nominationsDropped: integer("nominations_dropped").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_sweep_runs_kb_created").on(table.kbId, table.createdAt.desc()),
    check("ck_sweep_run_trigger", sql`${table.trigger} IN ('touched', 'merge', 'patrol')`),
    check("ck_sweep_run_status", sql`${table.status} IN ('ok', 'error')`),
  ],
);

export const claimInputs = pgTable(
  "claim_inputs",
  {
    derivedClaimId: uuid("derived_claim_id").notNull().references(() => claims.id),
    inputClaimId: uuid("input_claim_id").notNull().references(() => claims.id),
  },
  (table) => [
    primaryKey({ columns: [table.derivedClaimId, table.inputClaimId] }),
    index("idx_claim_inputs_input").on(table.inputClaimId),
  ],
);

export const claimEntities = pgTable(
  "claim_entities",
  {
    claimId: uuid("claim_id").notNull().references(() => claims.id),
    entityId: uuid("entity_id").notNull().references(() => entities.id),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.claimId, table.entityId, table.role] }),
    index("idx_claim_entity_entity").on(table.entityId),
    check("ck_claim_entity_role", sql`${table.role} IN ('about', 'subject', 'object', 'mentions')`),
  ],
);

// ---------------------------------------------------------------------------
// Graph v2 evidence and canonical knowledge
//
// This is deliberately parallel to the v1 entities/claims pipeline. Raw
// mention/assertion evidence is immutable provenance; canonical rows consolidate
// it without allowing repeated extraction to manufacture duplicate knowledge.
// ---------------------------------------------------------------------------

export const canonicalEntities = pgTable(
  "canonical_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    entityType: text("entity_type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    identityKeys: jsonb("identity_keys").notNull().default("{}"),
    sourceCategories: jsonb("source_categories").notNull().default("[]"),
    summary: text("summary"),
    summaryInputsHash: text("summary_inputs_hash"),
    canonicalId: uuid("canonical_id").references((): AnyPgColumn => canonicalEntities.id),
    status: text("status").notNull().default("active"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_canonical_entity_tenant_kb_id").on(table.tenantId, table.kbId, table.id),
    index("idx_canonical_entity_kb_type").on(table.kbId, table.entityType),
    index("idx_canonical_entity_kb_canonical").on(table.kbId, table.canonicalId),
    uniqueIndex("uq_canonical_entity_kb_email")
      .on(table.kbId, sql`lower(btrim(${table.identityKeys} ->> 'email'))`)
      .where(sql`${table.identityKeys} ? 'email'`),
    uniqueIndex("uq_canonical_entity_kb_phone")
      .on(table.kbId, sql`graph_v2_phone_norm(${table.identityKeys} ->> 'phone')`)
      .where(sql`${table.identityKeys} ? 'phone'`),
    uniqueIndex("uq_canonical_entity_kb_repo_key")
      .on(table.kbId, sql`lower(btrim(${table.identityKeys} ->> 'repo_key'))`)
      .where(sql`${table.identityKeys} ? 'repo_key'`),
    uniqueIndex("uq_canonical_entity_kb_domain")
      .on(table.kbId, sql`graph_v2_domain_norm(${table.identityKeys} ->> 'domain')`)
      .where(sql`${table.identityKeys} ? 'domain'`),
    ...(["slack", "discord", "instagram", "github", "x", "linkedin"] as const).map((namespace) =>
      uniqueIndex(`uq_canonical_entity_kb_handle_${namespace}`)
        .on(table.kbId, sql`lower(btrim(${table.identityKeys} ->> ${sql.raw(`'handle:${namespace}'`)}))`)
        .where(sql`${table.identityKeys} ? ${sql.raw(`'handle:${namespace}'`)}`),
    ),
    ...(["granola", "gcal", "gmail", "slack", "imessage", "notion", "github"] as const).map((provider) =>
      uniqueIndex(`uq_canonical_entity_kb_source_ref_${provider}`)
        .on(table.kbId, sql`lower(btrim(${table.identityKeys} ->> ${sql.raw(`'source_ref:${provider}'`)}))`)
        .where(sql`${table.identityKeys} ? ${sql.raw(`'source_ref:${provider}'`)}`),
    ),
    uniqueIndex("uq_canonical_entity_kb_directory")
      .on(table.kbId, sql`lower(btrim(${table.identityKeys} ->> 'directory'))`)
      .where(sql`${table.identityKeys} ? 'directory'`),
    check(
      "ck_canonical_entity_type",
      sql`${table.entityType} IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')`,
    ),
    check("ck_canonical_entity_status", sql`${table.status} IN ('active', 'merged', 'archived')`),
    check("ck_canonical_entity_name", sql`length(btrim(${table.canonicalName})) > 0`),
    check(
      "ck_canonical_entity_identity_keys",
      sql`jsonb_typeof(${table.identityKeys}) = 'object'
        AND (${table.identityKeys} - ARRAY['directory', 'email', 'phone', 'repo_key', 'domain', 'handle:slack', 'handle:discord', 'handle:instagram', 'handle:github', 'handle:x', 'handle:linkedin', 'source_ref:granola', 'source_ref:gcal', 'source_ref:gmail', 'source_ref:slack', 'source_ref:imessage', 'source_ref:notion', 'source_ref:github']::text[]) = '{}'::jsonb
        AND (NOT (${table.identityKeys} ? 'email') OR (jsonb_typeof(${table.identityKeys} -> 'email') = 'string' AND strpos(${table.identityKeys} ->> 'email', '..') = 0 AND strpos(${table.identityKeys} ->> 'email', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'email'))) >= 3 AND lower(btrim(${table.identityKeys} ->> 'email')) ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'))
        AND (NOT (${table.identityKeys} ? 'phone') OR (jsonb_typeof(${table.identityKeys} -> 'phone') = 'string' AND strpos(${table.identityKeys} ->> 'phone', '..') = 0 AND strpos(${table.identityKeys} ->> 'phone', '…') = 0 AND length(graph_v2_phone_norm(${table.identityKeys} ->> 'phone')) >= 7 AND graph_v2_phone_norm(${table.identityKeys} ->> 'phone') ~ '^\\d{7,}$'))
        AND (NOT (${table.identityKeys} ? 'repo_key') OR (jsonb_typeof(${table.identityKeys} -> 'repo_key') = 'string' AND strpos(${table.identityKeys} ->> 'repo_key', '..') = 0 AND strpos(${table.identityKeys} ->> 'repo_key', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'repo_key'))) >= 1 AND lower(btrim(${table.identityKeys} ->> 'repo_key')) ~ '^.+$'))
        AND (NOT (${table.identityKeys} ? 'domain') OR (${table.entityType} = 'Organization' AND jsonb_typeof(${table.identityKeys} -> 'domain') = 'string' AND strpos(${table.identityKeys} ->> 'domain', '..') = 0 AND strpos(${table.identityKeys} ->> 'domain', '…') = 0 AND length(graph_v2_domain_norm(${table.identityKeys} ->> 'domain')) >= 1 AND graph_v2_domain_norm(${table.identityKeys} ->> 'domain') ~ '^.+$'))
        AND (NOT (${table.identityKeys} ? 'handle:slack') OR (jsonb_typeof(${table.identityKeys} -> 'handle:slack') = 'string' AND strpos(${table.identityKeys} ->> 'handle:slack', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:slack', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:slack'))) >= 7 AND lower(btrim(${table.identityKeys} ->> 'handle:slack')) ~ '^[uw][a-z0-9]{6,}$'))
        AND (NOT (${table.identityKeys} ? 'handle:discord') OR (jsonb_typeof(${table.identityKeys} -> 'handle:discord') = 'string' AND strpos(${table.identityKeys} ->> 'handle:discord', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:discord', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:discord'))) BETWEEN 2 AND 32 AND lower(btrim(${table.identityKeys} ->> 'handle:discord')) ~ '^[a-z0-9_](?:[a-z0-9_]|\\.[a-z0-9_])+$'))
        AND (NOT (${table.identityKeys} ? 'handle:instagram') OR (jsonb_typeof(${table.identityKeys} -> 'handle:instagram') = 'string' AND strpos(${table.identityKeys} ->> 'handle:instagram', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:instagram', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:instagram'))) BETWEEN 2 AND 30 AND lower(btrim(${table.identityKeys} ->> 'handle:instagram')) ~ '^[a-z0-9_](?:[a-z0-9_]|\\.[a-z0-9_])+$'))
        AND (NOT (${table.identityKeys} ? 'handle:github') OR (jsonb_typeof(${table.identityKeys} -> 'handle:github') = 'string' AND strpos(${table.identityKeys} ->> 'handle:github', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:github', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:github'))) BETWEEN 2 AND 39 AND lower(btrim(${table.identityKeys} ->> 'handle:github')) ~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9])+$'))
        AND (NOT (${table.identityKeys} ? 'handle:x') OR (jsonb_typeof(${table.identityKeys} -> 'handle:x') = 'string' AND strpos(${table.identityKeys} ->> 'handle:x', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:x', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:x'))) BETWEEN 2 AND 15 AND lower(btrim(${table.identityKeys} ->> 'handle:x')) ~ '^[a-z0-9_]{2,15}$'))
        AND (NOT (${table.identityKeys} ? 'handle:linkedin') OR (jsonb_typeof(${table.identityKeys} -> 'handle:linkedin') = 'string' AND strpos(${table.identityKeys} ->> 'handle:linkedin', '..') = 0 AND strpos(${table.identityKeys} ->> 'handle:linkedin', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'handle:linkedin'))) BETWEEN 3 AND 100 AND lower(btrim(${table.identityKeys} ->> 'handle:linkedin')) ~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){2,99}$'))
        AND (NOT (${table.identityKeys} ? 'source_ref:granola') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:granola') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:granola', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:granola', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:granola'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:gcal') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:gcal') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:gcal', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:gcal', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:gcal'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:gmail') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:gmail') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:gmail', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:gmail', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:gmail'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:slack') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:slack') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:slack', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:slack', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:slack'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:imessage') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:imessage') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:imessage', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:imessage', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:imessage'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:notion') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:notion') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:notion', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:notion', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:notion'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'source_ref:github') OR (jsonb_typeof(${table.identityKeys} -> 'source_ref:github') = 'string' AND strpos(${table.identityKeys} ->> 'source_ref:github', '..') = 0 AND strpos(${table.identityKeys} ->> 'source_ref:github', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'source_ref:github'))) >= 1))
        AND (NOT (${table.identityKeys} ? 'directory') OR (jsonb_typeof(${table.identityKeys} -> 'directory') = 'string' AND strpos(${table.identityKeys} ->> 'directory', '..') = 0 AND strpos(${table.identityKeys} ->> 'directory', '…') = 0 AND length(lower(btrim(${table.identityKeys} ->> 'directory'))) BETWEEN 1 AND 128 AND lower(btrim(${table.identityKeys} ->> 'directory')) ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'))`,
    ),
    check(
      "ck_canonical_entity_source_categories",
      sql`jsonb_typeof(${table.sourceCategories}) = 'array'
        AND ${table.sourceCategories} <@ '["COLLABORATIVE_CONTENT", "MESSAGING", "EMAIL", "CALENDAR", "CODE_REPOSITORY", "MEETING_TRANSCRIPT", "KNOWLEDGE_HUB", "PEOPLE"]'::jsonb`,
    ),
    check(
      "ck_canonical_entity_merge_state",
      sql`(${table.status} = 'merged' AND ${table.canonicalId} IS NOT NULL AND ${table.mergedAt} IS NOT NULL)
        OR (${table.status} <> 'merged' AND ${table.canonicalId} IS NULL AND ${table.mergedAt} IS NULL)`,
    ),
  ],
);

export const canonicalEntitySources = pgTable(
  "canonical_entity_sources",
  {
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    provider: text("provider").notNull(),
    sourceNamespace: text("source_namespace").notNull(),
    sourceObjectId: text("source_object_id").notNull(),
    canonicalEntityId: uuid("canonical_entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kbId, table.provider, table.sourceNamespace, table.sourceObjectId] }),
    foreignKey({
      columns: [table.tenantId, table.kbId, table.canonicalEntityId],
      foreignColumns: [canonicalEntities.tenantId, canonicalEntities.kbId, canonicalEntities.id],
      name: "fk_canonical_entity_sources_scope",
    }).onDelete("cascade"),
    index("idx_canonical_entity_sources_entity").on(table.kbId, table.canonicalEntityId),
    check("ck_canonical_entity_sources_provider", sql`length(btrim(${table.provider})) > 0`),
    check("ck_canonical_entity_sources_namespace", sql`length(btrim(${table.sourceNamespace})) > 0`),
    check("ck_canonical_entity_sources_object_id", sql`length(btrim(${table.sourceObjectId})) > 0`),
  ],
);

/**
 * Operator identity directory: tenant-wide ground-truth identity groups. Each
 * row asserts that one strong identity key (an email, a github handle, ...)
 * belongs to one real-world principal (`group_slug`). Deliberately NOT
 * kb-scoped and NOT a v2 graph table: graph.rebuild wipes v2 graph rows per
 * kb, and these operator assertions must survive rebuilds.
 */
export const identityDirectory = pgTable(
  "identity_directory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    groupSlug: text("group_slug").notNull(),
    displayName: text("display_name").notNull(),
    entityType: text("entity_type").notNull().default("Person"),
    keyKind: text("key_kind").notNull(),
    keyValue: text("key_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_identity_directory_key").on(table.tenantId, table.keyKind, table.keyValue),
    index("idx_identity_directory_group").on(table.tenantId, table.groupSlug),
    check(
      "ck_identity_directory_group_slug",
      sql`${table.groupSlug} ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' AND length(${table.groupSlug}) <= 128`,
    ),
    check("ck_identity_directory_display_name", sql`length(btrim(${table.displayName})) > 0`),
    check(
      "ck_identity_directory_entity_type",
      sql`${table.entityType} IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')`,
    ),
    check("ck_identity_directory_key_kind", sql`${table.keyKind} <> 'directory' AND length(btrim(${table.keyKind})) > 0`),
    check(
      "ck_identity_directory_key_value",
      sql`length(btrim(${table.keyValue})) > 0 AND ${table.keyValue} = lower(btrim(${table.keyValue}))`,
    ),
  ],
);

export const v2SameAsDecisions = pgTable(
  "v2_same_as_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    aEntityId: uuid("a_entity_id").notNull().references(() => canonicalEntities.id),
    bEntityId: uuid("b_entity_id").notNull().references(() => canonicalEntities.id),
    state: text("state").notNull(),
    evidence: jsonb("evidence").notNull(),
    judgeModel: text("judge_model").notNull(),
    judgeReason: text("judge_reason").notNull(),
    winnerEntityId: uuid("winner_entity_id").references(() => canonicalEntities.id),
    loserEntityId: uuid("loser_entity_id").references(() => canonicalEntities.id),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_v2_same_as_decision_pair").on(table.kbId, table.aEntityId, table.bEntityId),
    index("idx_v2_same_as_decision_kb_state").on(table.kbId, table.state, table.decidedAt),
    check("ck_v2_same_as_decision_pair_order", sql`${table.aEntityId} < ${table.bEntityId}`),
    check("ck_v2_same_as_decision_state", sql`${table.state} IN ('merged', 'auto_bridge_merged', 'judge_rejected', 'key_conflict', 'merge_conflict', 'human_rejected')`),
    check("ck_v2_same_as_decision_evidence", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("ck_v2_same_as_decision_reason", sql`length(btrim(${table.judgeReason})) > 0`),
    check(
      "ck_v2_same_as_decision_merge_ids",
      sql`(${table.state} IN ('merged', 'auto_bridge_merged') AND ${table.winnerEntityId} IS NOT NULL AND ${table.loserEntityId} IS NOT NULL)
        OR ${table.state} NOT IN ('merged', 'auto_bridge_merged')`,
    ),
  ],
);

export const mentionOccurrences = pgTable(
  "mention_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    chunkId: uuid("chunk_id").notNull().references(() => chunks.id),
    surfaceText: text("surface_text").notNull(),
    entityType: text("entity_type").notNull(),
    sourceCategory: text("source_category").notNull(),
    span: jsonb("span").notNull(),
    identityKeys: jsonb("identity_keys").notNull().default("{}"),
    aliases: jsonb("aliases").notNull().default("[]"),
    sourceObjectRef: jsonb("source_object_ref"),
    resolutionStatus: text("resolution_status").notNull().default("unresolved"),
    resolvedEntityId: uuid("resolved_entity_id").references(() => canonicalEntities.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_mention_occurrence_chunk").on(table.chunkId),
    index("idx_mention_occurrence_kb_resolution").on(table.kbId, table.resolutionStatus),
    uniqueIndex("uq_mention_occurrence_chunk_span_type").on(table.chunkId, table.span, table.entityType, table.surfaceText),
    check(
      "ck_mention_occurrence_entity_type",
      sql`${table.entityType} IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')`,
    ),
    check(
      "ck_mention_occurrence_source_category",
      sql`${table.sourceCategory} IN ('COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')`,
    ),
    check("ck_mention_occurrence_surface", sql`length(btrim(${table.surfaceText})) > 0`),
    check("ck_mention_occurrence_aliases", sql`jsonb_typeof(${table.aliases}) = 'array'`),
    check(
      "ck_mention_occurrence_source_object_ref",
      sql`${table.sourceObjectRef} IS NULL OR (
        jsonb_typeof(${table.sourceObjectRef}) = 'object'
        AND jsonb_typeof(${table.sourceObjectRef} -> 'provider') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(${table.sourceObjectRef} -> 'namespace') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(${table.sourceObjectRef} -> 'id') IS NOT DISTINCT FROM 'string'
        AND length(btrim(${table.sourceObjectRef} ->> 'provider')) > 0
        AND length(btrim(${table.sourceObjectRef} ->> 'namespace')) > 0
        AND length(btrim(${table.sourceObjectRef} ->> 'id')) > 0
        AND (${table.sourceObjectRef} - ARRAY['provider', 'namespace', 'id']::text[]) = '{}'::jsonb
      )`,
    ),
    check("ck_mention_occurrence_resolution", sql`${table.resolutionStatus} IN ('link', 'new', 'unresolved')`),
    check(
      "ck_mention_occurrence_resolved_entity",
      sql`(${table.resolutionStatus} = 'unresolved' AND ${table.resolvedEntityId} IS NULL)
        OR (${table.resolutionStatus} IN ('link', 'new') AND ${table.resolvedEntityId} IS NOT NULL)`,
    ),
    check(
      "ck_mention_occurrence_span",
      sql`jsonb_typeof(${table.span}) = 'object'
        AND jsonb_typeof(${table.span} -> 'start') = 'number'
        AND jsonb_typeof(${table.span} -> 'end') = 'number'
        AND (${table.span} ->> 'start')::integer >= 0
        AND (${table.span} ->> 'end')::integer > (${table.span} ->> 'start')::integer`,
    ),
  ],
);

export const evidenceAssertions = pgTable(
  "evidence_assertions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectMentionId: uuid("subject_mention_id").notNull().references(() => mentionOccurrences.id),
    assertionKind: text("assertion_kind").notNull(),
    relation: text("relation"),
    scalarProperty: text("scalar_property"),
    statementText: text("statement_text"),
    objectMentionId: uuid("object_mention_id").references(() => mentionOccurrences.id),
    objectValue: jsonb("object_value"),
    qualifiers: jsonb("qualifiers").notNull().default("{}"),
    sourceCategory: text("source_category").notNull(),
    chunkId: uuid("chunk_id").notNull().references(() => chunks.id),
    documentId: uuid("document_id").notNull().references(() => sourceDocuments.id),
    extractorVersion: text("extractor_version").notNull(),
    ontologyVersion: text("ontology_version").notNull().default("2.1.0"),
    confidence: real("confidence"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_evidence_assertion_chunk").on(table.chunkId),
    index("idx_evidence_assertion_kb_relation").on(table.kbId, table.relation),
    unique("uq_evidence_assertion_observation")
      .on(
        table.chunkId,
        table.extractorVersion,
        table.ontologyVersion,
        table.subjectMentionId,
        table.relation,
        table.scalarProperty,
        table.statementText,
        table.objectMentionId,
        table.objectValue,
        table.qualifiers,
      )
      .nullsNotDistinct(),
    check("ck_evidence_assertion_kind", sql`${table.assertionKind} IN ('relation', 'scalar_property', 'statement')`),
    check(
      "ck_evidence_assertion_relation",
      sql`${table.relation} IS NULL OR ${table.relation} IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS', 'HAS_ACCESS')`,
    ),
    check(
      "ck_evidence_assertion_scalar_property",
      sql`${table.scalarProperty} IS NULL OR ${table.scalarProperty} IN ('EMAIL', 'URL', 'START_TIME', 'END_TIME', 'RSVP_STATUS', 'ROLE_TITLE', 'STATUS')`,
    ),
    check(
      "ck_evidence_assertion_shape",
      sql`(${table.assertionKind} = 'relation' AND ${table.relation} IS NOT NULL AND ${table.scalarProperty} IS NULL AND ${table.statementText} IS NULL AND ${table.objectMentionId} IS NOT NULL AND ${table.objectValue} IS NULL)
        OR (${table.assertionKind} = 'scalar_property' AND ${table.relation} IS NULL AND ${table.scalarProperty} IS NOT NULL AND ${table.statementText} IS NULL AND ${table.objectMentionId} IS NULL AND ${table.objectValue} IS NOT NULL)
        OR (${table.assertionKind} = 'statement' AND ${table.statementText} IS NOT NULL AND length(btrim(${table.statementText})) > 0 AND ${table.relation} IS NULL AND ${table.scalarProperty} IS NULL AND ${table.objectValue} IS NULL)`,
    ),
    check(
      "ck_evidence_assertion_source_category",
      sql`${table.sourceCategory} IN ('COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')`,
    ),
    check("ck_evidence_assertion_ontology_version", sql`${table.ontologyVersion} IN ('2.0.0', '2.1.0')`),
    check("ck_evidence_assertion_confidence", sql`${table.confidence} IS NULL OR ${table.confidence} BETWEEN 0 AND 1`),
    check("ck_evidence_assertion_distinct_mentions", sql`${table.objectMentionId} IS NULL OR ${table.subjectMentionId} <> ${table.objectMentionId}`),
  ],
);

export const canonicalFacts = pgTable(
  "canonical_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectEntityId: uuid("subject_entity_id").notNull().references(() => canonicalEntities.id),
    assertionKind: text("assertion_kind").notNull(),
    relation: text("relation"),
    scalarProperty: text("scalar_property"),
    statementText: text("statement_text"),
    statementHash: text("statement_hash"),
    objectEntityId: uuid("object_entity_id").references(() => canonicalEntities.id),
    scalarValue: jsonb("scalar_value"),
    qualifiers: jsonb("qualifiers").notNull().default("{}"),
    origin: text("origin").notNull().default("extracted"),
    derivedByModel: text("derived_by_model"),
    derivedByRun: text("derived_by_run"),
    ontologyVersion: text("ontology_version").notNull().default("2.1.0"),
    confidence: real("confidence"),
    eventAt: timestamp("event_at", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    invalidAt: timestamp("invalid_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => canonicalFacts.id),
    invalidationReason: text("invalidation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_canonical_fact_subject_live")
      .on(table.kbId, table.subjectEntityId, table.relation, table.scalarProperty)
      .where(sql`${table.invalidAt} IS NULL`),
    uniqueIndex("uq_canonical_fact_tuple")
      .on(
        table.kbId,
        table.subjectEntityId,
        table.relation,
        table.scalarProperty,
        table.objectEntityId,
        table.scalarValue,
        table.qualifiers,
      )
      .where(sql`${table.assertionKind} IN ('relation', 'scalar_property')`),
    uniqueIndex("uq_canonical_statement")
      .on(
        table.kbId,
        table.subjectEntityId,
        sql`COALESCE(${table.objectEntityId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.statementHash,
      )
      .where(sql`${table.assertionKind} = 'statement'`),
    check("ck_canonical_fact_kind", sql`${table.assertionKind} IN ('relation', 'scalar_property', 'statement')`),
    check(
      "ck_canonical_fact_relation",
      sql`${table.relation} IS NULL OR ${table.relation} IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS', 'HAS_ACCESS')`,
    ),
    check(
      "ck_canonical_fact_scalar_property",
      sql`${table.scalarProperty} IS NULL OR ${table.scalarProperty} IN ('EMAIL', 'URL', 'START_TIME', 'END_TIME', 'RSVP_STATUS', 'ROLE_TITLE', 'STATUS')`,
    ),
    check(
      "ck_canonical_fact_shape",
      sql`(${table.assertionKind} = 'relation' AND ${table.relation} IS NOT NULL AND ${table.scalarProperty} IS NULL AND ${table.statementText} IS NULL AND ${table.statementHash} IS NULL AND ${table.objectEntityId} IS NOT NULL AND ${table.scalarValue} IS NULL)
        OR (${table.assertionKind} = 'scalar_property' AND ${table.relation} IS NULL AND ${table.scalarProperty} IS NOT NULL AND ${table.statementText} IS NULL AND ${table.statementHash} IS NULL AND ${table.objectEntityId} IS NULL AND ${table.scalarValue} IS NOT NULL)
        OR (${table.assertionKind} = 'statement' AND ${table.statementText} IS NOT NULL AND length(btrim(${table.statementText})) > 0 AND ${table.statementHash} IS NOT NULL AND ${table.relation} IS NULL AND ${table.scalarProperty} IS NULL AND ${table.scalarValue} IS NULL)`,
    ),
    check("ck_canonical_fact_ontology_version", sql`${table.ontologyVersion} IN ('2.0.0', '2.1.0')`),
    check("ck_canonical_fact_confidence", sql`${table.confidence} IS NULL OR ${table.confidence} BETWEEN 0 AND 1`),
    check("ck_canonical_fact_distinct_entities", sql`${table.objectEntityId} IS NULL OR ${table.subjectEntityId} <> ${table.objectEntityId}`),
    check("ck_canonical_fact_origin", sql`${table.origin} IN ('extracted', 'inferred')`),
    check(
      "ck_canonical_fact_derivation_attribution",
      sql`(${table.origin} = 'extracted' AND ${table.derivedByModel} IS NULL AND ${table.derivedByRun} IS NULL)
        OR (${table.origin} = 'inferred' AND ${table.derivedByModel} IS NOT NULL AND ${table.derivedByRun} IS NOT NULL)`,
    ),
    check(
      "ck_canonical_fact_supersession",
      sql`(${table.invalidAt} IS NULL AND ${table.supersededBy} IS NULL AND ${table.invalidationReason} IS NULL)
        OR (${table.invalidAt} IS NOT NULL AND ${table.invalidationReason} IS NOT NULL)`,
    ),
  ],
);

export const factEvidence = pgTable(
  "fact_evidence",
  {
    canonicalFactId: uuid("canonical_fact_id").notNull().references(() => canonicalFacts.id),
    evidenceAssertionId: uuid("evidence_assertion_id").notNull().references(() => evidenceAssertions.id),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.canonicalFactId, table.evidenceAssertionId] }),
    index("idx_fact_evidence_fact").on(table.canonicalFactId),
    index("idx_fact_evidence_assertion").on(table.evidenceAssertionId),
  ],
);

export const ontologyProposals = pgTable(
  "ontology_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    ontologyVersion: text("ontology_version").notNull(),
    proposalKind: text("proposal_kind").notNull(),
    proposedName: text("proposed_name").notNull(),
    context: jsonb("context").notNull().default("{}"),
    sourceChunkId: uuid("source_chunk_id").references(() => chunks.id),
    status: text("status").notNull().default("pending"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_ontology_proposal_pending")
      .on(table.kbId, table.ontologyVersion, table.proposalKind, table.proposedName)
      .where(sql`${table.status} = 'pending'`),
    index("idx_ontology_proposal_kb_status").on(table.kbId, table.status, table.createdAt),
    check("ck_ontology_proposal_kind", sql`${table.proposalKind} IN ('ENTITY_TYPE', 'RELATION', 'SCALAR_PROPERTY', 'IDENTITY_KEY')`),
    check("ck_ontology_proposal_status", sql`${table.status} IN ('pending', 'accepted', 'rejected')`),
    check("ck_ontology_proposal_name", sql`length(btrim(${table.proposedName})) > 0`),
    check("ck_ontology_proposal_occurrence_count", sql`${table.occurrenceCount} > 0`),
  ],
);

export const claimEmbeddings = pgTable(
  "claim_embeddings",
  {
    claimId: uuid("claim_id").primaryKey().references(() => claims.id),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  },
  (table) => [
    index("idx_claim_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const claimLinks = pgTable(
  "claim_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    claimAId: uuid("claim_a_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
    claimBId: uuid("claim_b_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    weight: real("weight").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_claim_link_pair_kind").on(table.kbId, table.claimAId, table.claimBId, table.kind),
    index("idx_claim_links_kb_claim_a").on(table.kbId, table.claimAId),
    index("idx_claim_links_kb_claim_b").on(table.kbId, table.claimBId),
    check("ck_claim_link_kind", sql`${table.kind} IN ('knn')`),
    check("ck_claim_link_normalized_pair", sql`${table.claimAId} < ${table.claimBId}`),
  ],
);

export const chunkExtractions = pgTable(
  "chunk_extractions",
  {
    chunkId: uuid("chunk_id").notNull().references(() => chunks.id),
    extractorVersion: text("extractor_version").notNull(),
    status: text("status").notNull().default("pending"),
    model: text("model"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_chunk_extraction").on(table.chunkId, table.extractorVersion),
    index("idx_chunk_extractions_retry").on(table.status, table.nextAttemptAt),
    check("ck_chunk_extraction_status", sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'terminal')`),
  ],
);

// ---------------------------------------------------------------------------
// Graph pages and wiki
// ---------------------------------------------------------------------------

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    kind: text("kind").notNull(),
    entityId: uuid("entity_id").references(() => entities.id),
    treePath: text("tree_path").notNull(),
    title: text("title").notNull(),
    sectionDefs: jsonb("section_defs").notNull(),
    ownerSme: text("owner_sme"),
    verificationState: text("verification_state").notNull().default("unverified"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedContentHash: text("verified_content_hash"),
    content: text("content"),
    contentHash: text("content_hash"),
    inputsHash: text("inputs_hash"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_page_kb_tree_path_live")
      .on(table.kbId, table.treePath)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex("uq_page_kb_entity_live")
      .on(table.kbId, table.entityId)
      .where(sql`${table.archivedAt} IS NULL AND ${table.kind} = 'entity' AND ${table.entityId} IS NOT NULL`),
    check(
      "ck_page_kind",
      sql`${table.kind} IN ('entity', 'topic', 'standard', 'module', 'generation', 'codebase_map', 'index', 'procedure', 'deep_dive')`,
    ),
    check("ck_page_verification_state", sql`${table.verificationState} IN ('unverified', 'verified', 'stale')`),
  ],
);

export const pageEmbeddings = pgTable(
  "page_embeddings",
  {
    pageId: uuid("page_id").primaryKey().references(() => pages.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    embeddingInputsHash: text("embedding_inputs_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_page_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("idx_page_embeddings_kb").on(table.kbId),
  ],
);

export const pageClaims = pgTable(
  "page_claims",
  {
    pageId: uuid("page_id").notNull().references(() => pages.id),
    claimId: uuid("claim_id").notNull().references(() => claims.id),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.claimId] }),
    index("idx_page_claim_claim").on(table.claimId),
  ],
);

export const pageEntities = pgTable(
  "page_entities",
  {
    pageId: uuid("page_id").notNull().references(() => pages.id),
    entityId: uuid("entity_id").notNull().references(() => entities.id),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.entityId] }),
    index("idx_page_entity_entity").on(table.entityId),
  ],
);

export const pageFeedback = pgTable(
  "page_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id").notNull().references(() => pages.id),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    anchor: jsonb("anchor").notNull().default("{}"),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    mappedClaimIds: uuid("mapped_claim_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    state: text("state").notNull().default("open"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resultingClaimId: uuid("resulting_claim_id").references(() => claims.id),
  },
  (table) => [
    check("ck_page_feedback_kind", sql`${table.kind} IN ('flag', 'fix', 'freeform')`),
    check("ck_page_feedback_state", sql`${table.state} IN ('open', 'applied', 'dismissed')`),
  ],
);

export const pageVersions = pgTable(
  "page_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id").notNull().references(() => pages.id),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    inputsHash: text("inputs_hash"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    humanEdited: boolean("human_edited").notNull().default(false),
  },
);

export const wikiCandidates = pgTable(
  "wiki_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    seedEntityIds: uuid("seed_entity_ids").array().notNull(),
    trigger: text("trigger").notNull(),
    themeKey: text("theme_key"),
    evidence: jsonb("evidence").notNull(),
    score: real("score").notNull(),
    status: text("status").notNull().default("pending"),
    judgedAt: timestamp("judged_at", { withTimezone: true }),
    judgeRationale: text("judge_rationale"),
    createdPageIds: uuid("created_page_ids").array(),
    judgingAt: timestamp("judging_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_wiki_candidate_nonterminal_cluster")
      .on(table.kbId, table.seedEntityIds)
      .where(sql`${table.status} IN ('pending', 'judging')`),
    index("idx_wiki_candidate_kb_theme_key")
      .on(table.kbId, table.themeKey)
      .where(sql`${table.themeKey} IS NOT NULL`),
    index("idx_wiki_candidate_kb_status_created").on(table.kbId, table.status, table.createdAt.desc()),
    check("ck_wiki_candidate_trigger", sql`${table.trigger} IN ('supply', 'demand', 'both', 'agent', 'sme')`),
    check("ck_wiki_candidate_status", sql`${table.status} IN ('pending', 'judging', 'created', 'skipped', 'deferred', 'cooldown')`),
  ],
);

export const wikiReorgRuns = pgTable(
  "wiki_reorg_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    pageId: uuid("page_id").notNull().references(() => pages.id),
    status: text("status").notNull().default("pending"),
    plannedPayload: jsonb("planned_payload").notNull().default("{}"),
    appliedPayload: jsonb("applied_payload"),
    reviewerVerdict: jsonb("reviewer_verdict"),
    runningAt: timestamp("running_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_wiki_reorg_runs_kb_status_created").on(table.kbId, table.status, table.createdAt.asc()),
    index("idx_wiki_reorg_runs_page_completed").on(table.kbId, table.pageId, table.completedAt.desc()),
    uniqueIndex("uq_wiki_reorg_run_active_page")
      .on(table.kbId, table.pageId)
      .where(sql`${table.status} IN ('pending', 'running', 'reviewing', 'applying')`),
    check(
      "ck_wiki_reorg_run_status",
      sql`${table.status} IN ('pending', 'running', 'reviewing', 'applying', 'applied', 'rejected', 'failed')`,
    ),
  ],
);

export const hygieneReports = pgTable(
  "hygiene_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    windowDays: integer("window_days").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_hygiene_reports_kb_created").on(table.kbId, table.createdAt.desc()),
  ],
);

export const smeDigests = pgTable(
  "sme_digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_sme_digests_kb_created").on(table.kbId, table.createdAt.desc()),
  ],
);

export const synthesisRuns = pgTable(
  "synthesis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectEntityId: uuid("subject_entity_id").notNull().references(() => entities.id),
    tier: smallint("tier").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    liveClaimCount: integer("live_claim_count").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    deadSynthesisCount: integer("dead_synthesis_count").notNull(),
    producedCount: integer("produced_count").notNull(),
    gateFailureCount: integer("gate_failure_count").notNull(),
    gateFailures: jsonb("gate_failures"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ck_synthesis_run_status", sql`${table.status} IN ('applied', 'escalated', 'failed', 'skipped')`),
  ],
);

export const answerTraces = pgTable(
  "answer_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectId: text("subject_id").notNull(),
    question: text("question").notNull(),
    mode: text("mode").notNull(),
    kind: text("kind").notNull(),
    claimIds: uuid("claim_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    entityIds: uuid("entity_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    tokensUsed: integer("tokens_used"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_answer_trace_kb_created").on(table.kbId, table.createdAt.desc()),
    index("idx_answer_trace_entity_ids").using("gin", table.entityIds),
    check("ck_answer_trace_kind", sql`${table.kind} IN ('answer', 'abstain', 'error')`),
  ],
);

export const chatTraces = pgTable(
  "chat_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectId: text("subject_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    toolCalls: jsonb("tool_calls").notNull().default("[]"),
    claimIds: uuid("claim_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    entityIds: uuid("entity_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    turns: integer("turns").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    compactions: integer("compactions").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chat_trace_kb_created").on(table.kbId, table.createdAt.desc()),
    index("idx_chat_trace_entity_ids").using("gin", table.entityIds),
  ],
);

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    subjectId: text("subject_id").notNull(),
    title: text("title").notNull().default(""),
    messages: jsonb("messages").notNull().default("[]"),
    tokenCount: integer("token_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("web"),
    archivedMessages: jsonb("archived_messages"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chat_conversation_owner_updated").on(
      table.tenantId,
      table.kbId,
      table.subjectId,
      table.updatedAt.desc(),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Graph eval
// ---------------------------------------------------------------------------

export const evalQuestions = pgTable(
  "eval_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    question: text("question").notNull(),
    expectedAnswer: text("expected_answer"),
    graderNotes: text("grader_notes"),
    hopType: text("hop_type"),
    createdBy: text("created_by").notNull(),
  },
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id").notNull().references(() => kbContainers.id),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    config: jsonb("config").notNull().default("{}"),
  },
);

export const evalResults = pgTable(
  "eval_results",
  {
    runId: uuid("run_id").notNull().references(() => evalRuns.id),
    questionId: uuid("question_id").notNull().references(() => evalQuestions.id),
    answer: text("answer").notNull(),
    grade: smallint("grade"),
    gradedBy: text("graded_by"),
    notes: text("notes"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.questionId] })],
);
