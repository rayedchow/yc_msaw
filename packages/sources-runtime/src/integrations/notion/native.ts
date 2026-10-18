import { createHash } from "node:crypto";
import {
  collectNotionDataSourceTemplateCollection,
  collectNotionViews,
  createNotionViewQuery,
  deleteNotionViewQuery,
  extractNotionTitle,
  notionParentInfo,
  notionRichTextPlain,
  retrieveNotionDatabase,
  retrieveNotionDataSource,
  type NotionBlock,
  type NotionComment,
  type NotionDataSource,
  type NotionDataSourceTemplateCollection,
  type NotionDataSourceTemplate,
  type NotionDatabase,
  type NotionPage,
  type NotionParent,
  type NotionRichText,
  type NotionView,
  type NotionViewQueryResponse,
  NOTION_VERSION,
} from "./client.js";
import { NOTION_MEDIA_BLOCK_TYPES, NOTION_MEDIA_URL_EXTENSIONS } from "./coverage.js";
import { notionBlockSupportsChildren } from "./block-capabilities.js";
import { fetchNotionPageContent, propertyValueReferences, richTextMentionReferences, summarizeNotionRichText } from "./content.js";
import type {
  NotionBlockNode,
  NotionChildPage,
  NotionCommentAttachmentFileObjectSummary,
  NotionCommentAttachmentFileUploadSummary,
  NotionCommentAttachmentSummary,
  NotionCommentSummary,
  NotionDatabaseRowPage,
  NotionInlineDataSource,
  NotionPageContent,
  NotionPropertyValueSummary,
  NotionReference,
  NotionRichTextSpanSummary,
} from "./content.js";
import { notionPropertySchemaSummary } from "./property-schema.js";

const MEDIA_URL_EXTENSIONS = new Set<string>(NOTION_MEDIA_URL_EXTENSIONS);
const NATIVE_VIEW_MAX_VIEWS = numberFromEnv("NOTION_NATIVE_MAX_VIEWS", 100);
const NATIVE_VIEW_QUERY_SNAPSHOT_MAX_VIEWS = numberFromEnv("NOTION_NATIVE_VIEW_QUERY_SNAPSHOT_MAX_VIEWS", 20);
const NATIVE_TEMPLATE_PAGE_SNAPSHOT_MAX = numberFromEnv("NOTION_NATIVE_TEMPLATE_PAGE_SNAPSHOT_MAX", 20);
const NATIVE_TEMPLATE_BODY_PREVIEW_MAX = 1200;
const NATIVE_TEMPLATE_BLOCK_OUTLINE_MAX = 25;
const VIEW_QUERY_SNAPSHOT_PAGE_SIZE = numberFromEnv("NOTION_VIEW_QUERY_SNAPSHOT_PAGE_SIZE", 25);
const NOTION_API_VERSION_METADATA = { notionApiVersion: NOTION_VERSION } as const;

export interface NotionRenderedBlock {
  blockId: string;
  blockType: string;
  title: string;
  plainText: string;
  markdown: string;
  contentHash: string;
  childrenHash: string;
  childBlockIds: string[];
  hasChildren: boolean;
  richText?: NotionRichTextSpanSummary[];
  captionRichText?: NotionRichTextSpanSummary[];
  titleRichText?: NotionRichTextSpanSummary[];
  tableCellRichText?: NotionRichTextSpanSummary[][];
  childPage?: {
    pageId: string;
    title: string;
    url: string | null;
    parentBlockId: string;
    relativePath: string;
    bodyBlockIds: string[];
    nestedChildPageIds: string[];
    nestedChildPageCount: number;
    bodyMarkdown: string;
  } | null;
}

export interface NotionNativeSnapshot {
  objects: NotionObjectSnapshot[];
  edges: NotionObjectEdgeSnapshot[];
  blocks: NotionBlockSnapshot[];
  dataSources: NotionDataSourceSnapshot[];
  databases: NotionDatabaseSnapshot[];
  views: NotionViewSnapshot[];
  templates: NotionDataSourceTemplateSnapshot[];
  comments: NotionCommentSnapshot[];
}

export interface NotionObjectSnapshot {
  objectId: string;
  objectType: "page" | "block" | "data_source" | "database" | "view" | "data_source_template" | "comment";
  title: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
  databaseId: string | null;
  blockType: string | null;
  hasChildren: boolean;
  archived: boolean;
  inTrash: boolean;
  plainText: string;
  objectHash: string;
  properties: Record<string, unknown>;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
  lastEditedBy: unknown;
}

export interface NotionObjectEdgeSnapshot {
  parentObjectId: string;
  childObjectId: string;
  relationType: string;
  position: number;
  sourceObjectId: string | null;
  metadata: Record<string, unknown>;
  childHash: string | null;
}

export interface NotionBlockSnapshot {
  notionApiVersion: string;
  blockId: string;
  pageId: string | null;
  parentType: string | null;
  parentId: string | null;
  blockType: string;
  hasChildren: boolean;
  archived: boolean;
  inTrash: boolean;
  plainText: string;
  markdown: string;
  contentHash: string;
  childrenHash: string;
  tableCellRichText?: NotionRichTextSpanSummary[][];
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
  lastEditedBy: unknown;
}

export interface NotionDataSourceSnapshot {
  notionApiVersion: string;
  dataSourceId: string;
  databaseId: string | null;
  title: string;
  description: NotionRichText[];
  url: string | null;
  publicUrl: string | null;
  parent: NotionParent | null;
  parentType: string | null;
  parentId: string | null;
  databaseParent: NotionParent | null;
  databaseParentType: string | null;
  databaseParentId: string | null;
  isInline: boolean;
  archived: boolean;
  inTrash: boolean;
  icon: unknown;
  cover: unknown;
  properties: Record<string, unknown>;
  propertyHash: string;
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
  lastEditedBy: unknown;
}

export interface NotionDatabaseSnapshot {
  notionApiVersion: string;
  databaseId: string;
  title: string;
  description: NotionRichText[];
  url: string | null;
  publicUrl: string | null;
  parentType: string | null;
  parentId: string | null;
  isInline: boolean;
  isLocked: boolean;
  inTrash: boolean;
  icon: unknown;
  cover: unknown;
  properties: Record<string, unknown>;
  dataSources: Array<{ id?: string; name?: string; title?: NotionRichText[] }>;
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
  lastEditedBy: unknown;
}

export interface NotionViewSnapshot {
  notionApiVersion: string;
  viewId: string;
  databaseId: string | null;
  dataSourceId: string | null;
  name: string;
  viewType: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  dashboardViewId: string | null;
  filter: unknown;
  sorts: unknown[];
  quickFilters: unknown;
  configuration: unknown;
  query: NotionViewQuerySnapshot | null;
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
  lastEditedBy: unknown;
}

export interface NotionViewQuerySnapshot {
  notionApiVersion: string;
  queryId: string | null;
  resultPageIds: string[];
  totalCount: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  requestStatus: Record<string, unknown> | null;
  expiresAt: string | null;
  fetchedAt: string;
  pageSize: number;
  complete: boolean;
  raw: Record<string, unknown>;
}

export interface NotionDataSourceTemplateSnapshot {
  notionApiVersion: string;
  templateId: string;
  dataSourceId: string;
  name: string;
  isDefault: boolean;
  page?: NotionDataSourceTemplatePageSnapshot | null;
  pageHydrationStatus?: "hydrated" | "skipped" | "failed";
  pageHydrationError?: string | null;
  raw: Record<string, unknown>;
}

export interface NotionDataSourceTemplatePageSnapshot {
  notionApiVersion: string;
  pageId: string;
  title: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
  structuredIngestion: boolean;
  markdownTruncated: boolean;
  propertyValues: Array<Record<string, unknown>>;
  bodyMarkdown: string;
  bodyMarkdownPreview: string | null;
  bodyMarkdownPreviewTruncated: boolean;
  bodyBlockCount: number;
  bodyBlockIds: string[];
  bodyBlockTypes: string[];
  bodyBlockOutline: Array<Record<string, unknown>>;
  rowPageCount: number;
  childPageCount: number;
  commentCount: number;
  referenceCount: number;
  references: NotionReference[];
  warningCodes: string[];
  createdTime: string | null;
  lastEditedTime: string | null;
  createdBy: unknown;
  lastEditedBy: unknown;
  raw: Record<string, unknown>;
}

export interface NotionDataSourceTemplateCollectionSnapshot {
  notionApiVersion: string;
  dataSourceId: string;
  templateCount: number;
  complete: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  truncated: boolean;
  maxTemplates: number;
}

export interface NotionCommentSnapshot {
  notionApiVersion: string;
  commentId: string;
  pageId: string | null;
  blockId: string | null;
  parentType: string | null;
  parentId: string | null;
  discussionId: string | null;
  plainText: string;
  richText: NotionRichText[];
  richTextSummary: ReturnType<typeof summarizeNotionRichText>;
  references: NotionReference[];
  displayName: { type: string | null; resolvedName: string | null } | null;
  attachments: NotionCommentAttachmentSummary[];
  retrievalRequestStatus: Record<string, unknown> | null;
  retrievalComplete: boolean | null;
  retrievalHasMore: boolean | null;
  retrievalNextCursor: string | null;
  raw: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: unknown;
}

export async function buildNotionNativeSnapshot(userId: string, pageContent: NotionPageContent): Promise<NotionNativeSnapshot> {
  const context = await loadNativeContext(userId, pageContent);
  return buildNotionNativeSnapshotFromContent(pageContent, context);
}

export function buildNotionNativeSnapshotFromContent(
  pageContent: NotionPageContent,
  context: {
    dataSources?: NotionDataSource[];
    databases?: NotionDatabase[];
    views?: NotionView[];
    viewQueries?: Map<string, NotionViewQuerySnapshot>;
    templates?: NotionDataSourceTemplateSnapshot[];
    templateCollections?: NotionDataSourceTemplateCollectionSnapshot[];
  } = {},
): NotionNativeSnapshot {
  const objects: NotionObjectSnapshot[] = [];
  const edges: NotionObjectEdgeSnapshot[] = [];
  const seenEdges = new Set<string>();
  const page = pageContent.rawPage ?? syntheticPage(pageContent);
  const pageParent = notionParentInfo(page.parent);
  const pageObjectHash = hashStable({
    pageId: pageContent.pageId,
    contentHash: pageContent.contentHash,
    properties: pageContent.properties,
    propertyValues: pageContent.propertyValues,
    warnings: pageContent.warnings.map((warning) => warning.code),
  });

  objects.push({
    objectId: pageContent.pageId,
    objectType: "page",
    title: pageContent.title,
    url: pageContent.url,
    parentType: pageParent.parentType ?? pageContent.parentType,
    parentId: pageParent.parentId ?? pageContent.parentId,
    dataSourceId: pageContent.dataSourceId ?? page.parent?.data_source_id ?? null,
    databaseId: databaseIdFromParent(page.parent),
    blockType: null,
    hasChildren: pageContent.blockTree.length > 0,
    archived: Boolean(page.archived ?? page.is_archived),
    inTrash: Boolean(page.in_trash ?? false),
    plainText: pageContent.title,
    objectHash: pageObjectHash,
    properties: pageContent.properties,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      pageId: pageContent.pageId,
      structuredIngestion: pageContent.structuredIngestion,
      markdownTruncated: pageContent.markdownTruncated,
      referenceCount: pageContent.references.length,
      rowPageCount: pageContent.rowPages.length,
      propertyValues: compactPropertyValues(pageContent.propertyValues),
      breadcrumbTrail: pageContent.breadcrumbTrail,
      publicUrl: page.public_url ?? null,
      isLocked: Boolean(page.is_locked),
      icon: iconSummary(page.icon),
      cover: mediaSummary(recordValue(page.cover)),
      warningCodes: pageContent.warnings.map((warning) => warning.code),
    },
    raw: recordValue(page),
    createdTime: parseDate(page.created_time),
    lastEditedTime: pageContent.lastEditedTime ?? parseDate(page.last_edited_time),
    createdBy: page.created_by ?? null,
    lastEditedBy: page.last_edited_by ?? null,
  });

  if (pageParent.parentId) {
    pushObjectEdge(edges, seenEdges, {
      parentObjectId: pageParent.parentId,
      childObjectId: pageContent.pageId,
      relationType: pageParent.parentType === "data_source_id" || pageParent.parentType === "database_id" ? "row" : "contains",
      position: 0,
      sourceObjectId: pageContent.pageId,
      metadata: { parentType: pageParent.parentType, ...NOTION_API_VERSION_METADATA },
      childHash: pageObjectHash,
    });
  }
  collectPropertyReferenceEdges(pageContent.pageId, pageContent.pageId, pageContent.propertyValues, edges, seenEdges);

  const blockSnapshots: NotionBlockSnapshot[] = [];
  for (const [index, node] of pageContent.blockTree.entries()) {
    collectBlockNode({
      pageId: pageContent.pageId,
      containerPageId: pageContent.pageId,
      node,
      position: index,
      objects,
      edges,
      blockSnapshots,
      seenEdges,
    });
  }

  for (const rowPage of pageContent.rowPages) {
    collectRowPage(pageContent.pageId, rowPage, objects, edges, blockSnapshots, seenEdges);
  }

  const seenChildPages = new Set<string>();
  for (const [index, childPage] of pageContent.childPages.entries()) {
    collectChildPage(pageContent.pageId, pageContent.pageId, childPage, index, objects, edges, blockSnapshots, seenEdges, seenChildPages);
  }

  const dataSources = dedupeById([
    ...pageContent.nativeDataSources,
    ...(context.dataSources ?? []),
  ], (source) => source.id).map(notionDataSourceSnapshot);
  const databases = dedupeById([
    ...pageContent.nativeDatabases,
    ...(context.databases ?? []),
  ], (database) => database.id).map(notionDatabaseSnapshot);
  const views = dedupeById(context.views ?? [], (view) => view.id)
    .map((view) => notionViewSnapshot(view, context.viewQueries?.get(view.id) ?? null));
  const templates = dedupeById(context.templates ?? [], (template) => `${template.dataSourceId}:${template.templateId}`);
  const templatesByDataSourceId = groupBy(templates, (template) => template.dataSourceId);
  const templateCollectionsByDataSourceId = new Map((context.templateCollections ?? []).map((collection) => [collection.dataSourceId, collection]));
  const commentSummaries = commentSummaryMap(pageContent);
  const comments = [
    ...pageContent.rawComments.map((comment) => notionCommentSnapshot(comment, pageContent.pageId, commentSummaries.get(comment.id))),
    ...flattenBlockNodes(pageContent.blockTree).flatMap((block) =>
      (block.rawComments ?? []).map((comment) => notionCommentSnapshot(comment, pageContent.pageId, commentSummaries.get(comment.id)))),
    ...pageContent.rowPages.flatMap((rowPage) =>
      [
        ...(rowPage.rawComments ?? []).map((comment) => notionCommentSnapshot(comment, rowPage.pageId, commentSummaries.get(comment.id))),
        ...flattenBlockNodes(rowPage.bodyBlocks).flatMap((block) =>
          (block.rawComments ?? []).map((comment) => notionCommentSnapshot(comment, rowPage.pageId, commentSummaries.get(comment.id)))),
      ]),
    ...childPageCommentSnapshots(pageContent.childPages, commentSummaries),
  ];

  for (const source of dataSources) {
    if (source.dataSourceId !== pageContent.pageId) {
      objects.push(dataSourceObject(
        source,
        templatesByDataSourceId.get(source.dataSourceId) ?? [],
        templateCollectionsByDataSourceId.get(source.dataSourceId) ?? null,
      ));
    }
    if (source.databaseId) {
      pushObjectEdge(edges, seenEdges, {
        parentObjectId: source.databaseId,
        childObjectId: source.dataSourceId,
        relationType: "data_source",
        position: 0,
        sourceObjectId: pageContent.pageId,
        metadata: { ...NOTION_API_VERSION_METADATA },
        childHash: source.propertyHash,
      });
    }
  }

  for (const database of databases) {
    if (database.databaseId !== pageContent.pageId) {
      objects.push(databaseObject(database));
    }
  }

  for (const view of views) {
    objects.push(viewObject(view));
    const parentId = view.dataSourceId ?? view.databaseId;
    if (parentId) {
      pushObjectEdge(edges, seenEdges, {
        parentObjectId: parentId,
        childObjectId: view.viewId,
        relationType: "view",
        position: 0,
        sourceObjectId: pageContent.pageId,
        metadata: viewEdgeMetadata(view),
        childHash: hashStable(view.raw),
      });
    }
  }

  for (const sourceTemplates of templatesByDataSourceId.values()) {
    for (const [index, template] of sourceTemplates.entries()) {
      const objectId = templateObjectId(template);
      objects.push(templateObject(template));
      pushObjectEdge(edges, seenEdges, {
        parentObjectId: template.dataSourceId,
        childObjectId: objectId,
        relationType: "template",
        position: index,
        sourceObjectId: pageContent.pageId,
        metadata: {
          ...NOTION_API_VERSION_METADATA,
          templateId: template.templateId,
          name: template.name,
          isDefault: template.isDefault,
          pageId: template.page?.pageId ?? null,
          pageHydrationStatus: template.pageHydrationStatus ?? "skipped",
        },
        childHash: hashStable({ template: template.raw, page: template.page }),
      });
      if (template.page) {
        collectReferenceEdges(objectId, pageContent.pageId, template.page.references, "template", edges, seenEdges);
      }
    }
  }

  const commentDiscussionIndex = commentDiscussionIndexMap(comments);
  for (const comment of comments) {
    objects.push(commentObject(comment, pageContent.pageId, commentDiscussionIndex.get(comment.commentId)));
    pushObjectEdge(edges, seenEdges, {
      parentObjectId: comment.parentId ?? comment.pageId ?? pageContent.pageId,
      childObjectId: comment.commentId,
      relationType: "comment",
      position: 0,
      sourceObjectId: pageContent.pageId,
      metadata: { parentType: comment.parentType, discussionId: comment.discussionId, ...NOTION_API_VERSION_METADATA },
      childHash: hashStable(comment.raw),
    });
    collectReferenceEdges(comment.commentId, pageContent.pageId, comment.references, "comment", edges, seenEdges);
  }

  return { objects, edges, blocks: blockSnapshots, dataSources, databases, views, templates, comments };
}

