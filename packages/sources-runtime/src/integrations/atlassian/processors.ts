import {
  deleteConfluencePageSourceWiki,
  deleteJiraIssueSourceWiki,
  materializeConfluenceCommentsSourceWiki,
  materializeConfluencePageSourceWiki,
  materializeJiraIssueSourceWiki,
  rematerializeJiraIssueFromCapturedComments,
  type ConfluenceCommentsContainerRef,
} from "../../mirror/materializer.js";
import { isDeletedNangoRecord, nangoRecordId, nangoRecordVersion, processGenericNangoRecord } from "../nango/capture.js";
import {
  registerGenericNangoModels,
  registerProcessor,
  type NangoRecord,
  type NangoRecordProcessorContext,
  type NangoExecutor,
} from "../nango/types.js";

/**
 * Sync models the live Nango jira integration emits beyond Issue
 * (live-verified against the configured environment's sync status). No
 * renderer yet - generic lossless capture keeps them durable and versioned.
 */
const JIRA_GENERIC_MODELS = [
  { model: "Project", eventType: "project" },
  { model: "User", eventType: "user" },
  { model: "Field", eventType: "field" },
  { model: "IssueType", eventType: "issue_type" },
  { model: "ProjectComponent", eventType: "project_component" },
  { model: "ProjectVersion", eventType: "project_version" },
];

/**
 * Live-verified confluence sync models beyond Page: attachment metadata,
 * blog posts, and spaces all land as raw versioned events the moment the
 * dashboard-side syncs deliver them. FooterComment/InlineComment have
 * dedicated processors (same raw capture, plus the per-page comments doc).
 */
const CONFLUENCE_GENERIC_MODELS = [
  { model: "Space", eventType: "space" },
  { model: "Attachment", eventType: "attachment" },
  { model: "BlogPost", eventType: "blog_post" },
];

/** activity_events event_type per comment sync model (matches the previous generic registration). */
const CONFLUENCE_COMMENT_EVENT_TYPES = {
  FooterComment: "footer_comment",
  InlineComment: "inline_comment",
} as const;

export function registerAtlassianProcessors(): void {
  registerProcessor({
    provider: "jira",
    model: "Issue",
    process: processJiraIssueRecord,
  });
  registerProcessor({
    provider: "jira",
    model: "IssueComment",
    process: processJiraCommentRecord,
  });
  registerProcessor({
    provider: "confluence",
    model: "Page",
    process: processConfluencePageRecord,
  });
  registerProcessor({
    provider: "confluence",
    model: "FooterComment",
    process: (executor, record, ctx) => processConfluenceCommentRecord(executor, record, ctx, "FooterComment"),
  });
  registerProcessor({
    provider: "confluence",
    model: "InlineComment",
    process: (executor, record, ctx) => processConfluenceCommentRecord(executor, record, ctx, "InlineComment"),
  });
  registerGenericNangoModels("jira", JIRA_GENERIC_MODELS);
  registerGenericNangoModels("confluence", CONFLUENCE_GENERIC_MODELS);
}

export async function processJiraIssueRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "jira",
    model: "Issue",
    record,
  });

  const key = stringValue(record.key) ?? stringValue(record.issueKey) ?? stringValue(record.issue_key);
  if (isDeletedNangoRecord(record)) {
    if (key) await deleteJiraIssueSourceWiki(ctx.tenantId, key);
    return { stored: captured.stored, skipped: !captured.stored };
  }

  await materializeJiraIssueSourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    connectionId: ctx.connectionId ?? null,
    rawPayload: record,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

/**
 * A comment can arrive independently of the detail sweep. Capture it with the
 * same event identity as the proxy path, then rebuild from the locally stored
 * parent issue + comment ledger when that parent is available.
 */
export async function processJiraCommentRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const commentId = stringValue(record.id);
  const version = stringValue(record.updated) ?? stringValue(record.created);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "jira",
    model: "IssueComment",
    record,
    eventType: "issue_comment",
    sourceEventId: commentId
      ? `nango:jira:issue_comment:${commentId}:${version ?? nangoRecordVersion(record)}`
      : undefined,
    sourceUpdatedAt: version,
  });

  await rematerializeJiraIssueFromCapturedComments(ctx.tenantId, {
    issueId: stringValue(record.issueId) ?? stringValue(record.issue_id),
    issueKey: stringValue(record.issueKey) ?? stringValue(record.issue_key),
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

export async function processConfluencePageRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "confluence",
    model: "Page",
    record,
  });

  const pageId = nangoRecordId(record);
  const spaceId = confluenceSpaceId(record);
  if (isDeletedNangoRecord(record)) {
    if (pageId && spaceId) await deleteConfluencePageSourceWiki(ctx.tenantId, spaceId, pageId);
    return { stored: captured.stored, skipped: !captured.stored };
  }

  await materializeConfluencePageSourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    rawPayload: record,
  });
  // Comments can sync before their page: the page's arrival supplies the
  // space (and title) the comments doc needs, so refresh it here too.
  if (pageId) {
    await materializeConfluenceCommentsSourceWiki(ctx.tenantId, { containerType: "page", containerId: pageId });
  }
  return { stored: captured.stored, skipped: !captured.stored };
}

/**
 * FooterComment/InlineComment records: same generic lossless capture as
 * before (identical event_type and source event ids), plus a rebuild of the
 * container's aggregated comments doc. Deleted records rebuild too - the
 * tombstone stays in the raw ledger while the doc reflects current state.
 */
export async function processConfluenceCommentRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
  model: keyof typeof CONFLUENCE_COMMENT_EVENT_TYPES,
): Promise<{ stored: boolean; skipped: boolean }> {
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "confluence",
    model,
    record,
    eventType: CONFLUENCE_COMMENT_EVENT_TYPES[model],
  });

  const container = confluenceCommentContainer(record);
  if (container) {
    await materializeConfluenceCommentsSourceWiki(ctx.tenantId, container);
  }
  return { stored: captured.stored, skipped: !captured.stored };
}

function confluenceCommentContainer(record: NangoRecord): ConfluenceCommentsContainerRef | null {
  const pageId = stringValue(record.pageId) ?? stringValue(record.page_id);
  if (pageId) return { containerType: "page", containerId: pageId };
  const blogPostId = stringValue(record.blogPostId) ?? stringValue(record.blog_post_id);
  if (blogPostId) return { containerType: "blog_post", containerId: blogPostId };
  return null;
}

function confluenceSpaceId(record: NangoRecord): string | null {
  const space = objectValue(record.space);
  return stringValue(record.spaceId)
    ?? stringValue(record.space_id)
    ?? stringValue(space?.id)
    ?? stringValue(space?.key);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
