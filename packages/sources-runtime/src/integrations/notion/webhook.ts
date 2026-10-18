import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents, integrationTokens, notionPageSummaries } from "../../db/schema.js";
import { env } from "../../env.js";
import { enqueueCustomerBackendJob, enqueueEventProcessing } from "../../queue/dispatch.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import {
  markNotionDataSourcePagesDirty,
  markNotionPageDirty,
  removeNotionDataSourceContent,
  removeNotionPageContent,
} from "./poller.js";

export const notionWebhookRoute = new Hono();

type NotionWebhookEntity = {
  id?: string;
  type?: string;
};

type NotionWebhookPrincipal = {
  id?: string;
  type?: string;
};

type NotionWebhookParent = {
  id?: string;
  type?: string;
  page_id?: string;
  block_id?: string;
  database_id?: string;
  data_source_id?: string;
};

export type NotionWebhookEvent = {
  id?: string;
  timestamp?: string;
  workspace_id?: string;
  workspace_name?: string;
  subscription_id?: string;
  integration_id?: string;
  api_version?: string;
  type?: string;
  authors?: NotionWebhookPrincipal[];
  accessible_by?: NotionWebhookPrincipal[];
  attempt_number?: number;
  entity?: NotionWebhookEntity;
  data?: Record<string, unknown>;
};

type NotionWebhookResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 204; body?: undefined }
  | { status: 400 | 401 | 503; body: Record<string, unknown> };

notionWebhookRoute.post("/", async (c) => {
  const body = await c.req.text();
  const result = await handleNotionWebhook({
    body,
    signature: c.req.header("x-notion-signature"),
  });

  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body, result.status);
});

export async function handleNotionWebhook(input: {
  body: string;
  signature?: string | null;
}): Promise<NotionWebhookResult> {
  const payload = parseJsonObject(input.body);
  if (!payload) return { status: 400, body: { error: "Invalid Notion webhook payload" } };

  const verificationToken = stringValue(payload.verification_token);
  if (verificationToken && !stringValue(payload.type)) {
    // One-time subscription handshake: Notion POSTs the token here and expects
    // the developer to paste it back into the portal to activate. Log it so it
    // can be retrieved from CloudWatch and stored as
    // NOTION_WEBHOOK_VERIFICATION_TOKEN (it is not sensitive beyond this app's
    // webhook signing and is only reachable in our own logs).
    console.log(`[notion] webhook verification token received: ${verificationToken}`);
    return { status: 200, body: { ok: true, verification_token: verificationToken } };
  }

  const secret = env.NOTION_WEBHOOK_VERIFICATION_TOKEN?.trim();
  if (!secret) {
    return { status: 503, body: { error: "Notion webhook verification token is not configured" } };
  }
  if (!verifyNotionWebhookSignature(input.body, input.signature, secret)) {
    return { status: 401, body: { error: "Invalid Notion webhook signature" } };
  }

  const events = normalizeNotionWebhookEvents(payload);
  if (events.length === 0) return { status: 400, body: { error: "No Notion webhook events found" } };

  for (const event of events) {
    await processNotionWebhookEvent(event);
  }

  return { status: 204 };
}