function childPageCommentSnapshots(
  childPages: NotionChildPage[],
  summaries = new Map<string, NotionCommentSummary>(),
  seenPageIds = new Set<string>(),
): NotionCommentSnapshot[] {
  const comments: NotionCommentSnapshot[] = [];
  for (const childPage of childPages) {
    if (seenPageIds.has(childPage.pageId)) continue;
    seenPageIds.add(childPage.pageId);
    comments.push(
      ...(childPage.rawComments ?? []).map((comment) => notionCommentSnapshot(comment, childPage.pageId, summaries.get(comment.id))),
      ...flattenBlockNodes(childPage.bodyBlocks).flatMap((block) =>
        (block.rawComments ?? []).map((comment) => notionCommentSnapshot(comment, childPage.pageId, summaries.get(comment.id)))),
      ...childPageCommentSnapshots(childPage.childPages, summaries, seenPageIds),
    );
  }
  return comments;
}

async function loadNativeContext(userId: string, pageContent: NotionPageContent): Promise<{
  dataSources: NotionDataSource[];
  databases: NotionDatabase[];
  views: NotionView[];
  viewQueries: Map<string, NotionViewQuerySnapshot>;
  templates: NotionDataSourceTemplateSnapshot[];
  templateCollections: NotionDataSourceTemplateCollectionSnapshot[];
}> {
  const dataSources = new Map(pageContent.nativeDataSources.map((source) => [source.id, source]));
  const databases = new Map(pageContent.nativeDatabases.map((database) => [database.id, database]));
  const views = new Map<string, NotionView>();
  const viewQueries = new Map<string, NotionViewQuerySnapshot>();
  const templates = new Map<string, NotionDataSourceTemplateSnapshot>();
  const templateCollections = new Map<string, NotionDataSourceTemplateCollectionSnapshot>();
  const databaseIdsCoveredByDataSources = new Set<string>();

  for (const id of collectDataSourceIds(pageContent)) {
    if (!dataSources.has(id)) {
      const source = await optionalNativeRead(() => retrieveNotionDataSource(userId, id), `data source ${id}`);
      if (source) dataSources.set(source.id, source);
    }
  }

  for (const source of dataSources.values()) {
    const databaseId = databaseIdFromDataSource(source);
    if (databaseId) databaseIdsCoveredByDataSources.add(databaseId);
    if (databaseId && !databases.has(databaseId)) {
      const database = await optionalNativeRead(() => retrieveNotionDatabase(userId, databaseId), `database ${databaseId}`);
      if (database) databases.set(database.id, database);
    }
  }

  for (const dataSourceId of dataSources.keys()) {
    const sourceViews = await optionalNativeRead(
      () => collectAllNativeViews(userId, { dataSourceId }),
      `views for data source ${dataSourceId}`,
    );
    for (const view of sourceViews ?? []) views.set(view.id, view);

    const sourceTemplateCollection = await optionalNativeRead(
      () => collectNativeDataSourceTemplateCollection(userId, dataSourceId),
      `templates for data source ${dataSourceId}`,
    );
    if (sourceTemplateCollection) templateCollections.set(dataSourceId, sourceTemplateCollection.collection);
    for (const template of sourceTemplateCollection?.templates ?? []) {
      templates.set(`${template.dataSourceId}:${template.templateId}`, template);
    }
  }

  for (const databaseId of databases.keys()) {
    if (databaseIdsCoveredByDataSources.has(databaseId)) continue;
    const databaseViews = await optionalNativeRead(
      () => collectAllNativeViews(userId, { databaseId }),
      `views for database ${databaseId}`,
    );
    for (const view of databaseViews ?? []) views.set(view.id, view);
  }

  let queriedViewCount = 0;
  for (const viewId of views.keys()) {
    if (queriedViewCount >= NATIVE_VIEW_QUERY_SNAPSHOT_MAX_VIEWS) break;
    const query = await optionalNativeRead(
      () => collectNativeViewQuerySnapshot(userId, viewId),
      `query snapshot for view ${viewId}`,
    );
    if (query) viewQueries.set(viewId, query);
    queriedViewCount += 1;
  }

  return {
    dataSources: [...dataSources.values()],
    databases: [...databases.values()],
    views: [...views.values()],
    viewQueries,
    templates: [...templates.values()],
    templateCollections: [...templateCollections.values()],
  };
}

async function collectAllNativeViews(userId: string, opts: {
  databaseId?: string | null;
  dataSourceId?: string | null;
}): Promise<NotionView[]> {
  const views: NotionView[] = [];
  let cursor: string | null = null;
  do {
    const response = await collectNotionViews(userId, {
      ...opts,
      pageSize: 100,
      startCursor: cursor,
    });
    views.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor && views.length < NATIVE_VIEW_MAX_VIEWS);
  return views.slice(0, NATIVE_VIEW_MAX_VIEWS);
}

async function collectNativeViewQuerySnapshot(userId: string, viewId: string): Promise<NotionViewQuerySnapshot> {
  const pageSize = Math.max(1, Math.min(VIEW_QUERY_SNAPSHOT_PAGE_SIZE, 100));
  const fetchedAt = new Date().toISOString();
  const response = await createNotionViewQuery(userId, viewId, { page_size: pageSize });
  const queryId = viewQueryId(response);
  let deleteAttempted = false;
  let deleteAcknowledged = false;
  if (queryId) {
    deleteAttempted = true;
    const deleteResult = await optionalNativeRead(
      () => deleteNotionViewQuery(userId, viewId, queryId),
      `delete query snapshot ${queryId} for view ${viewId}`,
    );
    deleteAcknowledged = notionDeleteAcknowledged(deleteResult);
  }
  return viewQuerySnapshot(response, pageSize, fetchedAt, { deleteAttempted, deleteAcknowledged });
}

function notionDeleteAcknowledged(value: unknown): boolean {
  return Boolean(recordValue(value).deleted);
}

function viewQuerySnapshot(
  response: NotionViewQueryResponse,
  pageSize: number,
  fetchedAt: string,
  opts: { deleteAttempted?: boolean; deleteAcknowledged?: boolean } = {},
): NotionViewQuerySnapshot {
  const requestStatus = recordValue(response.request_status);
  const deleteAttempted = opts.deleteAttempted === true;
  const deleteAcknowledged = opts.deleteAcknowledged === true;
  const status = Object.keys(requestStatus).length > 0 ? { ...requestStatus } : {};
  if (deleteAttempted) {
    status.shepherd_query_delete_attempted = true;
    status.shepherd_query_delete_acknowledged = deleteAcknowledged;
    if (!deleteAcknowledged) status.shepherd_incomplete_reason = "temporary_view_query_delete_unconfirmed";
  }
  return {
    notionApiVersion: NOTION_VERSION,
    queryId: viewQueryId(response),
    resultPageIds: arrayValue(response.results).map(resultId).filter((id): id is string => Boolean(id)),
    totalCount: numberValue(response.total_count),
    hasMore: Boolean(response.has_more),
    nextCursor: deleteAttempted ? null : stringValue(response.next_cursor),
    requestStatus: Object.keys(status).length > 0 ? status : null,
    expiresAt: stringValue(response.expires_at),
    fetchedAt,
    pageSize,
    complete: response.has_more !== true && stringValue(requestStatus.type) !== "incomplete" && (!deleteAttempted || deleteAcknowledged),
    raw: recordValue(response),
  };
}

function viewQueryId(response: NotionViewQueryResponse): string | null {
  return stringValue(response.query_id) ?? stringValue(response.id);
}

function resultId(value: unknown): string | null {
  const record = recordValue(value);
  return stringValue(record.id) ?? stringValue(record.page_id);
}

async function collectNativeDataSourceTemplateCollection(userId: string, dataSourceId: string): Promise<{
  templates: NotionDataSourceTemplateSnapshot[];
  collection: NotionDataSourceTemplateCollectionSnapshot;
}> {
  const collection = await collectNotionDataSourceTemplateCollection(userId, dataSourceId);
  const templates: NotionDataSourceTemplateSnapshot[] = [];
  for (const [index, template] of collection.templates.entries()) {
    const snapshot = notionDataSourceTemplateSnapshot(dataSourceId, template);
    if (index >= NATIVE_TEMPLATE_PAGE_SNAPSHOT_MAX) {
      templates.push({
        ...snapshot,
        pageHydrationStatus: "skipped",
        pageHydrationError: "template_page_snapshot_cap_reached",
      });
      continue;
    }

    const pageContent = await optionalNativeRead(
      () => fetchNotionPageContent(userId, template.id),
      `template page ${template.id}`,
    );
    templates.push(pageContent
      ? {
        ...snapshot,
        page: notionDataSourceTemplatePageSnapshot(pageContent),
        pageHydrationStatus: "hydrated",
        pageHydrationError: null,
      }
      : {
        ...snapshot,
        pageHydrationStatus: "failed",
        pageHydrationError: "template_page_fetch_failed",
      });
  }
  return {
    templates,
    collection: notionDataSourceTemplateCollectionSnapshot(dataSourceId, collection),
  };
}

async function optionalNativeRead<T>(read: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.warn(`[notion-native] Skipped ${label}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function collectDataSourceIds(pageContent: NotionPageContent): string[] {
  const ids = new Set<string>();
  if (pageContent.dataSourceId) ids.add(pageContent.dataSourceId);
  addInlineDataSourceIds(ids, pageContent.blockTree);
  for (const rowPage of pageContent.rowPages) {
    ids.add(rowPage.dataSourceId);
    addInlineDataSourceIds(ids, rowPage.bodyBlocks);
  }
  const seenChildPageIds = new Set<string>();
  for (const childPage of pageContent.childPages) {
    addChildPageDataSourceIds(ids, childPage, seenChildPageIds);
  }
  return [...ids];
}

function addChildPageDataSourceIds(ids: Set<string>, childPage: NotionChildPage, seenPageIds = new Set<string>()): void {
  if (seenPageIds.has(childPage.pageId)) return;
  seenPageIds.add(childPage.pageId);
  addInlineDataSourceIds(ids, childPage.bodyBlocks);
  for (const nested of childPage.childPages) addChildPageDataSourceIds(ids, nested, seenPageIds);
}

function addInlineDataSourceIds(ids: Set<string>, blocks: NotionBlockNode[]): void {
  for (const source of flattenBlockNodes(blocks).flatMap((block) => block.inlineDataSources ?? [])) {
    ids.add(source.dataSourceId);
    for (const nested of source.nestedDataSources) ids.add(nested.dataSourceId);
  }
}

function collectRowPage(
  containerPageId: string,
  rowPage: NotionDatabaseRowPage,
  objects: NotionObjectSnapshot[],
  edges: NotionObjectEdgeSnapshot[],
  blockSnapshots: NotionBlockSnapshot[],
  seenEdges: Set<string>,
): void {
  const rawPage = rowPage.rawPage ?? syntheticRowPage(rowPage);
  const parent = notionParentInfo(rawPage.parent);
  const objectHash = hashStable({
    pageId: rowPage.pageId,
    values: rowPage.values,
    propertyValues: rowPage.propertyValues,
    bodyMarkdown: rowPage.bodyMarkdown,
    comments: rowPage.comments,
    breadcrumbTrail: rowPage.breadcrumbTrail,
  });
  objects.push({
    objectId: rowPage.pageId,
    objectType: "page",
    title: rowPage.title,
    url: rowPage.url,
    parentType: parent.parentType,
    parentId: parent.parentId,
    dataSourceId: rowPage.dataSourceId,
    databaseId: databaseIdFromParent(rawPage.parent),
    blockType: null,
    hasChildren: rowPage.bodyBlocks.length > 0,
    archived: Boolean(rawPage.archived ?? rawPage.is_archived),
    inTrash: Boolean(rawPage.in_trash ?? false),
    plainText: rowPage.title,
    objectHash,
    properties: rowPage.properties,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      pageId: rowPage.pageId,
      containerPageId,
      dataSourceId: rowPage.dataSourceId,
      dataSourceTitle: rowPage.dataSourceTitle,
      parentBlockId: rowPage.parentBlockId,
      relativePath: rowPage.relativePath,
      rowPage: true,
      breadcrumbTrail: rowPage.breadcrumbTrail,
      propertyValues: compactPropertyValues(rowPage.propertyValues),
    },
    raw: recordValue(rawPage),
    createdTime: parseDate(rawPage.created_time),
    lastEditedTime: parseDate(rawPage.last_edited_time),
    createdBy: rawPage.created_by ?? null,
    lastEditedBy: rawPage.last_edited_by ?? null,
  });

  pushObjectEdge(edges, seenEdges, {
    parentObjectId: rowPage.dataSourceId,
    childObjectId: rowPage.pageId,
    relationType: "row",
    position: 0,
    sourceObjectId: containerPageId,
    metadata: { parentBlockId: rowPage.parentBlockId, rowPagePath: rowPage.relativePath, ...NOTION_API_VERSION_METADATA },
    childHash: objectHash,
  });
  pushObjectEdge(edges, seenEdges, {
    parentObjectId: rowPage.parentBlockId,
    childObjectId: rowPage.pageId,
    relationType: "database_row_page",
    position: 0,
    sourceObjectId: containerPageId,
    metadata: { dataSourceId: rowPage.dataSourceId, rowPagePath: rowPage.relativePath, ...NOTION_API_VERSION_METADATA },
    childHash: objectHash,
  });
  collectPropertyReferenceEdges(rowPage.pageId, containerPageId, rowPage.propertyValues, edges, seenEdges);

  for (const [index, node] of rowPage.bodyBlocks.entries()) {
    collectBlockNode({
      pageId: rowPage.pageId,
      containerPageId,
      node,
      position: index,
      objects,
      edges,
      blockSnapshots,
      seenEdges,
    });
  }
}

function collectChildPage(
  containerPageId: string,
  parentPageId: string,
  childPage: NotionChildPage,
  position: number,
  objects: NotionObjectSnapshot[],
  edges: NotionObjectEdgeSnapshot[],
  blockSnapshots: NotionBlockSnapshot[],
  seenEdges: Set<string>,
  seenChildPages: Set<string>,
): void {
  if (seenChildPages.has(childPage.pageId)) return;
  seenChildPages.add(childPage.pageId);

  const rawPage = childPage.rawPage ?? syntheticChildPage(childPage);
  const parent = notionParentInfo(rawPage.parent);
  const objectHash = hashStable({
    pageId: childPage.pageId,
    properties: childPage.properties,
    propertyValues: childPage.propertyValues,
    bodyMarkdown: childPage.bodyMarkdown,
    comments: childPage.comments,
    breadcrumbTrail: childPage.breadcrumbTrail,
    childPageIds: childPage.childPages.map((nested) => nested.pageId),
  });
  objects.push({
    objectId: childPage.pageId,
    objectType: "page",
    title: childPage.title,
    url: childPage.url,
    parentType: parent.parentType,
    parentId: parent.parentId ?? childPage.parentBlockId,
    dataSourceId: null,
    databaseId: databaseIdFromParent(rawPage.parent),
    blockType: null,
    hasChildren: childPage.bodyBlocks.length > 0,
    archived: Boolean(rawPage.archived ?? rawPage.is_archived),
    inTrash: Boolean(rawPage.in_trash ?? false),
    plainText: childPage.title,
    objectHash,
    properties: childPage.properties,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      pageId: childPage.pageId,
      containerPageId,
      parentBlockId: childPage.parentBlockId,
      relativePath: childPage.relativePath,
      childPage: true,
      breadcrumbTrail: childPage.breadcrumbTrail,
      nestedChildPageIds: childPage.childPages.map((nested) => nested.pageId),
      commentCount: childPage.comments.length,
      propertyValues: compactPropertyValues(childPage.propertyValues),
    },
    raw: recordValue(rawPage),
    createdTime: parseDate(rawPage.created_time),
    lastEditedTime: parseDate(rawPage.last_edited_time),
    createdBy: rawPage.created_by ?? null,
    lastEditedBy: rawPage.last_edited_by ?? null,
  });

  pushObjectEdge(edges, seenEdges, {
    parentObjectId: parentPageId,
    childObjectId: childPage.pageId,
    relationType: "child_page",
    position,
    sourceObjectId: containerPageId,
    metadata: { parentBlockId: childPage.parentBlockId, childPagePath: childPage.relativePath, ...NOTION_API_VERSION_METADATA },
    childHash: objectHash,
  });
  collectPropertyReferenceEdges(childPage.pageId, containerPageId, childPage.propertyValues, edges, seenEdges);

  for (const [index, node] of childPage.bodyBlocks.entries()) {
    collectBlockNode({
      pageId: childPage.pageId,
      containerPageId,
      node,
      position: index,
      objects,
      edges,
      blockSnapshots,
      seenEdges,
    });
  }

  for (const [index, nested] of childPage.childPages.entries()) {
    collectChildPage(containerPageId, childPage.pageId, nested, index, objects, edges, blockSnapshots, seenEdges, seenChildPages);
  }
}

function collectBlockNode(input: {
  pageId: string;
  containerPageId: string;
  node: NotionBlockNode;
  position: number;
  objects: NotionObjectSnapshot[];
  edges: NotionObjectEdgeSnapshot[];
  blockSnapshots: NotionBlockSnapshot[];
  seenEdges: Set<string>;
}): void {
  const rawBlock = input.node.rawBlock ?? syntheticBlock(input.node, input.pageId);
  const rendered = renderNotionBlock(input.node);
  const parent = nativeBlockParentInfo(input.node, rawBlock);
  const blockArchived = notionBlockArchivedState(rawBlock) || input.node.archived === true;
  const blockInTrash = notionBlockInTrashState(rawBlock) || input.node.inTrash;
  if (!materializedChildPageObject(input.node)) {
    input.objects.push({
      objectId: input.node.id,
      objectType: "block",
      title: rendered.title,
      url: input.node.type === "code" ? null : blockUrlForNative(input.node),
      parentType: parent.parentType,
      parentId: parent.parentId ?? input.node.parentId,
      dataSourceId: null,
      databaseId: null,
      blockType: input.node.type,
      hasChildren: input.node.hasChildren,
      archived: blockArchived,
      inTrash: blockInTrash,
      plainText: rendered.plainText,
      objectHash: rendered.contentHash,
      properties: blockSemanticProperties(input.node),
      metadata: {
        ...NOTION_API_VERSION_METADATA,
        pageId: input.pageId,
        containerPageId: input.containerPageId,
        ...blockLayoutMetadata(input.node),
        commentCount: input.node.comments.length,
        warningCodes: input.node.warnings.map((warning) => warning.code),
        deleted: blockArchived || blockInTrash,
      },
      raw: recordValue(rawBlock),
      createdTime: parseDate(rawBlock.created_time),
      lastEditedTime: parseDate(rawBlock.last_edited_time),
      createdBy: rawBlock.created_by ?? null,
      lastEditedBy: rawBlock.last_edited_by ?? null,
    });
  }
  input.blockSnapshots.push({
    notionApiVersion: NOTION_VERSION,
    blockId: input.node.id,
    pageId: input.pageId,
    parentType: parent.parentType,
    parentId: parent.parentId ?? input.node.parentId,
    blockType: input.node.type,
    hasChildren: input.node.hasChildren,
    archived: blockArchived,
    inTrash: blockInTrash,
    plainText: rendered.plainText,
    markdown: rendered.markdown,
    contentHash: rendered.contentHash,
    childrenHash: rendered.childrenHash,
    tableCellRichText: rendered.tableCellRichText,
    raw: recordValue(rawBlock),
    createdTime: parseDate(rawBlock.created_time),
    lastEditedTime: parseDate(rawBlock.last_edited_time),
    createdBy: rawBlock.created_by ?? null,
    lastEditedBy: rawBlock.last_edited_by ?? null,
  });

  pushObjectEdge(input.edges, input.seenEdges, {
    parentObjectId: parent.parentId ?? input.pageId,
    childObjectId: input.node.id,
    relationType: "contains",
    position: input.position,
    sourceObjectId: input.containerPageId,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      parentType: parent.parentType,
      blockType: input.node.type,
      pageId: input.pageId,
      depth: input.node.depth,
      order: input.node.order,
      layoutRole: blockLayoutRole(input.node),
    },
    childHash: rendered.contentHash,
  });
  collectReferenceEdges(input.node.id, input.containerPageId, input.node.references, "block", input.edges, input.seenEdges);

  for (const source of input.node.inlineDataSources ?? []) {
    pushObjectEdge(input.edges, input.seenEdges, {
      parentObjectId: input.node.id,
      childObjectId: source.dataSourceId,
      relationType: "data_source",
      position: 0,
      sourceObjectId: input.containerPageId,
      metadata: {
        title: source.title,
        columns: source.columns,
        rowCount: source.rowCount,
        rowCapReached: source.rowCapReached,
        queryComplete: source.queryComplete,
        queryHasMore: source.queryHasMore,
        queryNextCursor: source.queryNextCursor,
        queryRequestStatus: source.queryRequestStatus,
        queryIncompleteReason: source.queryIncompleteReason,
        rowPageIds: source.rows.map((row) => row.pageId),
        nestedDataSourceIds: source.nestedDataSources.map((nested) => nested.dataSourceId),
        nestedDataSources: source.nestedDataSources.map((nested) => ({
          dataSourceId: nested.dataSourceId,
          title: nested.title,
          url: nested.url,
          materialized: Boolean(nested.materializedDataSource),
          rowPageIds: nested.materializedDataSource?.rows.map((row) => row.pageId) ?? [],
          rowCount: nested.materializedDataSource?.rowCount ?? null,
          columns: nested.materializedDataSource?.columns ?? [],
          queryComplete: nested.materializedDataSource?.queryComplete ?? null,
          queryHasMore: nested.materializedDataSource?.queryHasMore ?? null,
          queryIncompleteReason: nested.materializedDataSource?.queryIncompleteReason ?? null,
          nestedDataSourceIds: nested.materializedDataSource?.nestedDataSources.map((child) => child.dataSourceId) ?? [],
        })),
      },
      childHash: hashStable({
        dataSourceId: source.dataSourceId,
        rowCount: source.rowCount,
        columns: source.columns,
        queryComplete: source.queryComplete,
        queryIncompleteReason: source.queryIncompleteReason,
        nestedDataSourceIds: source.nestedDataSources.map((nested) => nested.dataSourceId),
        nestedDataSources: source.nestedDataSources.map((nested) => ({
          dataSourceId: nested.dataSourceId,
          rowPageIds: nested.materializedDataSource?.rows.map((row) => row.pageId) ?? [],
          queryComplete: nested.materializedDataSource?.queryComplete ?? null,
          queryIncompleteReason: nested.materializedDataSource?.queryIncompleteReason ?? null,
        })),
      }),
    });
  }

  for (const [index, child] of input.node.children.entries()) {
    collectBlockNode({ ...input, node: child, position: index });
  }
}

function materializedChildPageObject(node: NotionBlockNode): boolean {
  return node.type === "child_page" && node.childPage?.pageId === node.id;
}

function nativeBlockParentInfo(node: NotionBlockNode, rawBlock: NotionBlock): { parentType: string | null; parentId: string | null } {
  if (isSyncedSourceChild(node) && node.parentId) {
    return { parentType: "block_id", parentId: node.parentId };
  }
  const parent = notionParentInfo(rawBlock.parent);
  return { parentType: parent.parentType, parentId: parent.parentId ?? node.parentId };
}

function isSyncedSourceChild(node: NotionBlockNode): boolean {
  return node.references.some((reference) =>
    reference.kind === "synced_block" && reference.title === "synced_source_child");
}

export function renderNotionBlock(block: NotionBlockNode): NotionRenderedBlock {
  const markdown = (block.markdown || block.text || "").trim();
  const plainText = block.text.trim();
  const childBlockIds = block.children.map((child) => child.id);
  const title = plainText.slice(0, 200) || `${block.type} ${block.id}`;
  const tableCellRichText = tableCellRichTextForBlock(block);
  return {
    blockId: block.id,
    blockType: block.type,
    title,
    plainText,
    markdown,
    contentHash: hashContent(JSON.stringify({
      id: block.id,
      type: block.type,
      text: block.text,
      markdown,
      richText: block.richText,
      captionRichText: block.captionRichText,
      titleRichText: block.titleRichText,
      checked: block.checked,
      color: block.color,
      isToggleable: block.isToggleable,
      widthRatio: block.widthRatio,
      tableWidth: block.tableWidth,
      hasColumnHeader: block.hasColumnHeader,
      hasRowHeader: block.hasRowHeader,
      tableCells: block.tableCells,
      tableCellRichText,
      url: block.url,
      references: block.references.map((reference) => ({
        kind: reference.kind,
        pageId: reference.pageId,
        propertyId: reference.propertyId,
        propertyName: reference.propertyName,
        mentionType: reference.mentionType,
        targetObjectType: reference.targetObjectType,
        targetPartial: reference.targetPartial,
        targetId: reference.targetId,
        title: reference.title,
        url: reference.url,
      })),
      warnings: block.warnings.map((warning) => warning.code),
      childBlockIds,
      inlineDataSources: block.inlineDataSources?.map((source) => ({
        dataSourceId: source.dataSourceId,
        columns: source.columns,
        view: source.view
          ? {
            viewId: source.view.viewId,
            name: source.view.name,
            viewType: source.view.viewType,
            columns: source.view.columns,
            resultPageIds: source.view.resultPageIds,
            resultCount: source.view.resultCount,
            totalCount: source.view.totalCount,
            hasMore: source.view.hasMore,
            nextCursor: source.view.nextCursor,
            requestStatus: source.view.requestStatus,
            complete: source.view.complete,
          }
          : null,
        rowIds: source.rows.map((row) => row.pageId),
        rowCount: source.rowCount,
        rowCapReached: source.rowCapReached,
        queryComplete: source.queryComplete,
        queryHasMore: source.queryHasMore,
        queryNextCursor: source.queryNextCursor,
        queryIncompleteReason: source.queryIncompleteReason,
        nestedDataSourceIds: source.nestedDataSources.map((nested) => nested.dataSourceId),
        nestedDataSources: source.nestedDataSources.map((nested) => ({
          dataSourceId: nested.dataSourceId,
          title: nested.title,
          materialized: Boolean(nested.materializedDataSource),
          rowIds: nested.materializedDataSource?.rows.map((row) => row.pageId) ?? [],
          rowCount: nested.materializedDataSource?.rowCount ?? null,
          columns: nested.materializedDataSource?.columns ?? [],
          queryComplete: nested.materializedDataSource?.queryComplete ?? null,
        })),
      })),
      childPage: block.childPage
        ? {
          pageId: block.childPage.pageId,
          title: block.childPage.title,
          url: block.childPage.url,
          parentBlockId: block.childPage.parentBlockId,
          relativePath: block.childPage.relativePath,
          bodyBlockIds: block.childPage.bodyBlocks.map((child) => child.id),
          nestedChildPageIds: block.childPage.childPages.map((childPage) => childPage.pageId),
          nestedChildPageCount: block.childPage.childPages.length,
          bodyMarkdown: block.childPage.bodyMarkdown,
        }
        : null,
    })),
    childrenHash: hashStable(childBlockIds),
    childBlockIds,
    hasChildren: block.hasChildren,
    richText: block.richText,
    captionRichText: block.captionRichText,
    titleRichText: block.titleRichText,
    tableCellRichText,
  };
}

function tableCellRichTextForBlock(block: NotionBlockNode): NotionRichTextSpanSummary[][] | undefined {
  if (block.tableCellRichText) return block.tableCellRichText;
  if (block.type !== "table_row") return undefined;
  const rawValue = recordValue(recordValue(block.rawBlock)[block.type]);
  const cells = arrayValue(rawValue.cells);
  return cells.length > 0 ? cells.map((cell) => summarizeNotionRichText(arrayValue(cell))) : undefined;
}

function notionDataSourceSnapshot(source: NotionDataSource): NotionDataSourceSnapshot {
  const parent = notionParentInfo(source.parent ?? source.database_parent);
  const databaseParent = notionParentInfo(source.database_parent);
  const databaseId = databaseIdFromDataSource(source);
  const properties = source.properties ?? {};
  return {
    notionApiVersion: NOTION_VERSION,
    dataSourceId: source.id,
    databaseId,
    title: extractNotionTitle(source),
    description: source.description ?? [],
    url: source.url ?? null,
    publicUrl: source.public_url ?? null,
    parent: source.parent ?? null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    databaseParent: source.database_parent ?? null,
    databaseParentType: databaseParent.parentType,
    databaseParentId: databaseParent.parentId,
    isInline: Boolean(source.is_inline),
    archived: Boolean(source.archived ?? source.in_trash),
    inTrash: Boolean(source.in_trash ?? source.archived),
    icon: source.icon ?? null,
    cover: source.cover ?? null,
    properties,
    propertyHash: hashStable(properties),
    raw: recordValue(source),
    createdTime: parseDate(source.created_time),
    lastEditedTime: parseDate(source.last_edited_time),
    createdBy: source.created_by ?? null,
    lastEditedBy: source.last_edited_by ?? null,
  };
}

function notionDatabaseSnapshot(database: NotionDatabase): NotionDatabaseSnapshot {
  const parent = notionParentInfo(database.parent);
  return {
    notionApiVersion: NOTION_VERSION,
    databaseId: database.id,
    title: extractNotionTitle(database),
    description: database.description ?? [],
    url: database.url ?? null,
    publicUrl: database.public_url ?? null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    isInline: Boolean(database.is_inline),
    isLocked: Boolean(database.is_locked),
    inTrash: Boolean(database.in_trash),
    icon: database.icon ?? null,
    cover: database.cover ?? null,
    properties: database.properties ?? {},
    dataSources: database.data_sources ?? [],
    raw: recordValue(database),
    createdTime: parseDate(database.created_time),
    lastEditedTime: parseDate(database.last_edited_time),
    createdBy: database.created_by ?? null,
    lastEditedBy: database.last_edited_by ?? null,
  };
}

function notionViewSnapshot(view: NotionView, query: NotionViewQuerySnapshot | null = null): NotionViewSnapshot {
  const parent = notionParentInfo(view.parent);
  return {
    notionApiVersion: NOTION_VERSION,
    viewId: view.id,
    databaseId: stringValue(view.database_id) ?? databaseIdFromParent(view.parent),
    dataSourceId: stringValue(view.data_source_id),
    name: view.name ?? "",
    viewType: view.type ?? "",
    url: stringValue(view.url),
    parentType: parent.parentType,
    parentId: parent.parentId,
    dashboardViewId: stringValue(view.dashboard_view_id),
    filter: view.filter ?? null,
    sorts: view.sorts ?? [],
    quickFilters: view.quick_filters ?? null,
    configuration: view.configuration ?? {},
    query,
    raw: recordValue(view),
    createdTime: parseDate(view.created_time),
    lastEditedTime: parseDate(view.last_edited_time),
    createdBy: view.created_by ?? null,
    lastEditedBy: view.last_edited_by ?? null,
  };
}

function notionDataSourceTemplateSnapshot(
  dataSourceId: string,
  template: NotionDataSourceTemplate,
): NotionDataSourceTemplateSnapshot {
  return {
    notionApiVersion: NOTION_VERSION,
    templateId: template.id,
    dataSourceId,
    name: template.name ?? "",
    isDefault: Boolean(template.is_default),
    page: null,
    pageHydrationStatus: "skipped",
    pageHydrationError: null,
    raw: recordValue(template),
  };
}

function notionDataSourceTemplatePageSnapshot(pageContent: NotionPageContent): NotionDataSourceTemplatePageSnapshot {
  const page = recordValue(pageContent.rawPage);
  const bodyMarkdown = pageContent.markdown;
  const bodyPreview = markdownPreview(bodyMarkdown, NATIVE_TEMPLATE_BODY_PREVIEW_MAX);
  const flatBlocks = flattenBlockNodes(pageContent.blockTree);
  const bodyBlockIds = flatBlocks.map((block) => block.id);
  const bodyBlockTypes = flatBlocks.map((block) => block.type);
  return {
    notionApiVersion: NOTION_VERSION,
    pageId: pageContent.pageId,
    title: pageContent.title,
    url: pageContent.url,
    parentType: pageContent.parentType,
    parentId: pageContent.parentId,
    dataSourceId: pageContent.dataSourceId,
    structuredIngestion: pageContent.structuredIngestion,
    markdownTruncated: pageContent.markdownTruncated,
    propertyValues: compactPropertyValues(pageContent.propertyValues),
    bodyMarkdown,
    bodyMarkdownPreview: bodyPreview.preview,
    bodyMarkdownPreviewTruncated: bodyPreview.truncated,
    bodyBlockCount: flatBlocks.length,
    bodyBlockIds,
    bodyBlockTypes,
    bodyBlockOutline: bodyBlockOutline(bodyBlockIds, bodyBlockTypes),
    rowPageCount: pageContent.rowPages.length,
    childPageCount: pageContent.childPages.length,
    commentCount: pageContent.comments.length,
    referenceCount: pageContent.references.length,
    references: pageContent.references,
    warningCodes: pageContent.warnings.map((warning) => warning.code),
    createdTime: stringValue(page.created_time),
    lastEditedTime: pageContent.lastEditedTime?.toISOString() ?? stringValue(page.last_edited_time),
    createdBy: page.created_by ?? null,
    lastEditedBy: page.last_edited_by ?? null,
    raw: page,
  };
}

function notionDataSourceTemplateCollectionSnapshot(
  dataSourceId: string,
  collection: NotionDataSourceTemplateCollection,
): NotionDataSourceTemplateCollectionSnapshot {
  return {
    notionApiVersion: NOTION_VERSION,
    dataSourceId,
    templateCount: collection.templates.length,
    complete: collection.complete,
    hasMore: collection.hasMore,
    nextCursor: collection.nextCursor,
    truncated: collection.truncated,
    maxTemplates: collection.maxTemplates,
  };
}

function notionCommentSnapshot(comment: NotionComment, fallbackPageId: string, summary?: NotionCommentSummary): NotionCommentSnapshot {
  const parent = notionParentInfo(comment.parent);
  const richText = comment.rich_text ?? [];
  const displayName = recordValue(comment.display_name);
  return {
    notionApiVersion: NOTION_VERSION,
    commentId: comment.id,
    pageId: parent.parentType === "page_id" ? parent.parentId : fallbackPageId,
    blockId: parent.parentType === "block_id" ? parent.parentId : null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    discussionId: comment.discussion_id ?? null,
    plainText: notionRichTextPlain(richText).trim(),
    richText,
    richTextSummary: summarizeNotionRichText(richText),
    references: richTextMentionReferences(richText).map((reference) => ({ ...reference, commentId: comment.id })),
    displayName: Object.keys(displayName).length > 0
      ? {
        type: stringValue(displayName.type),
        resolvedName: stringValue(displayName.resolved_name),
      }
      : null,
    attachments: arrayValue(comment.attachments).map(commentAttachmentSummary),
    retrievalRequestStatus: summary?.retrievalRequestStatus ?? null,
    retrievalComplete: summary?.retrievalComplete ?? null,
    retrievalHasMore: summary?.retrievalHasMore ?? null,
    retrievalNextCursor: summary?.retrievalNextCursor ?? null,
    raw: recordValue(comment),
    createdTime: parseDate(comment.created_time),
    lastEditedTime: parseDate(comment.last_edited_time),
    createdBy: comment.created_by ?? null,
  };
}

function commentSummaryMap(pageContent: NotionPageContent): Map<string, NotionCommentSummary> {
  const summaries = new Map<string, NotionCommentSummary>();
  const seenChildPageIds = new Set<string>();
  const collectComments = (comments: NotionCommentSummary[]) => {
    for (const comment of comments) summaries.set(comment.commentId, comment);
  };
  const collectBlocks = (blocks: NotionBlockNode[]) => {
    for (const block of flattenBlockNodes(blocks)) collectComments(block.comments);
  };
  const collectChildPages = (childPages: NotionChildPage[]) => {
    for (const childPage of childPages) {
      if (seenChildPageIds.has(childPage.pageId)) continue;
      seenChildPageIds.add(childPage.pageId);
      collectComments(childPage.comments);
      collectBlocks(childPage.bodyBlocks);
      collectChildPages(childPage.childPages);
    }
  };

  collectComments(pageContent.comments);
  collectBlocks(pageContent.blockTree);
  for (const rowPage of pageContent.rowPages) {
    collectComments(rowPage.comments);
    collectBlocks(rowPage.bodyBlocks);
  }
  collectChildPages(pageContent.childPages);
  return summaries;
}

function dataSourceObject(
  source: NotionDataSourceSnapshot,
  templates: NotionDataSourceTemplateSnapshot[] = [],
  templateCollection: NotionDataSourceTemplateCollectionSnapshot | null = null,
): NotionObjectSnapshot {
  return {
    objectId: source.dataSourceId,
    objectType: "data_source",
    title: source.title,
    url: source.url,
    parentType: source.parentType,
    parentId: source.parentId,
    dataSourceId: source.dataSourceId,
    databaseId: source.databaseId,
    blockType: null,
    hasChildren: true,
    archived: source.archived,
    inTrash: source.inTrash,
    plainText: source.title,
    objectHash: hashStable(source.raw),
    properties: source.properties,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      objectType: "data_source",
      publicUrl: source.publicUrl,
      parent: source.parent,
      databaseParent: source.databaseParent,
      databaseParentType: source.databaseParentType,
      databaseParentId: source.databaseParentId,
      isInline: source.isInline,
      archived: source.archived,
      inTrash: source.inTrash,
      description: summarizeNotionRichText(source.description),
      descriptionPlainText: notionRichTextPlain(source.description).trim(),
      icon: iconSummary(source.icon),
      cover: mediaSummary(recordValue(source.cover)),
      propertySchema: notionPropertySchemaSummary(source.properties),
      templates: templates.map(templateSummary),
      templateCount: templates.length,
      templateCollectionComplete: templateCollection?.complete ?? null,
      templateHasMore: templateCollection?.hasMore ?? null,
      templateNextCursor: templateCollection?.nextCursor ?? null,
      templateTruncated: templateCollection?.truncated ?? null,
      templateMaxTemplates: templateCollection?.maxTemplates ?? null,
      defaultTemplateId: templates.find((template) => template.isDefault)?.templateId ?? null,
    },
    raw: source.raw,
    createdTime: source.createdTime,
    lastEditedTime: source.lastEditedTime,
    createdBy: source.createdBy,
    lastEditedBy: source.lastEditedBy,
  };
}

function templateObject(template: NotionDataSourceTemplateSnapshot): NotionObjectSnapshot {
  const page = template.page;
  const pageHydrationStatus = template.pageHydrationStatus ?? "skipped";
  const pageHydrationError = template.pageHydrationError ?? null;
  const bodyPreview = templateBodyPreview(page);
  return {
    objectId: templateObjectId(template),
    objectType: "data_source_template",
    title: page?.title ?? template.name,
    url: page?.url ?? null,
    parentType: "data_source_id",
    parentId: template.dataSourceId,
    dataSourceId: template.dataSourceId,
    databaseId: null,
    blockType: null,
    hasChildren: (page?.bodyBlockCount ?? 0) > 0,
    archived: false,
    inTrash: false,
    plainText: page?.title ?? template.name,
    objectHash: hashStable({ template: template.raw, page }),
    properties: {
      templateId: template.templateId,
      name: template.name,
      isDefault: template.isDefault,
      page: page ? templatePageObjectSummary(page) : null,
      pageHydrationStatus,
      pageHydrationError,
    },
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      objectType: "data_source_template",
      templateId: template.templateId,
      dataSourceId: template.dataSourceId,
      isDefault: template.isDefault,
      pageId: page?.pageId ?? null,
      pageHydrated: pageHydrationStatus === "hydrated",
      pageHydrationStatus,
      pageHydrationError,
      bodyBlockCount: page?.bodyBlockCount ?? 0,
      bodyBlockTypes: page?.bodyBlockTypes ?? [],
      bodyMarkdownPreview: bodyPreview.preview,
      bodyMarkdownPreviewTruncated: bodyPreview.truncated,
      bodyBlockOutline: templateBodyBlockOutline(page),
      rowPageCount: page?.rowPageCount ?? 0,
      childPageCount: page?.childPageCount ?? 0,
      commentCount: page?.commentCount ?? 0,
      referenceCount: page?.referenceCount ?? 0,
      warningCodes: page?.warningCodes ?? [],
    },
    raw: template.raw,
    createdTime: parseDate(page?.createdTime ?? undefined),
    lastEditedTime: parseDate(page?.lastEditedTime ?? undefined),
    createdBy: page?.createdBy ?? null,
    lastEditedBy: page?.lastEditedBy ?? null,
  };
}

function templateObjectId(template: NotionDataSourceTemplateSnapshot): string {
  return `notion-template:${template.dataSourceId}:${template.templateId}`;
}

function templatePageObjectSummary(page: NotionDataSourceTemplatePageSnapshot): Record<string, unknown> {
  const bodyPreview = templateBodyPreview(page);
  return {
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    parentType: page.parentType,
    parentId: page.parentId,
    dataSourceId: page.dataSourceId,
    structuredIngestion: page.structuredIngestion,
    markdownTruncated: page.markdownTruncated,
    propertyValues: page.propertyValues,
    bodyMarkdown: page.bodyMarkdown,
    bodyMarkdownPreview: bodyPreview.preview,
    bodyMarkdownPreviewTruncated: bodyPreview.truncated,
    bodyBlockCount: page.bodyBlockCount,
    bodyBlockIds: page.bodyBlockIds,
    bodyBlockTypes: page.bodyBlockTypes,
    bodyBlockOutline: templateBodyBlockOutline(page),
    rowPageCount: page.rowPageCount,
    childPageCount: page.childPageCount,
    commentCount: page.commentCount,
    referenceCount: page.referenceCount,
    references: page.references,
    warningCodes: page.warningCodes,
    createdTime: page.createdTime,
    lastEditedTime: page.lastEditedTime,
    createdBy: page.createdBy,
    lastEditedBy: page.lastEditedBy,
  };
}

function templateSummary(template: NotionDataSourceTemplateSnapshot): Record<string, unknown> {
  const pageHydrationStatus = template.pageHydrationStatus ?? "skipped";
  const bodyPreview = templateBodyPreview(template.page);
  return {
    templateId: template.templateId,
    name: template.name,
    isDefault: template.isDefault,
    pageId: template.page?.pageId ?? null,
    pageTitle: template.page?.title ?? null,
    pageHydrationStatus,
    pageHydrationError: template.pageHydrationError ?? null,
    bodyBlockCount: template.page?.bodyBlockCount ?? 0,
    bodyBlockTypes: template.page?.bodyBlockTypes ?? [],
    bodyMarkdownPreview: bodyPreview.preview,
    bodyMarkdownPreviewTruncated: bodyPreview.truncated,
    bodyBlockOutline: templateBodyBlockOutline(template.page),
    rowPageCount: template.page?.rowPageCount ?? 0,
    childPageCount: template.page?.childPageCount ?? 0,
    commentCount: template.page?.commentCount ?? 0,
    referenceCount: template.page?.referenceCount ?? 0,
    warningCodes: template.page?.warningCodes ?? [],
  };
}

function templateBodyPreview(page: NotionDataSourceTemplatePageSnapshot | null | undefined): {
  preview: string | null;
  truncated: boolean;
} {
  if (page) return { preview: page.bodyMarkdownPreview, truncated: page.bodyMarkdownPreviewTruncated };
  return { preview: null, truncated: false };
}

function templateBodyBlockOutline(page: NotionDataSourceTemplatePageSnapshot | null | undefined): Array<Record<string, unknown>> {
  return page?.bodyBlockOutline ?? [];
}

function markdownPreview(markdown: string, maxLength: number): { preview: string | null; truncated: boolean } {
  const body = markdown.trim();
  if (!body) return { preview: null, truncated: false };
  if (body.length <= maxLength) return { preview: body, truncated: false };
  return {
    preview: `${body.slice(0, maxLength).trimEnd()}...`,
    truncated: true,
  };
}

function bodyBlockOutline(bodyBlockIds: string[], bodyBlockTypes: string[]): Array<Record<string, unknown>> {
  return bodyBlockIds.slice(0, NATIVE_TEMPLATE_BLOCK_OUTLINE_MAX).map((blockId, index) => ({
    index,
    blockId,
    blockType: bodyBlockTypes[index] ?? null,
  }));
}

function databaseObject(database: NotionDatabaseSnapshot): NotionObjectSnapshot {
  return {
    objectId: database.databaseId,
    objectType: "database",
    title: database.title,
    url: database.url,
    parentType: database.parentType,
    parentId: database.parentId,
    dataSourceId: null,
    databaseId: database.databaseId,
    blockType: null,
    hasChildren: database.dataSources.length > 0,
    archived: false,
    inTrash: database.inTrash,
    plainText: database.title,
    objectHash: hashStable(database.raw),
    properties: database.properties,
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      publicUrl: database.publicUrl,
      isInline: database.isInline,
      isLocked: database.isLocked,
      description: summarizeNotionRichText(database.description),
      descriptionPlainText: notionRichTextPlain(database.description).trim(),
      icon: iconSummary(database.icon),
      cover: mediaSummary(recordValue(database.cover)),
      dataSources: database.dataSources,
      propertySchema: notionPropertySchemaSummary(database.properties),
    },
    raw: database.raw,
    createdTime: database.createdTime,
    lastEditedTime: database.lastEditedTime,
    createdBy: database.createdBy,
    lastEditedBy: database.lastEditedBy,
  };
}

function viewObject(view: NotionViewSnapshot): NotionObjectSnapshot {
  const configuration = notionViewConfigurationSummary(view.viewType, view.configuration);
  const propertyNamesById = viewConfigurationPropertyNamesById(configuration);
  const filterSummary = viewFilterSummary(view.filter, propertyNamesById);
  const sortsSummary = viewSortsSummary(view.sorts, propertyNamesById);
  const quickFiltersSummary = viewQuickFiltersSummary(view.quickFilters, configuration);
  return {
    objectId: view.viewId,
    objectType: "view",
    title: view.name,
    url: view.url,
    parentType: view.parentType ?? (view.dataSourceId ? "data_source_id" : view.databaseId ? "database_id" : null),
    parentId: view.parentId ?? view.dataSourceId ?? view.databaseId,
    dataSourceId: view.dataSourceId,
    databaseId: view.databaseId,
    blockType: null,
    hasChildren: false,
    archived: false,
    inTrash: false,
    plainText: view.name,
    objectHash: hashStable(view.raw),
    properties: {
      filter: view.filter,
      filterSummary,
      sorts: view.sorts,
      sortsSummary,
      quickFilters: view.quickFilters,
      quickFiltersSummary,
      configuration,
      dashboardViewId: view.dashboardViewId,
      query: view.query ? viewQueryMetadata(view.query) : null,
    },
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      viewType: view.viewType,
      parentType: view.parentType,
      parentId: view.parentId,
      dashboardViewId: view.dashboardViewId,
      filterSummary,
      sortsSummary,
      quickFiltersSummary,
      configuration,
      query: view.query ? viewQueryMetadata(view.query) : null,
    },
    raw: view.raw,
    createdTime: view.createdTime,
    lastEditedTime: view.lastEditedTime,
    createdBy: view.createdBy,
    lastEditedBy: view.lastEditedBy,
  };
}

function viewQueryMetadata(query: NotionViewQuerySnapshot): Record<string, unknown> {
  return {
    notionApiVersion: query.notionApiVersion,
    queryId: query.queryId,
    resultPageIds: query.resultPageIds,
    resultCount: query.resultPageIds.length,
    totalCount: query.totalCount,
    hasMore: query.hasMore,
    nextCursor: query.nextCursor,
    requestStatus: query.requestStatus,
    expiresAt: query.expiresAt,
    fetchedAt: query.fetchedAt,
    pageSize: query.pageSize,
    complete: query.complete,
  };
}

function viewEdgeMetadata(view: NotionViewSnapshot): Record<string, unknown> {
  const configuration = notionViewConfigurationSummary(view.viewType, view.configuration);
  const propertyNamesById = viewConfigurationPropertyNamesById(configuration);
  return {
    ...NOTION_API_VERSION_METADATA,
    viewType: view.viewType,
    viewName: view.name,
    parentType: view.parentType,
    parentId: view.parentId,
    dataSourceId: view.dataSourceId,
    databaseId: view.databaseId,
    dashboardViewId: view.dashboardViewId,
    filterSummary: viewFilterSummary(view.filter, propertyNamesById),
    sortsSummary: viewSortsSummary(view.sorts, propertyNamesById),
    quickFiltersSummary: viewQuickFiltersSummary(view.quickFilters, configuration),
    configuration,
    query: view.query ? viewQueryMetadata(view.query) : null,
  };
}

function notionViewConfigurationSummary(viewType: string, configuration: unknown): Record<string, unknown> {
  const config = recordValue(configuration);
  const propertyNamesById = rawViewConfigurationPropertyNamesById(config);
  return {
    type: stringValue(config.type) ?? viewType,
    visibleProperties: viewPropertyConfigSummary(config.properties),
    groupBy: groupBySummary(config.group_by, propertyNamesById),
    subGroupBy: groupBySummary(config.sub_group_by, propertyNamesById),
    cover: coverSummary(config.cover, propertyNamesById),
    coverSize: stringValue(config.cover_size),
    coverAspect: stringValue(config.cover_aspect),
    cardLayout: stringValue(config.card_layout),
    table: {
      wrapCells: booleanOrNull(config.wrap_cells),
      frozenColumnIndex: numberOrNull(config.frozen_column_index),
      showVerticalLines: booleanOrNull(config.show_vertical_lines),
      subtasks: subtaskConfigSummary(config.subtasks),
    },
    calendar: {
      datePropertyId: stringValue(config.date_property_id),
      datePropertyName: stringValue(config.date_property_name)
        ?? propertyNameFromId(config.date_property_id, propertyNamesById),
      viewRange: stringValue(config.view_range),
      showWeekends: booleanOrNull(config.show_weekends),
    },
    timeline: {
      datePropertyId: stringValue(config.date_property_id),
      datePropertyName: stringValue(config.date_property_name)
        ?? propertyNameFromId(config.date_property_id, propertyNamesById),
      endDatePropertyId: stringValue(config.end_date_property_id),
      endDatePropertyName: stringValue(config.end_date_property_name)
        ?? propertyNameFromId(config.end_date_property_id, propertyNamesById),
      showTable: booleanOrNull(config.show_table),
      tableProperties: viewPropertyConfigSummary(config.table_properties),
      preference: timelinePreferenceSummary(config.preference),
      arrowsBy: timelineArrowsBySummary(config.arrows_by, propertyNamesById),
      colorBy: booleanOrNull(config.color_by),
    },
    chart: {
      chartType: stringValue(config.chart_type),
      xAxis: viewAxisSummary(config.x_axis, propertyNamesById),
      yAxis: viewAxisSummary(config.y_axis, propertyNamesById),
      xAxisPropertyId: stringValue(config.x_axis_property_id),
      xAxisPropertyName: propertyNameFromId(config.x_axis_property_id, propertyNamesById),
      yAxisPropertyId: stringValue(config.y_axis_property_id),
      yAxisPropertyName: propertyNameFromId(config.y_axis_property_id, propertyNamesById),
      value: chartAggregationSummary(config.value, propertyNamesById),
      sort: stringValue(config.sort),
      colorTheme: stringValue(config.color_theme),
      height: stringValue(config.height),
      legendPosition: stringValue(config.legend_position),
      stackBy: groupBySummary(config.stack_by, propertyNamesById),
      caption: stringValue(config.caption),
      axisLabels: stringOrBooleanOrNull(config.axis_labels),
      colorByValue: booleanOrNull(config.color_by_value),
      cumulative: booleanOrNull(config.cumulative),
      donutLabels: stringValue(config.donut_labels),
      gridLines: stringOrBooleanOrNull(config.grid_lines),
      groupStyle: stringValue(config.group_style),
      hideEmptyGroups: booleanOrNull(config.hide_empty_groups),
      hideLineFillArea: booleanOrNull(config.hide_line_fill_area),
      hideTitle: booleanOrNull(config.hide_title),
      referenceLines: chartReferenceLineSummaries(config.reference_lines),
      referenceLineCount: arrayValue(config.reference_lines).length,
      showDataLabels: booleanOrNull(config.show_data_labels),
      smoothLine: booleanOrNull(config.smooth_line),
      yAxisMax: numberOrNull(config.y_axis_max),
      yAxisMin: numberOrNull(config.y_axis_min),
    },
    form: {
      isFormClosed: booleanOrNull(config.is_form_closed),
      anonymousSubmissions: booleanOrNull(config.anonymous_submissions),
      submissionPermissions: stringValue(config.submission_permissions),
    },
    map: {
      height: stringValue(config.height),
      mapBy: stringValue(config.map_by),
      mapByPropertyName: stringValue(config.map_by_property_name)
        ?? propertyNameFromId(config.map_by, propertyNamesById),
      properties: viewPropertyConfigSummary(config.properties),
    },
    dashboard: {
      rows: dashboardRowsSummary(config.rows),
      rowCount: arrayValue(config.rows).length,
    },
  };
}

function commentObject(
  comment: NotionCommentSnapshot,
  containerPageId: string,
  discussion: CommentDiscussionPosition | undefined,
): NotionObjectSnapshot {
  return {
    objectId: comment.commentId,
    objectType: "comment",
    title: comment.plainText.slice(0, 200),
    url: null,
    parentType: comment.parentType,
    parentId: comment.parentId,
    dataSourceId: null,
    databaseId: null,
    blockType: null,
    hasChildren: false,
    archived: false,
    inTrash: false,
    plainText: comment.plainText,
    objectHash: hashStable(comment.raw),
    properties: {
      richText: comment.richTextSummary,
      references: comment.references,
      displayName: comment.displayName,
      attachments: comment.attachments,
      discussion: discussion ?? null,
      retrieval: commentRetrievalSnapshotMetadata(comment),
    },
    metadata: {
      ...NOTION_API_VERSION_METADATA,
      pageId: comment.pageId,
      containerPageId,
      blockId: comment.blockId,
      discussionId: comment.discussionId,
      discussionKey: discussion?.discussionKey ?? null,
      discussionCommentIndex: discussion?.index ?? null,
      discussionCommentCount: discussion?.count ?? null,
      discussionSynthetic: discussion?.synthetic ?? false,
      referenceCount: comment.references.length,
      displayName: comment.displayName,
      attachmentCount: comment.attachments.length,
      retrieval: commentRetrievalSnapshotMetadata(comment),
    },
    raw: comment.raw,
    createdTime: comment.createdTime,
    lastEditedTime: comment.lastEditedTime,
    createdBy: comment.createdBy,
    lastEditedBy: null,
  };
}

function commentRetrievalSnapshotMetadata(comment: NotionCommentSnapshot): Record<string, unknown> {
  return {
    source: "notion_comments_api",
    requestStatus: comment.retrievalRequestStatus,
    complete: comment.retrievalComplete,
    hasMore: comment.retrievalHasMore,
    nextCursor: comment.retrievalNextCursor,
  };
}

interface CommentDiscussionPosition {
  discussionId: string | null;
  discussionKey: string;
  synthetic: boolean;
  index: number;
  count: number;
  commentIds: string[];
}

function commentDiscussionIndexMap(comments: NotionCommentSnapshot[]): Map<string, CommentDiscussionPosition> {
  const groups = new Map<string, NotionCommentSnapshot[]>();
  for (const comment of comments) {
    const key = comment.discussionId ?? `comment:${comment.commentId}`;
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }

  const positions = new Map<string, CommentDiscussionPosition>();
  for (const [discussionKey, group] of groups.entries()) {
    const commentIds = group.map((comment) => comment.commentId);
    group.forEach((comment, index) => {
      positions.set(comment.commentId, {
        discussionId: comment.discussionId,
        discussionKey,
        synthetic: comment.discussionId == null,
        index,
        count: group.length,
        commentIds,
      });
    });
  }
  return positions;
}

function collectPropertyReferenceEdges(
  ownerObjectId: string,
  sourceObjectId: string,
  propertyValues: NotionPropertyValueSummary[],
  edges: NotionObjectEdgeSnapshot[],
  seenEdges: Set<string>,
): void {
  propertyValueReferences(propertyValues, { pageId: ownerObjectId }).forEach((reference, index) => {
    const targetId = stringValue(reference.targetId);
    if (!targetId) return;
    pushObjectEdge(edges, seenEdges, {
      parentObjectId: ownerObjectId,
      childObjectId: targetId,
      relationType: propertyReferenceRelationType(reference.kind),
      position: index,
      sourceObjectId,
      metadata: {
        ...NOTION_API_VERSION_METADATA,
        kind: reference.kind,
        propertyId: reference.propertyId ?? null,
        propertyName: reference.propertyName ?? null,
        targetObjectType: reference.targetObjectType ?? null,
        targetPartial: reference.targetPartial ?? null,
        mentionType: reference.mentionType ?? null,
        title: reference.title ?? null,
        url: reference.url ?? null,
        date: reference.date ?? null,
        linkPreview: reference.linkPreview ?? null,
        linkMention: reference.linkMention ?? null,
        templateMention: reference.templateMention ?? null,
        customEmoji: reference.customEmoji ?? null,
      },
      childHash: null,
    });
  });
}

function propertyReferenceRelationType(kind: string): string {
  if (kind === "property_relation") return "property_relation";
  if (kind === "property_user") return "property_user";
  if (kind === "mention") return "property_mention";
  return "property_reference";
}

function collectReferenceEdges(
  ownerObjectId: string,
  sourceObjectId: string,
  references: NotionReference[],
  origin: "block" | "comment" | "template",
  edges: NotionObjectEdgeSnapshot[],
  seenEdges: Set<string>,
): void {
  references.forEach((reference, index) => {
    const targetId = stringValue(reference.targetId);
    if (!targetId) return;
    pushObjectEdge(edges, seenEdges, {
      parentObjectId: ownerObjectId,
      childObjectId: targetId,
      relationType: referenceRelationType(origin, reference.kind),
      position: index,
      sourceObjectId,
      metadata: {
        ...NOTION_API_VERSION_METADATA,
        kind: reference.kind,
        origin,
        pageId: reference.pageId ?? null,
        blockId: reference.blockId ?? null,
        commentId: reference.commentId ?? null,
        propertyId: reference.propertyId ?? null,
        propertyName: reference.propertyName ?? null,
        targetObjectType: reference.targetObjectType ?? null,
        targetPartial: reference.targetPartial ?? null,
        mentionType: reference.mentionType ?? null,
        title: reference.title ?? null,
        url: reference.url ?? null,
        date: reference.date ?? null,
        linkPreview: reference.linkPreview ?? null,
        linkMention: reference.linkMention ?? null,
        templateMention: reference.templateMention ?? null,
        customEmoji: reference.customEmoji ?? null,
      },
      childHash: null,
    });
  });
}

function referenceRelationType(origin: "block" | "comment" | "template", kind: string): string {
  if (origin === "comment") {
    return kind === "mention" ? "comment_mention" : "comment_reference";
  }
  if (origin === "template") {
    return kind === "mention" ? "template_mention" : "template_reference";
  }
  if (kind === "mention") return "block_mention";
  if (kind === "linked_page") return "block_linked_page";
  if (kind === "linked_database") return "block_linked_database";
  if (kind === "linked_comment") return "block_linked_comment";
  if (kind === "synced_block") return "synced_block_reference";
  if (kind === "child_database") return "child_database_reference";
  if (kind === "database_row_page") return "block_database_row_page";
  return "block_reference";
}

function pushObjectEdge(edges: NotionObjectEdgeSnapshot[], seen: Set<string>, edge: NotionObjectEdgeSnapshot): void {
  const key = `${edge.parentObjectId}\0${edge.childObjectId}\0${edge.relationType}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    ...edge,
    metadata: {
      ...edge.metadata,
      ...NOTION_API_VERSION_METADATA,
    },
  });
}