export function verifyNotionWebhookSignature(
  body: string,
  signature: string | null | undefined,
  verificationToken: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", verificationToken).update(body).digest("hex")}`;
  if (!signature || signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function notionWebhookAffectedPageId(event: NotionWebhookEvent): string | null {
  if (event.entity?.type === "page") return stringValue(event.entity.id);
  const pageId = stringValue(event.data?.page_id);
  if (pageId) return pageId;

  const parent = objectValue(event.data?.parent);
  if (stringValue(parent?.type) === "page") return stringValue(parent?.id);
  return null;
}

export function notionWebhookAffectedDataSourceId(event: NotionWebhookEvent): string | null {
  if (event.entity?.type === "data_source") return stringValue(event.entity.id);
  if (stringValue(event.type)?.startsWith("data_source.")) return stringValue(event.entity?.id);
  if (stringValue(event.type)?.startsWith("view.")) {
    const parent = objectValue(event.data?.parent);
    return stringValue(parent?.data_source_id)
      ?? (stringValue(parent?.type) === "data_source" ? stringValue(parent?.id) : null);
  }
  return null;
}

async function processNotionWebhookEvent(event: NotionWebhookEvent): Promise<void> {
  const eventType = stringValue(event.type);
  if (!eventType) return;

  const users = await usersForNotionWebhookEvent(event);
  if (users.length === 0) return;

  const pageId = notionWebhookAffectedPageId(event);
  const dataSourceId = notionWebhookAffectedDataSourceId(event);

  for (const userId of users) {
    if (pageId && eventType === "page.deleted") {
      await removeNotionPageContent(userId, pageId);
    }

    if (pageId && shouldDirtyPageForNotionEvent(eventType)) {
      await markNotionPageDirty(userId, pageId);
    }

    if (dataSourceId && eventType === "data_source.deleted") {
      await removeNotionDataSourceContent(userId, dataSourceId);
    }

    if (dataSourceId && shouldDirtyDataSourceForNotionEvent(eventType)) {
      await markNotionDataSourcePagesDirty(userId, dataSourceId);
    }

    if (shouldPollForNotionEvent(eventType)) {
      await enqueueCustomerBackendJob("notion-poll", "notion.poll", { userId });
    }

    if (shouldEmitWebhookSignalEvent(eventType)) {
      await emitNotionWebhookSignalEvent(userId, event);
    }
  }
}

async function usersForNotionWebhookEvent(event: NotionWebhookEvent): Promise<string[]> {
  const rows = await db
    .select({
      userId: integrationTokens.userId,
      metadata: integrationTokens.metadata,
    })
    .from(integrationTokens)
    .where(eq(integrationTokens.provider, "notion"));

  const strictMatches = rows
    .filter((row) => notionTokenMetadataMatchesEvent(row.metadata, event) && notionTokenWorkspaceCompatible(row.metadata, event))
    .map((row) => row.userId);
  if (strictMatches.length > 0) return uniqueStrings(strictMatches);

  const knownEntityUsers = await usersForKnownNotionEntity(event);
  if (knownEntityUsers.size === 0) return [];

  return uniqueStrings(rows
    .filter((row) => knownEntityUsers.has(row.userId) && notionTokenWorkspaceCompatible(row.metadata, event))
    .map((row) => row.userId));
}

function notionTokenMetadataMatchesEvent(metadata: unknown, event: NotionWebhookEvent): boolean {
  const record = objectValue(metadata);
  if (!record) return false;

  const accessibleIds = new Set((event.accessible_by ?? [])
    .map((principal) => stringValue(principal.id))
    .filter((id): id is string => Boolean(id)));
  const owner = objectValue(record.owner);
  const ownerId = stringValue(owner?.id);
  const botId = stringValue(record.botId) ?? stringValue(record.bot_id);
  if (accessibleIds.size > 0) {
    return Boolean((ownerId && accessibleIds.has(ownerId)) || (botId && accessibleIds.has(botId)));
  }

  return false;
}

async function usersForKnownNotionEntity(event: NotionWebhookEvent): Promise<Set<string>> {
  const pageId = notionWebhookAffectedPageId(event);
  if (pageId) {
    const rows = await db
      .select({ userId: notionPageSummaries.userId })
      .from(notionPageSummaries)
      .where(eq(notionPageSummaries.pageId, pageId));
    return new Set(rows.map((row) => row.userId));
  }

  const dataSourceId = notionWebhookAffectedDataSourceId(event);
  if (dataSourceId) {
    const rows = await db
      .select({ userId: notionPageSummaries.userId })
      .from(notionPageSummaries)
      .where(eq(notionPageSummaries.dataSourceId, dataSourceId));
    return new Set(rows.map((row) => row.userId));
  }

  return new Set();
}

function notionTokenWorkspaceCompatible(metadata: unknown, event: NotionWebhookEvent): boolean {
  const record = objectValue(metadata);
  if (!record) return false;
  const workspaceId = stringValue(record.workspaceId) ?? stringValue(record.workspace_id);
  const integrationId = stringValue(record.integrationId) ?? stringValue(record.integration_id);
  if (workspaceId && event.workspace_id && workspaceId !== event.workspace_id) return false;
  if (integrationId && event.integration_id && integrationId !== event.integration_id) return false;
  return true;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shouldDirtyPageForNotionEvent(eventType: string): boolean {
  return eventType === "page.content_updated"
    || eventType === "page.properties_updated"
    || eventType === "page.created"
    || eventType === "page.moved"
    || eventType === "page.undeleted"
    || eventType === "page.transcription_block.transcript_deleted"
    // Comment webhooks carry ids only (no body); re-render the page so the
    // comment text lands in notion_comment_snapshots + the mirror.
    || eventType.startsWith("comment.");
}

function shouldDirtyDataSourceForNotionEvent(eventType: string): boolean {
  return eventType === "data_source.content_updated"
    || eventType === "data_source.schema_updated"
    || eventType === "database.content_updated"
    || eventType === "database.schema_updated"
    || eventType.startsWith("view.");
}

function shouldPollForNotionEvent(eventType: string): boolean {
  return eventType === "data_source.content_updated"
    || eventType === "data_source.created"
    || eventType === "data_source.deleted"
    || eventType === "data_source.moved"
    || eventType === "data_source.schema_updated"
    || eventType === "data_source.undeleted"
    || eventType === "database.content_updated"
    || eventType === "database.created"
    || eventType === "database.deleted"
    || eventType === "database.moved"
    || eventType === "database.schema_updated"
    || eventType === "database.undeleted"
    || eventType.startsWith("view.");
}

function shouldEmitWebhookSignalEvent(eventType: string): boolean {
  return eventType === "page.deleted"
    || eventType === "page.locked"
    || eventType === "page.unlocked"
    || eventType === "page.transcription_block.transcript_deleted"
    || eventType.startsWith("comment.")
    || eventType.endsWith(".schema_updated")
    || eventType.startsWith("file_upload.")
    || eventType.startsWith("view.")
    || eventType === "data_source.deleted"
    || eventType === "database.deleted";
}

async function emitNotionWebhookSignalEvent(userId: string, event: NotionWebhookEvent): Promise<void> {
  const eventType = stringValue(event.type);
  if (!eventType) return;
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();
  const eventTime = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const sourceEventId = `notion:webhook:${event.id ?? hashWebhookEvent(event)}`;
  const rawPayload = redactProviderPayload("notion", compactWebhookEvent(event)) as Record<string, unknown>;

  const [inserted] = await db
    .insert(activityEvents)
    .values({
      userId,
      source: "notion",
      ...deriveActivityEventSourceContract({ source: "notion", eventType, rawPayload }),
      eventType: eventType.replace(/\W+/g, "_"),
      timestamp: eventTime,
      sourceUpdatedAt: eventTime,
      wikiEligibilityAt: eventTime,
      rawPayload,
      sourceEventId,
      processingStatus: "received",
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (inserted?.id) {
    await enqueueEventProcessing(inserted.id, userId);
  }
}

function compactWebhookEvent(event: NotionWebhookEvent): Record<string, unknown> {
  const entity = compactWebhookEntity(event.entity);
  const entityId = stringValue(event.entity?.id);
  const entityType = stringValue(event.entity?.type);
  const data = compactWebhookData(event);
  return {
    eventId: event.id ?? null,
    eventType: event.type ?? null,
    timestamp: event.timestamp ?? null,
    workspaceId: event.workspace_id ?? null,
    workspaceName: event.workspace_name ?? null,
    subscriptionId: event.subscription_id ?? null,
    integrationId: event.integration_id ?? null,
    apiVersion: event.api_version ?? null,
    attemptNumber: event.attempt_number ?? null,
    entity,
    data: event.data ?? {},
    structuredData: data,
    affected: {
      entityId,
      entityType,
      pageId: notionWebhookAffectedPageId(event),
      dataSourceId: notionWebhookAffectedDataSourceId(event),
      databaseId: notionWebhookAffectedDatabaseId(event),
      blockIds: uniqueStrings([
        ...data.updatedBlocks.map((block) => block.id).filter((id): id is string => Boolean(id)),
        data.parent?.blockId as string | null,
        data.target?.blockId as string | null,
      ].filter((id): id is string => Boolean(id))),
      commentId: entityType === "comment" ? entityId : null,
      viewId: entityType === "view" ? entityId : null,
      fileUploadId: entityType === "file_upload" ? entityId : null,
      transcriptId: data.transcriptId,
      propertyIds: data.updatedProperties.map((property) => property.id).filter(Boolean),
    },
    authors: event.authors ?? [],
    accessibleBy: event.accessible_by ?? [],
  };
}

function compactWebhookEntity(entity: NotionWebhookEntity | undefined): Record<string, unknown> | null {
  if (!entity) return null;
  return {
    id: stringValue(entity.id),
    type: stringValue(entity.type),
  };
}

function compactWebhookData(event: NotionWebhookEvent): {
  parent: Record<string, unknown> | null;
  target: Record<string, unknown> | null;
  pageId: string | null;
  transcriptId: string | null;
  updatedBlocks: Array<{ id: string | null; type: string | null }>;
  updatedProperties: Array<{ id: string | null; name: string | null; action: string | null }>;
  viewType: string | null;
  updatedFields: string[];
} {
  const data = objectValue(event.data) ?? {};
  return {
    parent: compactWebhookParent(objectValue(data.parent) as NotionWebhookParent | null),
    target: compactWebhookParent(objectValue(data.target) as NotionWebhookParent | null),
    pageId: stringValue(data.page_id),
    transcriptId: stringValue(data.transcript_id),
    updatedBlocks: arrayValue(data.updated_blocks).map((block) => ({
      id: stringValue(objectValue(block)?.id),
      type: stringValue(objectValue(block)?.type),
    })),
    updatedProperties: compactWebhookUpdatedProperties(data.updated_properties),
    viewType: stringValue(data.view_type),
    updatedFields: arrayValue(data.updated_fields)
      .map((field) => stringValue(field))
      .filter((field): field is string => Boolean(field)),
  };
}

function compactWebhookParent(parent: NotionWebhookParent | null): Record<string, unknown> | null {
  if (!parent) return null;
  return {
    id: stringValue(parent.id),
    type: stringValue(parent.type),
    pageId: stringValue(parent.page_id) ?? (stringValue(parent.type) === "page" ? stringValue(parent.id) : null),
    blockId: stringValue(parent.block_id) ?? (stringValue(parent.type) === "block" ? stringValue(parent.id) : null),
    databaseId: stringValue(parent.database_id) ?? (stringValue(parent.type) === "database" ? stringValue(parent.id) : null),
    dataSourceId: stringValue(parent.data_source_id) ?? (stringValue(parent.type) === "data_source" ? stringValue(parent.id) : null),
    commentId: stringValue(parent.type) === "comment" ? stringValue(parent.id) : null,
    viewId: stringValue(parent.type) === "view" ? stringValue(parent.id) : null,
    fileUploadId: stringValue(parent.type) === "file_upload" ? stringValue(parent.id) : null,
  };
}

function compactWebhookUpdatedProperties(value: unknown): Array<{ id: string | null; name: string | null; action: string | null }> {
  return arrayValue(value).map((property) => {
    if (typeof property === "string") return { id: stringValue(property), name: null, action: null };
    const record = objectValue(property);
    return {
      id: stringValue(record?.id),
      name: stringValue(record?.name),
      action: stringValue(record?.action),
    };
  });
}

function notionWebhookAffectedDatabaseId(event: NotionWebhookEvent): string | null {
  if (event.entity?.type === "database") return stringValue(event.entity.id);
  const parent = objectValue(event.data?.parent);
  if (stringValue(parent?.type) === "database") return stringValue(parent?.id);
  return null;
}

function normalizeNotionWebhookEvents(payload: Record<string, unknown>): NotionWebhookEvent[] {
  if (Array.isArray(payload.events)) {
    return payload.events.filter((event): event is NotionWebhookEvent => Boolean(objectValue(event)));
  }
  if (stringValue(payload.type) && objectValue(payload.entity)) return [payload as NotionWebhookEvent];
  return [];
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hashWebhookEvent(event: NotionWebhookEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16);
}