function flattenBlockNodes(nodes: NotionBlockNode[]): NotionBlockNode[] {
  return nodes.flatMap((node) => [node, ...flattenBlockNodes(node.children)]);
}

function compactPropertyValues(values: NotionPropertyValueSummary[]): Array<Record<string, unknown>> {
  return values.map((value) => ({
    name: value.name,
    id: value.id,
    type: value.type,
    display: value.display,
    plainText: value.plainText,
    empty: value.empty,
    hydration: value.hydration,
    richText: value.richText,
    mentions: value.mentions,
    linkUrls: value.linkUrls,
    relationIds: value.relationIds,
    relationHasMore: value.relationHasMore,
    loadedRelationCount: value.loadedRelationCount,
    relationCount: value.relationCount,
    rollup: value.rollup,
    formula: value.formula,
    files: value.files,
    people: value.people,
    peopleGroups: value.peopleGroups,
    date: value.date,
    number: value.number,
    url: value.url,
    urlRedacted: value.urlRedacted,
    email: value.email,
    phoneNumber: value.phoneNumber,
    createdTime: value.createdTime,
    lastEditedTime: value.lastEditedTime,
    lastVisitedTime: value.lastVisitedTime,
    createdBy: value.createdBy,
    lastEditedBy: value.lastEditedBy,
    button: value.button,
    checked: value.checked,
    uniqueId: value.uniqueId,
    verification: value.verification,
    place: value.place,
    optionNames: value.optionNames,
    options: value.options,
    statusGroup: value.statusGroup,
  }));
}

function nativeTabPanes(node: NotionBlockNode): Array<Record<string, unknown>> {
  return node.children
    .filter((child) => child.type === "paragraph")
    .map((child) => ({
      paneBlockId: child.id,
      label: child.text || child.id,
      labelRichText: child.richText ?? [],
      icon: child.icon ?? null,
      contentChildBlockIds: child.children.map((grandchild) => grandchild.id),
      contentChildBlockTypes: child.children.map((grandchild) => grandchild.type),
      contentChildBlockCount: child.children.length,
    }));
}

function nativeMeetingNoteTabs(node: NotionBlockNode): Array<Record<string, unknown>> {
  const meeting = node.meetingNotes;
  if (!meeting) return [];
  const roleEntries = [
    ["summary", meeting.children.summaryBlockId],
    ["notes", meeting.children.notesBlockId],
    ["transcript", meeting.children.transcriptBlockId],
  ] as const;
  return roleEntries.map(([role, blockId]) => {
    const child = blockId ? findNativeBlockById(node.children, blockId) : null;
    return {
      role,
      blockId,
      resolved: Boolean(child),
      text: child?.text ?? null,
      markdown: child?.markdown ?? null,
      childBlockIds: child?.children.map((grandchild) => grandchild.id) ?? [],
      childBlockTypes: child?.children.map((grandchild) => grandchild.type) ?? [],
      childBlockCount: child?.children.length ?? 0,
    };
  });
}

function findNativeBlockById(blocks: NotionBlockNode[], blockId: string): NotionBlockNode | null {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const nested = findNativeBlockById(block.children, blockId);
    if (nested) return nested;
  }
  return null;
}

function blockLayoutMetadata(node: NotionBlockNode): Record<string, unknown> {
  const supportsChildren = notionBlockSupportsChildren(node.type, node.isToggleable);
  const childFetchExpected = supportsChildren && node.hasChildren === true;
  return {
    depth: node.depth,
    order: node.order,
    layoutRole: blockLayoutRole(node),
    color: node.color ?? null,
    isToggleable: node.isToggleable ?? false,
    listStartIndex: node.listStartIndex ?? null,
    listFormat: node.listFormat ?? null,
    widthRatio: node.widthRatio ?? null,
    tableWidth: node.tableWidth ?? null,
    hasColumnHeader: node.hasColumnHeader ?? false,
    hasRowHeader: node.hasRowHeader ?? false,
    supportsChildren,
    hasChildren: node.hasChildren,
    childFetchExpected,
    childSnapshotKnown: true,
    childCapabilitySatisfied: !childFetchExpected || node.children.length > 0,
    childBlockIds: node.children.map((child) => child.id),
    childBlockCount: node.children.length,
    referenceKinds: [...new Set(node.references.map((reference) => reference.kind))],
  };
}

function blockSemanticProperties(node: NotionBlockNode): Record<string, unknown> {
  const rawValue = recordValue(recordValue(node.rawBlock)[node.type]);
  const media = mediaBlockType(node.type) ? mediaSummary(rawValue) : null;
  const externalReference = externalReferenceBlockType(node.type) ? externalReferenceSummary(node, rawValue) : null;
  const linkTarget = linkToPageTarget(rawValue);
  const syncedBlock = syncedBlockSummary(rawValue);
  const childPageBlock = node.type === "child_page" ? childPageBlockSummary(node, rawValue) : null;
  const childDatabaseBlock = node.type === "child_database" ? childDatabaseBlockSummary(node, rawValue) : null;
  const supportsChildren = notionBlockSupportsChildren(node.type, node.isToggleable);
  const childFetchExpected = supportsChildren && node.hasChildren === true;
  return {
    blockType: node.type,
    checked: node.checked ?? null,
    color: node.color ?? null,
    listStartIndex: node.listStartIndex ?? null,
    listFormat: node.listFormat ?? null,
    text: node.text,
    markdown: node.markdown,
    supportsChildren,
    hasChildren: node.hasChildren,
    childFetchExpected,
    childSnapshotKnown: true,
    childCapabilitySatisfied: !childFetchExpected || node.children.length > 0,
    childBlockCount: node.children.length,
    meetingNotes: node.meetingNotes ?? null,
    richText: node.richText ?? summarizeNotionRichText(arrayValue(rawValue.rich_text)),
    captionRichText: node.captionRichText ?? summarizeNotionRichText(arrayValue(rawValue.caption)),
    titleRichText: node.titleRichText ?? summarizeNotionRichText(arrayValue(rawValue.title)),
    tableCellRichText: node.type === "table_row"
      ? node.tableCellRichText ?? arrayValue(rawValue.cells).map((cell) => summarizeNotionRichText(arrayValue(cell)))
      : [],
    icon: node.icon ?? iconSummary(rawValue.icon),
    media,
    externalReference,
    url: node.type === "code" ? null : blockUrlForNative(node),
    mediaUrlRedacted: Boolean(media?.urlRedacted),
    externalReferenceUrlRedacted: Boolean(externalReference?.urlRedacted),
    language: node.type === "code" ? node.language ?? stringValue(rawValue.language) : null,
    equation: node.type === "equation" ? node.text || stringValue(rawValue.expression) : null,
    tableCells: node.tableCells ?? [],
    tabPanes: node.type === "tab" ? nativeTabPanes(node) : [],
    meetingNoteTabs: node.type === "meeting_notes" || node.type === "transcription" ? nativeMeetingNoteTabs(node) : [],
    meetingNotesLegacyType: node.type === "transcription",
    commentCount: node.comments.length,
    comments: node.comments.map((comment) => ({
      commentId: comment.commentId,
      discussionId: comment.discussionId,
      text: comment.text,
      author: comment.author,
      displayName: comment.displayName ?? null,
      richText: comment.richText ?? [],
      references: comment.references ?? [],
      attachments: comment.attachments ?? [],
      createdTime: comment.createdTime,
      lastEditedTime: comment.lastEditedTime,
    })),
    references: node.references.map((reference) => ({
      kind: reference.kind,
      pageId: reference.pageId ?? null,
      blockId: reference.blockId ?? node.id,
      propertyId: reference.propertyId ?? null,
      propertyName: reference.propertyName ?? null,
      targetId: reference.targetId ?? null,
      targetObjectType: reference.targetObjectType ?? null,
      targetPartial: reference.targetPartial ?? false,
      mentionType: reference.mentionType ?? null,
      title: reference.title ?? null,
      url: reference.url ?? null,
      date: reference.date ?? null,
      linkPreview: reference.linkPreview ?? null,
      linkMention: reference.linkMention ?? null,
      templateMention: reference.templateMention ?? null,
      customEmoji: reference.customEmoji ?? null,
    })),
    inlineDataSources: (node.inlineDataSources ?? []).map((source) => ({
      dataSourceId: source.dataSourceId,
      title: source.title,
      columns: source.columns,
      rowPageIds: source.rows.map((row) => row.pageId),
      rowCount: source.rowCount,
      rowCapReached: source.rowCapReached,
      queryComplete: source.queryComplete,
      queryHasMore: source.queryHasMore,
      queryNextCursor: source.queryNextCursor,
      queryIncompleteReason: source.queryIncompleteReason,
      nestedDataSourceIds: source.nestedDataSources.map((nested) => nested.dataSourceId),
      nestedDataSources: source.nestedDataSources.map((nested) => ({
        dataSourceId: nested.dataSourceId,
        title: nested.title,
        materialized: Boolean(nested.materializedDataSource),
        rowPageIds: nested.materializedDataSource?.rows.map((row) => row.pageId) ?? [],
        rowCount: nested.materializedDataSource?.rowCount ?? null,
        columns: nested.materializedDataSource?.columns ?? [],
        queryComplete: nested.materializedDataSource?.queryComplete ?? null,
      })),
    })),
    childPage: node.childPage
      ? {
        pageId: node.childPage.pageId,
        title: node.childPage.title,
        url: node.childPage.url,
        parentBlockId: node.childPage.parentBlockId,
        relativePath: node.childPage.relativePath,
        bodyBlockIds: node.childPage.bodyBlocks.map((child) => child.id),
        nestedChildPageIds: node.childPage.childPages.map((childPage) => childPage.pageId),
        nestedChildPageCount: node.childPage.childPages.length,
      }
      : null,
    childPageBlock,
    childDatabaseBlock,
    syncedBlock,
    syncedBlockRole: syncedBlock?.role ?? null,
    syncedFromBlockId: syncedBlock?.syncedFromBlockId ?? null,
    linkTarget,
    linkedPageId: linkTarget?.type === "page_id" ? linkTarget.id : null,
    linkedDatabaseId: linkTarget?.type === "database_id" ? linkTarget.id : null,
    linkedCommentId: linkTarget?.type === "comment_id" ? linkTarget.id : null,
    unsupportedType: stringValue(rawValue.block_type),
  };
}

function childPageBlockSummary(node: NotionBlockNode, rawValue: Record<string, unknown>): Record<string, unknown> {
  return {
    blockId: node.id,
    pageId: node.childPage?.pageId ?? node.id,
    title: node.text,
    titleRichText: node.titleRichText ?? summarizeNotionRichText(arrayValue(rawValue.title)),
    url: blockUrlForNative(node) ?? node.childPage?.url ?? null,
    materialized: Boolean(node.childPage),
    relativePath: node.childPage?.relativePath ?? null,
    bodyBlockIds: node.childPage?.bodyBlocks.map((child) => child.id) ?? [],
    bodyBlockTypes: node.childPage?.bodyBlocks.map((child) => child.type) ?? [],
    nestedChildPageIds: node.childPage?.childPages.map((childPage) => childPage.pageId) ?? [],
  };
}

function childDatabaseBlockSummary(node: NotionBlockNode, rawValue: Record<string, unknown>): Record<string, unknown> {
  return {
    blockId: node.id,
    databaseId: node.id,
    title: node.text,
    titleRichText: node.titleRichText ?? summarizeNotionRichText(arrayValue(rawValue.title)),
    url: blockUrlForNative(node),
    inlineDataSourceIds: (node.inlineDataSources ?? []).map((source) => source.dataSourceId),
    inlineDataSourceCount: node.inlineDataSources?.length ?? 0,
    rowCount: (node.inlineDataSources ?? []).reduce((sum, source) => sum + source.rows.length, 0),
  };
}

function externalReferenceBlockType(type: string): boolean {
  return type === "bookmark" || type === "embed" || type === "link_preview";
}

function externalReferenceSummary(node: NotionBlockNode, rawValue: Record<string, unknown>): Record<string, unknown> {
  const url = stringValue(rawValue.url) ?? node.url ?? null;
  const captionRichText = node.captionRichText ?? summarizeNotionRichText(arrayValue(rawValue.caption));
  const caption = node.caption ?? (captionRichText.length > 0 ? node.text : "");
  const urlRedacted = Boolean(url && isMediaUrl(url));
  return {
    blockId: node.id,
    type: node.type,
    label: node.type === "bookmark" ? "Bookmark" : node.type === "embed" ? "Embed" : "Link preview",
    caption,
    captionRichText,
    url: url && !urlRedacted ? url : null,
    urlRedacted,
  };
}

function syncedBlockSummary(rawValue: Record<string, unknown>): { role: "original" | "copy"; syncedFromBlockId: string | null } | null {
  if (!Object.prototype.hasOwnProperty.call(rawValue, "synced_from")) return null;
  const syncedFrom = rawValue.synced_from;
  if (syncedFrom === null) return { role: "original", syncedFromBlockId: null };
  const blockId = stringValue(recordValue(syncedFrom).block_id);
  return { role: blockId ? "copy" : "original", syncedFromBlockId: blockId ?? null };
}

function linkToPageTarget(rawValue: Record<string, unknown>): { type: string; id: string } | null {
  const link = recordValue(rawValue.link_to_page ?? rawValue);
  const pageId = stringValue(link.page_id);
  const databaseId = stringValue(link.database_id);
  const commentId = stringValue(link.comment_id);
  if (pageId) return { type: "page_id", id: pageId };
  if (databaseId) return { type: "database_id", id: databaseId };
  if (commentId) return { type: "comment_id", id: commentId };
  return null;
}

function blockLayoutRole(node: NotionBlockNode): string {
  if (node.type === "column_list") return "column_group";
  if (node.type === "column") return "column";
  if (node.type === "table") return "table";
  if (node.type === "table_row") return "table_row";
  if (node.type === "child_database") return "database_container";
  if (node.type === "synced_block") return "synced_block";
  if (node.type === "tab") return "tab";
  if (node.type === "template") return "template";
  if (node.type === "to_do") return "task";
  if (node.type.endsWith("_list_item")) return "list_item";
  return "block";
}

function blockUrlForNative(node: NotionBlockNode): string | null {
  const rawValue = recordValue(recordValue(node.rawBlock)[node.type]);
  if (node.type === "bookmark" || node.type === "embed" || node.type === "link_preview") return stringValue(rawValue.url);
  if (node.type === "child_page" || node.type === "child_database") return stringValue(rawValue.url);
  return null;
}

function mediaBlockType(type: string): boolean {
  return (NOTION_MEDIA_BLOCK_TYPES as readonly string[]).includes(type);
}

function mediaSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.keys(value).length === 0) return null;
  const type = stringValue(value.type) ?? mediaPayloadType(value);
  const payload = type ? recordValue(value[type]) : {};
  const upload = recordValue(value.file_upload);
  const file = recordValue(value.file);
  const url = stringValue(payload.url);
  const lifecycle = fileUploadLifecycleSummary(upload, payload, type);
  return {
    type,
    name: stringValue(value.name),
    caption: summarizeNotionRichText(arrayValue(value.caption)),
    fileObject: mediaFileObjectType(type) ? nativeFileObjectSummary(value, type, payload, upload, file, url, lifecycle) : null,
    fileUploadId: stringValue(upload.id) ?? (type === "file_upload" ? stringValue(payload.id) : null),
    fileUploadFilename: stringValue(upload.filename) ?? (type === "file_upload" ? stringValue(payload.filename) : null),
    fileUploadContentType: stringValue(upload.content_type) ?? (type === "file_upload" ? stringValue(payload.content_type) : null),
    fileUploadContentLength: numberValue(upload.content_length) ?? (type === "file_upload" ? numberValue(payload.content_length) : null),
    fileUploadStatus: stringValue(upload.status) ?? (type === "file_upload" ? stringValue(payload.status) : null),
    ...lifecycle,
    url: type === "external" && url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
    expiryTime: type === "file" ? stringValue(payload.expiry_time) : null,
  };
}

function mediaPayloadType(value: Record<string, unknown>): string | null {
  if (recordHasKeys(value.file_upload)) return "file_upload";
  if (recordHasKeys(value.external)) return "external";
  if (recordHasKeys(value.file)) return "file";
  return null;
}

function iconSummary(value: unknown): Record<string, unknown> | null {
  const icon = recordValue(value);
  if (Object.keys(icon).length === 0) return null;
  const type = stringValue(icon.type) ?? mediaPayloadType(icon);
  const payload = type ? recordValue(icon[type]) : {};
  const upload = recordValue(icon.file_upload);
  const file = recordValue(icon.file);
  const url = stringValue(payload.url);
  const customEmojiUrlRedacted = Boolean(type === "custom_emoji" && url && isNotionPrivateMediaUrl(url));
  const lifecycle = fileUploadLifecycleSummary(upload, payload, type);
  return {
    type,
    fileObject: mediaFileObjectType(type) ? nativeFileObjectSummary(icon, type, payload, upload, file, url, lifecycle) : null,
    emoji: type === "emoji" ? stringValue(icon.emoji) : null,
    name: type === "icon" ? stringValue(payload.name) : null,
    color: type === "icon" ? stringValue(payload.color) : null,
    customEmojiId: type === "custom_emoji" ? stringValue(payload.id) : null,
    customEmojiName: type === "custom_emoji" ? stringValue(payload.name) : null,
    customEmojiUrl: type === "custom_emoji" && url && !customEmojiUrlRedacted ? url : null,
    fileUploadId: type === "file_upload" ? stringValue(payload.id) : null,
    fileUploadFilename: type === "file_upload" ? stringValue(payload.filename) : null,
    fileUploadContentType: type === "file_upload" ? stringValue(payload.content_type) : null,
    fileUploadContentLength: type === "file_upload" ? numberValue(payload.content_length) ?? null : null,
    fileUploadStatus: type === "file_upload" ? stringValue(payload.status) : null,
    ...lifecycle,
    expiryTime: type === "file" ? stringValue(payload.expiry_time) : null,
    url: type === "external" && url && !isMediaUrl(url) ? url : null,
    urlRedacted: type === "custom_emoji" ? customEmojiUrlRedacted : Boolean(url && isMediaUrl(url)),
  };
}

function mediaFileObjectType(type: string | null): boolean {
  return type === "file" || type === "external" || type === "file_upload";
}

function nativeFileObjectSummary(
  value: Record<string, unknown>,
  type: string | null,
  payload: Record<string, unknown>,
  fileUpload: Record<string, unknown>,
  file: Record<string, unknown>,
  url: string | null,
  lifecycle: Record<string, unknown>,
): Record<string, unknown> {
  const urlRedacted = Boolean(url && isMediaUrl(url));
  const upload = recordHasKeys(fileUpload) ? fileUpload : type === "file_upload" ? payload : {};
  return {
    type,
    name: stringValue(value.name) ?? stringValue(value.filename) ?? stringValue(fileUpload.filename),
    file: type === "file"
      ? {
        url: url && !urlRedacted ? url : null,
        urlRedacted,
        expiryTime: stringValue(payload.expiry_time) ?? stringValue(file.expiry_time),
      }
      : null,
    external: type === "external"
      ? {
        url: url && !urlRedacted ? url : null,
        urlRedacted,
      }
      : null,
    fileUpload: type === "file_upload"
      ? {
        id: stringValue(fileUpload.id) ?? stringValue(payload.id),
        filename: stringValue(fileUpload.filename) ?? stringValue(payload.filename),
        contentType: stringValue(fileUpload.content_type) ?? stringValue(payload.content_type),
        contentLength: numberValue(fileUpload.content_length) ?? numberValue(payload.content_length) ?? null,
        status: stringValue(fileUpload.status) ?? stringValue(payload.status),
        expiryTime: stringValue(upload.expiry_time),
        createdTime: stringValue(upload.created_time),
        lastEditedTime: stringValue(upload.last_edited_time),
        inTrash: booleanOrNull(upload.in_trash),
        archived: booleanOrNull(upload.archived),
        createdBy: lifecycle.fileUploadCreatedBy ?? null,
        numberOfParts: lifecycle.fileUploadNumberOfParts ?? null,
        importResult: lifecycle.fileUploadImportResult ?? null,
        uploadUrlRedacted: lifecycle.fileUploadUploadUrlRedacted,
        completeUrlRedacted: lifecycle.fileUploadCompleteUrlRedacted,
      }
      : null,
  };
}

function commentAttachmentSummary(value: unknown): NotionCommentAttachmentSummary {
  const attachment = recordValue(value);
  const file = recordValue(attachment.file);
  const type = stringValue(file.type)
    ?? stringValue(attachment.type)
    ?? (recordHasKeys(file.file) || stringValue(file.url) ? "file" : mediaPayloadType(file));
  const payload = type ? recordValue(file[type]) : {};
  const fileUpload = recordValue(file.file_upload);
  const url = stringValue(payload.url) ?? stringValue(file.url);
  const lifecycle = fileUploadLifecycleSummary(fileUpload, payload, type);
  return {
    category: stringValue(attachment.category),
    name: stringValue(file.name) ?? stringValue(file.filename) ?? stringValue(fileUpload.filename),
    type,
    fileObject: commentAttachmentFileObjectSummary(file, type, payload, fileUpload, url, lifecycle),
    fileUploadId: stringValue(attachment.file_upload_id)
      ?? stringValue(fileUpload.id)
      ?? (type === "file_upload" ? stringValue(file.id) : null),
    fileUploadFilename: stringValue(fileUpload.filename)
      ?? (type === "file_upload" ? stringValue(payload.filename) : null),
    fileUploadContentType: stringValue(fileUpload.content_type)
      ?? (type === "file_upload" ? stringValue(payload.content_type) : null),
    fileUploadContentLength: numberValue(fileUpload.content_length)
      ?? (type === "file_upload" ? numberValue(payload.content_length) ?? null : null),
    fileUploadStatus: stringValue(fileUpload.status)
      ?? (type === "file_upload" ? stringValue(payload.status) : null),
    ...lifecycle,
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
    expiryTime: stringValue(payload.expiry_time) ?? stringValue(file.expiry_time),
  };
}

function commentAttachmentFileObjectSummary(
  file: Record<string, unknown>,
  type: string | null,
  payload: Record<string, unknown>,
  fileUpload: Record<string, unknown>,
  url: string | null,
  lifecycle: Record<string, unknown>,
): NotionCommentAttachmentFileObjectSummary {
  const name = stringValue(file.name) ?? stringValue(file.filename) ?? stringValue(fileUpload.filename);
  const urlRedacted = Boolean(url && isMediaUrl(url));
  const upload = recordHasKeys(fileUpload) ? fileUpload : type === "file_upload" ? payload : {};
  return {
    type,
    name,
    file: type === "file"
      ? {
        url: url && !urlRedacted ? url : null,
        urlRedacted,
        expiryTime: stringValue(payload.expiry_time) ?? stringValue(file.expiry_time),
      }
      : null,
    external: type === "external"
      ? {
        url: url && !urlRedacted ? url : null,
        urlRedacted,
      }
      : null,
    fileUpload: type === "file_upload"
      ? {
        id: stringValue(fileUpload.id) ?? stringValue(payload.id) ?? stringValue(file.id),
        filename: stringValue(fileUpload.filename) ?? stringValue(payload.filename),
        contentType: stringValue(fileUpload.content_type) ?? stringValue(payload.content_type),
        contentLength: numberValue(fileUpload.content_length) ?? numberValue(payload.content_length) ?? null,
        status: stringValue(fileUpload.status) ?? stringValue(payload.status),
        expiryTime: stringValue(upload.expiry_time),
        createdTime: stringValue(upload.created_time),
        lastEditedTime: stringValue(upload.last_edited_time),
        inTrash: booleanOrNull(upload.in_trash),
        archived: booleanOrNull(upload.archived),
        createdBy: lifecycle.fileUploadCreatedBy as NotionCommentAttachmentFileUploadSummary["createdBy"],
        numberOfParts: lifecycle.fileUploadNumberOfParts as NotionCommentAttachmentFileUploadSummary["numberOfParts"],
        importResult: lifecycle.fileUploadImportResult as NotionCommentAttachmentFileUploadSummary["importResult"],
        uploadUrlRedacted: lifecycle.fileUploadUploadUrlRedacted as boolean | undefined,
        completeUrlRedacted: lifecycle.fileUploadCompleteUrlRedacted as boolean | undefined,
      }
      : null,
  };
}

function fileUploadLifecycleSummary(
  fileUpload: Record<string, unknown>,
  payload: Record<string, unknown>,
  type: string | null,
): Record<string, unknown> {
  const upload = recordHasKeys(fileUpload) ? fileUpload : type === "file_upload" ? payload : {};
  if (!recordHasKeys(upload)) return {};
  const parts = recordValue(upload.number_of_parts);
  const importResult = recordValue(upload.file_import_result);
  const error = recordValue(importResult.error);
  const createdBy = recordValue(upload.created_by);
  return {
    fileUploadExpiryTime: stringValue(upload.expiry_time),
    fileUploadCreatedTime: stringValue(upload.created_time),
    fileUploadLastEditedTime: stringValue(upload.last_edited_time),
    fileUploadInTrash: booleanOrNull(upload.in_trash),
    fileUploadArchived: booleanOrNull(upload.archived),
    fileUploadCreatedBy: recordHasKeys(createdBy)
      ? { id: stringValue(createdBy.id), type: stringValue(createdBy.type) }
      : null,
    fileUploadNumberOfParts: recordHasKeys(parts)
      ? { total: numberValue(parts.total), sent: numberValue(parts.sent) }
      : null,
    fileUploadImportResult: recordHasKeys(importResult)
      ? {
        importedTime: stringValue(importResult.imported_time),
        type: stringValue(importResult.type),
        error: recordHasKeys(error)
          ? {
            type: stringValue(error.type),
            code: stringValue(error.code),
            message: stringValue(error.message),
            parameter: stringValue(error.parameter),
            statusCode: numberValue(error.status_code),
          }
          : null,
      }
      : null,
    fileUploadUploadUrlRedacted: Boolean(stringValue(upload.upload_url)),
    fileUploadCompleteUrlRedacted: Boolean(stringValue(upload.complete_url)),
  };
}

function recordHasKeys(value: unknown): boolean {
  return Object.keys(recordValue(value)).length > 0;
}

function isMediaUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const pathname = safeDecodeURIComponent(url.pathname).toLowerCase();
    if (host.includes("prod-files-secure.s3")) return true;
    if (host === "secure.notion-static.com" || host.endsWith(".secure.notion-static.com")) return true;
    return MEDIA_URL_EXTENSIONS.has(pathExtension(pathname));
  } catch {
    const normalized = trimmed.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
    return [...MEDIA_URL_EXTENSIONS].some((extension) => normalized.endsWith(extension));
  }
}

function isNotionPrivateMediaUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    return host.includes("prod-files-secure.s3")
      || host === "secure.notion-static.com"
      || host.endsWith(".secure.notion-static.com");
  } catch {
    return false;
  }
}

function pathExtension(pathname: string): string {
  const filename = pathname.split("/").pop() ?? "";
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot) : "";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function viewPropertyConfigSummary(value: unknown): Array<Record<string, unknown>> {
  return arrayValue(value).map((entry) => {
    const property = recordValue(entry);
    return {
      propertyId: stringValue(property.property_id) ?? stringValue(property.id),
      propertyName: stringValue(property.property_name) ?? stringValue(property.name),
      propertyType: stringValue(property.property_type) ?? stringValue(property.type),
      visible: booleanOrNull(property.visible),
      width: numberOrNull(property.width),
      wrap: booleanOrNull(property.wrap),
      widthMode: stringValue(property.width_mode) ?? stringValue(property.card_property_width_mode),
      cardPropertyWidthMode: stringValue(property.card_property_width_mode),
      aggregation: stringValue(property.aggregation),
      showAs: stringValue(property.show_as) ?? stringValue(property.status_show_as) ?? stringValue(property.display),
      statusShowAs: stringValue(property.status_show_as),
      dateFormat: stringValue(property.date_format),
      timeFormat: stringValue(property.time_format),
    };
  });
}

function groupBySummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const group = recordValue(value);
  if (Object.keys(group).length === 0) return null;
  const propertyId = stringValue(group.property_id);
  const sort = recordValue(group.sort);
  const groupByConfig = groupBySummary(group.group_by, propertyNamesById);
  return {
    propertyId,
    propertyName: stringValue(group.property_name) ?? propertyNameFromId(propertyId, propertyNamesById),
    propertyType: stringValue(group.property_type) ?? stringValue(group.type),
    direction: stringValue(group.direction),
    sort: stringValue(group.sort),
    sortType: stringValue(sort.type) ?? stringValue(group.sort),
    aggregator: stringValue(group.aggregator) ?? stringValue(group.aggregation),
    aggregation: stringValue(group.aggregation) ?? stringValue(group.aggregator),
    groupBy: stringValue(group.group_by),
    groupByConfig,
    dateBy: stringValue(group.date_by),
    startDayOfWeek: stringValue(group.start_day_of_week) ?? numberOrNull(group.start_day_of_week),
    rangeStart: numberOrNull(group.range_start),
    rangeEnd: numberOrNull(group.range_end),
    rangeSize: numberOrNull(group.range_size),
    hideEmptyGroups: booleanOrNull(group.hide_empty_groups),
    groups: normalizedNotionValue(group.groups),
    visibleGroups: normalizedNotionValue(group.visible_groups),
    hiddenGroups: normalizedNotionValue(group.hidden_groups),
  };
}

function viewAxisSummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const axis = recordValue(value);
  if (Object.keys(axis).length === 0) return null;
  const propertyId = stringValue(axis.property_id);
  return {
    propertyId,
    propertyName: stringValue(axis.property_name)
      ?? propertyNameFromId(propertyId, propertyNamesById)
      ?? stringValue(axis.property),
    propertyType: stringValue(axis.property_type) ?? stringValue(axis.type),
    aggregator: stringValue(axis.aggregator) ?? stringValue(axis.aggregation),
    aggregation: stringValue(axis.aggregation) ?? stringValue(axis.aggregator),
    groupBy: stringValue(axis.group_by),
    direction: stringValue(axis.direction),
    sort: stringValue(axis.sort),
    display: stringValue(axis.display) ?? stringValue(axis.show_as),
    ranges: normalizedNotionValue(axis.ranges),
    value: normalizedNotionValue(axis.value),
  };
}

function chartAggregationSummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const aggregation = recordValue(value);
  if (Object.keys(aggregation).length === 0) return null;
  const propertyId = stringValue(aggregation.property_id);
  return {
    aggregator: stringValue(aggregation.aggregator),
    propertyId,
    propertyName: stringValue(aggregation.property_name) ?? propertyNameFromId(propertyId, propertyNamesById),
  };
}

function chartReferenceLineSummaries(value: unknown): Array<Record<string, unknown>> {
  return arrayValue(value).map((entry) => {
    const line = recordValue(entry);
    return {
      id: stringValue(line.id),
      value: numberOrNull(line.value),
      label: stringValue(line.label),
      color: stringValue(line.color),
      dashStyle: stringValue(line.dash_style),
    };
  });
}

function coverSummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const cover = recordValue(value);
  if (Object.keys(cover).length === 0) return null;
  const propertyId = stringValue(cover.property_id);
  return {
    type: stringValue(cover.type),
    propertyId,
    propertyName: stringValue(cover.property_name) ?? propertyNameFromId(propertyId, propertyNamesById),
  };
}

function subtaskConfigSummary(value: unknown): Record<string, unknown> | null {
  const subtasks = recordValue(value);
  if (Object.keys(subtasks).length === 0) return null;
  return {
    propertyId: stringValue(subtasks.property_id),
    displayMode: stringValue(subtasks.display_mode),
    filterScope: stringValue(subtasks.filter_scope),
    toggleColumnId: stringValue(subtasks.toggle_column_id),
  };
}

function timelinePreferenceSummary(value: unknown): Record<string, unknown> | null {
  const preference = recordValue(value);
  if (Object.keys(preference).length === 0) return null;
  return {
    zoomLevel: stringValue(preference.zoom_level) ?? stringValue(preference.zoom),
    centerTimestamp: numberOrNull(preference.center_timestamp),
    raw: normalizedShallowObject(preference),
  };
}

function timelineArrowsBySummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const arrowsBy = recordValue(value);
  if (Object.keys(arrowsBy).length === 0) return null;
  const propertyId = stringValue(arrowsBy.property_id);
  return {
    propertyId,
    propertyName: stringValue(arrowsBy.property_name) ?? propertyNameFromId(propertyId, propertyNamesById),
    raw: normalizedShallowObject(arrowsBy),
  };
}

function viewFilterSummary(value: unknown, propertyNamesById = new Map<string, string>()): Record<string, unknown> | null {
  const filter = recordValue(value);
  if (Object.keys(filter).length === 0) return null;
  const andFilters = arrayValue(filter.and).map((entry) => viewFilterSummary(entry, propertyNamesById)).filter((entry): entry is Record<string, unknown> => entry !== null);
  const orFilters = arrayValue(filter.or).map((entry) => viewFilterSummary(entry, propertyNamesById)).filter((entry): entry is Record<string, unknown> => entry !== null);
  if (andFilters.length > 0 || orFilters.length > 0) {
    return {
      type: andFilters.length > 0 ? "and" : "or",
      filters: andFilters.length > 0 ? andFilters : orFilters,
      count: andFilters.length > 0 ? andFilters.length : orFilters.length,
    };
  }
  const operator = Object.keys(filter).find((key) =>
    !["property", "property_id", "property_name", "timestamp", "type"].includes(key));
  const propertySelector = stringValue(filter.property);
  const propertyId = stringValue(filter.property_id) ?? (propertySelector && propertyNamesById.has(propertySelector) ? propertySelector : null);
  return {
    type: stringValue(filter.type) ?? (stringValue(filter.timestamp) ? "timestamp" : "property"),
    propertySelector,
    propertyId,
    propertyName: stringValue(filter.property_name)
      ?? propertyNameFromId(propertyId, propertyNamesById)
      ?? propertySelector,
    timestamp: stringValue(filter.timestamp),
    operator: operator ?? null,
    value: operator ? normalizedNotionValue(filter[operator] ?? null) : null,
  };
}

function viewSortsSummary(value: unknown, propertyNamesById = new Map<string, string>()): Array<Record<string, unknown>> {
  return arrayValue(value).map((entry, index) => {
    const sort = recordValue(entry);
    const propertySelector = stringValue(sort.property);
    const propertyId = stringValue(sort.property_id) ?? (propertySelector && propertyNamesById.has(propertySelector) ? propertySelector : null);
    return {
      index,
      propertySelector,
      propertyId,
      propertyName: stringValue(sort.property_name)
        ?? propertyNameFromId(propertyId, propertyNamesById)
        ?? propertySelector,
      timestamp: stringValue(sort.timestamp),
      direction: stringValue(sort.direction),
    };
  });
}

function viewQuickFiltersSummary(value: unknown, configuration: Record<string, unknown> | null = null): Array<Record<string, unknown>> {
  const propertyNamesById = viewConfigurationPropertyNamesById(configuration);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => ({ index, key: null as string | null, value: entry }))
    : Object.entries(recordValue(value)).map(([key, entry], index) => ({ index, key, value: entry }));
  return entries.map((entry) => {
    const filter = recordValue(entry.value);
    const operator = Object.keys(filter).find((key) =>
      !["property", "property_id", "property_name", "timestamp", "type", "value", "filter"].includes(key));
    const quickValue = filter.value ?? filter.filter;
    const propertySelector = stringValue(filter.property);
    const propertyId = stringValue(filter.property_id) ?? (!propertySelector ? entry.key : null);
    return {
      index: entry.index,
      key: entry.key,
      propertySelector,
      propertyId,
      propertyName: stringValue(filter.property_name) ?? propertySelector ?? (propertyId ? propertyNamesById.get(propertyId) ?? null : null),
      type: stringValue(filter.type) ?? operator,
      operator: operator ?? null,
      value: normalizedNotionValue(quickValue ?? (operator ? filter[operator] : null)),
    };
  });
}

function viewConfigurationPropertyNamesById(configuration: Record<string, unknown> | null): Map<string, string> {
  const names = new Map<string, string>();
  if (!configuration) return names;
  const collect = (value: unknown) => {
    const property = recordValue(value);
    const pairs = [
      [property.propertyId, property.propertyName],
      [property.datePropertyId, property.datePropertyName],
      [property.endDatePropertyId, property.endDatePropertyName],
      [property.xAxisPropertyId, property.xAxisPropertyName],
      [property.yAxisPropertyId, property.yAxisPropertyName],
      [property.mapBy, property.mapByPropertyName],
    ] as const;
    for (const [id, name] of pairs) {
      const propertyId = stringValue(id);
      const propertyName = stringValue(name);
      if (propertyId && propertyName) names.set(propertyId, propertyName);
    }
  };
  for (const property of arrayValue(configuration.visibleProperties)) collect(property);
  for (const property of arrayValue(recordValue(configuration.timeline).tableProperties)) collect(property);
  for (const property of arrayValue(recordValue(configuration.map).properties)) collect(property);
  for (const group of [
    configuration.groupBy,
    configuration.subGroupBy,
    recordValue(configuration.timeline).arrowsBy,
    recordValue(configuration.timeline).colorBy,
    recordValue(configuration.chart).stackBy,
    recordValue(configuration.chart).xAxis,
    recordValue(configuration.chart).yAxis,
    recordValue(configuration.chart).value,
    recordValue(configuration.calendar),
    recordValue(configuration.map),
  ]) collect(group);
  return names;
}

function rawViewConfigurationPropertyNamesById(configuration: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  const collect = (value: unknown) => {
    const property = recordValue(value);
    if (Object.keys(property).length === 0) return;
    addPropertyNamePair(names, property.property_id, property.property_name);
    addPropertyNamePair(names, property.id, property.name);
    addPropertyNamePair(names, property.date_property_id, property.date_property_name);
    addPropertyNamePair(names, property.end_date_property_id, property.end_date_property_name);
    addPropertyNamePair(names, property.x_axis_property_id, property.x_axis_property_name);
    addPropertyNamePair(names, property.y_axis_property_id, property.y_axis_property_name);
    addPropertyNamePair(names, property.map_by, property.map_by_property_name);
    collect(property.group_by);
  };
  for (const property of arrayValue(configuration.properties)) collect(property);
  for (const property of arrayValue(configuration.table_properties)) collect(property);
  for (const property of arrayValue(configuration.map_properties)) collect(property);
  for (const entry of [
    configuration,
    configuration.group_by,
    configuration.sub_group_by,
    configuration.cover,
    configuration.x_axis,
    configuration.y_axis,
    configuration.value,
    configuration.stack_by,
    configuration.arrows_by,
    configuration.color_by,
  ]) collect(entry);
  return names;
}

function addPropertyNamePair(names: Map<string, string>, id: unknown, name: unknown): void {
  const propertyId = stringValue(id);
  const propertyName = stringValue(name);
  if (propertyId && propertyName) names.set(propertyId, propertyName);
}

function propertyNameFromId(id: unknown, propertyNamesById: Map<string, string>): string | null {
  const propertyId = stringValue(id);
  return propertyId ? propertyNamesById.get(propertyId) ?? null : null;
}

function dashboardRowsSummary(value: unknown): Array<Record<string, unknown>> {
  return arrayValue(value).map((row, rowIndex) => {
    const record = recordValue(row);
    const widgets = arrayValue(record.widgets).length > 0 ? arrayValue(record.widgets) : arrayValue(record.modules);
    const widgetSummaries = widgets.map((widget, widgetIndex) => {
      const entry = recordValue(widget);
      return {
        index: widgetIndex,
        id: stringValue(entry.id),
        type: stringValue(entry.type),
        title: stringValue(entry.title) ?? stringValue(entry.name),
        x: numberOrNull(entry.x),
        y: numberOrNull(entry.y),
        row: numberOrNull(entry.row),
        rowIndex: numberOrNull(entry.row_index) ?? numberOrNull(entry.row),
        column: numberOrNull(entry.column),
        widthRatio: numberOrNull(entry.width_ratio),
        width: numberOrNull(entry.width),
        height: numberOrNull(entry.height),
        viewId: stringValue(entry.view_id),
        dataSourceId: stringValue(entry.data_source_id),
        configuration: normalizedShallowObject(entry.configuration),
      };
    });
    return {
      index: rowIndex,
      id: stringValue(record.id),
      type: stringValue(record.type),
      height: numberOrNull(record.height),
      widgetCount: widgetSummaries.length,
      widgets: widgetSummaries,
      moduleCount: widgetSummaries.length,
      modules: widgetSummaries,
    };
  });
}

function normalizedShallowObject(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (Object.keys(record).length === 0) return null;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) return [key, entry];
    return [key, summarizeObjectKeys(entry)];
  }));
}

function normalizedNotionValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return summarizeComplexValue(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => normalizedNotionValue(entry, depth + 1));
  const record = recordValue(value);
  if (Object.keys(record).length === 0) return null;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "raw" && key !== "plain_text")
    .slice(0, 50)
    .map(([key, entry]) => [key, normalizedNotionValue(entry, depth + 1)]));
}

function summarizeComplexValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  const record = recordValue(value);
  if (Object.keys(record).length > 0) return { type: "object", keys: Object.keys(record).slice(0, 20) };
  return { type: typeof value };
}

function summarizeObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  const record = recordValue(value);
  if (Object.keys(record).length > 0) return { kind: "object", keys: Object.keys(record).slice(0, 20) };
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrBooleanOrNull(value: unknown): string | boolean | null {
  if (typeof value === "string" || typeof value === "boolean") return value;
  return null;
}

function databaseIdFromDataSource(source: NotionDataSource): string | null {
  return databaseIdFromParent(source.parent) ?? databaseIdFromParent(source.database_parent);
}

function databaseIdFromParent(parent: NotionParent | undefined): string | null {
  return parent?.database_id ?? null;
}

function syntheticPage(pageContent: NotionPageContent): NotionPage {
  return {
    object: "page",
    id: pageContent.pageId,
    url: pageContent.url ?? undefined,
    parent: parentFromInfo(pageContent.parentType, pageContent.parentId),
    properties: {
      Title: { type: "title", title: [{ type: "text", plain_text: pageContent.title, text: { content: pageContent.title } }] },
      ...pageContent.properties,
    } as Record<string, Record<string, unknown>>,
    last_edited_time: pageContent.lastEditedTime?.toISOString(),
    in_trash: false,
    is_archived: false,
    archived: false,
  };
}

function syntheticRowPage(rowPage: NotionDatabaseRowPage): NotionPage {
  return {
    object: "page",
    id: rowPage.pageId,
    url: rowPage.url ?? undefined,
    parent: { type: "data_source_id", data_source_id: rowPage.dataSourceId },
    properties: {
      Title: { type: "title", title: [{ type: "text", plain_text: rowPage.title, text: { content: rowPage.title } }] },
      ...rowPage.properties,
    } as Record<string, Record<string, unknown>>,
    in_trash: false,
    is_archived: false,
    archived: false,
  };
}

function syntheticChildPage(childPage: NotionChildPage): NotionPage {
  return {
    object: "page",
    id: childPage.pageId,
    url: childPage.url ?? undefined,
    parent: { type: "block_id", block_id: childPage.parentBlockId },
    properties: {
      Title: { type: "title", title: [{ type: "text", plain_text: childPage.title, text: { content: childPage.title } }] },
      ...childPage.properties,
    } as Record<string, Record<string, unknown>>,
    in_trash: false,
    is_archived: false,
    archived: false,
  };
}

function syntheticBlock(node: NotionBlockNode, pageId: string): NotionBlock {
  const richText = node.text ? [{ type: "text", plain_text: node.text, text: { content: node.text } }] : [];
  return {
    object: "block",
    id: node.id,
    type: node.type,
    parent: parentFromInfo(node.parentId ? "block_id" : "page_id", node.parentId ?? pageId),
    has_children: node.hasChildren,
    archived: node.archived === true,
    in_trash: node.inTrash,
    [node.type]: {
      rich_text: richText,
      cells: node.type === "table_row" ? syntheticTableCells(node) : undefined,
      checked: node.checked,
      color: node.color,
    },
  };
}

function notionBlockInTrashState(block: NotionBlock | Record<string, unknown>): boolean {
  return (block as { in_trash?: unknown }).in_trash === true;
}

function notionBlockArchivedState(block: NotionBlock | Record<string, unknown>): boolean {
  return (block as { archived?: unknown }).archived === true;
}

function syntheticTableCells(node: NotionBlockNode): unknown[][] {
  if (node.tableCellRichText) return node.tableCellRichText.map((cell) => cell.map(richTextSpanToSyntheticItem));
  return (node.tableCells ?? []).map((cell) => [{ type: "text", plain_text: cell, text: { content: cell } }]);
}

function richTextSpanToSyntheticItem(span: NotionRichTextSpanSummary): Record<string, unknown> {
  return {
    type: span.type,
    plain_text: span.plainText,
    href: span.href,
    annotations: span.annotations,
    text: span.text
      ? {
        content: span.text.content,
        link: span.text.link ? { url: span.text.link } : null,
      }
      : undefined,
    equation: span.equation,
    mention: span.mention,
  };
}

function parentFromInfo(parentType: string | null, parentId: string | null): NotionParent | undefined {
  if (!parentType || !parentId) return undefined;
  if (parentType === "page_id") return { type: parentType, page_id: parentId };
  if (parentType === "database_id") return { type: parentType, database_id: parentId };
  if (parentType === "data_source_id") return { type: parentType, data_source_id: parentId };
  if (parentType === "block_id") return { type: parentType, block_id: parentId };
  if (parentType === "agent_id") return { type: parentType, agent_id: parentId };
  return { type: parentType };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function dedupeById<T>(values: T[], idFor: (value: T) => string | null | undefined): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = idFor(value);
    if (id === null || id === undefined) {
      result.push(value);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) {
      group.push(value);
    } else {
      groups.set(key, [value]);
    }
  }
  return groups;
}

export function hashContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, sortStable(entry)]));
}
