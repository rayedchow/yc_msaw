import { createHash } from "node:crypto";
import {
  collectNotionDataSourcePageCollection,
  collectNotionViews,
  createNotionViewQuery,
  deleteNotionViewQuery,
  extractNotionTitle,
  notionParentInfo,
  notionApiErrorSummary,
  retrieveNotionBlock,
  retrieveNotionBlockChildren,
  retrieveNotionDatabase,
  retrieveNotionDataSource,
  retrieveNotionComments,
  retrieveNotionPage,
  retrieveNotionPageMarkdown,
  retrieveNotionPageProperty,
  retrieveNotionViewQuery,
  type NotionBlock,
  type NotionComment,
  type NotionDataSource,
  type NotionDatabase,
  type NotionPage,
  type NotionParent,
  type NotionView,
  type NotionViewQueryResponse,
  type NotionApiErrorSummary,
} from "./client.js";
import {
  NOTION_KNOWN_BLOCK_TYPES,
  NOTION_LEGACY_OR_COMPAT_BLOCK_TYPES,
  NOTION_MEDIA_BLOCK_TYPES,
  NOTION_MEDIA_URL_EXTENSIONS,
  NOTION_OFFICIAL_BLOCK_TYPES,
  NOTION_PAGINATED_PROPERTY_TYPES,
} from "./coverage.js";
import { notionBlockSupportsChildren } from "./block-capabilities.js";
import { notionPropertySchemaSummary } from "./property-schema.js";
import { slugify } from "../../lib/utils.js";

const UNKNOWN_BLOCK_RECOVERY_MAX_CHARS = 300_000;
const UNKNOWN_BLOCK_RECOVERY_MAX_REQUESTS = 300;
const STRUCTURED_BLOCK_MAX_BLOCKS = numberFromEnv("NOTION_STRUCTURED_BLOCK_MAX_BLOCKS", 5000);
const STRUCTURED_BLOCK_MAX_REQUESTS = numberFromEnv("NOTION_STRUCTURED_BLOCK_MAX_REQUESTS", 500);
const STRUCTURED_BLOCK_MAX_DEPTH = numberFromEnv("NOTION_STRUCTURED_BLOCK_MAX_DEPTH", 512);
const INLINE_DATABASE_MAX_DATA_SOURCES = numberFromEnv("NOTION_INLINE_DATABASE_MAX_DATA_SOURCES", 5);
const INLINE_DATABASE_MAX_ROWS = numberFromEnv("NOTION_INLINE_DATABASE_MAX_ROWS", 500);
const INLINE_DATABASE_MAX_ROW_BODIES = numberFromEnv("NOTION_INLINE_DATABASE_MAX_ROW_BODIES", 100);
const INLINE_DATABASE_MAX_ROW_COMMENT_FETCHES = numberFromEnv("NOTION_INLINE_DATABASE_MAX_ROW_COMMENT_FETCHES", 100);
const INLINE_DATABASE_MAX_NESTING = numberFromEnv("NOTION_INLINE_DATABASE_MAX_NESTING", 2);
const INLINE_DATABASE_MAX_VIEWS = numberFromEnv("NOTION_INLINE_DATABASE_MAX_VIEWS", 20);
const BLOCK_COMMENT_FETCH_MAX_BLOCKS = numberFromEnv("NOTION_BLOCK_COMMENT_FETCH_MAX_BLOCKS", 250);
const CHILD_PAGE_MAX_PAGES = numberFromEnv("NOTION_CHILD_PAGE_MAX_PAGES", 100);
const CHILD_PAGE_MAX_DEPTH = numberFromEnv("NOTION_CHILD_PAGE_MAX_DEPTH", 3);
const PROPERTY_HYDRATION_MAX_PROPERTIES = numberFromEnv("NOTION_PROPERTY_HYDRATION_MAX_PROPERTIES", 20);
const PROPERTY_HYDRATION_MAX_ITEMS = numberFromEnv("NOTION_PROPERTY_HYDRATION_MAX_ITEMS", 1000);
const COMMENT_FETCH_MAX_COMMENTS = numberFromEnv("NOTION_COMMENT_FETCH_MAX_COMMENTS", 100);
const BREADCRUMB_MAX_ANCESTORS = numberFromEnv("NOTION_BREADCRUMB_MAX_ANCESTORS", 8);

const PAGINATED_PROPERTY_TYPES = new Set<string>(NOTION_PAGINATED_PROPERTY_TYPES);
const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3", "heading_4"]);
const CHILD_TRAVERSAL_WARNING_CODES = new Set([
  "block_child_pagination_cursor_missing",
  "block_count_capped",
  "block_request_capped",
  "block_depth_capped",
  "block_cycle_skipped",
]);
const MEDIA_MARKDOWN_TAG = "(?:image|video|pdf|file|audio|embed|bookmark|link_preview)";
const MEDIA_URL_EXTENSIONS = new Set<string>(NOTION_MEDIA_URL_EXTENSIONS);
const REDACTED_MEDIA_MARKDOWN_TAG = "shepherd-redacted-media";

export interface NotionSection {
  sectionId: string;
  sectionTitle: string;
  content: string;
  contentHash: string;
  kind?: "properties" | "page_intro" | "page_body" | "heading" | "database_row_page" | "comments";
  anchorBlockId?: string | null;
  rootBlockIds?: string[];
  structuredFacts?: Record<string, unknown>;
  warningCodes?: string[];
}

export interface NotionPageContent {
  pageId: string;
  title: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
  properties: Record<string, unknown>;
  propertyValues: NotionPropertyValueSummary[];
  lastEditedTime: Date | null;
  markdown: string;
  contentHash: string;
  markdownTruncated: boolean;
  unknownBlockIds: string[];
  sections: NotionSection[];
  structuredIngestion: boolean;
  blockCoverage: Record<string, unknown>;
  blockTree: NotionBlockNode[];
  references: NotionReference[];
  rowPages: NotionDatabaseRowPage[];
  childPages: NotionChildPage[];
  comments: NotionCommentSummary[];
  rawPage: NotionPage | null;
  breadcrumbTrail: NotionBreadcrumbEntry[];
  nativeDatabases: NotionDatabase[];
  nativeDataSources: NotionDataSource[];
  rawComments: NotionComment[];
  warnings: NotionSourceWarning[];
}

export interface NotionPageMetadataSummary {
  object: "page";
  pageId: string;
  title: string;
  url: string | null;
  publicUrl: string | null;
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
  databaseId: string | null;
  properties: Record<string, unknown>;
  createdTime: Date | null;
  lastEditedTime: Date | null;
  createdBy: NotionUserSummary | null;
  lastEditedBy: NotionUserSummary | null;
  archived: boolean;
  inTrash: boolean;
  isLocked: boolean;
  icon: NotionBlockIconSummary | null;
  cover: Record<string, unknown> | null;
  propertyCount: number;
  propertyNames: string[];
  propertyTypes: Record<string, number>;
}

export const NOTION_PAGE_SUMMARY_RAW_PROPERTIES_KEY = "__shepherdNotionRawProperties";
export const NOTION_PAGE_SUMMARY_METADATA_KEY = "__shepherdNotionMetadata";
export const NOTION_PAGE_SUMMARY_ENVELOPE_KEY = "__shepherdNotionSummaryEnvelope";

export function notionPageSummaryMetadataPayload(page: NotionPageMetadataSummary): Record<string, unknown> {
  return {
    object: page.object,
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    publicUrl: page.publicUrl,
    parentType: page.parentType,
    parentId: page.parentId,
    dataSourceId: page.dataSourceId,
    databaseId: page.databaseId,
    createdTime: page.createdTime?.toISOString() ?? null,
    lastEditedTime: page.lastEditedTime?.toISOString() ?? null,
    createdBy: page.createdBy,
    lastEditedBy: page.lastEditedBy,
    archived: page.archived,
    inTrash: page.inTrash,
    isLocked: page.isLocked,
    icon: page.icon,
    cover: page.cover,
    propertyCount: page.propertyCount,
    propertyNames: page.propertyNames,
    propertyTypes: page.propertyTypes,
  };
}

export function notionPageSummaryStoredPropertiesPayload(page: NotionPageMetadataSummary): Record<string, unknown> {
  // The summary table has one JSON properties column, so raw page properties and
  // enriched page metadata are persisted together in an unforgeable envelope.
  return {
    [NOTION_PAGE_SUMMARY_ENVELOPE_KEY]: { version: 1 },
    [NOTION_PAGE_SUMMARY_RAW_PROPERTIES_KEY]: page.properties,
    [NOTION_PAGE_SUMMARY_METADATA_KEY]: notionPageSummaryMetadataPayload(page),
  };
}

export function notionPageSummaryRawProperties(value: unknown): Record<string, unknown> {
  const properties = recordValue(value);
  if (!isNotionPageSummaryStoredPropertiesPayload(properties)) return properties;
  return recordValue(properties[NOTION_PAGE_SUMMARY_RAW_PROPERTIES_KEY]);
}

function isNotionPageSummaryStoredPropertiesPayload(properties: Record<string, unknown>): boolean {
  const envelope = recordValue(properties[NOTION_PAGE_SUMMARY_ENVELOPE_KEY]);
  const metadata = recordValue(properties[NOTION_PAGE_SUMMARY_METADATA_KEY]);
  return Object.keys(properties).length === 3
    && numberValue(envelope.version) === 1
    && isRecordObject(properties[NOTION_PAGE_SUMMARY_RAW_PROPERTIES_KEY])
    && (stringValue(metadata.pageId) !== null || stringValue(metadata.title) !== null)
    && Array.isArray(metadata.propertyNames)
    && isRecordObject(metadata.propertyTypes);
}

export interface NotionBreadcrumbEntry {
  objectType: "workspace" | "page" | "database" | "data_source" | "block";
  objectId: string | null;
  title: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
}

export interface NotionBlockNode {
  id: string;
  type: string;
  parentId: string | null;
  depth: number;
  order: number;
  hasChildren: boolean;
  archived?: boolean;
  inTrash: boolean;
  text: string;
  caption?: string;
  richText?: NotionRichTextSpanSummary[];
  captionRichText?: NotionRichTextSpanSummary[];
  titleRichText?: NotionRichTextSpanSummary[];
  icon?: NotionBlockIconSummary | null;
  meetingNotes?: NotionMeetingNotesSummary;
  childPage?: NotionChildPage;
  markdown: string;
  checked?: boolean;
  color?: string | null;
  isToggleable?: boolean;
  listStartIndex?: number | null;
  listFormat?: string | null;
  widthRatio?: number | null;
  tableWidth?: number | null;
  hasColumnHeader?: boolean;
  hasRowHeader?: boolean;
  url?: string | null;
  language?: string | null;
  tableCells?: string[];
  tableCellRichText?: NotionRichTextSpanSummary[][];
  inlineDataSources?: NotionInlineDataSource[];
  comments: NotionCommentSummary[];
  rawComments?: NotionComment[];
  rawBlock?: NotionBlock;
  children: NotionBlockNode[];
  references: NotionReference[];
  warnings: NotionSourceWarning[];
}

export interface NotionBlockIconSummary {
  type: string | null;
  fileObject: NotionPropertyFileObjectSummary | null;
  emoji: string | null;
  name: string | null;
  color: string | null;
  customEmojiId: string | null;
  customEmojiName: string | null;
  customEmojiUrl: string | null;
  fileUploadId: string | null;
  fileUploadFilename: string | null;
  fileUploadContentType: string | null;
  fileUploadContentLength: number | null;
  fileUploadStatus: string | null;
  fileUploadExpiryTime?: string | null;
  fileUploadCreatedTime?: string | null;
  fileUploadLastEditedTime?: string | null;
  fileUploadInTrash?: boolean | null;
  fileUploadArchived?: boolean | null;
  fileUploadCreatedBy?: { id: string | null; type: string | null } | null;
  fileUploadNumberOfParts?: { total: number | null; sent: number | null } | null;
  fileUploadImportResult?: {
    importedTime: string | null;
    type: string | null;
    error: NotionFileUploadImportErrorSummary | null;
  } | null;
  fileUploadUploadUrlRedacted?: boolean;
  fileUploadCompleteUrlRedacted?: boolean;
  url: string | null;
  urlRedacted: boolean;
  expiryTime: string | null;
}

export interface NotionFileUploadImportErrorSummary {
  type: string | null;
  code: string | null;
  message: string | null;
  parameter: string | null;
  statusCode: number | null;
}

export interface NotionMeetingNotesSummary {
  title: string;
  status: string | null;
  children: {
    summaryBlockId: string | null;
    notesBlockId: string | null;
    transcriptBlockId: string | null;
  };
  calendarEvent: {
    startTime: string | null;
    endTime: string | null;
    attendees: NotionMeetingAttendeeSummary[];
  } | null;
  recording: {
    startTime: string | null;
    endTime: string | null;
  } | null;
}

export interface NotionMeetingAttendeeSummary {
  id: string | null;
  objectType: string | null;
  type: string | null;
  name: string | null;
  email: string | null;
  partial: boolean;
}

export interface NotionInlineDataSource {
  dataSourceId: string;
  title: string;
  url: string | null;
  columns: string[];
  view: NotionInlineDataSourceView | null;
  rows: NotionInlineDataSourceRow[];
  rowCount: number;
  rowCapReached: boolean;
  queryComplete: boolean;
  queryHasMore: boolean;
  queryNextCursor: string | null;
  queryRequestStatus: Record<string, unknown> | null;
  queryIncompleteReason: string | null;
  nestedDataSources: NotionInlineNestedDataSource[];
  rawDataSource?: NotionDataSource | null;
  rawDatabase?: NotionDatabase | null;
}

export interface NotionInlineDataSourceView {
  viewId: string;
  name: string;
  viewType: string;
  columns: string[];
  filter: Record<string, unknown> | null;
  sorts: unknown[];
  quickFilters: unknown[] | Record<string, unknown>;
  configuration: Record<string, unknown>;
  configurationSummary: Record<string, unknown>;
  resultPageIds: string[];
  resultReferences: Array<Record<string, unknown>>;
  renderedResultPageIds: string[];
  missingResultPageIds: string[];
  rowGroups: NotionInlineDataSourceViewRowGroup[];
  queryId: string | null;
  queryExpiresAt: string | null;
  queryPageSize: number | null;
  queryPagesFetched: number;
  queryDeleted: boolean;
  resultCount: number;
  totalCount: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  requestStatus: Record<string, unknown> | null;
  complete: boolean;
  rawView?: NotionView;
  rawQuery?: Record<string, unknown>;
}

export interface NotionInlineDataSourceViewRowGroup {
  propertyId: string | null;
  propertyName: string | null;
  propertyType: string | null;
  groupValue: string;
  groupValueId: string | null;
  groupColor: string | null;
  pageIds: string[];
  rowCount: number;
}

export interface NotionInlineNestedDataSource {
  dataSourceId: string;
  title: string;
  url: string | null;
  rawDataSource?: NotionDataSource;
  materializedDataSource?: NotionInlineDataSource | null;
}

export interface NotionInlineDataSourceRow {
  pageId: string;
  title: string;
  url: string | null;
  properties: Record<string, unknown>;
  propertyValues: NotionPropertyValueSummary[];
  values: Record<string, string>;
  bodyBlocks: NotionBlockNode[];
  bodyMarkdown: string;
  breadcrumbTrail: NotionBreadcrumbEntry[];
  bodyPagePath: string | null;
  comments: NotionCommentSummary[];
  rawPage?: NotionPage;
  rawComments?: NotionComment[];
}

export interface NotionDatabaseRowPage {
  pageId: string;
  title: string;
  url: string | null;
  dataSourceId: string;
  dataSourceTitle: string;
  parentBlockId: string;
  relativePath: string;
  properties: Record<string, unknown>;
  propertyValues: NotionPropertyValueSummary[];
  values: Record<string, string>;
  bodyBlocks: NotionBlockNode[];
  bodyMarkdown: string;
  breadcrumbTrail: NotionBreadcrumbEntry[];
  comments: NotionCommentSummary[];
  rawPage?: NotionPage;
  rawComments?: NotionComment[];
}

export interface NotionChildPage {
  pageId: string;
  title: string;
  url: string | null;
  parentBlockId: string;
  relativePath: string;
  properties: Record<string, unknown>;
  propertyValues: NotionPropertyValueSummary[];
  bodyBlocks: NotionBlockNode[];
  bodyMarkdown: string;
  breadcrumbTrail: NotionBreadcrumbEntry[];
  childPages: NotionChildPage[];
  comments: NotionCommentSummary[];
  rawPage?: NotionPage;
  rawComments?: NotionComment[];
}

export interface NotionCommentSummary {
  commentId: string;
  objectType: string | null;
  partial: boolean;
  parentType: string | null;
  parentId: string | null;
  parent: Record<string, unknown>;
  discussionId: string | null;
  discussionKey: string;
  discussionIndex: number;
  discussionCommentCount: number;
  text: string;
  author: string | null;
  displayName?: { type: string | null; resolvedName: string | null };
  richText?: NotionRichTextSpanSummary[];
  references?: NotionReference[];
  attachments?: NotionCommentAttachmentSummary[];
  retrievalRequestStatus?: Record<string, unknown> | null;
  retrievalComplete?: boolean;
  retrievalHasMore?: boolean;
  retrievalNextCursor?: string | null;
  createdTime: string | null;
  lastEditedTime: string | null;
}

export interface NotionCommentAttachmentSummary {
  category: string | null;
  name: string | null;
  type: string | null;
  fileObject: NotionCommentAttachmentFileObjectSummary;
  fileUploadId: string | null;
  fileUploadFilename: string | null;
  fileUploadContentType: string | null;
  fileUploadContentLength: number | null;
  fileUploadStatus: string | null;
  fileUploadExpiryTime?: string | null;
  fileUploadCreatedTime?: string | null;
  fileUploadLastEditedTime?: string | null;
  fileUploadInTrash?: boolean | null;
  fileUploadArchived?: boolean | null;
  fileUploadCreatedBy?: { id: string | null; type: string | null } | null;
  fileUploadNumberOfParts?: { total: number | null; sent: number | null } | null;
  fileUploadImportResult?: {
    importedTime: string | null;
    type: string | null;
    error: NotionFileUploadImportErrorSummary | null;
  } | null;
  fileUploadUploadUrlRedacted?: boolean;
  fileUploadCompleteUrlRedacted?: boolean;
  url: string | null;
  urlRedacted: boolean;
  expiryTime: string | null;
}

export interface NotionCommentAttachmentFileObjectSummary {
  type: string | null;
  name: string | null;
  file: { url: string | null; urlRedacted: boolean; expiryTime: string | null } | null;
  external: { url: string | null; urlRedacted: boolean } | null;
  fileUpload: NotionCommentAttachmentFileUploadSummary | null;
}

export type NotionPropertyFileObjectSummary = NotionCommentAttachmentFileObjectSummary;

export interface NotionCommentAttachmentFileUploadSummary {
  id: string | null;
  filename: string | null;
  contentType: string | null;
  contentLength: number | null;
  status: string | null;
  expiryTime?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  inTrash?: boolean | null;
  archived?: boolean | null;
  createdBy?: { id: string | null; type: string | null } | null;
  numberOfParts?: { total: number | null; sent: number | null } | null;
  importResult?: {
    importedTime: string | null;
    type: string | null;
    error: NotionFileUploadImportErrorSummary | null;
  } | null;
  uploadUrlRedacted?: boolean;
  completeUrlRedacted?: boolean;
}

export interface NotionReference {
  kind:
    | "child_page"
    | "child_database"
    | "database_row_page"
    | "linked_page"
    | "linked_database"
    | "linked_comment"
    | "mention"
    | "synced_block"
    | "property_relation"
    | "property_user";
  pageId?: string;
  blockId?: string;
  commentId?: string;
  propertyId?: string | null;
  propertyName?: string | null;
  mentionType?: string | null;
  targetObjectType?: string | null;
  targetPartial?: boolean;
  targetId?: string | null;
  title?: string | null;
  url?: string | null;
  date?: NotionRichTextMentionSummary["date"];
  linkPreview?: NotionRichTextMentionSummary["linkPreview"];
  linkMention?: NotionRichTextMentionSummary["linkMention"];
  templateMention?: NotionRichTextMentionSummary["templateMention"];
  customEmoji?: NotionRichTextMentionSummary["customEmoji"];
}

export interface NotionSourceWarning {
  code: string;
  message: string;
  blockId?: string;
  propertyId?: string;
  type?: string;
  providerError?: NotionApiErrorSummary | null;
}

export interface NotionPropertyValueSummary {
  name: string;
  id: string | null;
  type: string;
  display: string;
  plainText: string;
  empty: boolean;
  hydration?: {
    hydrated: boolean;
    truncated: boolean;
    itemCount: number | null;
    pageCount: number | null;
    maxItems: number | null;
    nextCursor: string | null;
    nextUrl: string | null;
    cursorMissing?: boolean;
    propertyItem?: NotionPropertyItemSummary;
    propertyItems?: NotionPropertyItemSummary[];
    failed?: boolean;
    providerError?: NotionApiErrorSummary | null;
  };
  richText?: NotionRichTextSpanSummary[];
  mentions?: NotionRichTextMentionSummary[];
  linkUrls?: string[];
  relationIds?: string[];
  relationHasMore?: boolean | null;
  loadedRelationCount?: number;
  relationCount?: number;
  rollup?: {
    type: string | null;
    function: string | null;
    display: string;
    value: unknown;
    incomplete?: boolean;
    unsupported?: boolean;
  };
  formula?: { type: string | null; display: string; value: unknown };
  files?: Array<{
    name: string | null;
    type: string | null;
    fileObject: NotionPropertyFileObjectSummary;
    fileUploadId: string | null;
    filename: string | null;
    contentType: string | null;
    contentLength: number | null;
    status: string | null;
    fileUploadExpiryTime?: string | null;
    fileUploadCreatedTime?: string | null;
    fileUploadLastEditedTime?: string | null;
    fileUploadInTrash?: boolean | null;
    fileUploadArchived?: boolean | null;
    fileUploadCreatedBy?: { id: string | null; type: string | null } | null;
    fileUploadNumberOfParts?: { total: number | null; sent: number | null } | null;
    fileUploadImportResult?: {
      importedTime: string | null;
      type: string | null;
      error: NotionFileUploadImportErrorSummary | null;
    } | null;
    fileUploadUploadUrlRedacted?: boolean;
    fileUploadCompleteUrlRedacted?: boolean;
    expiryTime: string | null;
    url: string | null;
    urlRedacted: boolean;
  }>;
  people?: NotionUserSummary[];
  peopleGroups?: NotionUserSummary[];
  date?: { start: string | null; end: string | null; timeZone: string | null };
  number?: number | null;
  url?: string | null;
  urlRedacted?: boolean;
  email?: string | null;
  phoneNumber?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  lastVisitedTime?: string | null;
  createdBy?: NotionUserSummary;
  lastEditedBy?: NotionUserSummary;
  button?: Record<string, unknown>;
  checked?: boolean | null;
  uniqueId?: { prefix: string | null; number: number | null; value: string };
  verification?: {
    state: string | null;
    date: string;
    dateRange: { start: string | null; end: string | null; timeZone: string | null };
    verifiedBy?: NotionUserSummary | null;
  };
  place?: {
    lat: number | null;
    lon: number | null;
    name: string | null;
    address: string | null;
    awsPlaceId: string | null;
    googlePlaceId: string | null;
    unsupportedApiNull?: boolean;
  };
  optionNames?: string[];
  options?: Array<{ id: string | null; name: string | null; color: string | null }>;
  statusGroup?: { id: string | null; name: string | null; color: string | null; optionIds: string[] } | null;
}

export interface NotionPropertyItemSummary {
  object: string | null;
  id: string | null;
  type: string | null;
  nextUrl: string | null;
  value?: unknown;
}

export interface NotionRichTextSpanSummary {
  type: string;
  plainText: string;
  href: string | null;
  hrefRedacted: boolean;
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string | null;
  };
  text?: { content: string; link: string | null; linkRedacted: boolean };
  equation?: { expression: string };
  mention?: NotionRichTextMentionSummary;
}

export interface NotionRichTextMentionSummary {
  type: string;
  targetObjectType: string | null;
  targetPartial: boolean;
  targetId: string | null;
  title: string | null;
  url: string | null;
  urlRedacted: boolean;
  user?: NotionUserSummary;
  date?: { start: string | null; end: string | null; timeZone: string | null };
  linkPreview?: { url: string | null; urlRedacted: boolean };
  linkMention?: {
    href: string | null;
    hrefRedacted: boolean;
    title: string | null;
    description: string | null;
    provider: string | null;
    author: string | null;
    height: number | null;
    padding: number | null;
    paddingTop: number | null;
    thumbnailUrlRedacted: boolean;
    iconUrlRedacted: boolean;
    iframeUrlRedacted: boolean;
    attributes: NotionUnfurlAttributeSummary[];
  };
  templateMention?: Record<string, unknown> & {
    templateMentionType?: string | null;
    templateMentionDate?: string | null;
    templateMentionUser?: string | null;
  };
  customEmoji?: { id: string | null; name: string | null; urlRedacted: boolean };
}

export interface NotionUnfurlAttributeSummary {
  id: string | null;
  name: string | null;
  type: string | null;
  subtype: string | null;
  section: string | null;
  value: unknown;
  srcUrlRedacted: boolean;
}

export interface NotionUserSummary {
  id: string | null;
  objectType: string | null;
  type: string | null;
  name: string | null;
  email: string | null;
  emailVerified: boolean | null;
  avatarUrlRedacted: boolean;
  bot: {
    ownerType: string | null;
    ownerUser: NotionUserSummary | null;
    workspaceId: string | null;
    workspaceName: string | null;
    maxFileUploadSizeInBytes: number | null;
  } | null;
  partial: boolean;
}

type StructuredBlockResult = {
  blockTree: NotionBlockNode[];
  references: NotionReference[];
  warnings: NotionSourceWarning[];
};

type NotionBlockChildrenFetcher = (
  parentId: string,
  depth: number,
  activeBlockIds?: Set<string>,
) => Promise<NotionBlockNode[]>;

type NotionBlockTraversalFrame = {
  kind: "children";
  parentId: string;
  depth: number;
  activeBlockIds: Set<string>;
  target: NotionBlockNode[];
};

type NotionBlockFinalizeFrame = {
  kind: "finalize";
  node: NotionBlockNode;
  sourceBlockId: string | null;
  sourceDepth: number;
  sourceActiveBlockIds: Set<string>;
};

type NotionBlockFetchFrame = NotionBlockTraversalFrame | NotionBlockFinalizeFrame;

type InlineDataSourceRef = {
  id: string;
  title: string;
  database?: NotionDatabase | null;
  dataSource?: NotionDataSource | null;
};

type InlineViewQuerySnapshot = {
  queryId: string | null;
  expiresAt: string | null;
  pageSize: number | null;
  pagesFetched: number;
  queryDeleted: boolean;
  resultPageIds: string[];
  resultReferences: Array<Record<string, unknown>>;
  totalCount: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  requestStatus: Record<string, unknown> | null;
  complete: boolean;
  raw: Record<string, unknown>;
};

type MarkdownFetchResult = {
  markdown: string;
  structureMarkdown: string;
  truncated: boolean;
  unknownBlockIds: string[];
  warnings: NotionSourceWarning[];
};

type NotionPropertyItemCollection = {
  items: unknown[];
  terminalPropertyItem: Record<string, unknown> | null;
  pageCount: number;
  truncated: boolean;
  failed: boolean;
  cursorMissing: boolean;
  nextCursor: string | null;
  nextUrl: string | null;
  providerError: NotionApiErrorSummary | null;
};

type NotionHeadingOutlineEntry = {
  id: string;
  level: number;
  title: string;
};

type NotionRenderContext = {
  headingOutline: NotionHeadingOutlineEntry[];
  breadcrumbTrail: NotionBreadcrumbEntry[];
};

export async function fetchNotionPageContent(userId: string, pageId: string): Promise<NotionPageContent> {
  let page: NotionPage;
  try {
    page = await retrieveNotionPage(userId, pageId);
  } catch (err) {
    if (isDatabaseInsteadOfPageError(err)) {
      return fetchStandaloneDatabaseContent(userId, pageId);
    }
    if (isNotionNotFoundError(err)) {
      const collectionContent = await tryFetchStandaloneDatabaseContent(userId, pageId);
      if (collectionContent) return collectionContent;
    }
    throw err;
  }
  const markdown = await fetchPageMarkdownWithRecovery(userId, pageId);
  let title = extractNotionTitle(page) || "Untitled Notion page";
  const parent = notionParentInfo(page.parent);
  const structuredEnabled = structuredIngestionEnabled();
  const warnings = [...markdown.warnings];
  let properties: Record<string, unknown> = page.properties ?? {};
  let blockTree: NotionBlockNode[] = [];
  let references: NotionReference[] = [];
  let rowPages: NotionDatabaseRowPage[] = [];
  let childPages: NotionChildPage[] = [];
  let comments: NotionCommentSummary[] = [];
  let rawComments: NotionComment[] = [];
  let sections: NotionSection[];
  let structuredIngestion = false;
  let breadcrumbTrail: NotionBreadcrumbEntry[] = [];

  if (structuredEnabled) {
    const propertyResult = await hydratePaginatedProperties(userId, page);
    properties = propertyResult.properties;
    title = extractNotionTitle({ properties: properties as NotionPage["properties"] }) || title;
    warnings.push(...propertyResult.warnings);
    const commentResult = await fetchNotionComments(userId, page.id);
    comments = commentResult.comments;
    rawComments = commentResult.rawComments;
    warnings.push(...commentResult.warnings);

    try {
      const structured = await fetchStructuredBlocks(userId, pageId);
      blockTree = structured.blockTree;
      warnings.push(...structured.warnings);
      await hydrateInlineDatabases(userId, blockTree, warnings, new Set(), 0);
      childPages = flattenChildPages(await hydrateChildPages(userId, blockTree, warnings));
      breadcrumbTrail = blockTreeHasType(blockTree, "breadcrumb")
        ? await resolveBreadcrumbTrail(userId, page, title, warnings)
        : [];
      assignRenderedMarkdown(blockTree, { breadcrumbTrail });
      rowPages = collectInlineDatabaseRowPages(blockTree);
      references = [
        ...propertyValueReferences(summarizeNotionPropertyValues(title, properties), { pageId: page.id }),
        ...collectBlockReferences(blockTree),
        ...collectCommentReferences(comments),
        ...rowPages.flatMap((rowPage) => propertyValueReferences(rowPage.propertyValues, { pageId: rowPage.pageId })),
        ...childPages.flatMap((childPage) => collectChildPagePropertyReferences(childPage)),
        ...childPages.flatMap((childPage) => collectCommentReferences(childPage.comments)),
      ];
      sections = buildStructuredSections(page.id, title, blockTree, warnings, comments, properties, rowPages, breadcrumbTrail, page);
      structuredIngestion = true;
    } catch (err) {
      warnings.push({
        code: "structured_block_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      references = [
        ...propertyValueReferences(summarizeNotionPropertyValues(title, properties), { pageId: page.id }),
        ...collectCommentReferences(comments),
      ];
      sections = appendCommentSection(page.id, splitNotionMarkdown(title, markdown.structureMarkdown), comments, notionPageMetadataFact(page), warnings);
    }
  } else {
    sections = splitNotionMarkdown(title, markdown.structureMarkdown);
    references = propertyValueReferences(summarizeNotionPropertyValues(title, properties), { pageId: page.id });
  }

  return {
    pageId: page.id,
    title,
    url: page.url ?? null,
    ...parent,
    properties,
    propertyValues: summarizeNotionPropertyValues(title, properties),
    lastEditedTime: parseDate(page.last_edited_time),
    markdown: markdown.markdown,
    contentHash: structuredIngestion
      ? hashContent(JSON.stringify({
        markdown: markdown.markdown,
        properties: propertyFingerprint(title, properties),
        structure: blockTree.map(blockFingerprint),
        childPages: childPages.map(childPageFingerprint),
        breadcrumbTrail,
        comments,
        warnings: warnings.map((warning) => warning.code),
      }))
      : hashContent(markdown.markdown),
    markdownTruncated: markdown.truncated,
    unknownBlockIds: markdown.unknownBlockIds,
    sections,
    structuredIngestion,
    blockCoverage: blockCoverageFact(blockTree),
    blockTree,
    references: dedupeReferences(references),
    rowPages,
    childPages,
    comments,
    rawPage: page,
    breadcrumbTrail,
    nativeDatabases: collectNativeDatabases(blockTree),
    nativeDataSources: collectNativeDataSources(blockTree),
    rawComments,
    warnings,
  };
}

async function fetchStandaloneDatabaseContent(userId: string, databaseId: string): Promise<NotionPageContent> {
  const warnings: NotionSourceWarning[] = [];
  let title = "Untitled Notion database";
  let url: string | null = null;
  let parent: ReturnType<typeof notionParentInfo> = { parentType: null, parentId: null, dataSourceId: null };
  let properties: Record<string, unknown> = {};
  let lastEditedTime: Date | null = null;
  let inTrash = false;
  let rawDatabase: NotionDatabase | null = null;
  let rawDataSource: NotionDataSource | null = null;

  try {
    const database = await retrieveNotionDatabase(userId, databaseId);
    rawDatabase = database;
    title = extractNotionTitle(database) || title;
    url = database.url ?? null;
    parent = notionParentInfo(database.parent);
    properties = database.properties ?? {};
    lastEditedTime = parseDate(database.last_edited_time);
    inTrash = database.in_trash === true || database.archived === true;
  } catch (databaseErr) {
    if (!isNotionNotFoundError(databaseErr)) throw databaseErr;
    const dataSource = await retrieveNotionDataSource(userId, databaseId);
    rawDataSource = dataSource;
    title = extractNotionTitle(dataSource) || title;
    url = dataSource.url ?? null;
    parent = notionParentInfo(dataSource.database_parent ?? dataSource.parent);
    properties = dataSource.properties ?? {};
    lastEditedTime = parseDate(dataSource.last_edited_time);
    warnings.push({
      code: "standalone_database_metadata_fallback",
      blockId: databaseId,
      message: databaseErr instanceof Error ? databaseErr.message : String(databaseErr),
    });
  }

  const block: NotionBlockNode = {
    id: databaseId,
    type: "child_database",
    parentId: parent.parentId,
    depth: 0,
    order: 0,
    hasChildren: false,
    inTrash,
    text: title,
    markdown: "",
    inlineDataSources: undefined,
    rawBlock: {
      object: "block",
      id: databaseId,
      type: "child_database",
      parent: parentFromInfo(parent.parentType, parent.parentId),
      archived: false,
      in_trash: inTrash,
      has_children: false,
      child_database: { title },
    },
    children: [],
    references: [{ kind: "child_database", blockId: databaseId, targetId: databaseId, title }],
    comments: [],
    rawComments: [],
    warnings: [],
  };

  await hydrateInlineDatabases(userId, [block], warnings, new Set(), 0);
  const blockTree = [block];
  assignRenderedMarkdown(blockTree);
  const markdown = renderBlocks(blockTree).trim();
  const references = collectBlockReferences(blockTree);
  const rowPages = collectInlineDatabaseRowPages(blockTree);
  const rawPage: NotionPage = {
    object: "page",
    id: databaseId,
    url: url ?? undefined,
    parent: parentFromInfo(parent.parentType, parent.parentId),
    properties: {
      Title: { type: "title", title: [{ type: "text", plain_text: title, text: { content: title } }] },
      ...properties,
    } as Record<string, Record<string, unknown>>,
    last_edited_time: lastEditedTime?.toISOString(),
    in_trash: inTrash,
    is_archived: inTrash,
    archived: inTrash,
  };
  const sections = buildStructuredSections(databaseId, title, blockTree, warnings, [], properties, rowPages, [], rawPage);

  return {
    pageId: databaseId,
    title,
    url,
    ...parent,
    dataSourceId: block.inlineDataSources?.[0]?.dataSourceId ?? parent.dataSourceId,
    properties,
    propertyValues: summarizeNotionPropertyValues(title, properties),
    lastEditedTime,
    markdown,
    contentHash: hashContent(JSON.stringify({
      markdown,
      properties: propertyFingerprint(title, properties),
      structure: blockTree.map(blockFingerprint),
      warnings: warnings.map((warning) => warning.code),
    })),
    markdownTruncated: false,
    unknownBlockIds: [],
    sections,
    structuredIngestion: true,
    blockCoverage: blockCoverageFact(blockTree),
    blockTree,
    references,
    rowPages,
    childPages: [],
    comments: [],
    rawPage,
    breadcrumbTrail: [],
    nativeDatabases: rawDatabase ? [rawDatabase, ...collectNativeDatabases(blockTree)] : collectNativeDatabases(blockTree),
    nativeDataSources: rawDataSource ? [rawDataSource, ...collectNativeDataSources(blockTree)] : collectNativeDataSources(blockTree),
    rawComments: [],
    warnings,
  };
}

async function tryFetchStandaloneDatabaseContent(userId: string, id: string): Promise<NotionPageContent | null> {
  try {
    return await fetchStandaloneDatabaseContent(userId, id);
  } catch (err) {
    if (!isNotionNotFoundError(err)) throw err;
    return null;
  }
}

function isDatabaseInsteadOfPageError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("is a database, not a page") || message.includes("Use the retrieve database API instead");
}

function isNotionNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("(404)") || message.toLowerCase().includes("could not find");
}

function parentFromInfo(parentType: string | null, parentId: string | null): NotionPage["parent"] {
  if (!parentType) return undefined;
  if (parentType === "workspace") return { type: parentType, workspace: true };
  if (!parentId) return undefined;
  if (parentType === "page_id") return { type: parentType, page_id: parentId };
  if (parentType === "database_id") return { type: parentType, database_id: parentId };
  if (parentType === "data_source_id") return { type: parentType, data_source_id: parentId };
  if (parentType === "block_id") return { type: parentType, block_id: parentId };
  if (parentType === "agent_id") return { type: parentType, agent_id: parentId };
  return { type: parentType };
}

export function summarizeNotionPageMetadata(page: NotionPage): NotionPageMetadataSummary {
  const parent = notionParentInfo(page.parent);
  const title = extractNotionTitle(page) || "Untitled Notion page";
  const propertySummaries = Object.entries(page.properties ?? {}).map(([name, property]) => ({
    name,
    type: stringValue(recordValue(property).type) ?? "unknown",
  }));
  return {
    object: page.object,
    pageId: page.id,
    title,
    url: page.url ?? null,
    publicUrl: page.public_url ?? null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    dataSourceId: parent.dataSourceId,
    databaseId: databaseIdFromParent(page.parent),
    properties: page.properties ?? {},
    createdTime: parseDate(page.created_time),
    lastEditedTime: parseDate(page.last_edited_time),
    createdBy: page.created_by ? personSummary(page.created_by) : null,
    lastEditedBy: page.last_edited_by ? personSummary(page.last_edited_by) : null,
    archived: Boolean(page.is_archived || page.archived),
    inTrash: Boolean(page.in_trash),
    isLocked: Boolean(page.is_locked),
    icon: blockIconSummary(page.icon),
    cover: pageCoverSummary(page.cover),
    propertyCount: propertySummaries.length,
    propertyNames: propertySummaries.map((property) => property.name),
    propertyTypes: countBy(propertySummaries.map((property) => property.type)),
  };
}

function notionPageMetadataFact(page: NotionPage | null | undefined): Record<string, unknown> | null {
  if (!page) return null;
  // Section facts intentionally keep only aggregate property metadata; the raw
  // property map is persisted in notion_page_summaries.properties instead.
  const metadata = summarizeNotionPageMetadata(page);
  return {
    object: metadata.object,
    pageId: metadata.pageId,
    title: metadata.title,
    url: metadata.url,
    publicUrl: metadata.publicUrl,
    parentType: metadata.parentType,
    parentId: metadata.parentId,
    dataSourceId: metadata.dataSourceId,
    databaseId: metadata.databaseId,
    createdTime: page.created_time ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    createdBy: metadata.createdBy,
    lastEditedBy: metadata.lastEditedBy,
    archived: metadata.archived,
    inTrash: metadata.inTrash,
    isLocked: metadata.isLocked,
    icon: metadata.icon,
    cover: metadata.cover,
    propertyCount: metadata.propertyCount,
    propertyNames: metadata.propertyNames,
    propertyTypes: metadata.propertyTypes,
  };
}

export function buildStructuredSections(
  pageId: string,
  pageTitle: string,
  blockTree: NotionBlockNode[],
  pageWarnings: NotionSourceWarning[] = [],
  pageComments: NotionCommentSummary[] = [],
  pageProperties: Record<string, unknown> = {},
  rowPages: NotionDatabaseRowPage[] = collectInlineDatabaseRowPages(blockTree),
  breadcrumbTrail: NotionBreadcrumbEntry[] = [],
  pageMetadata?: NotionPage | null,
): NotionSection[] {
  const pageRenderContext = renderContextForBlocks(blockTree, { breadcrumbTrail });
  const pageMetadataFact = notionPageMetadataFact(pageMetadata);
  const nestedHeadingSections = () => collectNestedHeadingSections(pageId, blockTree, pageRenderContext, pageWarnings, pageMetadataFact);
  const withRowPageSections = (sections: NotionSection[]): NotionSection[] => [
    ...sections,
    ...nestedHeadingSections(),
    ...rowPages
      .filter(rowPageHasSearchableContent)
      .map((rowPage) => rowPageSectionRecord(pageId, rowPage)),
  ];

  const withPropertySection = (sections: NotionSection[]): NotionSection[] => {
    const propertySection = pagePropertySectionRecord(pageId, pageTitle, pageProperties);
    return propertySection ? [propertySection, ...sections] : sections;
  };

  const topLevelHeadings = blockTree.filter((block) => HEADING_TYPES.has(block.type));
  if (topLevelHeadings.length === 0) {
    const content = renderBlocks(blockTree, pageRenderContext).trim();
    return appendCommentSection(pageId, withPropertySection(withRowPageSections([sectionRecord({
      pageId,
      idSuffix: "page-body",
      title: pageTitle,
      kind: "page_body",
      anchorBlockId: null,
      rootBlocks: blockTree,
      content,
      warnings: pageWarnings,
      tableOfContentsHeadingOutline: pageRenderContext.headingOutline,
      breadcrumbTrail: pageRenderContext.breadcrumbTrail,
      pageMetadata: pageMetadataFact,
    })])), pageComments, pageMetadataFact, pageWarnings);
  }

  const sections: NotionSection[] = [];
  let currentBlocks: NotionBlockNode[] = [];
  let currentHeading: NotionBlockNode | null = null;

  const flush = () => {
    if (!currentHeading && currentBlocks.length === 0) return;
    const rootBlocks = currentHeading ? [currentHeading, ...currentBlocks] : currentBlocks;
    const content = renderBlocks(rootBlocks, pageRenderContext).trim();
    sections.push(sectionRecord({
      pageId,
      idSuffix: currentHeading ? `block:${currentHeading.id}` : "page-intro",
      title: currentHeading?.text || pageTitle,
      kind: currentHeading ? "heading" : "page_intro",
      anchorBlockId: currentHeading?.id ?? null,
      rootBlocks,
      content,
      warnings: warningsForBlocks(rootBlocks, pageWarnings),
      tableOfContentsHeadingOutline: pageRenderContext.headingOutline,
      breadcrumbTrail: pageRenderContext.breadcrumbTrail,
      pageMetadata: pageMetadataFact,
    }));
  };

  for (const block of blockTree) {
    if (HEADING_TYPES.has(block.type)) {
      flush();
      currentHeading = block;
      currentBlocks = [];
    } else if (currentHeading) {
      currentBlocks.push(block);
    } else {
      currentBlocks.push(block);
    }
  }
  flush();

  const fallbackSections = sections.length > 0 ? sections : [sectionRecord({
    pageId,
    idSuffix: "page-body",
    title: pageTitle,
    kind: "page_body",
    anchorBlockId: null,
    rootBlocks: blockTree,
    content: renderBlocks(blockTree, pageRenderContext).trim(),
    warnings: pageWarnings,
    tableOfContentsHeadingOutline: pageRenderContext.headingOutline,
    breadcrumbTrail: pageRenderContext.breadcrumbTrail,
    pageMetadata: pageMetadataFact,
  })];
  return appendCommentSection(pageId, withPropertySection(withRowPageSections(fallbackSections)), pageComments, pageMetadataFact, pageWarnings);
}

function collectNestedHeadingSections(
  pageId: string,
  blockTree: NotionBlockNode[],
  context: NotionRenderContext,
  pageWarnings: NotionSourceWarning[],
  pageMetadata?: Record<string, unknown> | null,
): NotionSection[] {
  const sections: NotionSection[] = [];
  const visitSiblings = (siblings: NotionBlockNode[]) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const block = siblings[index]!;
      if (HEADING_TYPES.has(block.type) && block.depth > 0) {
        const rootBlocks = nestedHeadingRootBlocks(siblings, index);
        const content = renderBlocks(rootBlocks, context).trim();
        sections.push(nestedHeadingSectionRecord({
          pageId,
          heading: block,
          rootBlocks,
          content,
          warnings: warningsForBlocks(rootBlocks, pageWarnings),
          tableOfContentsHeadingOutline: context.headingOutline,
          breadcrumbTrail: context.breadcrumbTrail,
          pageMetadata,
        }));
      }
      visitSiblings(block.children);
    }
  };

  visitSiblings(blockTree);
  return sections;
}

function nestedHeadingRootBlocks(siblings: NotionBlockNode[], headingIndex: number): NotionBlockNode[] {
  const heading = siblings[headingIndex];
  if (!heading) return [];
  const blocks = [heading];
  for (let index = headingIndex + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index]!;
    if (HEADING_TYPES.has(sibling.type)) break;
    blocks.push(sibling);
  }
  return blocks;
}

async function fetchPageMarkdownWithRecovery(userId: string, pageId: string): Promise<MarkdownFetchResult> {
  const markdown = await retrieveNotionPageMarkdown(userId, pageId);
  const extraMarkdown: string[] = [];
  const warnings: NotionSourceWarning[] = [];
  let recoveredUnknownBlockChars = 0;
  let recoveredUnknownBlockRequests = 0;

  if (markdown.truncated && markdown.unknown_block_ids.length > 0) {
    for (const blockId of markdown.unknown_block_ids) {
      if (recoveredUnknownBlockRequests >= UNKNOWN_BLOCK_RECOVERY_MAX_REQUESTS) break;
      if (recoveredUnknownBlockChars >= UNKNOWN_BLOCK_RECOVERY_MAX_CHARS) break;
      recoveredUnknownBlockRequests++;
      try {
        const blockMarkdown = await retrieveNotionPageMarkdown(userId, blockId);
        const sanitizedMarkdown = stripMediaFromMarkdown(blockMarkdown.markdown);
        if (sanitizedMarkdown.trim()) {
          const fragment = `\n\n## Notion block ${blockId}\n\n${sanitizedMarkdown}`;
          const remaining = UNKNOWN_BLOCK_RECOVERY_MAX_CHARS - recoveredUnknownBlockChars;
          extraMarkdown.push(fragment.length > remaining ? fragment.slice(0, remaining) : fragment);
          recoveredUnknownBlockChars += Math.min(fragment.length, remaining);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("(404)")) throw err;
        warnings.push({
          code: "unknown_block_inaccessible",
          blockId,
          message: `Notion markdown reported unknown block ${blockId}, but the block was not accessible.`,
        });
      }
    }
  }

  if (markdown.truncated && recoveredUnknownBlockRequests < markdown.unknown_block_ids.length) {
    warnings.push({
      code: "unknown_block_recovery_capped",
      message: "Notion markdown unknown-block recovery hit the configured request or character cap.",
    });
  }

  const joinedMarkdown = `${markdown.markdown}${extraMarkdown.join("")}`;
  const structureMarkdown = stripMediaFromMarkdown(joinedMarkdown, { preserveRedactedMediaMarkers: true }).trim();
  return {
    markdown: stripRedactedMediaMarkers(structureMarkdown).trim(),
    structureMarkdown,
    truncated: markdown.truncated,
    unknownBlockIds: markdown.unknown_block_ids,
    warnings,
  };
}

async function fetchStructuredBlocks(userId: string, pageId: string): Promise<StructuredBlockResult> {
  const warnings: NotionSourceWarning[] = [];
  const references: NotionReference[] = [];
  let blockCount = 0;
  let requestCount = 0;

  const appendInlineChildren = async (
    parentNode: NotionBlockNode,
    inlineChildren: NotionBlock[],
    depth: number,
    activeBlockIds: Set<string>,
    childFrames: NotionBlockTraversalFrame[],
    finalizeFrames: NotionBlockFinalizeFrame[],
  ): Promise<void> => {
    if (depth > STRUCTURED_BLOCK_MAX_DEPTH) {
      warnings.push({
        code: "block_depth_capped",
        blockId: parentNode.id,
        message: `Notion inline block traversal exceeded max depth ${STRUCTURED_BLOCK_MAX_DEPTH}.`,
      });
      return;
    }

    let order = 0;
    for (const inlineBlock of inlineChildren) {
      if (blockCount >= STRUCTURED_BLOCK_MAX_BLOCKS) {
        warnings.push({
          code: "block_count_capped",
          blockId: parentNode.id,
          message: `Notion inline block traversal exceeded max block count ${STRUCTURED_BLOCK_MAX_BLOCKS}.`,
        });
        break;
      }
      if (activeBlockIds.has(inlineBlock.id)) {
        warnings.push({
          code: "block_cycle_skipped",
          blockId: inlineBlock.id,
          message: `Skipped recursive Notion inline block ${inlineBlock.id} because it already exists in the active traversal path.`,
        });
        continue;
      }

      blockCount++;
      const hydratedBlock = await hydratePartialBlock(userId, inlineBlock, warnings);
      const node = blockToNode(hydratedBlock, depth, order++);
      if (node.parentId === null) node.parentId = parentNode.id;
      parentNode.children.push(node);
      references.push(...node.references);
      warnings.push(...node.warnings);

      const descendantActiveBlockIds = new Set(activeBlockIds);
      descendantActiveBlockIds.add(node.id);
      const nestedInlineChildren = inlineBlockChildren(hydratedBlock, node.type);
      if (nestedInlineChildren.length > 0) {
        await appendInlineChildren(node, nestedInlineChildren, depth + 1, descendantActiveBlockIds, childFrames, finalizeFrames);
      } else if (node.hasChildren) {
        childFrames.push({
          kind: "children",
          parentId: node.id,
          depth: depth + 1,
          activeBlockIds: descendantActiveBlockIds,
          target: node.children,
        });
      }

      finalizeFrames.push({
        kind: "finalize",
        node,
        sourceBlockId: syncedFromBlockId(hydratedBlock),
        sourceDepth: depth + 1,
        sourceActiveBlockIds: descendantActiveBlockIds,
      });
    }
  };

  const fetchChildren: NotionBlockChildrenFetcher = async (parentId, depth, activeBlockIds = new Set<string>()) => {
    const rootChildren: NotionBlockNode[] = [];
    const stack: NotionBlockFetchFrame[] = [{
      kind: "children",
      parentId,
      depth,
      activeBlockIds,
      target: rootChildren,
    }];

    while (stack.length > 0) {
      const frame = stack.pop()!;

      if (frame.kind === "finalize") {
        if (frame.node.type === "synced_block" && frame.node.children.length === 0 && frame.sourceBlockId) {
          frame.node.children = await fetchSyncedBlockSourceChildren(
            frame.sourceBlockId,
            frame.node.id,
            frame.sourceDepth,
            frame.sourceActiveBlockIds,
            fetchChildren,
            references,
            warnings,
          );
        }
        frame.node.markdown = renderBlock(frame.node);
        continue;
      }

      if (frame.depth > STRUCTURED_BLOCK_MAX_DEPTH) {
        warnings.push({
          code: "block_depth_capped",
          blockId: frame.parentId,
          message: `Notion block traversal exceeded max depth ${STRUCTURED_BLOCK_MAX_DEPTH}.`,
        });
        continue;
      }
      if (frame.activeBlockIds.has(frame.parentId)) {
        warnings.push({
          code: "block_cycle_skipped",
          blockId: frame.parentId,
          message: `Skipped recursive Notion block fetch for ${frame.parentId} because it already exists in the active traversal path.`,
        });
        continue;
      }

      const childActiveBlockIds = new Set(frame.activeBlockIds);
      childActiveBlockIds.add(frame.parentId);
      const childFrames: NotionBlockTraversalFrame[] = [];
      const finalizeFrames: NotionBlockFinalizeFrame[] = [];
      let cursor: string | null = null;
      let order = 0;
      do {
        if (requestCount >= STRUCTURED_BLOCK_MAX_REQUESTS) {
          warnings.push({
            code: "block_request_capped",
            blockId: frame.parentId,
            message: `Notion block fetch exceeded max request count ${STRUCTURED_BLOCK_MAX_REQUESTS}.`,
          });
          break;
        }
        if (blockCount >= STRUCTURED_BLOCK_MAX_BLOCKS) {
          warnings.push({
            code: "block_count_capped",
            blockId: frame.parentId,
            message: `Notion block fetch exceeded max block count ${STRUCTURED_BLOCK_MAX_BLOCKS}.`,
          });
          break;
        }

        requestCount++;
        const response = await retrieveNotionBlockChildren(userId, frame.parentId, {
          startCursor: cursor,
          pageSize: 100,
        });
        for (const block of response.results) {
          if (blockCount >= STRUCTURED_BLOCK_MAX_BLOCKS) break;
          if (childActiveBlockIds.has(block.id)) {
            warnings.push({
              code: "block_cycle_skipped",
              blockId: block.id,
              message: `Skipped recursive Notion block ${block.id} because it already exists in the active traversal path.`,
            });
            continue;
          }
          blockCount++;
          const hydratedBlock = await hydratePartialBlock(userId, block, warnings);
          const node = blockToNode(hydratedBlock, frame.depth, order++);
          if (node.parentId === null) node.parentId = frame.parentId;
          frame.target.push(node);
          const inlineChildren = inlineBlockChildren(hydratedBlock, node.type);
          if (inlineChildren.length > 0) {
            const inlineActiveBlockIds = new Set(childActiveBlockIds);
            inlineActiveBlockIds.add(node.id);
            await appendInlineChildren(node, inlineChildren, frame.depth + 1, inlineActiveBlockIds, childFrames, finalizeFrames);
          } else if (node.hasChildren) {
            childFrames.push({
              kind: "children",
              parentId: node.id,
              depth: frame.depth + 1,
              activeBlockIds: childActiveBlockIds,
              target: node.children,
            });
          }
          finalizeFrames.push({
            kind: "finalize",
            node,
            sourceBlockId: syncedFromBlockId(hydratedBlock),
            sourceDepth: frame.depth + 1,
            sourceActiveBlockIds: childActiveBlockIds,
          });
          references.push(...node.references);
          warnings.push(...node.warnings);
        }
        const nextCursor = response.has_more ? stringValue(response.next_cursor) : null;
        if (response.has_more && !nextCursor) {
          warnings.push({
            code: "block_child_pagination_cursor_missing",
            blockId: frame.parentId,
            message: `Notion reported more children for ${frame.parentId} but did not return a usable next cursor.`,
          });
        }
        cursor = nextCursor;
      } while (cursor);

      for (let index = finalizeFrames.length - 1; index >= 0; index--) {
        stack.push(finalizeFrames[index]);
      }
      for (let index = childFrames.length - 1; index >= 0; index--) {
        stack.push(childFrames[index]);
      }
    }

    return rootChildren;
  };

  const blockTree = await fetchChildren(pageId, 0);
  await hydrateBlockComments(userId, blockTree, warnings);
  assignRenderedMarkdown(blockTree);
  return { blockTree, references, warnings };
}

async function hydrateBlockComments(
  userId: string,
  blocks: NotionBlockNode[],
  warnings: NotionSourceWarning[],
): Promise<void> {
  const flat = flattenBlocks(blocks);
  for (const [index, block] of flat.entries()) {
    if (index >= BLOCK_COMMENT_FETCH_MAX_BLOCKS) {
      warnings.push({
        code: "block_comment_fetch_cap_reached",
        blockId: block.id,
        message: `Notion block comment hydration exceeded max block count ${BLOCK_COMMENT_FETCH_MAX_BLOCKS}.`,
      });
      break;
    }
    const result = await fetchNotionComments(userId, block.id);
    block.comments = result.comments;
    block.rawComments = result.rawComments;
    warnings.push(...result.warnings.map((warning) => ({ ...warning, blockId: block.id })));
  }
}

async function hydratePartialBlock(
  userId: string,
  block: NotionBlock,
  warnings: NotionSourceWarning[],
): Promise<NotionBlock> {
  const type = typeof block.type === "string" ? block.type : null;
  if (type && recordValue(block[type]) === block[type]) return block;

  try {
    return await retrieveNotionBlock(userId, block.id);
  } catch (err) {
    warnings.push({
      code: "block_hydration_failed",
      blockId: block.id,
      type: type ?? undefined,
      message: err instanceof Error ? err.message : String(err),
    });
    return block;
  }
}

function inlineBlockChildren(block: NotionBlock, type: string): NotionBlock[] {
  const value = recordValue(block[type]);
  return arrayValue(value.children).filter((child): child is NotionBlock => {
    const record = recordValue(child);
    return (record.object === "block" || record.object === undefined)
      && Boolean(stringValue(record.id))
      && Boolean(stringValue(record.type));
  });
}

async function fetchSyncedBlockSourceChildren(
  sourceBlockId: string,
  copyBlockId: string,
  depth: number,
  activeBlockIds: Set<string>,
  fetchChildren: NotionBlockChildrenFetcher,
  references: NotionReference[],
  warnings: NotionSourceWarning[],
): Promise<NotionBlockNode[]> {
  try {
    const sourceWarningStart = warnings.length;
    const children = await fetchChildren(sourceBlockId, depth, activeBlockIds);
    anchorSyncedSourceWarnings(warnings.slice(sourceWarningStart), copyBlockId, sourceBlockId, warnings);
    if (children.length === 0) return children;
    markSyncedSourceChildren(children, copyBlockId, sourceBlockId);
    collectSyncedSourceAnnotations(children, references, warnings);
    warnings.push({
      code: "synced_block_source_expanded",
      blockId: copyBlockId,
      message: `Expanded synced block copy ${copyBlockId} from source block ${sourceBlockId}.`,
    });
    return children;
  } catch (err) {
    warnings.push({
      code: "synced_block_source_fetch_failed",
      blockId: copyBlockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function anchorSyncedSourceWarnings(
  sourceWarnings: NotionSourceWarning[],
  copyBlockId: string,
  sourceBlockId: string,
  warnings: NotionSourceWarning[],
): void {
  for (const warning of sourceWarnings) {
    if (!warning.blockId || warning.blockId === copyBlockId) continue;
    warnings.push({
      ...warning,
      blockId: copyBlockId,
      message: `${warning.message} (while expanding synced block source ${sourceBlockId}).`,
    });
  }
}

function collectSyncedSourceAnnotations(
  children: NotionBlockNode[],
  references: NotionReference[],
  warnings: NotionSourceWarning[],
): void {
  for (const child of children) {
    references.push(...child.references.filter((reference) => reference.kind === "synced_block" && reference.title === "synced_source_child"));
    warnings.push(...child.warnings.filter((warning) => warning.code === "synced_block_source_child"));
    collectSyncedSourceAnnotations(child.children, references, warnings);
  }
}

function markSyncedSourceChildren(children: NotionBlockNode[], parentId: string, sourceBlockId: string): void {
  for (const child of children) {
    child.parentId = parentId;
    child.references.push({
      kind: "synced_block",
      blockId: child.id,
      targetId: sourceBlockId,
      title: "synced_source_child",
    });
    child.warnings.push({
      code: "synced_block_source_child",
      blockId: child.id,
      message: `Block ${child.id} was expanded from synced block source ${sourceBlockId}.`,
    });
    markSyncedSourceChildren(child.children, child.id, sourceBlockId);
  }
}

function syncedFromBlockId(block: NotionBlock): string | null {
  if (block.type !== "synced_block") return null;
  const value = recordValue(block.synced_block);
  return stringValue(recordValue(value.synced_from).block_id);
}

function blockToNode(block: NotionBlock, depth: number, order: number): NotionBlockNode {
  const type = typeof block.type === "string" ? block.type : "unknown";
  const content = blockContent(block, type);
  const warnings: NotionSourceWarning[] = [];
  const references: NotionReference[] = blockReferences(block, type, content);

  if (type === "unsupported") {
    const unsupportedType = unsupportedBlockType(block);
    warnings.push({
      code: "unsupported_block",
      blockId: block.id,
      type: unsupportedType ?? undefined,
      message: `Notion returned unsupported block type ${unsupportedType ?? "unknown"}.`,
    });
  } else if (!knownBlockType(type)) {
    warnings.push({
      code: "unknown_block_type",
      blockId: block.id,
      type,
      message: `Notion returned unrecognized block type ${type}.`,
    });
  }

  return {
    id: block.id,
    type,
    parentId: blockParentId(block.parent),
    depth,
    order,
    hasChildren: block.has_children === true,
    archived: notionBlockArchivedState(block),
    inTrash: notionBlockInTrashState(block),
    text: content.text,
    caption: content.caption,
    richText: content.richText,
    captionRichText: content.captionRichText,
    titleRichText: content.titleRichText,
    icon: content.icon,
    meetingNotes: content.meetingNotes,
    markdown: "",
    checked: content.checked,
    color: content.color,
    isToggleable: content.isToggleable,
    listStartIndex: content.listStartIndex,
    listFormat: content.listFormat,
    widthRatio: content.widthRatio,
    tableWidth: content.tableWidth,
    hasColumnHeader: content.hasColumnHeader,
    hasRowHeader: content.hasRowHeader,
    url: content.url,
    language: content.language,
    tableCells: content.tableCells,
    tableCellRichText: content.tableCellRichText,
    inlineDataSources: undefined,
    comments: [],
    rawComments: [],
    rawBlock: block,
    children: [],
    references,
    warnings,
  };
}

function blockContent(block: NotionBlock, type: string): {
  text: string;
  caption?: string;
  richText?: NotionRichTextSpanSummary[];
  captionRichText?: NotionRichTextSpanSummary[];
  titleRichText?: NotionRichTextSpanSummary[];
  icon?: NotionBlockIconSummary | null;
  meetingNotes?: NotionMeetingNotesSummary;
  checked?: boolean;
  color?: string | null;
  isToggleable?: boolean;
  listStartIndex?: number | null;
  listFormat?: string | null;
  widthRatio?: number | null;
  tableWidth?: number | null;
  hasColumnHeader?: boolean;
  hasRowHeader?: boolean;
  url?: string | null;
  language?: string | null;
  tableCells?: string[];
  tableCellRichText?: NotionRichTextSpanSummary[][];
} {
  const value = recordValue(block[type]);
  const richText = richTextMarkdown(arrayValue(value.rich_text));
  const caption = richTextMarkdown(arrayValue(value.caption));
  const titleRichText = richTextMarkdown(arrayValue(value.title));
  const richTextSpans = summarizeNotionRichText(arrayValue(value.rich_text));
  const captionRichTextSpans = summarizeNotionRichText(arrayValue(value.caption));
  const titleRichTextSpans = summarizeNotionRichText(arrayValue(value.title));
  const title = stringValue(value.title);
  const expression = stringValue(value.expression);
  const language = stringValue(value.language);
  const url = stringValue(value.url) ?? fileUrl(value);
  const metadata = {
    icon: blockIconSummary(value.icon),
    color: stringValue(value.color),
    isToggleable: booleanValue(value.is_toggleable),
    listStartIndex: numberValue(value.list_start_index),
    listFormat: stringValue(value.list_format),
    widthRatio: numberValue(value.width_ratio),
    tableWidth: numberValue(value.table_width),
    hasColumnHeader: booleanValue(value.has_column_header),
    hasRowHeader: booleanValue(value.has_row_header),
  };

  if (type === "child_page" || type === "child_database") {
    return { text: title ?? "", titleRichText: titleRichTextSpans, url, ...metadata };
  }
  if (type === "meeting_notes" || type === "transcription") {
    const meetingNotes = meetingNotesSummary(value, titleRichText);
    return { text: meetingNotes.title, titleRichText: titleRichTextSpans, meetingNotes, ...metadata };
  }
  if (type === "equation") return { text: expression ?? "", ...metadata };
  if (type === "code") {
    return {
      text: richText,
      caption: stripMediaUrlsFromText(caption).trim(),
      richText: richTextSpans,
      captionRichText: captionRichTextSpans,
      language,
      ...metadata,
    };
  }
  if (type === "to_do") return { text: richText, richText: richTextSpans, checked: value.checked === true, ...metadata };
  if (mediaBlockType(type)) {
    const safeCaption = stripMediaUrlsFromText(caption).trim();
    return {
      text: mediaBlockDisplayText(type, value, safeCaption),
      caption: safeCaption,
      captionRichText: captionRichTextSpans,
      url,
      ...metadata,
    };
  }
  if (type === "table_row") {
    const cellRichText = arrayValue(value.cells).map((cell) => summarizeNotionRichText(arrayValue(cell)));
    const cells = arrayValue(value.cells).map((cell) => richTextMarkdown(arrayValue(cell)));
    return { text: cells.join("\t"), tableCells: cells, tableCellRichText: cellRichText, ...metadata };
  }
  if (richText) return { text: richText, richText: richTextSpans, url, ...metadata };
  if (caption) return { text: caption, captionRichText: captionRichTextSpans, url, ...metadata };
  if (title) return { text: title, titleRichText: titleRichTextSpans, url, ...metadata };
  if (url) return { text: url, url, ...metadata };
  return { text: "", ...metadata };
}

function blockReferences(block: NotionBlock, type: string, content: { text: string; url?: string | null }): NotionReference[] {
  const value = recordValue(block[type]);
  const richTextRefs = richTextReferencesFromBlock(value).map((ref) => ({ ...ref, blockId: block.id }));
  if (type === "child_page") {
    return [{ kind: "child_page", blockId: block.id, targetId: block.id, title: content.text || null }, ...richTextRefs];
  }
  if (type === "child_database") {
    return [{ kind: "child_database", blockId: block.id, targetId: block.id, title: content.text || null }, ...richTextRefs];
  }
  if (type === "link_to_page") {
    const link = recordValue(value.link_to_page ?? value);
    const linkType = stringValue(link.type);
    const pageId = stringValue(link.page_id);
    const databaseId = stringValue(link.database_id);
    const commentId = stringValue(link.comment_id);
    return [{
      kind: linkType === "database_id" || databaseId
        ? "linked_database"
        : linkType === "comment_id" || commentId
          ? "linked_comment"
          : "linked_page",
      blockId: block.id,
      targetObjectType: linkType === "database_id" || databaseId
        ? "database"
        : linkType === "comment_id" || commentId
          ? "comment"
          : "page",
      targetId: pageId ?? databaseId ?? commentId ?? null,
      title: content.text || null,
    }, ...richTextRefs];
  }
  if (type === "synced_block") {
    const syncedFrom = recordValue(value.synced_from);
    return [{
      kind: "synced_block",
      blockId: block.id,
      targetId: stringValue(syncedFrom.block_id) ?? null,
    }, ...richTextRefs];
  }
  return richTextRefs;
}

function renderBlocks(blocks: NotionBlockNode[], context: NotionRenderContext = renderContextForBlocks(blocks)): string {
  const rendered: string[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index];
    if (block?.type === "numbered_list_item") {
      const group = collectConsecutiveNumberedListItems(blocks, index);
      rendered.push(...renderNumberedListGroup(group, context));
      index += group.length;
      continue;
    }
    const markdown = block ? renderBlock(block, context) : "";
    if (markdown) rendered.push(markdown);
    index += 1;
  }
  return rendered.filter(Boolean).join("\n\n");
}

function renderIconPrefix(icon?: NotionBlockIconSummary | null): string {
  if (!icon) return "";
  if (icon.emoji) return `${icon.emoji} `;
  if (icon.name) return `[icon:${icon.name}] `;
  if (icon.customEmojiId) return `[icon:${icon.customEmojiId}] `;
  if (icon.fileUploadId) return `[icon:file_upload:${icon.fileUploadId}] `;
  if (icon.url) return `[icon:${icon.url}] `;
  if (icon.urlRedacted) return "[icon:redacted] ";
  return icon.type ? `[icon:${icon.type}] ` : "";
}

function mediaBlockDisplayText(type: string, value: Record<string, unknown>, caption: string): string {
  if (caption) return caption;
  const payloadType = stringValue(value.type) ?? mediaPayloadType(value);
  const payload = payloadType ? recordValue(value[payloadType]) : {};
  const displayName = firstSafeMediaDisplayName([
    stringValue(value.name),
    stringValue(payload.name),
    stringValue(payload.filename),
  ]);
  if (!displayName) return "";
  const label = mediaBlockLabel(type);
  return label ? `${label}: ${displayName}` : displayName;
}

function firstSafeMediaDisplayName(candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    const safe = safeMediaDisplayName(candidate);
    if (safe) return safe;
  }
  return null;
}

function safeMediaDisplayName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = stripMediaUrlsFromText(value).trim();
  if (!trimmed || trimmed !== value.trim()) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function mediaBlockLabel(type: string): string | null {
  switch (type) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "pdf":
      return "PDF";
    case "file":
      return "File";
    case "audio":
      return "Audio";
    default:
      return null;
  }
}

function renderBlock(block: NotionBlockNode, context: NotionRenderContext = renderContextForBlocks([block])): string {
  return appendBlockComments(renderBlockBody(block, context), block.comments);
}

function renderBlockBody(block: NotionBlockNode, context: NotionRenderContext = renderContextForBlocks([block])): string {
  const childMarkdown = renderBlocks(block.children, context);
  const text = block.text.trim();
  const withChildren = (line: string) => childMarkdown ? `${line}\n${indentMarkdown(childMarkdown)}` : line;

  switch (block.type) {
    case "paragraph":
      return withChildren(`${renderIconPrefix(block.icon)}${text}`.trimEnd());
    case "heading_1":
      return renderHeadingBlock(block, 1, childMarkdown);
    case "heading_2":
      return renderHeadingBlock(block, 2, childMarkdown);
    case "heading_3":
      return renderHeadingBlock(block, 3, childMarkdown);
    case "heading_4":
      return renderHeadingBlock(block, 4, childMarkdown);
    case "bulleted_list_item":
      if (!text && !childMarkdown) return "";
      return withChildren(`- ${text}`);
    case "numbered_list_item":
      if (!text && !childMarkdown) return "";
      return renderNumberedListItem(block, context, null);
    case "to_do":
      if (!text && !childMarkdown) return "";
      return withChildren(`- [${block.checked ? "x" : " "}] ${text}`);
    case "toggle":
      return `<details>\n<summary>${text || "Toggle"}</summary>${childMarkdown ? `\n\n${childMarkdown}` : ""}\n</details>`;
    case "quote":
      return withChildren(text.split("\n").map((line) => `> ${line}`).join("\n"));
    case "callout":
      if (!text && !block.icon) return childMarkdown;
      return withChildren(`> [!NOTE] ${renderIconPrefix(block.icon)}${text}`.trimEnd());
    case "code":
      return renderCodeBlock(block);
    case "equation":
      return `$$\n${text}\n$$`;
    case "divider":
      return "---";
    case "breadcrumb":
      return renderBreadcrumb(context.breadcrumbTrail);
    case "table_of_contents":
      return renderTableOfContents(context.headingOutline);
    case "child_page":
      return renderChildPage(block);
    case "child_database":
      return renderChildDatabase(block);
    case "link_to_page":
      return renderLinkToPage(block);
    case "table":
      return renderTable(block);
    case "table_row":
      return renderTableRow(block);
    case "column_list":
      return renderColumnList(block, context);
    case "column":
    case "synced_block":
    case "mention":
      return childMarkdown || text;
    case "template":
      return renderTemplateBlock(block, childMarkdown);
    case "meeting_notes":
    case "transcription":
      return renderMeetingNotesBlock(block, childMarkdown);
    case "tab":
      return renderTab(block, childMarkdown);
    case "embed":
    case "bookmark":
    case "link_preview":
      return renderExternalReference(block);
    case "image":
    case "video":
    case "pdf":
    case "file":
    case "audio":
      return text || childMarkdown;
    case "unsupported":
      return `[Unsupported Notion block: ${block.warnings[0]?.type ?? block.id}]`;
    default:
      return withChildren(text || `[Notion ${block.type} block: ${block.id}]`);
  }
}

function renderHeadingBlock(block: NotionBlockNode, level: number, childMarkdown: string): string {
  const marker = "#".repeat(Math.max(1, Math.min(level, 6)));
  const line = `${marker} ${block.text.trim() || "Untitled heading"}`;
  if (!block.isToggleable) return childMarkdown ? `${line}\n${indentMarkdown(childMarkdown)}` : line;
  return `<details>\n<summary>${line}</summary>${childMarkdown ? `\n\n${childMarkdown}` : ""}\n</details>`;
}

function appendBlockComments(markdown: string, comments: NotionCommentSummary[]): string {
  if (comments.length === 0) return markdown;
  const renderedComments = renderComments(comments)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const prefix = markdown.trim() || "_Empty Notion block._";
  return `${prefix}\n\nBlock comments:\n${renderedComments}`;
}

function renderTable(block: NotionBlockNode): string {
  const rows = block.children.filter((child) => child.type === "table_row").map(renderTableRowCells);
  if (rows.length === 0) return block.text;
  const columnCount = effectiveTableColumnCount(block, rows);
  const normalized = rows.map((row) => normalizeTableCells(row, columnCount));
  const hasColumnHeader = block.hasColumnHeader === true;
  const hasRowHeader = block.hasRowHeader === true;
  const header = hasColumnHeader ? normalized[0] : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const body = hasColumnHeader ? normalized.slice(1) : normalized;
  const separator = Array(columnCount).fill("---");
  return [
    `| ${header.map(escapeTableCell).join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body.map((row) => {
      const cells = row.map((cell, index) => escapeTableCell(formatTableBodyCell(cell, index, hasRowHeader)));
      return `| ${cells.join(" | ")} |`;
    }),
  ].join("\n");
}

function formatTableBodyCell(cell: string, columnIndex: number, hasRowHeader: boolean): string {
  if (!hasRowHeader || columnIndex !== 0 || !cell.trim()) return cell;
  return `**${cell}**`;
}

function renderExternalReference(block: NotionBlockNode): string {
  const text = block.text.trim();
  const url = block.url?.trim() ?? "";
  const label = block.type === "bookmark" ? "Bookmark" : block.type === "embed" ? "Embed" : "Link preview";
  if (url && isMediaUrl(url)) return text && !isMediaUrl(text) ? `${label}: ${text}` : "";
  if (url && text && text !== url && !isMediaUrl(text)) return `${label}: ${text} (${url})`;
  const target = url || text;
  if (!target || isMediaUrl(target)) return "";
  return `${label}: ${target}`;
}

function renderLinkToPage(block: NotionBlockNode): string {
  const reference = block.references[0];
  const target = block.text || reference?.targetId || block.id;
  const label = reference?.kind === "linked_database"
    ? "Linked Notion database"
    : reference?.kind === "linked_comment"
      ? "Linked Notion comment"
      : "Linked Notion page";
  return `[[${label}: ${target}]]`;
}

function renderCodeBlock(block: NotionBlockNode): string {
  const code = `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
  const caption = block.caption?.trim();
  return caption ? `${code}\n\nCaption: ${caption}` : code;
}

function renderMeetingNotesBlock(block: NotionBlockNode, childMarkdown: string): string {
  const meeting = block.meetingNotes;
  if (!meeting) return childMarkdown || block.text;
  const title = meeting.title || block.text || block.id;
  const lines = [
    `**Meeting notes: ${title}**`,
    meeting.status ? `Status: ${meeting.status}` : "",
    meeting.children.summaryBlockId ? `Summary block: ${meeting.children.summaryBlockId}` : "",
    meeting.children.notesBlockId ? `Notes block: ${meeting.children.notesBlockId}` : "",
    meeting.children.transcriptBlockId ? `Transcript block: ${meeting.children.transcriptBlockId}` : "",
    meeting.calendarEvent
      ? `Calendar: ${meeting.calendarEvent.startTime ?? "unknown"} to ${meeting.calendarEvent.endTime ?? "unknown"}${meeting.calendarEvent.attendees.length > 0 ? `; attendees: ${meeting.calendarEvent.attendees.map(meetingAttendeeLabel).join(", ")}` : ""}`
      : "",
    meeting.recording
      ? `Recording: ${meeting.recording.startTime ?? "unknown"} to ${meeting.recording.endTime ?? "unknown"}`
      : "",
  ].filter(Boolean);
  return childMarkdown ? `${lines.join("\n")}\n${indentMarkdown(childMarkdown)}` : lines.join("\n");
}

function numberedListMarker(block: NotionBlockNode): string {
  return numberedListMarkerFor(block, explicitListIndex(block) ?? 1);
}

function numberedListMarkerFor(block: NotionBlockNode, index: number): string {
  const normalizedIndex = Math.max(1, Math.floor(index));
  switch (block.listFormat) {
    case "letters":
      return `${letterListLabel(normalizedIndex)}.`;
    case "roman":
      return `${romanListLabel(normalizedIndex)}.`;
    default:
      return `${normalizedIndex}.`;
  }
}

function explicitListIndex(block: NotionBlockNode | undefined): number | null {
  return typeof block?.listStartIndex === "number" && block.listStartIndex >= 1
    ? Math.floor(block.listStartIndex)
    : null;
}

function collectConsecutiveNumberedListItems(blocks: NotionBlockNode[], startIndex: number): NotionBlockNode[] {
  const first = blocks[startIndex];
  if (!first || first.type !== "numbered_list_item") return [];
  const format = first.listFormat ?? "numbers";
  const group: NotionBlockNode[] = [];
  for (let index = startIndex; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || block.type !== "numbered_list_item" || (block.listFormat ?? "numbers") !== format) break;
    group.push(block);
  }
  return group;
}

function renderNumberedListGroup(blocks: NotionBlockNode[], context: NotionRenderContext): string[] {
  const rendered: string[] = [];
  let nextIndex = explicitListIndex(blocks[0]) ?? 1;
  for (const block of blocks) {
    const currentIndex = explicitListIndex(block) ?? nextIndex;
    const markdown = appendBlockComments(renderNumberedListItem(block, context, currentIndex), block.comments);
    if (markdown) rendered.push(markdown);
    nextIndex = currentIndex + 1;
  }
  return rendered;
}

function renderNumberedListItem(
  block: NotionBlockNode,
  context: NotionRenderContext,
  listIndex: number | null,
): string {
  const childMarkdown = renderBlocks(block.children, context);
  const text = block.text.trim();
  if (!text && !childMarkdown) return "";
  const marker = listIndex == null ? numberedListMarker(block) : numberedListMarkerFor(block, listIndex);
  const line = `${marker} ${text}`;
  return childMarkdown ? `${line}\n${indentMarkdown(childMarkdown)}` : line;
}

function letterListLabel(index: number): string {
  let remaining = index;
  let label = "";
  while (remaining > 0) {
    remaining -= 1;
    label = String.fromCharCode(97 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26);
  }
  return label || "a";
}

function romanListLabel(index: number): string {
  const values: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let remaining = index;
  let label = "";
  for (const [value, token] of values) {
    while (remaining >= value) {
      label += token;
      remaining -= value;
    }
  }
  return label || "i";
}

function renderTableRow(block: NotionBlockNode): string {
  return `| ${renderTableRowCells(block).map(escapeTableCell).join(" | ")} |`;
}

function renderTableRowCells(block: NotionBlockNode): string[] {
  return block.tableCells ?? block.text.split("\t");
}

function effectiveTableColumnCount(block: NotionBlockNode, rows: string[][]): number {
  const rowWidth = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const declaredWidth = typeof block.tableWidth === "number" && Number.isFinite(block.tableWidth)
    ? Math.max(0, Math.trunc(block.tableWidth))
    : 0;
  return Math.max(rowWidth, declaredWidth);
}

function normalizeTableCells(cells: string[], columnCount: number): string[] {
  if (cells.length >= columnCount) return cells;
  return [...cells, ...Array(columnCount - cells.length).fill("")];
}

function renderColumnList(block: NotionBlockNode, context: NotionRenderContext): string {
  const columns = block.children.filter((child) => child.type === "column");
  if (columns.length === 0) return renderBlocks(block.children, context).trim() || block.text;

  return columns
    .map((column, index) => {
      const effectiveWidthRatio = effectiveColumnWidthRatio(column, columns.length);
      const width = typeof effectiveWidthRatio === "number"
        ? ` (${Math.round(effectiveWidthRatio * 100)}%)`
        : "";
      const content = renderBlocks(column.children, context).trim() || column.text.trim();
      return [`**Column ${index + 1}${width}**`, "", content].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function effectiveColumnWidthRatio(column: NotionBlockNode, columnCount: number): number | null {
  if (typeof column.widthRatio === "number" && Number.isFinite(column.widthRatio)) return column.widthRatio;
  return columnCount > 0 ? 1 / columnCount : null;
}

function siblingColumnCount(column: NotionBlockNode, blocks: NotionBlockNode[]): number {
  const siblingCount = blocks.filter((candidate) => candidate.type === "column" && candidate.parentId === column.parentId).length;
  return siblingCount || 1;
}

function siblingColumns(column: NotionBlockNode, blocks: NotionBlockNode[]): NotionBlockNode[] {
  return blocks
    .filter((candidate) => candidate.type === "column" && candidate.parentId === column.parentId)
    .sort((a, b) => a.order - b.order);
}

function columnListBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const columns = block.children.filter((child) => child.type === "column");
  const explicitWidthTotal = columns.reduce((sum, column) => sum + (typeof column.widthRatio === "number" && Number.isFinite(column.widthRatio) ? column.widthRatio : 0), 0);
  return {
    blockId: block.id,
    columnCount: columns.length,
    explicitWidthRatioTotal: explicitWidthTotal || null,
    effectiveWidthRatioTotal: columns.reduce((sum, column) => sum + (effectiveColumnWidthRatio(column, columns.length) ?? 0), 0),
    columns: columns.map((column, index) => columnLayoutColumnFact(column, index, columns.length)),
  };
}

function columnBlockFact(block: NotionBlockNode, flatBlocks: NotionBlockNode[]): Record<string, unknown> {
  const siblings = siblingColumns(block, flatBlocks);
  const columnIndex = siblings.findIndex((column) => column.id === block.id);
  return {
    ...columnLayoutColumnFact(block, Math.max(0, columnIndex), siblingColumnCount(block, flatBlocks)),
    parentColumnListId: block.parentId,
    siblingColumnIds: siblings.map((column) => column.id),
    siblingColumnCount: siblings.length || siblingColumnCount(block, flatBlocks),
  };
}

function columnLayoutColumnFact(column: NotionBlockNode, index: number, columnCount: number): Record<string, unknown> {
  const contentMarkdown = renderBlocks(column.children).trim() || column.text.trim();
  return {
    blockId: column.id,
    index,
    widthRatio: column.widthRatio ?? null,
    effectiveWidthRatio: effectiveColumnWidthRatio(column, columnCount),
    hasExplicitWidthRatio: typeof column.widthRatio === "number" && Number.isFinite(column.widthRatio),
    childBlockIds: column.children.map((child) => child.id),
    childBlockTypes: column.children.map((child) => child.type),
    childBlockCount: column.children.length,
    contentMarkdown,
    contentHash: hashContent(contentMarkdown),
  };
}

function tabPanes(block: NotionBlockNode): Array<{
  blockId: string;
  paneIndex: number;
  blockType: string;
  parentBlockId: string | null;
  depth: number;
  order: number;
  label: string;
  labelPlainText: string;
  labelRichText: NotionRichTextSpanSummary[];
  icon: NotionBlockIconSummary | null | undefined;
  color: string | null | undefined;
  hasChildren: boolean;
  contentMarkdown: string;
  contentHash: string;
  contentChildBlockIds: string[];
  contentChildBlockTypes: string[];
}> {
  if (block.type !== "tab") return [];
  return block.children
    .filter((child) => child.type === "paragraph")
    .map((child, paneIndex) => {
      const labelRichText = child.richText ?? [];
      const contentMarkdown = renderBlocks(child.children).trim();
      return {
        blockId: child.id,
        paneIndex,
        blockType: child.type,
        parentBlockId: child.parentId,
        depth: child.depth,
        order: child.order,
        label: child.text.trim() || child.id,
        labelPlainText: labelRichText.map((span) => span.plainText).join("") || child.text.trim() || child.id,
        labelRichText,
        icon: child.icon,
        color: child.color,
        hasChildren: child.hasChildren,
        contentMarkdown,
        contentHash: hashContent(contentMarkdown),
        contentChildBlockIds: child.children.map((grandchild) => grandchild.id),
        contentChildBlockTypes: child.children.map((grandchild) => grandchild.type),
      };
    });
}

function renderTab(block: NotionBlockNode, childMarkdown: string): string {
  const panes = tabPanes(block);
  if (panes.length === 0) {
    const title = block.text.trim() || block.id;
    return [`**Tab: ${title}**`, childMarkdown].filter(Boolean).join("\n\n");
  }
  return panes.map((pane) => {
    const title = `${renderIconPrefix(pane.icon)}${pane.label}`.trim();
    return [`**Tab: ${title || pane.blockId}**`, pane.contentMarkdown].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

function renderTemplateBlock(block: NotionBlockNode, childMarkdown: string): string {
  const title = block.text.trim() || "Untitled template";
  return [`**Template: ${title}**`, childMarkdown].filter(Boolean).join("\n\n");
}

function renderContextForBlocks(
  blocks: NotionBlockNode[],
  opts: { breadcrumbTrail?: NotionBreadcrumbEntry[] } = {},
): NotionRenderContext {
  return {
    breadcrumbTrail: opts.breadcrumbTrail ?? [],
    headingOutline: flattenBlocks(blocks)
      .filter((block) => HEADING_TYPES.has(block.type))
      .map((block) => ({
        id: block.id,
        level: headingLevel(block.type),
        title: block.text.trim() || "Untitled heading",
      })),
  };
}

function assignRenderedMarkdown(blocks: NotionBlockNode[], opts: { breadcrumbTrail?: NotionBreadcrumbEntry[] } = {}): void {
  const context = renderContextForBlocks(blocks, opts);
  for (const block of flattenBlocks(blocks)) {
    block.markdown = renderBlock(block, context);
  }
}

function renderBreadcrumb(trail: NotionBreadcrumbEntry[]): string {
  return trail.map((entry) => entry.title.trim()).filter(Boolean).join(" / ");
}

async function resolveBreadcrumbTrail(
  userId: string,
  page: NotionPage,
  title: string,
  warnings: NotionSourceWarning[],
): Promise<NotionBreadcrumbEntry[]> {
  const ancestors: NotionBreadcrumbEntry[] = [];
  const seen = new Set<string>([page.id]);
  let parent = page.parent;

  for (let depth = 0; depth < BREADCRUMB_MAX_ANCESTORS; depth += 1) {
    const info = notionParentInfo(parent);
    if (!info.parentType || info.parentType === "workspace") {
      ancestors.push(workspaceBreadcrumbEntry());
      break;
    }
    if (!info.parentId) break;
    const seenKey = `${info.parentType}:${info.parentId}`;
    if (seen.has(seenKey)) break;
    seen.add(seenKey);

    try {
      const resolved = await resolveBreadcrumbParent(userId, info.parentType, info.parentId);
      if (!resolved) break;
      ancestors.push(resolved.entry);
      parent = resolved.parent;
    } catch (err) {
      warnings.push({
        code: "breadcrumb_parent_resolve_failed",
        message: `Failed to resolve Notion breadcrumb parent ${info.parentType}:${info.parentId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      break;
    }
  }

  const currentParent = notionParentInfo(page.parent);
  return [
    ...ancestors.reverse(),
    {
      objectType: "page",
      objectId: page.id,
      title,
      url: page.url ?? null,
      parentType: currentParent.parentType,
      parentId: currentParent.parentId,
    },
  ];
}

async function resolveBreadcrumbParent(
  userId: string,
  parentType: string,
  parentId: string,
): Promise<{ entry: NotionBreadcrumbEntry; parent?: NotionParent } | null> {
  if (parentType === "page_id") {
    const page = await retrieveNotionPage(userId, parentId);
    const parent = notionParentInfo(page.parent);
    return {
      entry: {
        objectType: "page",
        objectId: page.id,
        title: extractNotionTitle(page) || page.id,
        url: page.url ?? null,
        parentType: parent.parentType,
        parentId: parent.parentId,
      },
      parent: page.parent,
    };
  }
  if (parentType === "database_id") {
    const database = await retrieveNotionDatabase(userId, parentId);
    const parent = notionParentInfo(database.parent);
    return {
      entry: {
        objectType: "database",
        objectId: database.id,
        title: extractNotionTitle(database) || database.id,
        url: database.url ?? null,
        parentType: parent.parentType,
        parentId: parent.parentId,
      },
      parent: database.parent,
    };
  }
  if (parentType === "data_source_id") {
    const dataSource = await retrieveNotionDataSource(userId, parentId);
    const parentRef = dataSource.database_parent ?? dataSource.parent;
    const parent = notionParentInfo(parentRef);
    return {
      entry: {
        objectType: "data_source",
        objectId: dataSource.id,
        title: extractNotionTitle(dataSource) || dataSource.id,
        url: dataSource.url ?? null,
        parentType: parent.parentType,
        parentId: parent.parentId,
      },
      parent: parentRef,
    };
  }
  if (parentType === "block_id") {
    const block = await retrieveNotionBlock(userId, parentId);
    const parent = notionParentInfo(block.parent);
    return {
      entry: {
        objectType: "block",
        objectId: block.id,
        title: breadcrumbBlockTitle(block),
        url: null,
        parentType: parent.parentType,
        parentId: parent.parentId,
      },
      parent: block.parent,
    };
  }
  return null;
}

function workspaceBreadcrumbEntry(): NotionBreadcrumbEntry {
  return {
    objectType: "workspace",
    objectId: null,
    title: "Workspace",
    url: null,
    parentType: null,
    parentId: null,
  };
}

function breadcrumbBlockTitle(block: NotionBlock): string {
  const type = stringValue(block.type) ?? "block";
  const content = blockContent(block, type);
  return content.text.trim() || `${type} ${block.id}`;
}

function blockTreeHasType(blocks: NotionBlockNode[], type: string): boolean {
  return flattenBlocks(blocks).some((block) => block.type === type);
}

function renderTableOfContents(headings: NotionHeadingOutlineEntry[]): string {
  if (headings.length === 0) return "";
  const minLevel = Math.min(...headings.map((heading) => heading.level));
  return headings
    .map((heading) => {
      const indent = "  ".repeat(Math.max(0, heading.level - minLevel));
      return `${indent}- ${heading.title} (block: ${heading.id})`;
    })
    .join("\n");
}

function headingLevel(type: string): number {
  const match = /^heading_(\d)$/u.exec(type);
  return match ? Number(match[1]) : 1;
}

async function hydrateInlineDatabases(
  userId: string,
  blocks: NotionBlockNode[],
  pageWarnings: NotionSourceWarning[],
  visitedDataSourceIds: Set<string>,
  nesting: number,
): Promise<void> {
  const databaseBlocks = flattenBlocks(blocks).filter((block) => block.type === "child_database");
  for (const block of databaseBlocks) {
    if (nesting > INLINE_DATABASE_MAX_NESTING) {
      pageWarnings.push({
        code: "inline_database_nesting_capped",
        blockId: block.id,
        message: `Inline Notion database expansion exceeded max nesting ${INLINE_DATABASE_MAX_NESTING}.`,
      });
      continue;
    }

    try {
      const dataSourceRefs = await inlineDataSourceRefs(userId, block);
      if (dataSourceRefs.length === 0) {
        pageWarnings.push({
          code: "inline_database_no_data_sources",
          blockId: block.id,
          message: `Notion child database "${block.text || block.id}" did not expose any data sources.`,
        });
        continue;
      }

      if (dataSourceRefs.length > INLINE_DATABASE_MAX_DATA_SOURCES) {
        pageWarnings.push({
          code: "inline_database_data_source_cap_reached",
          blockId: block.id,
          message: `Notion child database "${block.text || block.id}" exceeded the inline data source cap.`,
        });
      }

      const tables: NotionInlineDataSource[] = [];
      for (const ref of dataSourceRefs.slice(0, INLINE_DATABASE_MAX_DATA_SOURCES)) {
        if (visitedDataSourceIds.has(ref.id)) {
          pageWarnings.push({
            code: "inline_database_cycle_skipped",
            blockId: block.id,
            message: `Skipped recursive Notion data source ${ref.id}.`,
          });
          continue;
        }
        tables.push(await fetchInlineDataSourceTable(userId, block, ref, pageWarnings, visitedDataSourceIds, nesting));
      }

      block.inlineDataSources = tables;
      const materializedSources = flattenInlineDataSources(tables);
      block.references = [
        { kind: "child_database", blockId: block.id, targetId: block.id, title: block.text || null },
        ...materializedSources.map((table) => ({
          kind: "child_database" as const,
          blockId: block.id,
          targetId: table.dataSourceId,
          title: table.title,
          url: table.url,
        })),
      ];
      block.markdown = renderBlock(block);
    } catch (err) {
      pageWarnings.push({
        code: "inline_database_expand_failed",
        blockId: block.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function inlineDataSourceRefs(userId: string, block: NotionBlockNode): Promise<InlineDataSourceRef[]> {
  try {
    const database = await retrieveNotionDatabase(userId, block.id);
    return (database.data_sources ?? [])
      .map((source) => ({
        id: stringValue(source.id) ?? "",
        title: (stringValue(source.name) ?? richTextMarkdown(arrayValue(source.title)))
          || block.text
          || "Notion database",
        database,
        dataSource: null,
      }))
      .filter((source) => source.id);
  } catch (databaseErr) {
    try {
      const dataSource = await retrieveNotionDataSource(userId, block.id);
      return [{
        id: dataSource.id,
        title: extractNotionTitle(dataSource) || block.text || "Notion database",
        database: null,
        dataSource,
      }];
    } catch {
      throw databaseErr;
    }
  }
}

async function fetchInlineDataSourceTable(
  userId: string,
  block: NotionBlockNode,
  ref: InlineDataSourceRef,
  pageWarnings: NotionSourceWarning[],
  visitedDataSourceIds: Set<string>,
  nesting: number,
): Promise<NotionInlineDataSource> {
  let dataSource: NotionDataSource | null = ref.dataSource ?? null;
  try {
    if (!dataSource) dataSource = await retrieveNotionDataSource(userId, ref.id);
  } catch (err) {
    pageWarnings.push({
      code: "inline_data_source_metadata_failed",
      blockId: block.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const collection = await collectNotionDataSourcePageCollection(userId, ref.id, { maxResults: INLINE_DATABASE_MAX_ROWS });
  const rowCapReached = collection.hasMore;
  const nestedDataSources: NotionInlineNestedDataSource[] = [];
  for (const source of collection.dataSources.slice(0, INLINE_DATABASE_MAX_DATA_SOURCES)) {
    const title = extractNotionTitle(source) || source.id;
    const nested: NotionInlineNestedDataSource = {
      dataSourceId: source.id,
      title,
      url: source.url ?? null,
      rawDataSource: source,
      materializedDataSource: null,
    };
    if (source.id === ref.id || visitedDataSourceIds.has(source.id)) {
      pageWarnings.push({
        code: "inline_database_cycle_skipped",
        blockId: block.id,
        message: `Skipped recursive Notion data source ${source.id}.`,
      });
    } else if (nesting + 1 > INLINE_DATABASE_MAX_NESTING) {
      pageWarnings.push({
        code: "inline_database_nesting_capped",
        blockId: block.id,
        message: `Inline Notion database expansion exceeded max nesting ${INLINE_DATABASE_MAX_NESTING}.`,
      });
    } else {
      nested.materializedDataSource = await fetchInlineDataSourceTable(
        userId,
        block,
        { id: source.id, title, database: null, dataSource: source },
        pageWarnings,
        new Set([...visitedDataSourceIds, ref.id]),
        nesting + 1,
      );
    }
    nestedDataSources.push(nested);
  }
  if (collection.dataSources.length > INLINE_DATABASE_MAX_DATA_SOURCES) {
    pageWarnings.push({
      code: "inline_database_data_source_cap_reached",
      blockId: block.id,
      message: `Notion data source ${ref.id} returned more than ${INLINE_DATABASE_MAX_DATA_SOURCES} nested data sources.`,
    });
  }
  if (rowCapReached) {
    pageWarnings.push({
      code: "inline_database_row_cap_reached",
      blockId: block.id,
      message: `Notion data source ${ref.id} reached the inline row cap ${INLINE_DATABASE_MAX_ROWS}.`,
    });
  }
  if (!collection.complete) {
    pageWarnings.push({
      code: "inline_data_source_query_incomplete",
      blockId: block.id,
      message: collection.incompleteReason
        ? `Notion data source ${ref.id} query is incomplete: ${collection.incompleteReason}.`
        : `Notion data source ${ref.id} query is incomplete.`,
    });
  }

  let view = await collectInlineDataSourceView(userId, ref.id, dataSource, block.id, pageWarnings);
  const rows = await hydrateAndOrderInlineViewRows(userId, collection.pages, view, block.id, pageWarnings);
  let renderedResultPageIds: string[] = [];
  let missingResultPageIds: string[] = [];
  if (view) {
    renderedResultPageIds = rows.map((row) => row.id);
    const renderedResultPageIdSet = new Set(renderedResultPageIds);
    missingResultPageIds = view.resultPageIds.filter((pageId) => !renderedResultPageIdSet.has(pageId));
    if (missingResultPageIds.length > 0) {
      pageWarnings.push({
        code: "inline_database_view_rows_missing",
        blockId: block.id,
        message: `Notion view ${view.viewId} returned ${missingResultPageIds.length} row ID(s) that could not be hydrated.`,
      });
    }
  }
  const columns = view?.columns.length ? view.columns : inlineDataSourceColumns(dataSource, rows);
  const inlineRows: NotionInlineDataSourceRow[] = [];
  let bodyFetches = 0;
  let bodyFetchCapWarned = false;
  let commentFetches = 0;
  let commentFetchCapWarned = false;
  let rowCommentFetchDisabled = false;
  for (const row of rows) {
    let bodyBlocks: NotionBlockNode[] = [];
    let bodyMarkdown = "";
    let comments: NotionCommentSummary[] = [];
    let rawComments: NotionComment[] = [];
    if (bodyFetches < INLINE_DATABASE_MAX_ROW_BODIES) {
      bodyFetches++;
      try {
        const body = await fetchStructuredBlocksForInlineRow(userId, row.id);
        const fetchedBodyBlocks = body.blockTree;
        bodyBlocks = fetchedBodyBlocks;
        pageWarnings.push(...body.warnings.map((warning) => ({ ...warning, blockId: block.id })));
        await hydrateInlineDatabases(userId, bodyBlocks, pageWarnings, new Set([...visitedDataSourceIds, ref.id]), nesting + 1);
        assignRenderedMarkdown(bodyBlocks);
        if (bodyHasInlineRowContent(fetchedBodyBlocks)) {
          bodyMarkdown = renderBlocks(bodyBlocks).trim();
        }
      } catch (err) {
        pageWarnings.push({
          code: "inline_database_row_body_fetch_failed",
          blockId: block.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!bodyFetchCapWarned) {
      bodyFetchCapWarned = true;
      pageWarnings.push({
        code: "inline_database_row_body_cap_reached",
        blockId: block.id,
        message: `Notion data source ${ref.id} exceeded the inline row body fetch cap ${INLINE_DATABASE_MAX_ROW_BODIES}.`,
      });
    }

    if (rowCommentFetchDisabled) {
      comments = [];
    } else if (commentFetches < INLINE_DATABASE_MAX_ROW_COMMENT_FETCHES) {
      commentFetches++;
      const commentResult = await fetchNotionComments(userId, row.id);
      comments = commentResult.comments;
      rawComments = commentResult.rawComments;
      const failedWarning = commentResult.warnings.find((warning) => warning.code === "comment_fetch_failed");
      if (failedWarning) {
        rowCommentFetchDisabled = true;
        pageWarnings.push({ ...failedWarning, blockId: block.id });
      } else {
        pageWarnings.push(...commentResult.warnings.map((warning) => ({ ...warning, blockId: block.id })));
      }
    } else if (!commentFetchCapWarned) {
      commentFetchCapWarned = true;
      pageWarnings.push({
        code: "inline_database_row_comment_cap_reached",
        blockId: block.id,
        message: `Notion data source ${ref.id} exceeded the inline row comment fetch cap ${INLINE_DATABASE_MAX_ROW_COMMENT_FETCHES}.`,
      });
    }

    const propertyResult = await hydratePaginatedProperties(userId, row);
    pageWarnings.push(...propertyResult.warnings.map((warning) => ({ ...warning, blockId: block.id })));
    const rowProperties = propertyResult.properties;
    const hydratedRow = { ...row, properties: rowProperties } as NotionPage;
    const title = extractNotionTitle(hydratedRow) || "Untitled database row";
    const bodyPagePath = inlineRowPageRelativePath(ref.title, ref.id, title, row.id);
    let breadcrumbTrail: NotionBreadcrumbEntry[] = [];
    if (bodyBlocks.length > 0 && blockTreeHasType(bodyBlocks, "breadcrumb")) {
      breadcrumbTrail = await resolveBreadcrumbTrail(userId, hydratedRow, title, pageWarnings);
      assignRenderedMarkdown(bodyBlocks, { breadcrumbTrail });
      if (bodyHasInlineRowContent(bodyBlocks)) {
        bodyMarkdown = renderBlocks(bodyBlocks, renderContextForBlocks(bodyBlocks, { breadcrumbTrail })).trim();
      }
    }
    inlineRows.push({
      pageId: row.id,
      title,
      url: row.url ?? null,
      properties: rowProperties,
      propertyValues: summarizeNotionPropertyValues(title, rowProperties),
      values: Object.fromEntries(columns.map((column) => [column, inlinePropertyValue(column, hydratedRow)])),
      bodyBlocks,
      bodyMarkdown,
      breadcrumbTrail,
      bodyPagePath,
      comments,
      rawPage: row,
      rawComments,
    });
  }
  if (view) {
    view = {
      ...view,
      renderedResultPageIds,
      missingResultPageIds,
      rowGroups: collectInlineViewRowGroups(view, inlineRows, block.id, pageWarnings),
    };
  }

  return {
    dataSourceId: ref.id,
    title: dataSource ? extractNotionTitle(dataSource) || ref.title : ref.title,
    url: dataSource?.url ?? null,
    columns,
    view,
    rows: inlineRows,
    rowCount: inlineRows.length,
    rowCapReached,
    queryComplete: collection.complete,
    queryHasMore: collection.hasMore,
    queryNextCursor: collection.nextCursor,
    queryRequestStatus: collection.requestStatus,
    queryIncompleteReason: collection.incompleteReason,
    nestedDataSources,
    rawDataSource: dataSource,
    rawDatabase: ref.database ?? null,
  };
}

async function fetchStructuredBlocksForInlineRow(userId: string, pageId: string): Promise<{
  blockTree: NotionBlockNode[];
  references: NotionReference[];
  warnings: NotionSourceWarning[];
}> {
  const attempts = Math.max(1, numberFromEnv("NOTION_INLINE_DATABASE_ROW_BODY_FETCH_ATTEMPTS", 2));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchStructuredBlocks(userId, pageId);
    } catch (err) {
      lastError = err;
      if (!isTransientNotionFetchError(err) || attempt === attempts - 1) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isTransientNotionFetchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("aborted") || message.includes("timeout") || message.includes("fetch failed");
}

function renderChildDatabase(block: NotionBlockNode): string {
  const title = block.text || block.id;
  if (!block.inlineDataSources || block.inlineDataSources.length === 0) {
    return `[[Child database: ${title}]]`;
  }

  const parts = [`**Database: ${title}**`];
  const nestedVisited = new Set(block.inlineDataSources.map((source) => source.dataSourceId));
  for (const dataSource of block.inlineDataSources) {
    if (block.inlineDataSources.length > 1 || dataSource.title !== title) {
      parts.push(`**Data source: ${dataSource.title}**`);
    }
    const viewSummary = dataSource.view ? renderInlineDataSourceViewSummary(dataSource.view) : "";
    if (viewSummary) parts.push(viewSummary);
    parts.push(renderInlineDataSourceTable(dataSource));
    parts.push(renderNestedInlineDataSources(dataSource, nestedVisited));
  }
  return parts.filter(Boolean).join("\n\n");
}

function renderNestedInlineDataSources(dataSource: NotionInlineDataSource, visited = new Set<string>()): string {
  visited.add(dataSource.dataSourceId);
  const parts: string[] = [];

  for (const nested of dataSource.nestedDataSources) {
    if (!nested.materializedDataSource || visited.has(nested.materializedDataSource.dataSourceId)) continue;
    visited.add(nested.materializedDataSource.dataSourceId);
    parts.push(`**Nested data source: ${nested.materializedDataSource.title}**`);
    const nestedViewSummary = nested.materializedDataSource.view
      ? renderInlineDataSourceViewSummary(nested.materializedDataSource.view)
      : "";
    if (nestedViewSummary) parts.push(nestedViewSummary);
    parts.push(renderInlineDataSourceTable(nested.materializedDataSource));
    parts.push(renderNestedInlineDataSources(nested.materializedDataSource, visited));
  }

  return parts.filter(Boolean).join("\n\n");
}

function renderChildPage(block: NotionBlockNode): string {
  const title = block.text || block.id;
  if (block.childPage?.relativePath) {
    return `[[Child page: ${title}]](${block.childPage.relativePath})`;
  }
  return `[[Child page: ${title}]]`;
}

function renderInlineDataSourceTable(dataSource: NotionInlineDataSource): string {
  if (dataSource.rows.length === 0) return "_No rows._";
  const columns = dataSource.columns.length > 0 ? dataSource.columns : ["Name"];
  const separator = Array(columns.length).fill("---");
  return [
    `| ${columns.map(escapeTableCell).join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...dataSource.rows.map((row) => {
      const titleColumn = columns[0] ?? "Name";
      return `| ${columns.map((column) => {
        const value = row.values[column] ?? "";
        return escapeTableCell(column === titleColumn && row.bodyPagePath && rowHasDocumentContent(row)
          ? `[${escapeMarkdownLinkLabel(value || row.title)}](${row.bodyPagePath})`
          : value);
      }).join(" | ")} |`;
    }),
  ].join("\n");
}

function renderInlineDataSourceViewSummary(view: NotionInlineDataSourceView): string {
  const details = [`${view.name || "Untitled view"}${view.viewType ? ` (${view.viewType})` : ""}`];
  if (view.columns.length > 0) details.push(`columns: ${view.columns.join(", ")}`);
  const hiddenProperties = arrayValue(view.configurationSummary.hiddenProperties)
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value));
  if (hiddenProperties.length > 0) details.push(`hidden: ${hiddenProperties.join(", ")}`);
  const filterSummary = inlineDataSourceViewFilterSummary(view.filter);
  if (filterSummary) details.push(`filter: ${renderInlineViewFilterSummary(filterSummary)}`);
  const sortsSummary = inlineDataSourceViewSortsSummary(view.sorts);
  if (sortsSummary.length > 0) details.push(`sorts: ${sortsSummary.map(renderInlineViewSortSummary).join(", ")}`);
  const quickFiltersSummary = arrayValue(view.configurationSummary.quickFiltersSummary).length > 0
    ? arrayValue(view.configurationSummary.quickFiltersSummary).map(recordValue)
    : inlineDataSourceViewQuickFiltersSummary(view.quickFilters);
  if (quickFiltersSummary.length > 0) details.push(`quick filters: ${quickFiltersSummary.map(renderInlineViewQuickFilterSummary).join(", ")}`);
  const groupLabels = arrayValue(view.configurationSummary.groups)
    .map(renderInlineViewGroupSummary)
    .filter((label): label is string => Boolean(label));
  if (groupLabels.length > 0) details.push(`groups: ${groupLabels.join(", ")}`);
  const configurationDetails = arrayValue(view.configurationSummary.configurationDetails)
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value));
  if (configurationDetails.length > 0) details.push(`view config: ${configurationDetails.join(", ")}`);
  return `_View: ${details.join("; ")}._`;
}

function renderInlineViewGroupSummary(value: unknown): string | null {
  const group = recordValue(value);
  const label = stringValue(group.propertyName) ?? stringValue(group.propertyId);
  if (!label) return null;
  const groupBy = stringValue(group.groupBy);
  const start = numberValue(group.rangeStart);
  const end = numberValue(group.rangeEnd);
  const size = numberValue(group.rangeSize);
  const range = start !== undefined && end !== undefined
    ? ` ${start}-${end}${size !== undefined ? ` step ${size}` : ""}`
    : "";
  const dateBy = stringValue(group.dateBy);
  const startDay = renderInlineViewStartDayOfWeek(group.startDayOfWeek);
  const suffix = [
    groupBy ? `by ${groupBy}${range}` : null,
    dateBy ? `date ${dateBy}` : null,
    startDay ? `week starts ${startDay}` : null,
  ].filter(Boolean).join(", ");
  return suffix ? `${label} ${suffix}` : label;
}

function renderInlineViewStartDayOfWeek(value: unknown): string | null {
  const numeric = numberValue(value);
  if (numeric === 0) return "Sunday";
  if (numeric === 1) return "Monday";
  if (numeric !== undefined) return String(numeric);
  return stringValue(value);
}

function inlineDataSourceViewQuickFilters(value: unknown): unknown[] | Record<string, unknown> {
  if (Array.isArray(value)) return value;
  return recordValue(value);
}

function inlineDataSourceViewFilterSummary(value: unknown): Record<string, unknown> | null {
  const filter = recordValue(value);
  if (Object.keys(filter).length === 0) return null;
  const andFilters = arrayValue(filter.and)
    .map(inlineDataSourceViewFilterSummary)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const orFilters = arrayValue(filter.or)
    .map(inlineDataSourceViewFilterSummary)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (andFilters.length > 0 || orFilters.length > 0) {
    return {
      type: andFilters.length > 0 ? "and" : "or",
      filters: andFilters.length > 0 ? andFilters : orFilters,
      count: andFilters.length > 0 ? andFilters.length : orFilters.length,
    };
  }
  const operator = Object.keys(filter).find((key) =>
    !["property", "property_id", "property_name", "timestamp", "type"].includes(key));
  return {
    type: stringValue(filter.type) ?? (stringValue(filter.timestamp) ? "timestamp" : "property"),
    propertySelector: stringValue(filter.property),
    propertyId: stringValue(filter.property_id),
    propertyName: stringValue(filter.property_name) ?? stringValue(filter.property),
    timestamp: stringValue(filter.timestamp),
    operator: operator ?? null,
    value: operator ? summarizeComplexValue(filter[operator] ?? null) : null,
  };
}

function inlineDataSourceViewSortsSummary(value: unknown): Array<Record<string, unknown>> {
  return arrayValue(value).map((entry, index) => {
    const sort = recordValue(entry);
    return {
      index,
      propertySelector: stringValue(sort.property),
      propertyId: stringValue(sort.property_id),
      propertyName: stringValue(sort.property_name) ?? stringValue(sort.property),
      timestamp: stringValue(sort.timestamp),
      direction: stringValue(sort.direction),
    };
  });
}

function inlineDataSourceViewQuickFiltersSummary(
  value: unknown[] | Record<string, unknown>,
  schemaById = new Map<string, string>(),
): Array<Record<string, unknown>> {
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
      propertyName: stringValue(filter.property_name)
        ?? propertySelector
        ?? (propertyId ? schemaById.get(propertyId) ?? null : null),
      type: stringValue(filter.type) ?? operator,
      operator: operator ?? null,
      value: summarizeComplexValue(quickValue ?? (operator ? filter[operator] : null)),
    };
  });
}

function inlineDataSourceViewConfigurationDetails(
  configuration: Record<string, unknown>,
  schemaById = new Map<string, string>(),
): string[] {
  const details: string[] = [];
  const cover = recordValue(configuration.cover);
  const coverType = stringValue(cover.type);
  if (coverType) details.push(`cover ${coverType}`);
  const cardLayout = stringValue(configuration.card_layout);
  if (cardLayout) details.push(`card layout ${cardLayout}`);
  const coverSize = stringValue(configuration.cover_size);
  if (coverSize) details.push(`cover size ${coverSize}`);
  const dateProperty = stringValue(configuration.date_property_name) ?? stringValue(configuration.date_property_id);
  if (dateProperty) details.push(`date ${dateProperty}`);
  const endDateProperty = stringValue(configuration.end_date_property_name) ?? stringValue(configuration.end_date_property_id);
  if (endDateProperty) details.push(`end date ${endDateProperty}`);
  const viewRange = stringValue(configuration.view_range);
  if (viewRange) details.push(`range ${viewRange}`);
  const chartType = stringValue(configuration.chart_type);
  if (chartType) details.push(`chart ${chartType}`);
  const mapById = stringValue(configuration.map_by);
  const mapBySchemaName = mapById ? schemaById.get(mapById) : undefined;
  const mapBy = stringValue(configuration.map_by_property_name)
    ?? mapBySchemaName
    ?? mapById;
  if (mapBy) details.push(`map by ${mapBy}`);
  const closed = booleanValue(configuration.is_form_closed);
  if (closed !== undefined) details.push(`form ${closed ? "closed" : "open"}`);
  const dashboardRows = arrayValue(configuration.rows);
  if (dashboardRows.length > 0) details.push(`dashboard rows ${dashboardRows.length}`);
  return details;
}

function renderInlineViewFilterSummary(summary: Record<string, unknown>): string {
  const type = stringValue(summary.type);
  const nested = arrayValue(summary.filters).map((entry) => renderInlineViewFilterSummary(recordValue(entry)));
  if ((type === "and" || type === "or") && nested.length > 0) return `${type}(${nested.join(", ")})`;
  const property = stringValue(summary.propertyName) ?? stringValue(summary.propertySelector) ?? stringValue(summary.propertyId) ?? stringValue(summary.timestamp) ?? stringValue(summary.type) ?? "unknown";
  const operator = stringValue(summary.operator) ?? "condition";
  const value = renderInlineViewSummaryValue(summary.value);
  return value ? `${property} ${operator} ${value}` : `${property} ${operator}`;
}

function renderInlineViewSortSummary(summary: Record<string, unknown>): string {
  const target = stringValue(summary.propertyName) ?? stringValue(summary.propertySelector) ?? stringValue(summary.propertyId) ?? stringValue(summary.timestamp) ?? "unknown";
  const direction = stringValue(summary.direction);
  return direction ? `${target} ${direction}` : target;
}

function renderInlineViewQuickFilterSummary(summary: Record<string, unknown>): string {
  const key = stringValue(summary.key);
  const propertyId = stringValue(summary.propertyId);
  const label = key && key !== propertyId
    ? key
    : stringValue(summary.propertyName) ?? stringValue(summary.propertySelector) ?? propertyId ?? key ?? "quick filter";
  const operator = stringValue(summary.operator);
  const value = renderInlineViewSummaryValue(summary.value);
  return [label, operator, value].filter(Boolean).join(" ");
}

function renderInlineViewSummaryValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function inlineDataSourceViewQuickFilterCount(value: unknown[] | Record<string, unknown>): number {
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function rowHasDocumentContent(row: NotionInlineDataSourceRow): boolean {
  return Boolean(row.bodyMarkdown.trim() || row.comments.length > 0);
}

function rowPageHasSearchableContent(rowPage: NotionDatabaseRowPage): boolean {
  return Boolean(
    rowPage.bodyMarkdown.trim()
    || rowPage.comments.length > 0
    || Object.values(rowPage.values).some((value) => value.trim().length > 0)
    || rowPage.propertyValues.some((property) => property.display.trim().length > 0),
  );
}

function flattenInlineDataSources(sources: NotionInlineDataSource[], seen = new Set<string>()): NotionInlineDataSource[] {
  const flattened: NotionInlineDataSource[] = [];
  for (const source of sources) {
    if (seen.has(source.dataSourceId)) continue;
    seen.add(source.dataSourceId);
    flattened.push(source);
    flattened.push(...flattenInlineDataSources(source.nestedDataSources
      .map((nested) => nested.materializedDataSource)
      .filter((nested): nested is NotionInlineDataSource => Boolean(nested)), seen));
  }
  return flattened;
}

function collectInlineDatabaseRowPages(blocks: NotionBlockNode[]): NotionDatabaseRowPage[] {
  return flattenBlocks(blocks).flatMap((block) =>
    flattenInlineDataSources(block.inlineDataSources ?? []).flatMap((source) =>
      source.rows
        .filter((row) => row.bodyPagePath)
        .map((row) => ({
          pageId: row.pageId,
          title: row.title,
          url: row.url,
          dataSourceId: source.dataSourceId,
          dataSourceTitle: source.title,
          parentBlockId: block.id,
          relativePath: row.bodyPagePath!,
          properties: row.properties,
          propertyValues: row.propertyValues,
          values: row.values,
          bodyBlocks: row.bodyBlocks,
          bodyMarkdown: row.bodyMarkdown,
          breadcrumbTrail: row.breadcrumbTrail,
          comments: row.comments,
          rawPage: row.rawPage,
          rawComments: row.rawComments,
        }))),
  );
}

async function hydrateChildPages(
  userId: string,
  blocks: NotionBlockNode[],
  warnings: NotionSourceWarning[],
  seen = new Set<string>(),
  depth = 0,
  budget: { count: number } = { count: 0 },
): Promise<NotionChildPage[]> {
  const childBlocks = flattenBlocks(blocks).filter((block) => block.type === "child_page");
  const childPages: NotionChildPage[] = [];

  for (const block of childBlocks) {
    if (seen.has(block.id)) continue;
    if (depth >= CHILD_PAGE_MAX_DEPTH) {
      warnings.push({
        code: "child_page_depth_cap_reached",
        blockId: block.id,
        message: `Notion child page materialization exceeded max depth ${CHILD_PAGE_MAX_DEPTH}.`,
      });
      continue;
    }
    seen.add(block.id);
    if (budget.count >= CHILD_PAGE_MAX_PAGES) {
      warnings.push({
        code: "child_page_cap_reached",
        blockId: block.id,
        message: `Notion child page materialization exceeded max pages ${CHILD_PAGE_MAX_PAGES}.`,
      });
      break;
    }
    budget.count += 1;

    try {
      const childPage = await fetchChildPage(userId, block, warnings, seen, depth + 1, budget);
      block.childPage = childPage;
      childPages.push(childPage);
    } catch (err) {
      warnings.push({
        code: "child_page_fetch_failed",
        blockId: block.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return childPages;
}

function flattenChildPages(childPages: NotionChildPage[]): NotionChildPage[] {
  const seen = new Set<string>();
  const flattened: NotionChildPage[] = [];
  const visit = (childPage: NotionChildPage): void => {
    if (seen.has(childPage.pageId)) return;
    seen.add(childPage.pageId);
    flattened.push(childPage);
    for (const nested of childPage.childPages) visit(nested);
  };
  for (const childPage of childPages) visit(childPage);
  return flattened;
}

async function fetchChildPage(
  userId: string,
  block: NotionBlockNode,
  warnings: NotionSourceWarning[],
  seen: Set<string>,
  depth: number,
  budget: { count: number },
): Promise<NotionChildPage> {
  const page = await retrieveNotionPage(userId, block.id);
  const propertyResult = await hydratePaginatedProperties(userId, page);
  warnings.push(...propertyResult.warnings.map((warning) => ({ ...warning, blockId: block.id })));
  const childProperties = propertyResult.properties;
  const hydratedPage = { ...page, properties: childProperties } as NotionPage;
  const title = extractNotionTitle(hydratedPage) || block.text || "Untitled child page";
  block.text = title;
  for (const reference of block.references) {
    if (reference.kind === "child_page" && reference.blockId === block.id) reference.title = title;
  }
  const body = await fetchStructuredBlocksForInlineRow(userId, page.id);
  warnings.push(...body.warnings.map((warning) => ({ ...warning, blockId: block.id })));
  const bodyBlocks = body.blockTree;
  await hydrateInlineDatabases(userId, bodyBlocks, warnings, new Set(), 0);
  const childPages = await hydrateChildPages(userId, bodyBlocks, warnings, seen, depth, budget);
  const commentResult = await fetchNotionComments(userId, page.id);
  warnings.push(...commentResult.warnings.map((warning) => ({ ...warning, blockId: block.id })));
  const breadcrumbTrail = blockTreeHasType(bodyBlocks, "breadcrumb")
    ? await resolveBreadcrumbTrail(userId, hydratedPage, title, warnings)
    : [];
  assignRenderedMarkdown(bodyBlocks, { breadcrumbTrail });
  const bodyMarkdown = renderBlocks(bodyBlocks, renderContextForBlocks(bodyBlocks, { breadcrumbTrail })).trim();
  return {
    pageId: page.id,
    title,
    url: page.url ?? null,
    parentBlockId: block.id,
    relativePath: childPageRelativePath(title, page.id),
    properties: childProperties,
    propertyValues: summarizeNotionPropertyValues(title, childProperties),
    bodyBlocks,
    bodyMarkdown,
    breadcrumbTrail,
    childPages,
    comments: commentResult.comments,
    rawPage: page,
    rawComments: commentResult.rawComments,
  };
}

function collectNativeDataSources(blocks: NotionBlockNode[]): NotionDataSource[] {
  const seen = new Set<string>();
  const sources: NotionDataSource[] = [];
  for (const source of flattenBlocks(blocks).flatMap((block) => flattenInlineDataSources(block.inlineDataSources ?? []))) {
    const candidates = [
      source.rawDataSource,
      ...source.nestedDataSources.map((nested) => nested.rawDataSource),
    ];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      sources.push(candidate);
    }
  }
  return sources;
}

function collectNativeDatabases(blocks: NotionBlockNode[]): NotionDatabase[] {
  const seen = new Set<string>();
  const databases: NotionDatabase[] = [];
  for (const source of flattenBlocks(blocks).flatMap((block) => flattenInlineDataSources(block.inlineDataSources ?? []))) {
    if (!source.rawDatabase || seen.has(source.rawDatabase.id)) continue;
    seen.add(source.rawDatabase.id);
    databases.push(source.rawDatabase);
  }
  return databases;
}

function inlineRowPageRelativePath(dataSourceTitle: string, dataSourceId: string, rowTitle: string, rowPageId: string): string {
  const sourceSlug = entitySlug(dataSourceTitle || "data-source");
  const rowSlug = entitySlug(rowTitle || "untitled-row");
  return `pages/${sourceSlug}-data-source-${shortHash(dataSourceId)}/${rowSlug}-page-${shortHash(rowPageId)}/content.md`;
}

function childPageRelativePath(title: string, pageId: string): string {
  const pageSlug = entitySlug(title || "child-page");
  return `pages/${pageSlug}-page-${shortHash(pageId)}/content.md`;
}

function entitySlug(value: string): string {
  return slugify(value).slice(0, 80).replace(/-$/u, "") || "untitled";
}

function bodyHasInlineRowContent(blocks: NotionBlockNode[]): boolean {
  return blocks.some(blockHasInlineRowContent);
}

function blockHasInlineRowContent(block: NotionBlockNode): boolean {
  if (block.children.some(blockHasInlineRowContent)) return true;
  const text = block.text.trim();
  switch (block.type) {
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "heading_4":
    case "divider":
    case "breadcrumb":
    case "table_of_contents":
    case "column_list":
    case "column":
    case "tab":
    case "template":
      return false;
    case "paragraph":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
    case "callout":
    case "code":
    case "equation":
    case "toggle":
    case "meeting_notes":
    case "transcription":
    case "mention":
      return text.length > 0;
    case "to_do":
      return text.length > 0;
    case "table":
      return block.children.some(blockHasInlineRowContent);
    case "table_row":
      return (block.tableCells ?? []).some((cell) => cell.trim().length > 0);
    case "child_page":
    case "child_database":
    case "link_to_page":
    case "synced_block":
      return true;
    case "embed":
    case "bookmark":
    case "link_preview":
      return Boolean((block.url || text).trim()) && !isMediaUrl(block.url || text);
    case "image":
    case "video":
    case "pdf":
    case "file":
    case "audio":
      return text.length > 0 || mediaBlockHasPayload(block);
    case "unsupported":
      return true;
    default:
      return text.length > 0;
  }
}

function inlineDataSourceColumns(dataSource: NotionDataSource | null, rows: NotionPage[]): string[] {
  const schemaNames = Object.keys(dataSource?.properties ?? {});
  const rowNames = rows.flatMap((row) => Object.keys(row.properties ?? {}));
  const allNames = [...new Set([...schemaNames, ...rowNames])];
  const titleName = allNames.find((name) => stringValue(recordValue(dataSource?.properties?.[name]).type) === "title")
    ?? allNames.find((name) => rows.some((row) => stringValue(recordValue(row.properties?.[name]).type) === "title"))
    ?? "Name";
  const ordered = [titleName, ...allNames.filter((name) => name !== titleName)];
  return ordered.filter((name) =>
    name === titleName || rows.some((row) => inlinePropertyValue(name, row).trim() !== ""));
}

async function collectInlineDataSourceView(
  userId: string,
  dataSourceId: string,
  dataSource: NotionDataSource | null,
  blockId: string,
  warnings: NotionSourceWarning[],
): Promise<NotionInlineDataSourceView | null> {
  try {
    const listed = await collectNotionViews(userId, {
      dataSourceId,
      pageSize: Math.max(1, Math.min(INLINE_DATABASE_MAX_VIEWS, 100)),
    });
    if (listed.has_more) {
      warnings.push({
        code: "inline_database_view_cap_reached",
        blockId,
        message: `Notion data source ${dataSourceId} exposes more than ${INLINE_DATABASE_MAX_VIEWS} views; rendered the first available view.`,
      });
    }
    const view = listed.results.find((candidate) => stringValue(candidate.data_source_id) === dataSourceId)
      ?? listed.results[0]
      ?? null;
    if (!view) return null;
    const query = await collectInlineDataSourceViewQuery(userId, view, blockId, warnings);
    if (query && !query.complete) {
      warnings.push({
        code: "inline_database_view_query_incomplete",
        blockId,
        message: `Notion view ${view.id} query is incomplete; rendered the available ordered result snapshot.`,
      });
    }
    return {
      viewId: view.id,
      name: view.name ?? "",
      viewType: view.type ?? "",
      columns: inlineDataSourceViewColumns(view, dataSource),
      filter: firstNonEmptyRecord([view.filter]),
      sorts: arrayValue(view.sorts),
      quickFilters: inlineDataSourceViewQuickFilters(view.quick_filters),
      configuration: recordValue(view.configuration),
      configurationSummary: inlineDataSourceViewConfigurationSummary(view, dataSource),
      resultPageIds: query?.resultPageIds ?? [],
      resultReferences: query?.resultReferences ?? [],
      renderedResultPageIds: [],
      missingResultPageIds: [],
      rowGroups: [],
      queryId: query?.queryId ?? null,
      queryExpiresAt: query?.expiresAt ?? null,
      queryPageSize: query?.pageSize ?? null,
      queryPagesFetched: query?.pagesFetched ?? 0,
      queryDeleted: query?.queryDeleted ?? false,
      resultCount: query?.resultPageIds.length ?? 0,
      totalCount: query?.totalCount ?? null,
      hasMore: query?.hasMore ?? false,
      nextCursor: query?.nextCursor ?? null,
      requestStatus: query?.requestStatus ?? null,
      complete: query?.complete ?? false,
      rawView: view,
      rawQuery: query?.raw,
    };
  } catch (err) {
    warnings.push({
      code: "inline_database_view_fetch_failed",
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function collectInlineDataSourceViewQuery(
  userId: string,
  view: NotionView,
  blockId: string,
  warnings: NotionSourceWarning[],
): Promise<InlineViewQuerySnapshot | null> {
  try {
    const pageSize = Math.min(INLINE_DATABASE_MAX_ROWS, 100);
    const firstPage = await createNotionViewQuery(userId, view.id, { page_size: pageSize });
    const queryId = stringValue(firstPage.query_id) ?? stringValue(firstPage.id);
    const pages: NotionViewQueryResponse[] = [firstPage];
    let cursor = firstPage.has_more === true ? stringValue(firstPage.next_cursor) : null;

    while (queryId && cursor && viewQueryResultPageIds(pages).length < INLINE_DATABASE_MAX_ROWS) {
      const remaining = INLINE_DATABASE_MAX_ROWS - viewQueryResultPageIds(pages).length;
      const page = await retrieveNotionViewQuery(userId, view.id, queryId, {
        startCursor: cursor,
        pageSize: Math.min(100, remaining),
      });
      pages.push(page);
      cursor = page.has_more === true ? stringValue(page.next_cursor) : null;
    }

    let queryDeleted = false;
    if (queryId) {
      try {
        await deleteNotionViewQuery(userId, view.id, queryId);
        queryDeleted = true;
      } catch (err) {
        warnings.push({
          code: "inline_database_view_query_delete_failed",
          blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const resultPageIds = viewQueryResultPageIds(pages).slice(0, INLINE_DATABASE_MAX_ROWS);
    const resultReferences = viewQueryResultReferences(pages).slice(0, INLINE_DATABASE_MAX_ROWS);
    const lastPage = pages[pages.length - 1] ?? firstPage;
    const requestStatus = viewQueryRequestStatus(pages);
    const hasMore = lastPage.has_more === true || resultPageIds.length >= INLINE_DATABASE_MAX_ROWS && cursor !== null;
    return {
      queryId,
      expiresAt: stringValue(firstPage.expires_at) ?? stringValue(lastPage.expires_at),
      pageSize,
      pagesFetched: pages.length,
      queryDeleted,
      resultPageIds,
      resultReferences,
      totalCount: numberValue(firstPage.total_count) ?? null,
      hasMore,
      nextCursor: queryDeleted ? null : cursor ?? stringValue(lastPage.next_cursor),
      requestStatus,
      complete: !hasMore && stringValue(requestStatus?.type) !== "incomplete",
      raw: {
        firstPage: recordValue(firstPage),
        queryId,
        expiresAt: stringValue(firstPage.expires_at) ?? stringValue(lastPage.expires_at),
        pageSize,
        pagesFetched: pages.length,
        queryDeleted,
        resultPageIds,
        resultReferences,
        lastPage: recordValue(lastPage),
      },
    };
  } catch (err) {
    warnings.push({
      code: "inline_database_view_query_failed",
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function viewQueryResultPageIds(pages: NotionViewQueryResponse[]): string[] {
  return pages.flatMap((page) => arrayValue(page.results).map(notionResultPageId).filter((id): id is string => Boolean(id)));
}

function viewQueryResultReferences(pages: NotionViewQueryResponse[]): Array<Record<string, unknown>> {
  return pages.flatMap((page) => arrayValue(page.results).map(notionResultReference).filter((entry): entry is Record<string, unknown> => entry !== null));
}

function firstNonEmptyRecord(values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = recordValue(value);
    if (Object.keys(record).length > 0) return record;
  }
  return null;
}

function viewQueryRequestStatus(pages: NotionViewQueryResponse[]): Record<string, unknown> | null {
  const statuses = pages.map((page) => recordValue(page.request_status)).filter((status) => Object.keys(status).length > 0);
  let incompleteStatus: Record<string, unknown> | null = null;
  let incompleteReason: string | null = null;
  for (const status of statuses) {
    if (stringValue(status.incomplete_reason)) incompleteReason = stringValue(status.incomplete_reason);
    if (stringValue(status.type) === "incomplete") {
      incompleteStatus = { ...(incompleteStatus ?? {}), ...status };
    }
  }
  if (incompleteStatus) {
    return {
      ...incompleteStatus,
      ...(incompleteReason ? { incomplete_reason: incompleteReason } : {}),
    };
  }
  return statuses[0] ?? null;
}

function inlineDataSourceViewColumns(view: NotionView, dataSource: NotionDataSource | null): string[] {
  const schemaById = new Map<string, string>();
  for (const [key, property] of Object.entries(dataSource?.properties ?? {})) {
    const id = stringValue(recordValue(property).id);
    if (id) schemaById.set(id, inlineDataSourceSchemaDisplayName(key, property));
  }
  return arrayValue(recordValue(view.configuration).properties)
    .map((entry) => {
      const property = recordValue(entry);
      if (property.visible === false) return null;
      const id = stringValue(property.property_id) ?? stringValue(property.id);
      return stringValue(property.property_name) ?? stringValue(property.name) ?? (id ? schemaById.get(id) ?? null : null);
    })
    .filter((name): name is string => Boolean(name));
}

function inlineDataSourceViewConfigurationSummary(
  view: NotionView,
  dataSource: NotionDataSource | null,
): Record<string, unknown> {
  const configuration = recordValue(view.configuration);
  const schemaById = new Map<string, string>();
  for (const [key, property] of Object.entries(dataSource?.properties ?? {})) {
    const id = stringValue(recordValue(property).id);
    if (id) schemaById.set(id, inlineDataSourceSchemaDisplayName(key, property));
  }

  const visibleProperties: string[] = [];
  const hiddenProperties: string[] = [];
  const visiblePropertyConfigs: Array<Record<string, unknown>> = [];
  const hiddenPropertyConfigs: Array<Record<string, unknown>> = [];
  for (const entry of arrayValue(configuration.properties)) {
    const property = recordValue(entry);
    const config = inlineViewPropertyConfigSummary(property, schemaById);
    const name = stringValue(config.propertyName);
    if (!name) continue;
    if (property.visible === false) {
      hiddenProperties.push(name);
      hiddenPropertyConfigs.push(config);
    } else {
      visibleProperties.push(name);
      visiblePropertyConfigs.push(config);
    }
  }

  const groups = [
    summarizeInlineViewGroup(configuration.group_by, schemaById),
    summarizeInlineViewGroup(configuration.sub_group_by, schemaById),
    summarizeInlineViewGroup(recordValue(configuration.board).group_by, schemaById),
    summarizeInlineViewGroup(recordValue(configuration.timeline).group_by, schemaById),
  ].filter((group): group is Record<string, unknown> => Boolean(group));

  return {
    type: stringValue(configuration.type) ?? view.type ?? null,
    configurationKeys: Object.keys(configuration).sort(),
    propertyCount: visibleProperties.length + hiddenProperties.length,
    visibleProperties,
    hiddenProperties,
    visiblePropertyConfigs,
    hiddenPropertyConfigs,
    propertyConfigs: [...visiblePropertyConfigs, ...hiddenPropertyConfigs],
    groups,
    hasFilter: Object.keys(recordValue(view.filter)).length > 0,
    filterSummary: inlineDataSourceViewFilterSummary(view.filter),
    sortCount: arrayValue(view.sorts).length,
    sortsSummary: inlineDataSourceViewSortsSummary(view.sorts),
    quickFilterCount: inlineDataSourceViewQuickFilterCount(inlineDataSourceViewQuickFilters(view.quick_filters)),
    quickFiltersSummary: inlineDataSourceViewQuickFiltersSummary(inlineDataSourceViewQuickFilters(view.quick_filters), schemaById),
    configurationDetails: inlineDataSourceViewConfigurationDetails(configuration, schemaById),
    cover: inlineViewCoverSummary(configuration.cover),
    coverSize: stringValue(configuration.cover_size),
    coverAspect: stringValue(configuration.cover_aspect),
    cardLayout: stringValue(configuration.card_layout),
    table: inlineViewTableSummary(configuration),
    calendar: inlineViewCalendarSummary(configuration),
    timeline: inlineViewTimelineSummary(configuration, schemaById),
    form: inlineViewFormSummary(configuration),
    map: inlineViewMapSummary(configuration, schemaById),
    dashboard: inlineViewDashboardSummary(configuration),
    chart: inlineViewChartSummary(configuration, schemaById),
  };
}

function inlineDataSourceSchemaDisplayName(key: string, property: unknown): string {
  return stringValue(recordValue(property).name) ?? key;
}

function inlineViewPropertyConfigSummary(
  property: Record<string, unknown>,
  schemaById: Map<string, string>,
): Record<string, unknown> {
  const id = stringValue(property.property_id) ?? stringValue(property.id);
  return {
    propertyId: id,
    propertyName: stringValue(property.property_name)
      ?? stringValue(property.name)
      ?? (id ? schemaById.get(id) ?? null : null),
    propertyType: stringValue(property.property_type) ?? stringValue(property.type),
    visible: booleanValue(property.visible) ?? null,
    width: numberValue(property.width) ?? null,
    wrap: booleanValue(property.wrap) ?? null,
    widthMode: stringValue(property.width_mode) ?? stringValue(property.card_property_width_mode),
    cardPropertyWidthMode: stringValue(property.card_property_width_mode),
    aggregation: stringValue(property.aggregation),
    showAs: stringValue(property.show_as) ?? stringValue(property.status_show_as) ?? stringValue(property.display),
    statusShowAs: stringValue(property.status_show_as),
    dateFormat: stringValue(property.date_format),
    timeFormat: stringValue(property.time_format),
  };
}

function inlineViewCoverSummary(value: unknown): Record<string, unknown> | null {
  const cover = recordValue(value);
  if (Object.keys(cover).length === 0) return null;
  return {
    type: stringValue(cover.type),
    propertyId: stringValue(cover.property_id),
    propertyName: stringValue(cover.property_name),
  };
}

function inlineViewTableSummary(configuration: Record<string, unknown>): Record<string, unknown> | null {
  const hasTableFields = stringValue(configuration.type) === "table"
    || booleanValue(configuration.wrap_cells) !== undefined
    || numberValue(configuration.frozen_column_index) !== undefined
    || booleanValue(configuration.show_vertical_lines) !== undefined
    || recordHasKeys(configuration.subtasks);
  if (!hasTableFields) return null;
  return {
    wrapCells: booleanValue(configuration.wrap_cells) ?? null,
    frozenColumnIndex: numberValue(configuration.frozen_column_index) ?? null,
    showVerticalLines: booleanValue(configuration.show_vertical_lines) ?? null,
    subtasks: inlineViewSubtaskSummary(configuration.subtasks),
  };
}

function inlineViewSubtaskSummary(value: unknown): Record<string, unknown> | null {
  const subtasks = recordValue(value);
  if (Object.keys(subtasks).length === 0) return null;
  return {
    propertyId: stringValue(subtasks.property_id),
    displayMode: stringValue(subtasks.display_mode),
    filterScope: stringValue(subtasks.filter_scope),
    toggleColumnId: stringValue(subtasks.toggle_column_id),
  };
}

function inlineViewCalendarSummary(configuration: Record<string, unknown>): Record<string, unknown> | null {
  const hasCalendarFields = stringValue(configuration.type) === "calendar"
    || stringValue(configuration.date_property_id) !== null
    || stringValue(configuration.date_property_name) !== null
    || stringValue(configuration.view_range) !== null
    || booleanValue(configuration.show_weekends) !== undefined;
  if (!hasCalendarFields) return null;
  return {
    datePropertyId: stringValue(configuration.date_property_id),
    datePropertyName: stringValue(configuration.date_property_name),
    viewRange: stringValue(configuration.view_range),
    showWeekends: booleanValue(configuration.show_weekends) ?? null,
  };
}

function inlineViewTimelineSummary(
  configuration: Record<string, unknown>,
  schemaById: Map<string, string>,
): Record<string, unknown> | null {
  const hasTimelineFields = stringValue(configuration.type) === "timeline"
    || stringValue(configuration.end_date_property_id) !== null
    || stringValue(configuration.end_date_property_name) !== null
    || booleanValue(configuration.show_table) !== undefined
    || arrayValue(configuration.table_properties).length > 0
    || recordHasKeys(configuration.preference)
    || recordHasKeys(configuration.arrows_by)
    || booleanValue(configuration.color_by) !== undefined;
  if (!hasTimelineFields) return null;
  const datePropertyId = stringValue(configuration.date_property_id);
  const endDatePropertyId = stringValue(configuration.end_date_property_id);
  return {
    datePropertyId,
    datePropertyName: stringValue(configuration.date_property_name) ?? (datePropertyId ? schemaById.get(datePropertyId) ?? null : null),
    endDatePropertyId,
    endDatePropertyName: stringValue(configuration.end_date_property_name) ?? (endDatePropertyId ? schemaById.get(endDatePropertyId) ?? null : null),
    showTable: booleanValue(configuration.show_table) ?? null,
    tableProperties: arrayValue(configuration.table_properties).map((entry) => inlineViewPropertyConfigSummary(recordValue(entry), schemaById)),
    preference: inlineViewTimelinePreferenceSummary(configuration.preference),
    arrowsBy: inlineViewTimelineArrowsBySummary(configuration.arrows_by, schemaById),
    colorBy: booleanValue(configuration.color_by) ?? null,
  };
}

function inlineViewFormSummary(configuration: Record<string, unknown>): Record<string, unknown> | null {
  const hasFormFields = stringValue(configuration.type) === "form"
    || booleanValue(configuration.is_form_closed) !== undefined
    || booleanValue(configuration.anonymous_submissions) !== undefined
    || stringValue(configuration.submission_permissions) !== null;
  if (!hasFormFields) return null;
  return {
    isFormClosed: booleanValue(configuration.is_form_closed) ?? null,
    anonymousSubmissions: booleanValue(configuration.anonymous_submissions) ?? null,
    submissionPermissions: stringValue(configuration.submission_permissions),
  };
}

function inlineViewTimelinePreferenceSummary(value: unknown): Record<string, unknown> | null {
  const preference = recordValue(value);
  if (Object.keys(preference).length === 0) return null;
  return {
    zoomLevel: stringValue(preference.zoom_level) ?? stringValue(preference.zoom),
    centerTimestamp: numberValue(preference.center_timestamp) ?? null,
    raw: inlineViewShallowObject(preference),
  };
}

function inlineViewTimelineArrowsBySummary(value: unknown, schemaById: Map<string, string>): Record<string, unknown> | null {
  const arrowsBy = recordValue(value);
  if (Object.keys(arrowsBy).length === 0) return null;
  const propertyId = stringValue(arrowsBy.property_id);
  return {
    propertyId,
    propertyName: stringValue(arrowsBy.property_name) ?? (propertyId ? schemaById.get(propertyId) ?? null : null),
    raw: inlineViewShallowObject(arrowsBy),
  };
}

function inlineViewMapSummary(
  configuration: Record<string, unknown>,
  schemaById: Map<string, string>,
): Record<string, unknown> | null {
  const hasMapFields = stringValue(configuration.type) === "map"
    || stringValue(configuration.map_by) !== null
    || stringValue(configuration.map_by_property_name) !== null;
  if (!hasMapFields) return null;
  const mapBy = stringValue(configuration.map_by);
  return {
    height: stringValue(configuration.height),
    mapBy,
    mapByPropertyName: stringValue(configuration.map_by_property_name)
      ?? (mapBy ? schemaById.get(mapBy) ?? null : null),
    properties: arrayValue(configuration.properties).map((entry) => inlineViewPropertyConfigSummary(recordValue(entry), schemaById)),
  };
}

function inlineViewDashboardSummary(configuration: Record<string, unknown>): Record<string, unknown> | null {
  const rows = inlineViewDashboardRowsSummary(configuration.rows);
  if (stringValue(configuration.type) !== "dashboard" && rows.length === 0) return null;
  return {
    rowCount: rows.length,
    rows,
  };
}

function summarizeInlineViewGroup(value: unknown, schemaById: Map<string, string>): Record<string, unknown> | null {
  const group = recordValue(value);
  if (Object.keys(group).length === 0) return null;
  const propertyId = stringValue(group.property_id) ?? stringValue(group.id);
  return {
    propertyId,
    propertyName: stringValue(group.property_name)
      ?? stringValue(group.name)
      ?? stringValue(group.property)
      ?? (propertyId ? schemaById.get(propertyId) ?? null : null),
    type: stringValue(group.property_type) ?? stringValue(group.type),
    direction: stringValue(group.direction),
    sort: stringValue(group.sort),
    groupBy: stringValue(group.group_by),
    dateBy: stringValue(group.date_by),
    startDayOfWeek: stringValue(group.start_day_of_week) ?? numberValue(group.start_day_of_week),
    rangeStart: numberValue(group.range_start),
    rangeEnd: numberValue(group.range_end),
    rangeSize: numberValue(group.range_size),
    aggregator: stringValue(group.aggregator) ?? stringValue(group.aggregation),
    aggregation: stringValue(group.aggregation) ?? stringValue(group.aggregator),
    hideEmptyGroups: booleanValue(group.hide_empty_groups),
    groups: summarizeComplexValue(group.groups),
    visibleGroups: summarizeComplexValue(group.visible_groups),
    hiddenGroups: summarizeComplexValue(group.hidden_groups),
  };
}

function inlineViewDashboardRowsSummary(value: unknown): Array<Record<string, unknown>> {
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
        x: numberValue(entry.x) ?? null,
        y: numberValue(entry.y) ?? null,
        row: numberValue(entry.row) ?? null,
        rowIndex: numberValue(entry.row_index) ?? numberValue(entry.row) ?? null,
        column: numberValue(entry.column) ?? null,
        widthRatio: numberValue(entry.width_ratio) ?? null,
        width: numberValue(entry.width) ?? null,
        height: numberValue(entry.height) ?? null,
        viewId: stringValue(entry.view_id),
        dataSourceId: stringValue(entry.data_source_id),
        configuration: inlineViewShallowObject(entry.configuration),
      };
    });
    return {
      index: rowIndex,
      id: stringValue(record.id),
      type: stringValue(record.type),
      height: numberValue(record.height) ?? null,
      widgetCount: widgetSummaries.length,
      widgets: widgetSummaries,
      moduleCount: widgetSummaries.length,
      modules: widgetSummaries,
    };
  });
}

function inlineViewShallowObject(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (Object.keys(record).length === 0) return null;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) return [key, entry];
    return [key, summarizeComplexValue(entry)];
  }));
}

function inlineViewChartSummary(
  configuration: Record<string, unknown>,
  schemaById: Map<string, string>,
): Record<string, unknown> | null {
  const type = stringValue(configuration.type);
  const hasChartFields = type === "chart"
    || stringValue(configuration.chart_type) != null
    || recordHasKeys(configuration.x_axis)
    || recordHasKeys(configuration.y_axis)
    || recordHasKeys(configuration.value)
    || arrayValue(configuration.reference_lines).length > 0;
  if (!hasChartFields) return null;
  const xAxisPropertyId = stringValue(configuration.x_axis_property_id);
  const yAxisPropertyId = stringValue(configuration.y_axis_property_id);
  const referenceLines = arrayValue(configuration.reference_lines)
    .map(inlineViewChartReferenceLineSummary)
    .filter((line): line is Record<string, unknown> => Boolean(line));
  return {
    chartType: stringValue(configuration.chart_type),
    xAxis: summarizeInlineViewGroup(configuration.x_axis, schemaById),
    yAxis: inlineViewChartAggregationSummary(configuration.y_axis, schemaById),
    xAxisPropertyId,
    xAxisPropertyName: xAxisPropertyId ? schemaById.get(xAxisPropertyId) ?? null : null,
    yAxisPropertyId,
    yAxisPropertyName: yAxisPropertyId ? schemaById.get(yAxisPropertyId) ?? null : null,
    value: inlineViewChartAggregationSummary(configuration.value, schemaById),
    sort: stringValue(configuration.sort),
    colorTheme: stringValue(configuration.color_theme),
    height: stringValue(configuration.height),
    hideEmptyGroups: booleanValue(configuration.hide_empty_groups) ?? null,
    legendPosition: stringValue(configuration.legend_position),
    showDataLabels: booleanValue(configuration.show_data_labels) ?? null,
    axisLabels: stringValue(configuration.axis_labels),
    gridLines: stringValue(configuration.grid_lines),
    cumulative: booleanValue(configuration.cumulative) ?? null,
    smoothLine: booleanValue(configuration.smooth_line) ?? null,
    hideLineFillArea: booleanValue(configuration.hide_line_fill_area) ?? null,
    groupStyle: stringValue(configuration.group_style),
    yAxisMin: numberValue(configuration.y_axis_min) ?? null,
    yAxisMax: numberValue(configuration.y_axis_max) ?? null,
    donutLabels: stringValue(configuration.donut_labels),
    hideTitle: booleanValue(configuration.hide_title) ?? null,
    stackBy: summarizeInlineViewGroup(configuration.stack_by, schemaById),
    referenceLines,
    referenceLineCount: referenceLines.length,
    caption: stringValue(configuration.caption),
    colorByValue: booleanValue(configuration.color_by_value) ?? null,
  };
}

function inlineViewChartAggregationSummary(
  value: unknown,
  schemaById: Map<string, string>,
): Record<string, unknown> | null {
  const aggregation = recordValue(value);
  if (Object.keys(aggregation).length === 0) return null;
  const propertyId = stringValue(aggregation.property_id);
  return {
    aggregator: stringValue(aggregation.aggregator),
    propertyId,
    propertyName: propertyId ? schemaById.get(propertyId) ?? null : null,
  };
}

function inlineViewChartReferenceLineSummary(value: unknown): Record<string, unknown> | null {
  const line = recordValue(value);
  if (Object.keys(line).length === 0) return null;
  return {
    id: stringValue(line.id),
    value: numberValue(line.value) ?? null,
    label: stringValue(line.label),
    color: stringValue(line.color),
    dashStyle: stringValue(line.dash_style),
  };
}

function collectInlineViewRowGroups(
  view: NotionInlineDataSourceView,
  rows: NotionInlineDataSourceRow[],
  blockId: string,
  warnings: NotionSourceWarning[],
): NotionInlineDataSourceViewRowGroup[] {
  const group = firstInlineViewGroupSpec(view);
  if (!group && arrayValue(view.configurationSummary.groups).length > 0) {
    warnings.push({
      code: "inline_database_view_group_unresolved",
      blockId,
      message: `Notion view ${view.viewId} has grouping configuration without a property id or name; row groups were not derived.`,
    });
  }
  if (!group) return [];

  const grouped = new Map<string, NotionInlineDataSourceViewRowGroup>();
  for (const row of rows) {
    const property = row.propertyValues.find((candidate) =>
      Boolean(group.propertyId && candidate.id === group.propertyId)
        || Boolean(group.propertyName && candidate.name === group.propertyName));
    for (const value of inlineViewGroupValues(property)) {
      const key = `${group.propertyId ?? group.propertyName ?? ""}\0${value.groupValueId ?? value.groupValue}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.pageIds.push(row.pageId);
        existing.rowCount = existing.pageIds.length;
      } else {
        grouped.set(key, {
          propertyId: group.propertyId,
          propertyName: group.propertyName,
          propertyType: property?.type ?? group.propertyType,
          groupValue: value.groupValue,
          groupValueId: value.groupValueId,
          groupColor: value.groupColor,
          pageIds: [row.pageId],
          rowCount: 1,
        });
      }
    }
  }
  return [...grouped.values()];
}

function firstInlineViewGroupSpec(view: NotionInlineDataSourceView): {
  propertyId: string | null;
  propertyName: string | null;
  propertyType: string | null;
} | null {
  for (const value of arrayValue(view.configurationSummary.groups)) {
    const group = recordValue(value);
    const propertyId = stringValue(group.propertyId);
    const propertyName = stringValue(group.propertyName);
    if (!propertyId && !propertyName) continue;
    return {
      propertyId,
      propertyName,
      propertyType: stringValue(group.propertyType) ?? stringValue(group.type),
    };
  }
  return null;
}

function inlineViewGroupValues(property: NotionPropertyValueSummary | undefined): Array<{
  groupValue: string;
  groupValueId: string | null;
  groupColor: string | null;
}> {
  if (!property) return [{ groupValue: "(empty)", groupValueId: null, groupColor: null }];
  if (property.options?.length) {
    return property.options.map((option) => ({
      groupValue: option.name ?? option.id ?? "(empty)",
      groupValueId: option.id,
      groupColor: option.color,
    }));
  }
  if (typeof property.checked === "boolean") {
    return [{ groupValue: property.checked ? "Yes" : "No", groupValueId: String(property.checked), groupColor: null }];
  }
  const display = property.display.trim();
  return [{
    groupValue: display || "(empty)",
    groupValueId: null,
    groupColor: null,
  }];
}

async function hydrateAndOrderInlineViewRows(
  userId: string,
  rows: NotionPage[],
  view: NotionInlineDataSourceView | null,
  blockId: string,
  warnings: NotionSourceWarning[],
): Promise<NotionPage[]> {
  if (!view || view.resultPageIds.length === 0) return rows;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const visibleRows: NotionPage[] = [];
  for (const pageId of view.resultPageIds) {
    const existing = rowsById.get(pageId);
    if (existing) {
      visibleRows.push(existing);
      continue;
    }
    try {
      visibleRows.push(await retrieveNotionPage(userId, pageId));
    } catch (err) {
      warnings.push({
        code: "inline_database_view_row_fetch_failed",
        blockId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return visibleRows;
}

function notionResultPageId(value: unknown): string | null {
  const result = recordValue(value);
  return stringValue(result.id) ?? stringValue(result.page_id);
}

function notionResultReference(value: unknown): Record<string, unknown> | null {
  const result = recordValue(value);
  const id = stringValue(result.id) ?? stringValue(result.page_id);
  if (!id) return null;
  return {
    object: stringValue(result.object) ?? "page",
    id,
  };
}

function inlinePropertyValue(name: string, row: NotionPage): string {
  const property = recordValue(row.properties?.[name]);
  const type = stringValue(property.type);
  if (!type && name === "Name") return extractNotionTitle(row) || "Untitled";
  return propertyDisplayValue(property, { fallbackTitle: extractNotionTitle(row) || "Untitled" });
}

export function renderNotionPropertyValue(property: Record<string, unknown>, opts: { fallbackTitle?: string } = {}): string {
  return propertyDisplayValue(property, opts);
}

export function summarizeNotionPropertyValues(
  pageTitle: string,
  properties: Record<string, unknown>,
): NotionPropertyValueSummary[] {
  return Object.entries(properties).map(([name, raw]) => {
    const property = recordValue(raw);
    return summarizeNotionPropertyValue(name, property, pageTitle);
  });
}

export function summarizeNotionRichText(items: unknown[]): NotionRichTextSpanSummary[] {
  return items.map((item) => {
    const record = recordValue(item);
    const type = stringValue(record.type) ?? "unknown";
    const href = stringValue(record.href);
    const text = recordValue(record.text);
    const textLink = recordValue(text.link);
    const textLinkUrl = stringValue(textLink.url);
    const equation = recordValue(record.equation);
    const expression = stringValue(equation.expression);
    return {
      type,
      plainText: stripMediaUrlsFromText(stringValue(record.plain_text) ?? stringValue(text.content) ?? expression ?? ""),
      href: href && !isMediaUrl(href) ? href : null,
      hrefRedacted: Boolean(href && isMediaUrl(href)),
      annotations: richTextAnnotations(record.annotations),
      text: type === "text" ? {
        content: stripMediaUrlsFromText(stringValue(text.content) ?? ""),
        link: textLinkUrl && !isMediaUrl(textLinkUrl) ? textLinkUrl : null,
        linkRedacted: Boolean(textLinkUrl && isMediaUrl(textLinkUrl)),
      } : undefined,
      equation: type === "equation" && expression ? { expression } : undefined,
      mention: type === "mention" ? richTextMentionSummary(record.mention, record) : undefined,
    };
  });
}

function summarizeNotionPropertyValue(
  name: string,
  property: Record<string, unknown>,
  pageTitle: string,
): NotionPropertyValueSummary {
  const type = stringValue(property.type) ?? "unknown";
  const display = propertyDisplayValue(property, { fallbackTitle: pageTitle }).trim();
  const summary: NotionPropertyValueSummary = {
    name,
    id: stringValue(property.id),
    type,
    display,
    plainText: comparablePropertyText(display),
    empty: display.length === 0,
  };
  const hydration = propertyHydrationSummary(property);
  if (hydration) summary.hydration = hydration;

  switch (type) {
    case "title":
    case "rich_text": {
      summary.richText = summarizeNotionRichText(arrayValue(property[type]));
      summary.mentions = richTextMentionSummaries(summary.richText);
      summary.linkUrls = richTextLinkUrls(summary.richText);
      break;
    }
    case "relation":
      summary.relationIds = arrayValue(property.relation)
        .map((item) => stringValue(recordValue(item).id))
        .filter((value): value is string => Boolean(value));
      summary.relationHasMore = booleanValue(property.has_more) ?? null;
      summary.loadedRelationCount = summary.relationIds.length;
      if (summary.relationHasMore !== true) summary.relationCount = summary.relationIds.length;
      break;
    case "rollup": {
      const rollup = recordValue(property.rollup);
      const rollupType = stringValue(rollup.type);
      summary.rollup = {
        type: rollupType,
        function: stringValue(rollup.function),
        display,
        value: rollupType ? summarizeTypedPropertyPayload(rollupType, rollup[rollupType]) : summarizeComplexValue(rollup),
        incomplete: rollupType === "incomplete",
        unsupported: rollupType === "unsupported",
      };
      break;
    }
    case "formula": {
      const formula = recordValue(property.formula);
      const formulaType = stringValue(formula.type);
      summary.formula = {
        type: formulaType,
        display,
        value: formulaType ? summarizeTypedPropertyPayload(formulaType, formula[formulaType]) : summarizeComplexValue(formula),
      };
      break;
    }
    case "files":
      summary.files = arrayValue(property.files).map((file) => fileSummary(recordValue(file)));
      break;
    case "people":
      summary.people = arrayValue(property.people).map((person) => personSummary(person));
      summary.peopleGroups = summary.people.filter((person) => person.objectType === "group");
      break;
    case "number":
      summary.number = numberValue(property.number) ?? null;
      break;
    case "url": {
      const url = stringValue(property.url);
      summary.url = url && !isMediaUrl(url) ? url : null;
      summary.urlRedacted = Boolean(url && isMediaUrl(url));
      break;
    }
    case "email":
      summary.email = stringValue(property.email);
      break;
    case "phone_number":
      summary.phoneNumber = stringValue(property.phone_number);
      break;
    case "created_time":
      summary.createdTime = stringValue(property.created_time);
      break;
    case "last_edited_time":
      summary.lastEditedTime = stringValue(property.last_edited_time);
      break;
    case "last_visited_time":
      summary.lastVisitedTime = stringValue(property.last_visited_time);
      break;
    case "created_by":
      summary.createdBy = personSummary(property.created_by);
      break;
    case "last_edited_by":
      summary.lastEditedBy = personSummary(property.last_edited_by);
      break;
    case "button":
      summary.button = summarizeComplexValue(property.button) as Record<string, unknown>;
      break;
    case "date":
      summary.date = dateSummary(property.date);
      break;
    case "checkbox":
      summary.checked = typeof property.checkbox === "boolean" ? property.checkbox : null;
      break;
    case "select":
    case "status": {
      const option = optionSummary(recordValue(property[type]));
      const optionName = option.name;
      summary.optionNames = optionName ? [optionName] : [];
      summary.options = optionName || option.id || option.color ? [option] : [];
      if (type === "status") summary.statusGroup = statusGroupSummary(recordValue(property.status).group);
      break;
    }
    case "multi_select":
      summary.options = arrayValue(property.multi_select).map((item) => optionSummary(recordValue(item)));
      summary.optionNames = summary.options
        .map((item) => item.name)
        .filter((value): value is string => Boolean(value));
      break;
    case "unique_id": {
      const uniqueId = recordValue(property.unique_id);
      const number = numberValue(uniqueId.number) ?? null;
      summary.uniqueId = {
        prefix: stringValue(uniqueId.prefix),
        number,
        value: uniqueIdValue(uniqueId),
      };
      break;
    }
    case "verification":
      summary.verification = verificationSummary(property.verification);
      break;
    case "place":
    case "location":
      summary.place = placeSummary(property[type]);
      break;
    default:
      break;
  }

  return summary;
}

function propertyHydrationSummary(property: Record<string, unknown>): NonNullable<NotionPropertyValueSummary["hydration"]> | null {
  const hydration = recordValue(property.shepherd_hydration);
  const propertyItem = propertyItemSummary(property.shepherd_property_item);
  const propertyItems = arrayValue(property.shepherd_property_items)
    .map(propertyItemSummary)
    .filter((item): item is NotionPropertyItemSummary => item !== null);
  const hasHydration = Object.keys(hydration).length > 0
    || typeof property.shepherd_hydrated === "boolean"
    || typeof property.shepherd_truncated === "boolean"
    || propertyItem !== null
    || propertyItems.length > 0
    || typeof property.has_more === "boolean"
    || Boolean(stringValue(property.next_cursor))
    || Boolean(stringValue(property.next_url));
  if (!hasHydration) return null;

  return {
    hydrated: booleanValue(property.shepherd_hydrated) ?? (Object.keys(hydration).length > 0),
    truncated: booleanValue(hydration.truncated)
      ?? booleanValue(property.shepherd_truncated)
      ?? booleanValue(property.has_more)
      ?? false,
    itemCount: numberValue(hydration.item_count) ?? null,
    pageCount: numberValue(hydration.page_count) ?? null,
    maxItems: numberValue(hydration.max_items) ?? null,
    nextCursor: stringValue(hydration.next_cursor) ?? stringValue(property.next_cursor),
    nextUrl: stringValue(hydration.next_url) ?? stringValue(property.next_url),
    cursorMissing: booleanValue(hydration.cursor_missing) ?? false,
    failed: booleanValue(hydration.failed),
    providerError: storedNotionApiErrorSummary(hydration.provider_error),
    ...(propertyItem ? { propertyItem } : {}),
    ...(propertyItems.length > 0 ? { propertyItems } : {}),
  };
}

function storedNotionApiErrorSummary(value: unknown): NotionApiErrorSummary | null {
  const direct = notionApiErrorSummary(value);
  if (direct) return direct;
  const record = recordValue(value);
  const status = numberValue(record.status);
  if (status === undefined) return null;
  return {
    status,
    code: stringValue(record.code),
    message: stringValue(record.message) ?? "",
    retryAfterMs: numberValue(record.retryAfterMs) ?? null,
  };
}

function propertyItemSummary(value: unknown): NotionPropertyItemSummary | null {
  const item = recordValue(value);
  if (Object.keys(item).length === 0) return null;
  const type = stringValue(item.type);
  const summary: NotionPropertyItemSummary = {
    object: stringValue(item.object),
    id: stringValue(item.id),
    type,
    nextUrl: stringValue(item.next_url),
  };
  if (type && item[type] !== undefined) {
    summary.value = summarizePropertyItemPayload(type, item[type]);
  }
  return summary;
}

function summarizePropertyItemPayload(type: string, value: unknown): unknown {
  if (type === "title" || type === "rich_text") {
    const richText = recordValue(value);
    const hasRichTextItem = Boolean(
      stringValue(richText.type)
        || stringValue(richText.plain_text)
        || recordHasKeys(richText.text)
        || recordHasKeys(richText.equation)
        || recordHasKeys(richText.mention),
    );
    return summarizeNestedRichTextPayload(hasRichTextItem ? [value] : []);
  }
  if (type === "people" || type === "created_by" || type === "last_edited_by") {
    return personSummary(value);
  }
  if (type === "relation") {
    const relation = recordValue(value);
    return { id: stringValue(relation.id) };
  }
  if (type === "rollup" || type === "formula") {
    const nested = recordValue(value);
    const nestedType = stringValue(nested.type);
    return nestedType ? {
      type: nestedType,
      display: type === "rollup" ? rollupPropertyValue(nested) : typedPropertyValue(nested),
      value: summarizeTypedPropertyPayload(nestedType, nested[nestedType]),
      function: type === "rollup" ? stringValue(nested.function) : undefined,
      incomplete: type === "rollup" ? nestedType === "incomplete" : undefined,
      unsupported: type === "rollup" ? nestedType === "unsupported" : undefined,
    } : summarizeComplexValue(nested);
  }
  return summarizeTypedPropertyPayload(type, value);
}

function richTextAnnotations(value: unknown): NotionRichTextSpanSummary["annotations"] {
  const annotations = recordValue(value);
  return {
    bold: annotations.bold === true,
    italic: annotations.italic === true,
    strikethrough: annotations.strikethrough === true,
    underline: annotations.underline === true,
    code: annotations.code === true,
    color: stringValue(annotations.color),
  };
}

function richTextMentionSummary(value: unknown, richText: Record<string, unknown>): NotionRichTextMentionSummary {
  const mention = recordValue(value);
  const type = stringValue(mention.type) ?? "unknown";
  const payload = recordValue(mention[type]);
  const url = stringValue(richText.href);
  const linkPreviewUrl = stringValue(recordValue(mention.link_preview).url);
  const linkMention = recordValue(mention.link_mention);
  const linkMentionHref = stringValue(linkMention.href);
  return {
    type,
    targetObjectType: stringValue(payload.object) ?? objectTypeForMention(type),
    targetPartial: partialMentionTarget(type, payload, richText),
    targetId: stringValue(payload.id) ?? stringValue(payload.page_id) ?? stringValue(payload.database_id),
    title: stringValue(richText.plain_text) ?? stringValue(payload.name) ?? stringValue(linkMention.title),
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
    user: type === "user" ? personSummary(payload) : undefined,
    date: type === "date" ? dateSummary(payload) : undefined,
    linkPreview: type === "link_preview" ? {
      url: linkPreviewUrl && !isMediaUrl(linkPreviewUrl) ? linkPreviewUrl : null,
      urlRedacted: Boolean(linkPreviewUrl && isMediaUrl(linkPreviewUrl)),
    } : undefined,
    linkMention: type === "link_mention" ? {
      href: linkMentionHref && !isMediaUrl(linkMentionHref) ? linkMentionHref : null,
      hrefRedacted: Boolean(linkMentionHref && isMediaUrl(linkMentionHref)),
      title: stringValue(linkMention.title),
      description: stringValue(linkMention.description),
      provider: stringValue(linkMention.link_provider),
      author: stringValue(linkMention.link_author),
      height: numberValue(linkMention.height) ?? null,
      padding: numberValue(linkMention.padding) ?? null,
      paddingTop: numberValue(linkMention.padding_top) ?? null,
      thumbnailUrlRedacted: Boolean(stringValue(linkMention.thumbnail_url)),
      iconUrlRedacted: Boolean(stringValue(linkMention.icon_url)),
      iframeUrlRedacted: Boolean(stringValue(linkMention.iframe_url)),
      attributes: unfurlAttributeSummaries(linkMention.unfurl_attributes),
    } : undefined,
    templateMention: type === "template_mention" ? templateMentionSummary(mention.template_mention) : undefined,
    customEmoji: type === "custom_emoji" ? {
      id: stringValue(payload.id),
      name: stringValue(payload.name),
      urlRedacted: Boolean(stringValue(payload.url)),
    } : undefined,
  };
}

function unfurlAttributeSummaries(value: unknown): NotionUnfurlAttributeSummary[] {
  return arrayValue(value).filter((entry) => Object.keys(recordValue(entry)).length > 0).slice(0, 50).map((entry) => {
    const attribute = recordValue(entry);
    const type = stringValue(attribute.type);
    const payload = recordValue(type ? attribute[type] : null);
    return {
      id: stringValue(attribute.id),
      name: stringValue(attribute.name),
      type,
      subtype: stringValue(payload.type),
      section: stringValue(payload.section),
      value: type === "inline" ? normalizedUnfurlValue(payload.value) : null,
      srcUrlRedacted: type === "embed" && Boolean(stringValue(payload.src_url)),
    };
  });
}

function normalizedUnfurlValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return summarizeComplexValue(value);
}

function propertyDisplayValue(property: Record<string, unknown>, opts: { fallbackTitle?: string } = {}): string {
  const type = stringValue(property.type);
  switch (type) {
    case "title":
      return richTextMarkdown(arrayValue(property.title)) || opts.fallbackTitle || "Untitled";
    case "rich_text":
      return richTextMarkdown(arrayValue(property.rich_text));
    case "number":
      return property.number === null || property.number === undefined ? "" : String(property.number);
    case "select":
    case "status":
      return stringValue(recordValue(property[type]).name) ?? "";
    case "multi_select":
      return arrayValue(property.multi_select)
        .map((item) => stringValue(recordValue(item).name))
        .filter((value): value is string => Boolean(value))
        .join(", ");
    case "date":
      return datePropertyValue(property.date);
    case "checkbox":
      return property.checkbox === true ? "Yes" : property.checkbox === false ? "No" : "";
    case "url": {
      const url = stringValue(property.url);
      return url && !isMediaUrl(url) ? url : "";
    }
    case "email":
    case "phone_number":
      return stringValue(property[type]) ?? "";
    case "people":
      return arrayValue(property.people).map(personLabel).filter(Boolean).join(", ");
    case "files":
      return arrayValue(property.files)
        .map(fileLabel)
        .filter(Boolean)
        .join(", ");
    case "relation":
      return arrayValue(property.relation)
        .map((item) => stringValue(recordValue(item).id))
        .filter((value): value is string => Boolean(value))
        .join(", ");
    case "formula":
      return typedPropertyValue(recordValue(property.formula));
    case "rollup":
      return rollupPropertyValue(recordValue(property.rollup));
    case "created_time":
    case "last_edited_time":
    case "last_visited_time":
      return stringValue(property[type]) ?? "";
    case "created_by":
    case "last_edited_by":
      return personLabel(property[type]);
    case "unique_id":
      return uniqueIdValue(recordValue(property.unique_id));
    case "verification":
      return verificationValue(recordValue(property.verification));
    case "place":
    case "location":
      return placeValue(property[type]);
    case "button":
      return "";
    default:
      return compactJson(type ? property[type] ?? property : property, 300);
  }
}

function pagePropertySectionRecord(
  pageId: string,
  pageTitle: string,
  properties: Record<string, unknown>,
): NotionSection | null {
  const rows = pagePropertyRows(pageTitle, properties);
  if (rows.length === 0) return null;
  const propertyValues = meaningfulPropertySummaries(pageTitle, properties);
  const propertyReferences = propertyValueReferences(propertyValues, { pageId });
  const content = [
    "| Property | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${escapeTableCell(name)} | ${escapeTableCell(value)} |`),
  ].join("\n");
  return {
    sectionId: `notion-section:${pageId}:properties`,
    sectionTitle: "Properties",
    content,
    contentHash: hashContent(JSON.stringify({ content, rows, propertyValues })),
    kind: "properties",
    anchorBlockId: null,
    rootBlockIds: [],
    structuredFacts: {
      propertyCount: propertyValues.length,
      propertyNames: propertyValues.map((property) => property.name),
      propertyTypes: countBy(propertyValues.map((property) => property.type)),
      propertyValues,
      propertyReferenceCount: propertyReferences.length,
      propertyReferenceTargets: propertyReferences.map(referenceFact),
    },
    warningCodes: [],
  };
}

function pagePropertyRows(pageTitle: string, properties: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = recordValue(raw);
    const type = stringValue(property.type);
    const value = propertyDisplayValue(property, { fallbackTitle: pageTitle }).trim();
    if (!value) continue;
    if (type === "title" && comparablePropertyText(value) === comparablePropertyText(pageTitle)) continue;
    rows.push([name, value]);
  }
  return rows;
}

function meaningfulPropertySummaries(
  pageTitle: string,
  properties: Record<string, unknown>,
  opts: { includeMatchingTitle?: boolean } = {},
): NotionPropertyValueSummary[] {
  return summarizeNotionPropertyValues(pageTitle, properties)
    .filter((property) => {
      if (property.empty) return false;
      if (!opts.includeMatchingTitle && property.type === "title" && comparablePropertyText(property.display) === comparablePropertyText(pageTitle)) return false;
      return true;
    });
}

function propertyFingerprint(pageTitle: string, properties: Record<string, unknown>): Array<[string, string]> {
  return pagePropertyRows(pageTitle, properties);
}

function comparablePropertyText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`~<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function datePropertyValue(value: unknown): string {
  const date = recordValue(value);
  const start = stringValue(date.start);
  const end = stringValue(date.end);
  if (start && end) return `${start} to ${end}`;
  return start ?? end ?? "";
}

function typedPropertyValue(value: Record<string, unknown>): string {
  const type = stringValue(value.type);
  if (!type) return compactJson(value, 300);
  if (type === "date") return datePropertyValue(value.date);
  const raw = value[type];
  if (raw === null || raw === undefined) return "";
  if (type === "array") return syntheticPropertyArrayValue(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return isMediaUrl(raw) ? "" : raw;
  return compactJson(raw, 300);
}

function rollupPropertyValue(value: Record<string, unknown>): string {
  const type = stringValue(value.type);
  if (type === "array") return syntheticPropertyArrayValue(value.array);
  return typedPropertyValue(value);
}

function syntheticPropertyArrayValue(value: unknown): string {
  return arrayValue(value)
    .map((item) => {
      const record = recordValue(item);
      const itemType = stringValue(record.type);
      if (!itemType) return compactJson(record, 160);
      return inlineSyntheticPropertyValue(itemType, record);
    })
    .filter(Boolean)
    .join(", ");
}

function inlineSyntheticPropertyValue(type: string, property: Record<string, unknown>): string {
  if (type === "title" || type === "rich_text") return richTextMarkdown(arrayValue(property[type]));
  if (type === "select" || type === "status") return stringValue(recordValue(property[type]).name) ?? "";
  if (type === "multi_select") {
    return arrayValue(property.multi_select)
      .map((item) => stringValue(recordValue(item).name))
      .filter((value): value is string => Boolean(value))
      .join(", ");
  }
  if (type === "date") return datePropertyValue(property.date);
  if (type === "people") return arrayValue(property.people).map(personLabel).filter(Boolean).join(", ");
  if (type === "files") return arrayValue(property.files).map(fileLabel).filter(Boolean).join(", ");
  if (type === "relation") {
    return arrayValue(property.relation)
      .map((item) => stringValue(recordValue(item).id))
      .filter((value): value is string => Boolean(value))
      .join(", ");
  }
  if (type === "formula") return typedPropertyValue(recordValue(property.formula));
  if (type === "rollup") return rollupPropertyValue(recordValue(property.rollup));
  if (type === "created_by" || type === "last_edited_by") return personLabel(property[type]);
  if (type === "created_time" || type === "last_edited_time") return stringValue(property[type]) ?? "";
  if (type === "unique_id") return uniqueIdValue(recordValue(property.unique_id));
  if (type === "verification") return verificationValue(recordValue(property.verification));
  if (type === "place" || type === "location") return placeValue(property[type]);
  const raw = property[type];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return isMediaUrl(raw) ? "" : raw;
  return compactJson(raw, 160);
}

function summarizeTypedPropertyPayload(type: string, value: unknown): unknown {
  if (type === "array") {
    return arrayValue(value).slice(0, 100).map((item) => {
      const record = recordValue(item);
      const itemType = stringValue(record.type);
      if (!itemType) return summarizeComplexValue(record);
      const summary: Record<string, unknown> = {
        type: itemType,
        display: inlineSyntheticPropertyValue(itemType, record),
        value: summarizeTypedPropertyPayload(itemType, record[itemType]),
      };
      const relationHasMore = itemType === "relation" ? booleanValue(record.has_more) : undefined;
      if (relationHasMore !== undefined) summary.hasMore = relationHasMore;
      return summary;
    });
  }
  if (type === "date") return dateSummary(value);
  if (type === "people") return arrayValue(value).map((person) => personSummary(person));
  if (type === "files") return arrayValue(value).map((file) => fileSummary(recordValue(file)));
  if (type === "relation") {
    return arrayValue(value)
      .map((item) => stringValue(recordValue(item).id))
      .filter((id): id is string => Boolean(id));
  }
  if (type === "select" || type === "status") {
    const option = recordValue(value);
    return {
      ...optionSummary(option),
      group: type === "status" ? statusGroupSummary(option.group) : null,
    };
  }
  if (type === "title" || type === "rich_text") return summarizeNestedRichTextPayload(value);
  if (type === "url") {
    const url = stringValue(value);
    return { url: url && !isMediaUrl(url) ? url : null, urlRedacted: Boolean(url && isMediaUrl(url)) };
  }
  if (type === "email" || type === "phone_number" || type === "created_time" || type === "last_edited_time" || type === "last_visited_time") {
    return stringValue(value);
  }
  if (type === "created_by" || type === "last_edited_by") return personSummary(value);
  if (type === "unique_id") {
    const uniqueId = recordValue(value);
    return {
      prefix: stringValue(uniqueId.prefix),
      number: numberValue(uniqueId.number) ?? null,
      value: uniqueIdValue(uniqueId),
    };
  }
  if (type === "verification") {
    return verificationSummary(value);
  }
  if (type === "place" || type === "location") return placeSummary(value);
  if (typeof value === "string") return isMediaUrl(value) ? "[redacted media URL]" : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return summarizeComplexValue(value);
}

function summarizeComplexValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return isMediaUrl(value) ? "[redacted media URL]" : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(summarizeComplexValue);
  const record = recordValue(value);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "plain_text")
    .slice(0, 50)
    .map(([key, entry]) => [key, summarizeComplexValue(entry)]));
}

function summarizeNestedRichTextPayload(value: unknown): {
  plainText: string;
  richText: NotionRichTextSpanSummary[];
  mentions: NotionRichTextMentionSummary[];
  linkUrls: string[];
} {
  const richText = summarizeNotionRichText(arrayValue(value));
  return {
    plainText: richTextPlain(arrayValue(value)),
    richText,
    mentions: richTextMentionSummaries(richText),
    linkUrls: richTextLinkUrls(richText),
  };
}

function richTextMentionSummaries(richText: NotionRichTextSpanSummary[]): NotionRichTextMentionSummary[] {
  return richText.map((span) => span.mention).filter((value): value is NotionRichTextMentionSummary => Boolean(value));
}

function richTextLinkUrls(richText: NotionRichTextSpanSummary[]): string[] {
  return [...new Set(richText
    .flatMap((span) => [
      span.href,
      span.text?.link ?? null,
      span.mention?.url ?? null,
      span.mention?.linkPreview?.url ?? null,
      span.mention?.linkMention?.href ?? null,
    ])
    .filter((value): value is string => Boolean(value)))];
}

function personSummary(value: unknown): NotionUserSummary {
  const person = recordValue(value);
  const bot = recordValue(person.bot);
  const owner = recordValue(bot.owner);
  const ownerUser = recordValue(owner.user);
  const workspaceLimits = recordValue(bot.workspace_limits);
  const avatarUrl = stringValue(person.avatar_url);
  return {
    id: stringValue(person.id),
    objectType: stringValue(person.object),
    type: stringValue(person.type),
    name: stringValue(person.name),
    email: stringValue(recordValue(person.person).email),
    emailVerified: booleanValue(recordValue(person.person).email_verified) ?? null,
    avatarUrlRedacted: Boolean(avatarUrl),
    bot: Object.keys(bot).length > 0
      ? {
        ownerType: stringValue(owner.type),
        ownerUser: Object.keys(ownerUser).length > 0 ? personSummary(ownerUser) : null,
        workspaceId: stringValue(bot.workspace_id),
        workspaceName: stringValue(bot.workspace_name),
        maxFileUploadSizeInBytes: numberValue(workspaceLimits.max_file_upload_size_in_bytes) ?? null,
      }
      : null,
    partial: partialUserObject(person),
  };
}

function templateMentionSummary(value: unknown): NonNullable<NotionRichTextMentionSummary["templateMention"]> {
  const template = summarizeComplexValue(value) as Record<string, unknown>;
  const type = stringValue(template.type);
  return {
    ...template,
    templateMentionType: type,
    templateMentionDate: type === "template_mention_date" ? stringValue(template.template_mention_date) : null,
    templateMentionUser: type === "template_mention_user" ? stringValue(template.template_mention_user) : null,
  };
}

function fileSummary(value: Record<string, unknown>): NonNullable<NotionPropertyValueSummary["files"]>[number] {
  const type = stringValue(value.type);
  const payload = type ? recordValue(value[type]) : {};
  const fileUpload = recordValue(value.file_upload);
  const file = recordValue(value.file);
  const external = recordValue(value.external);
  const url = stringValue(payload.url) ?? stringValue(file.url) ?? stringValue(external.url);
  const uploadId = stringValue(fileUpload.id) ?? (type === "file_upload" ? stringValue(payload.id) : null);
  const lifecycle = fileUploadLifecycleSummary(fileUpload, payload, type);
  return {
    name: stringValue(value.name),
    type,
    fileObject: propertyFileObjectSummary(value, type, payload, fileUpload, file, url, lifecycle),
    fileUploadId: uploadId,
    filename: stringValue(fileUpload.filename) ?? (type === "file_upload" ? stringValue(payload.filename) : null),
    contentType: stringValue(fileUpload.content_type) ?? (type === "file_upload" ? stringValue(payload.content_type) : null),
    contentLength: numberValue(fileUpload.content_length) ?? (type === "file_upload" ? numberValue(payload.content_length) ?? null : null),
    status: stringValue(fileUpload.status) ?? (type === "file_upload" ? stringValue(payload.status) : null),
    ...lifecycle,
    expiryTime: stringValue(payload.expiry_time) ?? stringValue(file.expiry_time),
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
  };
}

function propertyFileObjectSummary(
  value: Record<string, unknown>,
  type: string | null,
  payload: Record<string, unknown>,
  fileUpload: Record<string, unknown>,
  file: Record<string, unknown>,
  url: string | null,
  lifecycle: Record<string, unknown>,
): NotionPropertyFileObjectSummary {
  const name = stringValue(value.name) ?? stringValue(value.filename) ?? stringValue(fileUpload.filename);
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
        id: stringValue(fileUpload.id) ?? stringValue(payload.id),
        filename: stringValue(fileUpload.filename) ?? stringValue(payload.filename),
        contentType: stringValue(fileUpload.content_type) ?? stringValue(payload.content_type),
        contentLength: numberValue(fileUpload.content_length) ?? numberValue(payload.content_length) ?? null,
        status: stringValue(fileUpload.status) ?? stringValue(payload.status),
        expiryTime: stringValue(upload.expiry_time),
        createdTime: stringValue(upload.created_time),
        lastEditedTime: stringValue(upload.last_edited_time),
        inTrash: booleanValue(upload.in_trash) ?? null,
        archived: booleanValue(upload.archived) ?? null,
        createdBy: lifecycle.fileUploadCreatedBy as NotionCommentAttachmentFileUploadSummary["createdBy"],
        numberOfParts: lifecycle.fileUploadNumberOfParts as NotionCommentAttachmentFileUploadSummary["numberOfParts"],
        importResult: lifecycle.fileUploadImportResult as NotionCommentAttachmentFileUploadSummary["importResult"],
        uploadUrlRedacted: lifecycle.fileUploadUploadUrlRedacted as boolean | undefined,
        completeUrlRedacted: lifecycle.fileUploadCompleteUrlRedacted as boolean | undefined,
      }
      : null,
  };
}

function meetingNotesSummary(value: Record<string, unknown>, title: string): NotionMeetingNotesSummary {
  const children = recordValue(value.children);
  const calendarEvent = recordHasKeys(value.calendar_event) ? recordValue(value.calendar_event) : null;
  const recording = recordHasKeys(value.recording) ? recordValue(value.recording) : null;
  return {
    title,
    status: stringValue(value.status),
    children: {
      summaryBlockId: stringValue(children.summary_block_id),
      notesBlockId: stringValue(children.notes_block_id),
      transcriptBlockId: stringValue(children.transcript_block_id),
    },
    calendarEvent: calendarEvent
      ? {
        startTime: stringValue(calendarEvent.start_time),
        endTime: stringValue(calendarEvent.end_time),
        attendees: arrayValue(calendarEvent.attendees).flatMap((attendee) => {
          const summary = meetingAttendeeSummary(attendee);
          return summary.id || summary.name || summary.email ? [summary] : [];
        }),
      }
      : null,
    recording: recording
      ? {
        startTime: stringValue(recording.start_time),
        endTime: stringValue(recording.end_time),
      }
      : null,
  };
}

function meetingAttendeeSummary(attendee: unknown): NotionMeetingAttendeeSummary {
  if (typeof attendee === "string") {
    return {
      id: stringValue(attendee),
      objectType: null,
      type: null,
      name: null,
      email: null,
      partial: true,
    };
  }
  const user = personSummary(attendee);
  const partial = user.partial || (!user.objectType && !user.type && !user.name && !user.email);
  return {
    id: user.id,
    objectType: user.objectType,
    type: user.type,
    name: user.name,
    email: user.email,
    partial,
  };
}

function meetingAttendeeLabel(attendee: NotionMeetingAttendeeSummary): string {
  return attendee.name ?? attendee.email ?? attendee.id ?? "unknown";
}

function dateSummary(value: unknown): { start: string | null; end: string | null; timeZone: string | null } {
  const date = recordValue(value);
  return {
    start: stringValue(date.start),
    end: stringValue(date.end),
    timeZone: stringValue(date.time_zone),
  };
}

function placeSummary(value: unknown): NonNullable<NotionPropertyValueSummary["place"]> {
  const unsupportedApiNull = value === null;
  const place = recordValue(value);
  return {
    lat: numberValue(place.lat) ?? null,
    lon: numberValue(place.lon) ?? null,
    name: stringValue(place.name),
    address: stringValue(place.address),
    awsPlaceId: stringValue(place.aws_place_id),
    googlePlaceId: stringValue(place.google_place_id),
    ...(unsupportedApiNull ? { unsupportedApiNull: true } : {}),
  };
}

function optionSummary(value: Record<string, unknown>): { id: string | null; name: string | null; color: string | null } {
  return {
    id: stringValue(value.id),
    name: stringValue(value.name),
    color: stringValue(value.color),
  };
}

function statusGroupSummary(value: unknown): NonNullable<NotionPropertyValueSummary["statusGroup"]> | null {
  const group = recordValue(value);
  if (Object.keys(group).length === 0) return null;
  return {
    id: stringValue(group.id),
    name: stringValue(group.name),
    color: stringValue(group.color),
    optionIds: arrayValue(group.option_ids).filter((id): id is string => typeof id === "string"),
  };
}

function verificationSummary(value: unknown): NonNullable<NotionPropertyValueSummary["verification"]> {
  const verification = recordValue(value);
  const verifiedBy = recordValue(verification.verified_by);
  const date = verification.date;
  return {
    state: stringValue(verification.state),
    date: datePropertyValue(date),
    dateRange: dateSummary(date),
    verifiedBy: Object.keys(verifiedBy).length > 0 ? personSummary(verifiedBy) : null,
  };
}

function personLabel(value: unknown): string {
  const person = recordValue(value);
  const label = stringValue(person.name) ?? stringValue(recordValue(person.person).email) ?? stringValue(person.id) ?? "";
  return stringValue(person.object) === "group" && label ? `${label} (group)` : label;
}

function fileLabel(value: unknown): string {
  const file = recordValue(value);
  return stringValue(file.name) ?? "";
}

function uniqueIdValue(value: Record<string, unknown>): string {
  const prefix = stringValue(value.prefix);
  const number = typeof value.number === "number" ? String(value.number) : "";
  return [prefix, number].filter(Boolean).join("-");
}

function verificationValue(value: Record<string, unknown>): string {
  const state = stringValue(value.state);
  const date = datePropertyValue(value.date);
  return [state, date].filter(Boolean).join(" ");
}

function placeValue(value: unknown): string {
  const place = placeSummary(value);
  const coordinates = place.lat !== null && place.lon !== null ? `${place.lat}, ${place.lon}` : "";
  return [place.name, place.address, coordinates].filter(Boolean).join(" ");
}

function compactJson(value: unknown, maxChars: number): string {
  const text = stripMediaUrlsFromText(JSON.stringify(value) ?? "");
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function stripMediaFromMarkdown(markdown: string, opts: { preserveRedactedMediaMarkers?: boolean } = {}): string {
  let text = markdown;
  const mediaTagPattern = new RegExp(`<(${MEDIA_MARKDOWN_TAG})\\b([^>]*)(?:/>|>([\\s\\S]*?)</\\1>)`, "gi");
  text = text.replace(mediaTagPattern, (match, type: string, attributes: string, caption: string | undefined, offset: number) => {
    if (isEscapedMarkdownSyntax(text, offset)) return match;
    if (!opts.preserveRedactedMediaMarkers) return "";
    return redactedMediaMarkdownMarker(type, stripMarkupText(caption ?? ""), attributes ?? "");
  });
  text = text.replace(/!\[([^\]]*)]\(([^)]+)\)([ \t]*\{[^\n]*\})?/g, (match, caption: string, url: string, attributes: string | undefined, offset: number) => {
    if (isEscapedMarkdownSyntax(text, offset)) return match;
    if (!isMediaUrl(cleanMarkdownUrl(url))) return match;
    if (!opts.preserveRedactedMediaMarkers) return "";
    return redactedMediaMarkdownMarker("image", caption, attributes ?? "", true);
  });
  text = text.replace(/\[([^\]]*)]\(([^)]+)\)/g, (match, label: string, url: string) =>
    isMediaUrl(cleanMarkdownUrl(url)) ? label.trim() : match);
  return stripMediaUrlsFromText(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function redactedMediaMarkdownMarker(type: string, caption: string, attributes: string, hasSourceOverride?: boolean): string {
  const parsed = parseEnhancedMarkdownAttributes(attributes);
  const hasSource = hasSourceOverride ?? Boolean(parsed.src);
  return `<${REDACTED_MEDIA_MARKDOWN_TAG} type="${escapeHtmlAttribute(type)}" caption="${escapeHtmlAttribute(caption.trim())}" has-source="${hasSource ? "true" : "false"}"${parsed.color ? ` color="${escapeHtmlAttribute(parsed.color)}"` : ""}/>`;
}

function stripRedactedMediaMarkers(markdown: string): string {
  const markerPattern = new RegExp(`^[ \\t]*<${REDACTED_MEDIA_MARKDOWN_TAG}\\b[^>]*\\/>[ \\t]*(?:\\n|$)`, "gimu");
  return markdown
    .replace(markerPattern, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripMediaUrlsFromText(text: string): string {
  return text
    .replace(/<https?:\/\/[^>\s]+>/gi, (match) => {
      const url = match.slice(1, -1);
      return isMediaUrl(url) ? "" : match;
    })
    .replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
      const { url, suffix } = splitTrailingPunctuation(match);
      return isMediaUrl(url) ? suffix : match;
    })
    .replace(/"https?:\/\/[^"]+"/gi, (match) => {
      const url = match.slice(1, -1);
      return isMediaUrl(url) ? "\"\"" : match;
    })
    .replace(/\(\s*\)/g, "")
    .replace(/ {2,}/g, " ");
}

function isMediaUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
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
  if (!/^https?:\/\//i.test(trimmed)) return false;
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

function cleanMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("<") && trimmed.endsWith(">")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitTrailingPunctuation(value: string): { url: string; suffix: string } {
  const match = /^(.*?)([).,;:!?]+)?$/.exec(value);
  if (!match) return { url: value, suffix: "" };
  let url = match[1] || value;
  let suffix = match[2] || "";
  while (suffix.startsWith(")") && unbalancedCloseParen(url)) {
    url += ")";
    suffix = suffix.slice(1);
  }
  return { url, suffix };
}

function unbalancedCloseParen(value: string): boolean {
  let balance = 0;
  for (const char of value) {
    if (char === "(") balance++;
    if (char === ")") balance--;
  }
  return balance > 0;
}

function pathExtension(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return "";
  return pathname.slice(dot);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function appendCommentSection(
  pageId: string,
  sections: NotionSection[],
  comments: NotionCommentSummary[],
  pageMetadata?: Record<string, unknown> | null,
  warnings: NotionSourceWarning[] = [],
): NotionSection[] {
  if (comments.length === 0 && !hasIncompleteCommentRetrieval(warnings, pageId)) return sections;
  return [...sections, commentSectionRecord(pageId, comments, pageMetadata, warnings)];
}

function commentSectionRecord(
  pageId: string,
  comments: NotionCommentSummary[],
  pageMetadata?: Record<string, unknown> | null,
  warnings: NotionSourceWarning[] = [],
): NotionSection {
  const content = comments.length > 0
    ? renderComments(comments)
    : hasIncompleteCommentRetrieval(warnings, pageId)
      ? "_No comments returned; Notion comment retrieval is incomplete._"
      : "";
  return {
    sectionId: `notion-section:${pageId}:comments`,
    sectionTitle: "Comments",
    content,
    contentHash: hashContent(JSON.stringify({ content, comments, pageMetadata })),
    kind: "comments",
    anchorBlockId: null,
    rootBlockIds: [],
    structuredFacts: {
      pageMetadata: pageMetadata ?? null,
      commentCount: comments.length,
      discussionCount: commentDiscussionSummaries(comments).length,
      commentRetrieval: commentRetrievalFact(comments, warnings, pageId),
      discussions: commentDiscussionSummaries(comments),
      comments: comments.map(commentFact),
    },
    warningCodes: [],
  };
}

function hasIncompleteCommentRetrieval(warnings: NotionSourceWarning[], blockId?: string | null): boolean {
  return warnings.some((warning) =>
    (warning.code === "comment_fetch_failed" || warning.code === "comment_fetch_incomplete")
    && (!blockId || !warning.blockId || warning.blockId === blockId));
}

function commentDiscussionSummaries(comments: NotionCommentSummary[]): Array<Record<string, unknown>> {
  const groups = new Map<string, NotionCommentSummary[]>();
  for (const comment of comments) {
    const key = commentDiscussionKey(comment);
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return Array.from(groups.entries()).map(([key, group]) => ({
    discussionId: group[0]?.discussionId ?? null,
    synthetic: group[0]?.discussionId == null,
    commentIds: group.map((comment) => comment.commentId),
    commentCount: group.length,
    firstCommentId: group[0]?.commentId ?? null,
    lastCommentId: group[group.length - 1]?.commentId ?? null,
    authors: Array.from(new Set(group.map((comment) => comment.displayName?.resolvedName || comment.author).filter(Boolean))),
    createdTimes: group.map((comment) => comment.createdTime).filter(Boolean),
    referenceCount: group.reduce((sum, comment) => sum + (comment.references?.length ?? 0), 0),
    attachmentCount: group.reduce((sum, comment) => sum + (comment.attachments?.length ?? 0), 0),
    richTextSpanCount: group.reduce((sum, comment) => sum + (comment.richText?.length ?? 0), 0),
    parentObjects: uniqueCommentParents(group),
    key,
  }));
}

function commentRetrievalFact(
  comments: NotionCommentSummary[],
  warnings: NotionSourceWarning[] = [],
  blockId?: string | null,
): Record<string, unknown> {
  const requestStatus = commentRetrievalRequestStatus(comments);
  const retrievalComplete = comments.length > 0
    ? comments.every((comment) => comment.retrievalComplete !== false)
    : !hasIncompleteCommentRetrieval(warnings, blockId);
  const hasMore = comments.some((comment) => comment.retrievalHasMore === true);
  const nextCursor = comments.map((comment) => comment.retrievalNextCursor).find((cursor): cursor is string => Boolean(cursor)) ?? null;
  const providerErrors = commentRetrievalProviderErrors(warnings, blockId);
  return {
    source: "notion_comments_api",
    requestedParentScope: "page_or_block_id",
    returnedListShape: "flat_chronological_comments",
    threadKey: "discussion_id",
    syntheticThreadKeyPrefix: "comment:",
    includesResolvedComments: false,
    resolvedCommentsRetrievable: false,
    resolvedCommentLimitation: "Notion REST comment retrieval omits resolved comments.",
    commentCount: comments.length,
    discussionCount: commentDiscussionSummaries(comments).length,
    requestStatus,
    providerErrors,
    complete: retrievalComplete && !hasMore && stringValue(requestStatus?.type) !== "incomplete",
    hasMore,
    nextCursor,
  };
}

function commentRetrievalProviderErrors(warnings: NotionSourceWarning[], blockId?: string | null): NotionApiErrorSummary[] {
  return warnings
    .filter((warning) =>
      warning.code === "comment_fetch_failed"
      && warning.providerError
      && (!blockId || !warning.blockId || warning.blockId === blockId))
    .map((warning) => warning.providerError)
    .filter((error): error is NotionApiErrorSummary => Boolean(error));
}

function commentRetrievalRequestStatus(comments: NotionCommentSummary[]): Record<string, unknown> | null {
  for (const comment of comments) {
    const status = recordValue(comment.retrievalRequestStatus);
    if (stringValue(status.type) === "incomplete") return status;
  }
  for (const comment of comments) {
    const status = recordValue(comment.retrievalRequestStatus);
    if (Object.keys(status).length > 0) return status;
  }
  return null;
}

function uniqueCommentParents(comments: NotionCommentSummary[]): Array<{ parentType: string | null; parentId: string | null }> {
  const seen = new Set<string>();
  const parents: Array<{ parentType: string | null; parentId: string | null }> = [];
  for (const comment of comments) {
    const key = `${comment.parentType ?? ""}:${comment.parentId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parents.push({ parentType: comment.parentType, parentId: comment.parentId });
  }
  return parents;
}

function commentFact(comment: NotionCommentSummary): Record<string, unknown> {
  return {
    commentId: comment.commentId,
    objectType: comment.objectType,
    partial: comment.partial,
    parentType: comment.parentType,
    parentId: comment.parentId,
    parent: comment.parent,
    discussionId: comment.discussionId,
    discussionKey: comment.discussionKey,
    discussionIndex: comment.discussionIndex,
    discussionCommentCount: comment.discussionCommentCount,
    text: comment.text,
    author: comment.author,
    displayName: comment.displayName ?? null,
    richText: comment.richText ?? [],
    references: comment.references ?? [],
    attachments: comment.attachments ?? [],
    retrievalRequestStatus: comment.retrievalRequestStatus ?? null,
    retrievalComplete: comment.retrievalComplete ?? null,
    retrievalHasMore: comment.retrievalHasMore ?? null,
    retrievalNextCursor: comment.retrievalNextCursor ?? null,
    createdTime: comment.createdTime,
    lastEditedTime: comment.lastEditedTime,
  };
}

function renderComments(comments: NotionCommentSummary[]): string {
  return comments
    .map((comment) => {
      const displayName = comment.displayName?.resolvedName || comment.author || "unknown";
      const meta = [displayName, comment.createdTime?.slice(0, 10)].filter(Boolean).join(", ");
      const text = (comment.text || "_No text_").split("\n").map((line, index) => index === 0 ? line : `  ${line}`).join("\n");
      const attachments = (comment.attachments ?? []).map((attachment) => {
        const parts = [
          attachment.category ?? attachment.type,
          attachment.name,
          attachment.expiryTime ? `expires ${attachment.expiryTime}` : "",
          attachment.urlRedacted ? "URL redacted" : attachment.url ? attachment.url : "",
        ].filter(Boolean).join(", ");
        return `  - Attachment: ${parts || "unknown"}`;
      });
      return [`- ${meta ? `${meta}: ` : ""}${text}`, ...attachments].join("\n");
    })
    .join("\n");
}

function sectionRecord(input: {
  pageId: string;
  idSuffix: string;
  title: string;
  kind: "page_intro" | "page_body" | "heading";
  anchorBlockId: string | null;
  rootBlocks: NotionBlockNode[];
  content: string;
  warnings: NotionSourceWarning[];
  tableOfContentsHeadingOutline?: NotionHeadingOutlineEntry[];
  breadcrumbTrail?: NotionBreadcrumbEntry[];
  pageMetadata?: Record<string, unknown> | null;
}): NotionSection {
  const rootBlockIds = input.rootBlocks.map((block) => block.id);
  const warningCodes = [...new Set(input.warnings.map((warning) => warning.code))];
  return {
    sectionId: `notion-section:${input.pageId}:${input.idSuffix}`,
    sectionTitle: input.title || "Untitled Notion section",
    content: input.content,
    contentHash: hashContent(JSON.stringify({
      content: input.content,
      rootBlockIds,
      warnings: warningCodes,
      breadcrumbTrail: input.breadcrumbTrail,
      pageMetadata: input.pageMetadata,
    })),
    kind: input.kind,
    anchorBlockId: input.anchorBlockId,
    rootBlockIds,
    structuredFacts: sectionFacts(input.rootBlocks, {
      tableOfContentsHeadingOutline: input.tableOfContentsHeadingOutline,
      warnings: input.warnings,
      breadcrumbTrail: input.breadcrumbTrail,
      pageMetadata: input.pageMetadata,
    }),
    warningCodes,
  };
}

function nestedHeadingSectionRecord(input: {
  pageId: string;
  heading: NotionBlockNode;
  rootBlocks: NotionBlockNode[];
  content: string;
  warnings: NotionSourceWarning[];
  tableOfContentsHeadingOutline?: NotionHeadingOutlineEntry[];
  breadcrumbTrail?: NotionBreadcrumbEntry[];
  pageMetadata?: Record<string, unknown> | null;
}): NotionSection {
  const rootBlockIds = input.rootBlocks.map((block) => block.id);
  const warningCodes = [...new Set(input.warnings.map((warning) => warning.code))];
  return {
    sectionId: `notion-section:${input.pageId}:nested-block:${input.heading.id}`,
    sectionTitle: input.heading.text || "Untitled Notion section",
    content: input.content,
    contentHash: hashContent(JSON.stringify({
      content: input.content,
      rootBlockIds,
      headingBlockId: input.heading.id,
      parentBlockId: input.heading.parentId,
      warnings: warningCodes,
      breadcrumbTrail: input.breadcrumbTrail,
      pageMetadata: input.pageMetadata,
    })),
    kind: "heading",
    anchorBlockId: input.heading.id,
    rootBlockIds,
    structuredFacts: {
      nestedHeading: true,
      headingBlockId: input.heading.id,
      parentBlockId: input.heading.parentId,
      depth: input.heading.depth,
      order: input.heading.order,
      ...sectionFacts(input.rootBlocks, {
        tableOfContentsHeadingOutline: input.tableOfContentsHeadingOutline,
        warnings: input.warnings,
        breadcrumbTrail: input.breadcrumbTrail,
        pageMetadata: input.pageMetadata,
      }),
    },
    warningCodes,
  };
}

function rowPageSectionRecord(pageId: string, rowPage: NotionDatabaseRowPage): NotionSection {
  const content = renderDatabaseRowPageContent(rowPage);
  const warningCodes: string[] = [];
  return {
    sectionId: `notion-section:${pageId}:database-row:${rowPage.pageId}`,
    sectionTitle: rowPage.title || "Untitled database row page",
    content,
    contentHash: hashContent(JSON.stringify({
      content,
      values: rowPage.values,
      comments: rowPage.comments,
    })),
    kind: "database_row_page",
    anchorBlockId: rowPage.pageId,
    rootBlockIds: rowPage.bodyBlocks.map((block) => block.id),
    structuredFacts: notionDatabaseRowPageStructuredFacts(rowPage),
    warningCodes,
  };
}

export function notionDatabaseRowPageStructuredFacts(rowPage: NotionDatabaseRowPage): Record<string, unknown> {
  const propertyValues = meaningfulPropertySummaries(rowPage.title, rowPage.properties, { includeMatchingTitle: true });
  const propertyReferences = propertyValueReferences(rowPage.propertyValues, { pageId: rowPage.pageId });
  const commentReferences = collectCommentReferences(rowPage.comments);
  const commentDiscussions = commentDiscussionSummaries(rowPage.comments);
  return {
    dataSourceId: rowPage.dataSourceId,
    dataSourceTitle: rowPage.dataSourceTitle,
    rowPageId: rowPage.pageId,
    rowPagePath: rowPage.relativePath,
    pageMetadata: notionPageMetadataFact(rowPage.rawPage),
    propertyCount: propertyValues.length,
    propertyTypes: countBy(propertyValues.map((property) => property.type)),
    propertyValues,
    propertyReferenceCount: propertyReferences.length,
    propertyReferenceTargets: propertyReferences.map(referenceFact),
    commentCount: rowPage.comments.length,
    discussionCount: commentDiscussions.length,
    commentRetrieval: commentRetrievalFact(rowPage.comments),
    discussions: commentDiscussions,
    comments: rowPage.comments.map(commentFact),
    commentReferenceCount: commentReferences.length,
    commentReferenceTargets: commentReferences.map(referenceFact),
    ...sectionFacts(rowPage.bodyBlocks, { breadcrumbTrail: rowPage.breadcrumbTrail }),
  };
}

export function notionChildPageStructuredFacts(childPage: NotionChildPage): Record<string, unknown> {
  const propertyValues = meaningfulPropertySummaries(childPage.title, childPage.properties, { includeMatchingTitle: true });
  const propertyReferences = propertyValueReferences(childPage.propertyValues, { pageId: childPage.pageId });
  const commentReferences = collectCommentReferences(childPage.comments);
  const commentDiscussions = commentDiscussionSummaries(childPage.comments);
  return {
    childPageId: childPage.pageId,
    childPagePath: childPage.relativePath,
    parentBlockId: childPage.parentBlockId,
    pageMetadata: notionPageMetadataFact(childPage.rawPage),
    propertyCount: propertyValues.length,
    propertyTypes: countBy(propertyValues.map((property) => property.type)),
    propertyValues,
    propertyReferenceCount: propertyReferences.length,
    propertyReferenceTargets: propertyReferences.map(referenceFact),
    commentCount: childPage.comments.length,
    discussionCount: commentDiscussions.length,
    commentRetrieval: commentRetrievalFact(childPage.comments),
    discussions: commentDiscussions,
    comments: childPage.comments.map(commentFact),
    commentReferenceCount: commentReferences.length,
    commentReferenceTargets: commentReferences.map(referenceFact),
    nestedChildPageCount: childPage.childPages.length,
    nestedChildPageIds: childPage.childPages.map((nested) => nested.pageId),
    nestedChildPagePaths: childPage.childPages.map((nested) => nested.relativePath),
    ...sectionFacts(childPage.bodyBlocks, { breadcrumbTrail: childPage.breadcrumbTrail }),
  };
}

export function renderDatabaseRowPageContent(rowPage: NotionDatabaseRowPage): string {
  const propertyRows = Object.entries(rowPage.values)
    .filter(([, value]) => value.trim().length > 0)
    .map(([name, value]) => `- ${name}: ${value}`);

  return [
    `# ${rowPage.title || "Untitled Notion page"}`,
    "",
    [
      `- Parent data source: ${rowPage.dataSourceTitle}`,
      `- Page ID: ${rowPage.pageId}`,
      rowPage.url ? `- URL: ${rowPage.url}` : "",
    ].filter(Boolean).join("\n"),
    "",
    "## Page Properties",
    "",
    propertyRows.length > 0 ? propertyRows.join("\n") : "_No non-empty properties._",
    "",
    "## Body",
    "",
    rowPage.bodyMarkdown.trim() || "_No body content._",
    ...(rowPage.comments.length > 0
      ? [
        "",
        "## Comments",
        "",
        renderComments(rowPage.comments),
      ]
      : []),
  ].join("\n");
}

export function renderChildPageContent(childPage: NotionChildPage): string {
  const propertyRows = childPage.propertyValues
    .filter((property) => property.display.trim().length > 0)
    .map((property) => `- ${property.name}: ${property.display}`);

  return [
    `# ${childPage.title || "Untitled Notion child page"}`,
    "",
    [
      `- Parent block ID: ${childPage.parentBlockId}`,
      `- Page ID: ${childPage.pageId}`,
      childPage.url ? `- URL: ${childPage.url}` : "",
    ].filter(Boolean).join("\n"),
    "",
    "## Page Properties",
    "",
    propertyRows.length > 0 ? propertyRows.join("\n") : "_No non-empty properties._",
    "",
    "## Body",
    "",
    childPage.bodyMarkdown.trim() || "_No body content._",
    ...(childPage.comments.length > 0
      ? [
        "",
        "## Comments",
        "",
        renderComments(childPage.comments),
      ]
      : []),
    ...(childPage.childPages.length > 0
      ? [
        "",
        "## Nested Child Pages",
        "",
        childPage.childPages
          .map((nested) => `- [${nested.title || nested.pageId}](${relativeMarkdownPath(childPage.relativePath, nested.relativePath)})`)
          .join("\n"),
      ]
      : []),
  ].join("\n");
}

function relativeMarkdownPath(fromFilePath: string, targetFilePath: string): string {
  const fromParts = fromFilePath.split("/").filter(Boolean);
  const targetParts = targetFilePath.split("/").filter(Boolean);
  fromParts.pop();

  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
    common += 1;
  }

  const up = Array.from({ length: fromParts.length - common }, () => "..");
  const down = targetParts.slice(common);
  const relative = [...up, ...down].join("/");
  return relative || targetParts.at(-1) || targetFilePath;
}

function sectionFacts(
  blocks: NotionBlockNode[],
  opts: {
    tableOfContentsHeadingOutline?: NotionHeadingOutlineEntry[];
    warnings?: NotionSourceWarning[];
    breadcrumbTrail?: NotionBreadcrumbEntry[];
    pageMetadata?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const flat = flattenBlocks(blocks);
  const toDos = flat.filter((block) => block.type === "to_do");
  const headingBlocks = flat.filter((block) => HEADING_TYPES.has(block.type));
  const headingOutline = headingBlocks.map((block) => ({
    blockId: block.id,
    level: headingLevel(block.type),
    title: block.text.trim() || "Untitled heading",
    isToggleable: block.isToggleable ?? false,
    childBlockCount: block.children.length,
  }));
  const tableOfContentsHeadingOutline = (opts.tableOfContentsHeadingOutline ?? []).map((heading) => {
    const block = flat.find((candidate) => candidate.id === heading.id);
    return {
      blockId: heading.id,
      level: heading.level,
      title: heading.title,
      ...(block
        ? {
          isToggleable: block.isToggleable ?? false,
          childBlockCount: block.children.length,
        }
        : {}),
    };
  });
  const references = flat.flatMap((block) => block.references);
  const columns = flat.filter((block) => block.type === "column");
  const columnLists = flat.filter((block) => block.type === "column_list");
  const tables = flat.filter((block) => block.type === "table");
  const linkToPageBlocks = flat.filter((block) => block.type === "link_to_page");
  const syncedBlocks = flat.filter((block) => block.type === "synced_block");
  const breadcrumbBlocks = flat.filter((block) => block.type === "breadcrumb");
  const tableOfContentsBlocks = flat.filter((block) => block.type === "table_of_contents");
  const blockCommentBlocks = flat.filter((block) => block.comments.length > 0);
  const topLevelInlineDataSources = flat.flatMap((block) => block.inlineDataSources ?? []);
  const inlineDataSources = flattenInlineDataSources(topLevelInlineDataSources);
  const childPageBlocks = flat.filter((block) => block.type === "child_page");
  const childDatabaseBlocks = flat.filter((block) => block.type === "child_database");
  const coloredBlocks = flat.filter((block) => block.color && block.color !== "default");
  const visualBlocks = flat.filter((block) => (
    Boolean(block.icon)
    || Boolean(block.color && block.color !== "default")
    || block.type === "callout"
  ));
  const mediaBlocks = flat.filter((block) => mediaBlockType(block.type));
  const externalReferenceBlocks = flat.filter((block) => externalReferenceBlockType(block.type));
  const templateBlocks = flat.filter((block) => block.type === "template");
  const tabBlocks = flat.filter((block) => block.type === "tab");
  const meetingNoteBlocks = flat.filter((block) => block.type === "meeting_notes" || block.type === "transcription");
  const listGroups = collectListGroupFacts(blocks);
  const taskGroups = collectTaskGroupFacts(blocks);
  const blockStructure = flat.map((block) => blockStructureFact(block, flat, opts.warnings ?? [], {
    breadcrumbTrail: opts.breadcrumbTrail ?? [],
    tableOfContentsHeadingOutline: tableOfContentsHeadingOutline.length ? tableOfContentsHeadingOutline : headingOutline,
  }));
  return {
    pageMetadata: opts.pageMetadata ?? null,
    rootBlockCount: blocks.length,
    blockCount: flat.length,
    blockTypes: countBy(flat.map((block) => block.type)),
    blockCoverage: blockCoverageFact(flat, blockStructure),
    blockStructureCount: blockStructure.length,
    blockStructure,
    headingCount: headingBlocks.length,
    headingOutline,
    tableOfContentsBlockCount: tableOfContentsBlocks.length,
    tableOfContentsBlocks: tableOfContentsBlocks.map((block) => ({
      blockId: block.id,
      color: block.color ?? null,
      headingCount: tableOfContentsHeadingOutline.length || headingOutline.length,
      headingBlockIds: (tableOfContentsHeadingOutline.length ? tableOfContentsHeadingOutline : headingOutline)
        .map((heading) => heading.blockId),
      headingOutline: tableOfContentsHeadingOutline.length ? tableOfContentsHeadingOutline : headingOutline,
    })),
    syncedBlockCount: syncedBlocks.length,
    syncedBlockCopyCount: syncedBlocks.filter((block) => syncedBlockSourceId(block)).length,
    syncedBlockOriginalCount: syncedBlocks.filter((block) => !syncedBlockSourceId(block)).length,
    syncedBlocks: syncedBlocks.map((block) => syncedBlockFact(block, opts.warnings ?? [])),
    linkToPageBlockCount: linkToPageBlocks.length,
    linkToPageBlocks: linkToPageBlocks.map(linkToPageBlockFact),
    breadcrumbBlockCount: breadcrumbBlocks.length,
    breadcrumbBlocks: breadcrumbBlocks.map((block) => breadcrumbBlockFact(block, opts.breadcrumbTrail ?? [], opts.warnings ?? [])),
    blockCommentBlockCount: blockCommentBlocks.length,
    blockCommentCount: blockCommentBlocks.reduce((sum, block) => sum + block.comments.length, 0),
    blockCommentBlocks: blockCommentBlocks.map(blockCommentFact),
    toggleableHeadingCount: headingBlocks.filter((block) => block.isToggleable).length,
    taskCount: toDos.length,
    checkedTaskCount: toDos.filter((block) => block.checked).length,
    uncheckedTaskCount: toDos.filter((block) => block.checked === false).length,
    taskGroupCount: taskGroups.length,
    taskGroups,
    listGroupCount: listGroups.length,
    listGroups,
    coloredBlockCount: coloredBlocks.length,
    blockColors: countBy(coloredBlocks.map((block) => block.color ?? "default")),
    visualBlockCount: visualBlocks.length,
    iconBlockCount: visualBlocks.filter((block) => Boolean(block.icon)).length,
    visualBlocks: visualBlocks.map(visualBlockFact),
    mediaBlockCount: mediaBlocks.length,
    mediaBlocks: mediaBlocks.map(mediaBlockSummary),
    externalReferenceBlockCount: externalReferenceBlocks.length,
    externalReferenceBlocks: externalReferenceBlocks.map(externalReferenceBlockSummary),
    templateBlockCount: templateBlocks.length,
    templateBlocks: templateBlocks.map((block) => ({
      blockId: block.id,
      title: block.text,
      titleRichText: block.richText ?? block.titleRichText ?? [],
      childBlockIds: block.children.map((child) => child.id),
      childBlockTypes: block.children.map((child) => child.type),
      childBlockCount: block.children.length,
    })),
    meetingNoteBlockCount: meetingNoteBlocks.length,
    meetingNoteBlocks: meetingNoteBlocks.map(meetingNoteBlockFact),
    tabBlockCount: tabBlocks.length,
    tabBlocks: tabBlocks.map((block) => ({
      blockId: block.id,
      title: block.text || block.id,
      titleRichText: block.richText ?? block.titleRichText ?? [],
      childBlockIds: block.children.map((child) => child.id),
      childBlockTypes: block.children.map((child) => child.type),
      childBlockCount: block.children.length,
      panes: tabPanes(block).map((pane) => ({
        paneBlockId: pane.blockId,
        paneIndex: pane.paneIndex,
        blockType: pane.blockType,
        parentBlockId: pane.parentBlockId,
        depth: pane.depth,
        order: pane.order,
        label: pane.label,
        labelPlainText: pane.labelPlainText,
        labelRichText: pane.labelRichText,
        icon: pane.icon,
        color: pane.color ?? null,
        hasChildren: pane.hasChildren,
        contentMarkdown: pane.contentMarkdown,
        contentHash: pane.contentHash,
        contentChildBlockIds: pane.contentChildBlockIds,
        contentChildBlockTypes: pane.contentChildBlockTypes,
        contentChildBlockCount: pane.contentChildBlockIds.length,
      })),
    })),
    columnListCount: columnLists.length,
    columnLists: columnLists.map((block) => {
      const listColumns = block.children.filter((child) => child.type === "column");
      return {
        blockId: block.id,
        columnCount: listColumns.length,
        columns: listColumns.map((column, index) => ({
          blockId: column.id,
          index,
          widthRatio: column.widthRatio ?? null,
          effectiveWidthRatio: effectiveColumnWidthRatio(column, listColumns.length),
          childBlockIds: column.children.map((child) => child.id),
          childBlockTypes: column.children.map((child) => child.type),
        })),
      };
    }),
    columnCount: columns.length,
    columns: columns.map((block) => ({
      blockId: block.id,
      parentId: block.parentId,
      widthRatio: block.widthRatio ?? null,
      effectiveWidthRatio: effectiveColumnWidthRatio(block, siblingColumnCount(block, columns)),
      childBlockCount: block.children.length,
    })),
    tableCount: tables.length,
    tables: tables.map(tableFact),
    childPageCount: childPageBlocks.length,
    materializedChildPageCount: childPageBlocks.filter((block) => block.childPage).length,
    childPages: childPageBlocks.map(childPageBlockFact),
    childDatabaseBlockCount: childDatabaseBlocks.length,
    childDatabaseBlocks: childDatabaseBlocks.map(childDatabaseBlockFact),
    inlineDatabaseCount: flat.filter((block) => block.type === "child_database" && (block.inlineDataSources?.length ?? 0) > 0).length,
    inlineDataSourceCount: inlineDataSources.length,
    inlineDatabaseRowCount: inlineDataSources.reduce((sum, source) => sum + source.rows.length, 0),
    inlineDatabaseBodyRowCount: inlineDataSources.reduce(
      (sum, source) => sum + source.rows.filter((row) => row.bodyMarkdown.trim()).length,
      0,
    ),
    inlineDatabaseCommentRowCount: inlineDataSources.reduce(
      (sum, source) => sum + source.rows.filter((row) => row.comments.length > 0).length,
      0,
    ),
    inlineDatabaseCommentCount: inlineDataSources.reduce(
      (sum, source) => sum + source.rows.reduce((rowSum, row) => rowSum + row.comments.length, 0),
      0,
    ),
    inlineDatabaseRowPageCount: inlineDataSources.reduce(
      (sum, source) => sum + source.rows.filter((row) => row.bodyPagePath).length,
      0,
    ),
    inlineDatabases: inlineDataSources.map(inlineDataSourceFact),
    referenceCount: references.length,
    referenceTargets: references.map(referenceFact),
  };
}

function childPageBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const rawValue = recordValue(recordValue(block.rawBlock).child_page);
  const childPage = block.childPage;
  const propertyValues = childPage
    ? meaningfulPropertySummaries(childPage.title, childPage.properties, { includeMatchingTitle: true })
    : [];
  const propertyReferences = childPage
    ? propertyValueReferences(childPage.propertyValues, { pageId: childPage.pageId })
    : [];
  const commentDiscussions = childPage ? commentDiscussionSummaries(childPage.comments) : [];
  const commentReferences = childPage ? collectCommentReferences(childPage.comments) : [];
  return {
    blockId: block.id,
    pageId: childPage?.pageId ?? block.id,
    title: block.text,
    titleRichText: block.titleRichText ?? [],
    url: block.url ?? stringValue(rawValue.url) ?? childPage?.url ?? null,
    materialized: Boolean(childPage),
    path: childPage?.relativePath ?? null,
    pageMetadata: notionPageMetadataFact(childPage?.rawPage),
    breadcrumbTrail: childPage?.breadcrumbTrail ?? [],
    bodyMarkdown: childPage?.bodyMarkdown ?? "",
    bodyContentHash: hashContent(childPage?.bodyMarkdown ?? ""),
    renderedContentHash: childPage ? hashContent(renderChildPageContent(childPage)) : hashContent(""),
    bodyBlockIds: childPage?.bodyBlocks.map((child) => child.id) ?? [],
    bodyBlockTypes: childPage?.bodyBlocks.map((child) => child.type) ?? [],
    bodyBlockCount: childPage?.bodyBlocks.length ?? 0,
    bodyBlockSummaries: childPage ? childPageBodyBlockSummaries(childPage.bodyBlocks) : [],
    nestedChildPageCount: childPage?.childPages.length ?? 0,
    nestedChildPageIds: childPage?.childPages.map((nested) => nested.pageId) ?? [],
    nestedChildPagePaths: childPage?.childPages.map((nested) => nested.relativePath) ?? [],
    nestedChildPages: childPage?.childPages.map((nested) => ({
      pageId: nested.pageId,
      title: nested.title,
      path: nested.relativePath,
      parentBlockId: nested.parentBlockId,
      bodyBlockCount: nested.bodyBlocks.length,
    })) ?? [],
    commentCount: childPage?.comments.length ?? 0,
    discussionCount: commentDiscussions.length,
    commentRetrieval: childPage ? commentRetrievalFact(childPage.comments) : null,
    discussions: commentDiscussions,
    comments: childPage?.comments.map(commentFact) ?? [],
    commentReferenceCount: commentReferences.length,
    commentReferenceTargets: commentReferences.map(referenceFact),
    propertyCount: childPage?.propertyValues.length ?? 0,
    meaningfulPropertyCount: propertyValues.length,
    propertyTypes: countBy(propertyValues.map((property) => property.type)),
    propertyValues,
    propertyReferenceCount: propertyReferences.length,
    propertyReferenceTargets: propertyReferences.map(referenceFact),
  };
}

function childPageBodyBlockSummaries(blocks: NotionBlockNode[]): Array<Record<string, unknown>> {
  return flattenBlocks(blocks).map((block) => ({
    blockId: block.id,
    type: block.type,
    parentId: block.parentId,
    depth: block.depth,
    order: block.order,
    text: block.text,
    markdown: block.markdown,
    markdownHash: hashContent(block.markdown),
    hasChildren: block.hasChildren,
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlockCount: block.children.length,
  }));
}

function childDatabaseBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const rawValue = recordValue(recordValue(block.rawBlock).child_database);
  const inlineSources = block.inlineDataSources ?? [];
  const allInlineSources = flattenInlineDataSources(inlineSources);
  return {
    blockId: block.id,
    databaseId: block.id,
    title: block.text,
    titleRichText: block.titleRichText ?? [],
    url: block.url ?? stringValue(rawValue.url) ?? null,
    inlineDataSourceIds: inlineSources.map((source) => source.dataSourceId),
    inlineDataSourceCount: inlineSources.length,
    materializedDataSourceIds: allInlineSources.map((source) => source.dataSourceId),
    materializedDataSourceCount: allInlineSources.length,
    rowCount: allInlineSources.reduce((sum, source) => sum + source.rows.length, 0),
    queryComplete: allInlineSources.every((source) => source.queryComplete),
    inlineDataSources: inlineSources.map(inlineDataSourceFact),
    materializedDataSources: allInlineSources.map(inlineDataSourceFact),
    viewIds: allInlineSources.map((source) => source.view?.viewId).filter((viewId): viewId is string => Boolean(viewId)),
    viewTypes: countBy(allInlineSources.map((source) => source.view?.viewType ?? "unviewed")),
    rowPageIds: allInlineSources.flatMap((source) => source.rows.map((row) => row.pageId)),
    rowPages: allInlineSources.flatMap((source) => source.rows.map((row) => inlineDataSourceRowFact(row))),
  };
}

function inlineDataSourceFact(source: NotionInlineDataSource): Record<string, unknown> {
  const propertySchema = notionPropertySchemaSummary(source.rawDataSource?.properties ?? source.rawDatabase?.properties);
  return {
    dataSourceId: source.dataSourceId,
    title: source.title,
    url: source.url,
    rowCount: source.rowCount,
    rowCapReached: source.rowCapReached,
    queryComplete: source.queryComplete,
    queryHasMore: source.queryHasMore,
    queryNextCursor: source.queryNextCursor,
    queryRequestStatus: source.queryRequestStatus,
    queryIncompleteReason: source.queryIncompleteReason,
    propertySchema,
    schemaPropertyCount: propertySchema.length,
    schemaPropertyTypes: propertySchema.map((property) => property.type),
    columns: source.columns,
    view: source.view ? inlineDataSourceViewFact(source.view) : null,
    rowIds: source.rows.map((row) => row.pageId),
    rows: source.rows.map(inlineDataSourceRowFact),
    nestedDataSourceIds: Array.from(new Set(source.nestedDataSources.map((nested) => nested.dataSourceId))),
    nestedDataSources: source.nestedDataSources.map((nested) => ({
      dataSourceId: nested.dataSourceId,
      title: nested.title,
      url: nested.url,
      materialized: Boolean(nested.materializedDataSource),
      rowCount: nested.materializedDataSource?.rowCount ?? null,
      rowIds: nested.materializedDataSource?.rows.map((row) => row.pageId) ?? [],
      columns: nested.materializedDataSource?.columns ?? [],
      queryComplete: nested.materializedDataSource?.queryComplete ?? null,
      queryHasMore: nested.materializedDataSource?.queryHasMore ?? null,
      queryIncompleteReason: nested.materializedDataSource?.queryIncompleteReason ?? null,
      nestedDataSourceIds: nested.materializedDataSource
        ? Array.from(new Set(nested.materializedDataSource.nestedDataSources.map((child) => child.dataSourceId)))
        : [],
    })),
  };
}

function inlineDataSourceViewFact(view: NotionInlineDataSourceView): Record<string, unknown> {
  return {
    viewId: view.viewId,
    name: view.name,
    viewType: view.viewType,
    columns: view.columns,
    filter: view.filter,
    sorts: view.sorts,
    quickFilters: view.quickFilters,
    configuration: view.configuration,
    configurationSummary: view.configurationSummary,
    resultPageIds: view.resultPageIds,
    resultReferences: view.resultReferences,
    renderedResultPageIds: view.renderedResultPageIds,
    missingResultPageIds: view.missingResultPageIds,
    rowGroups: view.rowGroups,
    queryId: view.queryId,
    queryExpiresAt: view.queryExpiresAt,
    queryPageSize: view.queryPageSize,
    queryPagesFetched: view.queryPagesFetched,
    queryDeleted: view.queryDeleted,
    resultCount: view.resultCount,
    totalCount: view.totalCount,
    hasMore: view.hasMore,
    nextCursor: view.nextCursor,
    requestStatus: view.requestStatus,
    complete: view.complete,
  };
}

function inlineDataSourceRowFact(row: NotionInlineDataSourceRow): Record<string, unknown> {
  const propertyReferences = propertyValueReferences(row.propertyValues, { pageId: row.pageId });
  const commentReferences = collectCommentReferences(row.comments);
  return {
    pageId: row.pageId,
    title: row.title,
    url: row.url,
    values: row.values,
    propertyCount: row.propertyValues.length,
    propertyTypes: countBy(row.propertyValues.map((property) => property.type)),
    propertyValues: row.propertyValues,
    propertyReferenceCount: propertyReferences.length,
    propertyReferenceTargets: propertyReferences.map(referenceFact),
    bodyMarkdown: row.bodyMarkdown,
    bodyContentHash: hashContent(row.bodyMarkdown),
    bodyBlockIds: row.bodyBlocks.map((block) => block.id),
    bodyBlockTypes: row.bodyBlocks.map((block) => block.type),
    bodyBlockCount: row.bodyBlocks.length,
    bodyPagePath: row.bodyPagePath,
    breadcrumbTrail: row.breadcrumbTrail,
    commentCount: row.comments.length,
    discussionCount: commentDiscussionSummaries(row.comments).length,
    comments: row.comments.map(commentFact),
    commentReferenceCount: commentReferences.length,
    commentReferenceTargets: commentReferences.map(referenceFact),
  };
}

function meetingNoteBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const meeting = block.meetingNotes;
  const roleEntries = [
    ["summary", meeting?.children.summaryBlockId ?? null],
    ["notes", meeting?.children.notesBlockId ?? null],
    ["transcript", meeting?.children.transcriptBlockId ?? null],
  ] as const;
  const tabs = roleEntries.map(([role, blockId]) => {
    const child = blockId ? findBlockById(block.children, blockId) : null;
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
  return {
    blockId: block.id,
    type: block.type,
    legacyType: block.type === "transcription",
    title: meeting?.title ?? block.text,
    status: meeting?.status ?? null,
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlockCount: block.children.length,
    calendarEvent: meeting?.calendarEvent ?? null,
    recording: meeting?.recording ?? null,
    tabs,
    unresolvedTabRoles: tabs
      .filter((tab) => tab.blockId && !tab.resolved)
      .map((tab) => tab.role),
  };
}

function findBlockById(blocks: NotionBlockNode[], blockId: string): NotionBlockNode | null {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const nested = findBlockById(block.children, blockId);
    if (nested) return nested;
  }
  return null;
}

function blockStructureFact(
  block: NotionBlockNode,
  flatBlocks: NotionBlockNode[],
  warnings: NotionSourceWarning[],
  opts: {
    breadcrumbTrail?: NotionBreadcrumbEntry[];
    tableOfContentsHeadingOutline?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const children = block.children;
  const rawBlock = recordValue(block.rawBlock);
  const supportsChildren = notionBlockSupportsChildren(block.type, block.isToggleable);
  const childFetchExpected = supportsChildren && block.hasChildren === true;
  const path = blockTreePathFact(block, flatBlocks);
  const childTraversal = blockChildTraversalFact(block, warnings, supportsChildren, childFetchExpected);
  return {
    blockId: block.id,
    type: block.type,
    unsupportedType: block.type === "unsupported" ? unsupportedBlockType(block.rawBlock as NotionBlock) : null,
    object: stringValue(rawBlock.object) ?? "block",
    parent: notionParentSummary(block.rawBlock?.parent),
    createdTime: stringValue(rawBlock.created_time),
    lastEditedTime: stringValue(rawBlock.last_edited_time),
    createdBy: rawBlock.created_by ? personSummary(rawBlock.created_by) : null,
    lastEditedBy: rawBlock.last_edited_by ? personSummary(rawBlock.last_edited_by) : null,
    archived: notionBlockArchivedState(rawBlock) || block.archived === true,
    inTrash: notionBlockInTrashState(rawBlock) || block.inTrash,
    deleted: notionBlockDeletedState(rawBlock) || block.archived === true || block.inTrash,
    parentBlockId: block.parentId,
    depth: block.depth,
    order: block.order,
    ...path,
    hasChildren: block.hasChildren,
    supportsChildren,
    childFetchExpected,
    childCapabilitySatisfied: !childFetchExpected || block.children.length > 0,
    childTraversal,
    childBlockIds: children.map((child) => child.id),
    childBlockTypes: children.map((child) => child.type),
    childBlockCount: children.length,
    text: truncateFactText(block.text),
    markdown: truncateFactText(block.markdown),
    richTextSpanCount: block.richText?.length ?? 0,
    caption: truncateFactText(block.caption ?? null),
    captionRichTextSpanCount: block.captionRichText?.length ?? 0,
    titleRichTextSpanCount: block.titleRichText?.length ?? 0,
    checked: block.checked ?? null,
    color: block.color ?? null,
    icon: block.icon ?? null,
    isToggleable: block.isToggleable ?? null,
    listStartIndex: block.listStartIndex ?? null,
    listFormat: block.listFormat ?? null,
    widthRatio: block.widthRatio ?? null,
    effectiveWidthRatio: block.type === "column" ? effectiveColumnWidthRatio(block, siblingColumnCount(block, flatBlocks)) : null,
    tableWidth: block.tableWidth ?? null,
    hasColumnHeader: block.hasColumnHeader ?? null,
    hasRowHeader: block.hasRowHeader ?? null,
    tableCellCount: block.tableCells?.length ?? block.tableCellRichText?.length ?? null,
    language: block.language ?? null,
    url: block.url && !isMediaUrl(block.url) ? block.url : null,
    urlRedacted: Boolean(block.url && isMediaUrl(block.url)),
    referenceCount: block.references.length,
    references: block.references.map(referenceFact),
    commentCount: block.comments.length,
    warningCodes: block.warnings.map((warning) => warning.code),
    inlineDataSourceIds: (block.inlineDataSources ?? []).map((source) => source.dataSourceId),
    childPageId: block.childPage?.pageId ?? null,
    childPagePath: block.childPage?.relativePath ?? null,
    meetingNotes: block.meetingNotes ?? null,
    semantic: blockStructureSemanticFact(block, warnings, flatBlocks, opts),
  };
}

function blockTreePathFact(block: NotionBlockNode, flatBlocks: NotionBlockNode[]): Record<string, unknown> {
  const byId = new Map(flatBlocks.map((candidate) => [candidate.id, candidate]));
  const ancestors: NotionBlockNode[] = [];
  const seen = new Set<string>([block.id]);
  let cursor = block.parentId ? byId.get(block.parentId) ?? null : null;
  let cycleDetected = false;

  while (cursor) {
    if (seen.has(cursor.id)) {
      cycleDetected = true;
      break;
    }
    seen.add(cursor.id);
    ancestors.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null;
  }

  ancestors.reverse();
  const path = [...ancestors, block];
  return {
    ancestorBlockIds: ancestors.map((ancestor) => ancestor.id),
    ancestorBlockTypes: ancestors.map((ancestor) => ancestor.type),
    ancestorBlockCount: ancestors.length,
    blockPathIds: path.map((entry) => entry.id),
    blockPathTypes: path.map((entry) => entry.type),
    orderPath: path.map((entry) => entry.order),
    depthPath: path.map((entry) => entry.depth),
    rootBlockId: path[0]?.id ?? block.id,
    rootBlockType: path[0]?.type ?? block.type,
    pathCycleDetected: cycleDetected,
  };
}

function blockChildTraversalFact(
  block: NotionBlockNode,
  warnings: NotionSourceWarning[],
  supportsChildren = notionBlockSupportsChildren(block.type, block.isToggleable),
  childFetchExpected = supportsChildren && block.hasChildren === true,
): Record<string, unknown> {
  const relevantWarnings = warnings.filter((warning) =>
    warning.blockId === block.id && CHILD_TRAVERSAL_WARNING_CODES.has(warning.code));
  const warningCodes = Array.from(new Set(relevantWarnings.map((warning) => warning.code)));
  const inlineChildren = block.rawBlock ? inlineBlockChildren(block.rawBlock, block.type) : [];
  const source = inlineChildren.length > 0
    ? "inline_payload"
    : childFetchExpected
      ? "notion_block_children_api"
      : "not_requested";
  const incomplete = childFetchExpected && (block.children.length === 0 || warningCodes.length > 0);
  return {
    source,
    pageSize: source === "notion_block_children_api" ? 100 : null,
    supportsChildren,
    hasChildren: block.hasChildren,
    requested: childFetchExpected,
    expected: childFetchExpected,
    complete: !incomplete,
    fetchedChildCount: block.children.length,
    fetchedChildIds: block.children.map((child) => child.id),
    warningCodes,
    cursorMissing: warningCodes.includes("block_child_pagination_cursor_missing"),
    capped: warningCodes.some((code) => code === "block_count_capped" || code === "block_request_capped" || code === "block_depth_capped"),
    cycleSkipped: warningCodes.includes("block_cycle_skipped"),
  };
}

function blockCoverageFact(
  blocks: NotionBlockNode[],
  blockStructure?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const official = new Set<string>(NOTION_OFFICIAL_BLOCK_TYPES);
  const legacy = new Set<string>(NOTION_LEGACY_OR_COMPAT_BLOCK_TYPES);
  const known = new Set<string>(NOTION_KNOWN_BLOCK_TYPES);
  const flat = flattenBlocks(blocks);
  const seenTypes = Array.from(new Set(flat.map((block) => block.type))).sort();
  const officialTypesSeen = seenTypes.filter((type) => official.has(type));
  const legacyTypesSeen = seenTypes.filter((type) => legacy.has(type));
  const unknownTypesSeen = seenTypes.filter((type) => !known.has(type));
  const unsupportedBlocks = flat
    .filter((block) => block.type === "unsupported")
    .map((block) => ({
      blockId: block.id,
      providerBlockType: unsupportedBlockType(block.rawBlock as NotionBlock),
    }));
  const semanticByType = new Map<string, { blockCount: number; semanticCount: number }>();
  if (blockStructure) {
    for (const fact of blockStructure) {
      const type = stringValue(fact.type) ?? "unknown";
      const current = semanticByType.get(type) ?? { blockCount: 0, semanticCount: 0 };
      current.blockCount++;
      if (recordHasKeys(recordValue(fact.semantic))) current.semanticCount++;
      semanticByType.set(type, current);
    }
  } else {
    for (const block of flat) {
      const current = semanticByType.get(block.type) ?? { blockCount: 0, semanticCount: 0 };
      current.blockCount++;
      current.semanticCount++;
      semanticByType.set(block.type, current);
    }
  }
  return {
    officialSchemaBlockTypeCount: NOTION_OFFICIAL_BLOCK_TYPES.length,
    officialTypesSeen,
    officialTypeCount: officialTypesSeen.length,
    legacyTypesSeen,
    legacyTypeCount: legacyTypesSeen.length,
    unknownTypesSeen,
    unknownTypeCount: unknownTypesSeen.length,
    unsupportedBlockCount: unsupportedBlocks.length,
    unsupportedBlocks,
    semanticCoverageByType: Object.fromEntries([...semanticByType.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function blockStructureSemanticFact(
  block: NotionBlockNode,
  warnings: NotionSourceWarning[],
  flatBlocks: NotionBlockNode[] = flattenBlocks([block]),
  opts: {
    breadcrumbTrail?: NotionBreadcrumbEntry[];
    tableOfContentsHeadingOutline?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const rawValue = recordValue(recordValue(block.rawBlock)[block.type]);
  const supportsChildren = notionBlockSupportsChildren(block.type, block.isToggleable);
  const childFetchExpected = supportsChildren && block.hasChildren === true;
  const richText = block.richText ?? summarizeNotionRichText(arrayValue(rawValue.rich_text));
  const captionRichText = block.captionRichText ?? summarizeNotionRichText(arrayValue(rawValue.caption));
  const titleRichText = block.titleRichText ?? summarizeNotionRichText(arrayValue(rawValue.title));
  const common: Record<string, unknown> = {
    blockId: block.id,
    type: block.type,
    richText,
    captionRichText,
    titleRichText,
    richTextContent: blockRichTextContentFact(richText, captionRichText, titleRichText),
    icon: block.icon ?? blockIconSummary(rawValue.icon),
    color: block.color ?? stringValue(rawValue.color) ?? null,
    supportsChildren,
    hasChildren: block.hasChildren,
    childFetchExpected,
    childBlockCount: block.children.length,
    childTraversal: blockChildTraversalFact(block, warnings, supportsChildren, childFetchExpected),
  };

  if (mediaBlockType(block.type)) {
    return { ...common, media: mediaBlockSummary(block) };
  }
  if (externalReferenceBlockType(block.type)) {
    return { ...common, externalReference: externalReferenceBlockSummary(block) };
  }
  if (block.type === "link_to_page") return { ...common, linkToPage: linkToPageBlockFact(block) };
  if (block.type === "synced_block") return { ...common, syncedBlock: syncedBlockFact(block, warnings) };
  if (block.type === "child_page") return { ...common, childPageBlock: childPageBlockFact(block) };
  if (block.type === "child_database") return { ...common, childDatabaseBlock: childDatabaseBlockFact(block) };
  if (block.type === "meeting_notes" || block.type === "transcription") {
    return { ...common, meetingNotes: meetingNoteBlockFact(block) };
  }
  if (block.type === "tab") {
    return {
      ...common,
      tab: {
        blockId: block.id,
        title: block.text || block.id,
        panes: tabPanes(block),
      },
    };
  }
  if (block.type === "column_list") return { ...common, columnLayout: columnListBlockFact(block) };
  if (block.type === "column") return { ...common, column: columnBlockFact(block, flatBlocks) };
  if (block.type === "breadcrumb") return { ...common, breadcrumb: breadcrumbBlockFact(block, opts.breadcrumbTrail ?? [], warnings) };
  if (block.type === "table_of_contents") return { ...common, tableOfContents: tableOfContentsBlockFact(block, opts.tableOfContentsHeadingOutline ?? []) };
  if (block.type === "toggle" || block.type === "template" || block.type === "callout" || block.type === "quote") {
    return { ...common, displayContainer: displayContainerBlockFact(block) };
  }
  if (block.type === "table") return { ...common, table: tableFact(block) };
  if (block.type === "table_row") {
    return {
      ...common,
      tableRow: {
        blockId: block.id,
        cells: block.tableCells ?? [],
        richTextCells: block.tableCellRichText ?? [],
      },
    };
  }
  if (block.type === "equation") {
    return { ...common, equation: { expression: block.text || stringValue(rawValue.expression) || "" } };
  }
  if (block.type === "code") {
    return {
      ...common,
      code: {
        language: block.language ?? stringValue(rawValue.language),
        caption: block.caption ?? null,
        text: block.text,
      },
    };
  }
  if (block.type === "to_do") {
    return {
      ...common,
      task: {
        checked: block.checked === true,
        text: block.text,
        group: taskRunFact(block, flatBlocks),
      },
    };
  }
  if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
    return { ...common, list: listRunFact(block, flatBlocks) };
  }
  if (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3" || block.type === "heading_4") {
    return { ...common, heading: { level: headingLevel(block.type), isToggleable: block.isToggleable === true } };
  }
  if (block.type === "unsupported") {
    return { ...common, unsupported: { blockType: unsupportedBlockType(block.rawBlock as NotionBlock) } };
  }
  return common;
}

function blockRichTextContentFact(
  richText: NotionRichTextSpanSummary[],
  captionRichText: NotionRichTextSpanSummary[],
  titleRichText: NotionRichTextSpanSummary[],
): Record<string, unknown> {
  const allSpans = [richText, captionRichText, titleRichText].flat();
  const mentions = [richText, captionRichText, titleRichText].flatMap(richTextMentionSummaries);
  const linkUrls = [richText, captionRichText, titleRichText].flatMap(richTextLinkUrls);
  return {
    richText: richTextFieldFact(richText),
    caption: richTextFieldFact(captionRichText),
    title: richTextFieldFact(titleRichText),
    spanCount: allSpans.length,
    mentionCount: mentions.length,
    mentionTypes: countBy(mentions.map((mention) => mention.type)),
    mentions,
    linkUrls: [...new Set(linkUrls)],
    equationCount: allSpans.filter((span) => span.type === "equation").length,
    annotationCounts: richTextAnnotationCounts(allSpans),
  };
}

function richTextFieldFact(richText: NotionRichTextSpanSummary[]): Record<string, unknown> {
  const mentions = richTextMentionSummaries(richText);
  return {
    plainText: richText.map((span) => span.plainText).join(""),
    spanCount: richText.length,
    spans: richText,
    mentionCount: mentions.length,
    mentionTypes: countBy(mentions.map((mention) => mention.type)),
    mentions,
    linkUrls: richTextLinkUrls(richText),
    equationCount: richText.filter((span) => span.type === "equation").length,
    annotationCounts: richTextAnnotationCounts(richText),
  };
}

function richTextAnnotationCounts(richText: NotionRichTextSpanSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const span of richText) {
    for (const [key, value] of Object.entries(span.annotations)) {
      if (value === true || typeof value === "string" && value && value !== "default") {
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function referenceFact(reference: NotionReference): Record<string, unknown> {
  return {
    kind: reference.kind,
    pageId: reference.pageId ?? null,
    blockId: reference.blockId ?? null,
    commentId: reference.commentId ?? null,
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
  };
}

function notionParentSummary(parent: unknown): Record<string, unknown> {
  const value = recordValue(parent);
  const type = stringValue(value.type);
  return {
    type,
    pageId: stringValue(value.page_id),
    databaseId: stringValue(value.database_id),
    dataSourceId: stringValue(value.data_source_id),
    blockId: stringValue(value.block_id),
    agentId: stringValue(value.agent_id),
    workspace: value.workspace === true,
  };
}

function visualBlockFact(block: NotionBlockNode): Record<string, unknown> {
  return {
    blockId: block.id,
    type: block.type,
    color: block.color ?? null,
    icon: block.icon ?? null,
    text: block.text,
    richText: block.richText ?? block.titleRichText ?? block.captionRichText ?? [],
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlockCount: block.children.length,
  };
}

function tableFact(block: NotionBlockNode): Record<string, unknown> {
  const rows = block.children.filter((child) => child.type === "table_row");
  const hasColumnHeader = block.hasColumnHeader === true;
  const hasRowHeader = block.hasRowHeader === true;
  const columnCount = effectiveTableColumnCount(block, rows.map(renderTableRowCells));
  return {
    blockId: block.id,
    tableWidth: block.tableWidth ?? null,
    hasColumnHeader: block.hasColumnHeader ?? null,
    hasRowHeader: block.hasRowHeader ?? null,
    rowCount: rows.length,
    columnCount,
    rows: rows.map((row, rowIndex) => tableRowFact(row, rowIndex, hasColumnHeader, hasRowHeader, columnCount)),
    rowHeaderValues: hasRowHeader
      ? rows
        .slice(hasColumnHeader ? 1 : 0)
        .map((row) => row.tableCells?.[0] ?? "")
        .filter((value) => value.trim().length > 0)
      : [],
  };
}

function tableRowFact(
  row: NotionBlockNode,
  rowIndex: number,
  hasColumnHeader: boolean,
  hasRowHeader: boolean,
  columnCount: number,
): Record<string, unknown> {
  const cells = row.tableCells ?? [];
  const richTextCells = row.tableCellRichText ?? [];
  const rawCellCount = Math.max(cells.length, richTextCells.length);
  const cellCount = Math.max(rawCellCount, columnCount);
  const isColumnHeader = hasColumnHeader && rowIndex === 0;
  return {
    blockId: row.id,
    rowIndex,
    isColumnHeader,
    rawCellCount,
    cellCount,
    cells: Array.from({ length: cellCount }, (_, columnIndex) => {
      const richText = richTextCells[columnIndex] ?? [];
      const text = cells[columnIndex] ?? richText.map((span) => span.plainText).join("");
      return {
        columnIndex,
        text,
        plainText: richText.map((span) => span.plainText).join("") || comparablePropertyText(text),
        richText,
        mentions: richTextMentionSummaries(richText),
        linkUrls: richTextLinkUrls(richText),
        isColumnHeader,
        isRowHeader: hasRowHeader && !isColumnHeader && columnIndex === 0,
      };
    }),
  };
}

function mediaBlockSummary(block: NotionBlockNode): Record<string, unknown> {
  const value = recordValue(recordValue(block.rawBlock)[block.type]);
  const payloadType = stringValue(value.type) ?? mediaPayloadType(value);
  const payload = payloadType ? recordValue(value[payloadType]) : {};
  const fileUpload = recordValue(value.file_upload);
  const file = recordValue(value.file);
  const external = recordValue(value.external);
  const url = stringValue(payload.url) ?? stringValue(file.url) ?? stringValue(external.url) ?? stringValue(value.url);
  const fileUploadId = stringValue(fileUpload.id) ?? (payloadType === "file_upload" ? stringValue(payload.id) : null);
  const lifecycle = fileUploadLifecycleSummary(fileUpload, payload, payloadType);
  return {
    blockId: block.id,
    type: block.type,
    payloadType,
    fileObject: mediaFileObjectType(payloadType)
      ? propertyFileObjectSummary(value, payloadType, payload, fileUpload, file, url, lifecycle)
      : null,
    caption: block.caption ?? block.text,
    captionRichText: block.captionRichText ?? [],
    name: stringValue(value.name) ?? stringValue(payload.name) ?? stringValue(payload.filename),
    fileUploadId,
    fileUploadFilename: stringValue(fileUpload.filename) ?? (payloadType === "file_upload" ? stringValue(payload.filename) : null),
    fileUploadContentType: stringValue(fileUpload.content_type) ?? (payloadType === "file_upload" ? stringValue(payload.content_type) : null),
    fileUploadContentLength: numberValue(fileUpload.content_length) ?? (payloadType === "file_upload" ? numberValue(payload.content_length) ?? null : null),
    fileUploadStatus: stringValue(fileUpload.status) ?? (payloadType === "file_upload" ? stringValue(payload.status) : null),
    ...lifecycle,
    expiryTime: stringValue(payload.expiry_time) ?? stringValue(file.expiry_time),
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
  };
}

function externalReferenceBlockType(type: string): boolean {
  return type === "embed" || type === "bookmark" || type === "link_preview";
}

function externalReferenceBlockSummary(block: NotionBlockNode): Record<string, unknown> {
  const value = recordValue(recordValue(block.rawBlock)[block.type]);
  const url = block.url ?? stringValue(value.url);
  const captionRichText = block.captionRichText ?? [];
  const caption = block.caption ?? (captionRichText.length > 0 ? block.text : "");
  return {
    blockId: block.id,
    type: block.type,
    label: block.type === "bookmark" ? "Bookmark" : block.type === "embed" ? "Embed" : "Link preview",
    caption,
    captionRichText,
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
    rendered: renderExternalReference(block),
  };
}

function syncedBlockFact(block: NotionBlockNode, warnings: NotionSourceWarning[]): Record<string, unknown> {
  const sourceBlockId = syncedBlockSourceId(block);
  const descendants = flattenBlocks(block.children);
  const sourceChildren = sourceBlockId
    ? descendants
      .filter((child) => child.references.some((reference) => (
        reference.kind === "synced_block"
        && reference.title === "synced_source_child"
        && reference.targetId === sourceBlockId
      )))
    : [];
  const warningCodes = warnings
    .filter((warning) => warning.blockId === block.id)
    .map((warning) => warning.code);
  const expandedFromSource = warningCodes.includes("synced_block_source_expanded");
  const sourceExpansionFailed = warningCodes.includes("synced_block_source_fetch_failed");
  const childrenSource = sourceExpansionFailed
    ? "unavailable"
    : expandedFromSource
      ? "synced_source"
      : block.children.length > 0
        ? "local"
        : "empty";
  const contentMarkdown = renderBlocks(block.children).trim();
  return {
    blockId: block.id,
    role: sourceBlockId ? "copy" : "original",
    sourceBlockId,
    childrenSource,
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlocks: block.children.map(syncedBlockChildFact),
    childBlockCount: block.children.length,
    visibleDescendantBlockCount: descendants.length,
    contentMarkdown,
    contentHash: hashContent(contentMarkdown),
    sourceChildBlockIds: sourceChildren.map((child) => child.id),
    sourceChildBlockTypes: sourceChildren.map((child) => child.type),
    sourceChildBlocks: sourceChildren.map(syncedBlockChildFact),
    sourceChildBlockCount: sourceChildren.length,
    expandedFromSource,
    sourceExpansionFailed,
    warningCodes,
  };
}

function syncedBlockChildFact(block: NotionBlockNode): Record<string, unknown> {
  return {
    blockId: block.id,
    type: block.type,
    parentBlockId: block.parentId,
    depth: block.depth,
    order: block.order,
    text: truncateFactText(block.text),
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlockCount: block.children.length,
  };
}

function syncedBlockSourceId(block: NotionBlockNode): string | null {
  const referenceTarget = block.references.find((reference) => reference.kind === "synced_block")?.targetId;
  if (referenceTarget) return referenceTarget;
  const value = recordValue(recordValue(block.rawBlock).synced_block);
  return stringValue(recordValue(value.synced_from).block_id);
}

function linkToPageBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const reference = block.references.find((candidate) => (
    candidate.kind === "linked_page"
    || candidate.kind === "linked_database"
    || candidate.kind === "linked_comment"
  ));
  const rawLinkValue = recordValue(recordValue(block.rawBlock).link_to_page);
  const rawLink = recordValue(rawLinkValue.link_to_page ?? rawLinkValue);
  const notionType = stringValue(rawLink.type)
    ?? (stringValue(rawLink.page_id)
      ? "page_id"
      : stringValue(rawLink.database_id)
        ? "database_id"
        : stringValue(rawLink.comment_id)
          ? "comment_id"
          : null);
  const targetKind = reference?.kind === "linked_database"
    ? "database"
    : reference?.kind === "linked_comment"
      ? "comment"
      : "page";
  return {
    blockId: block.id,
    targetKind,
    notionType,
    targetObjectType: reference?.targetObjectType ?? targetKind,
    targetId: reference?.targetId ?? null,
    pageId: stringValue(rawLink.page_id) ?? null,
    databaseId: stringValue(rawLink.database_id) ?? null,
    commentId: stringValue(rawLink.comment_id) ?? null,
    title: reference?.title ?? null,
    renderedLabel: renderLinkToPage(block),
  };
}

function breadcrumbBlockFact(
  block: NotionBlockNode,
  trail: NotionBreadcrumbEntry[],
  warnings: NotionSourceWarning[],
): Record<string, unknown> {
  const warningCodes = warnings
    .filter((warning) => warning.code.startsWith("breadcrumb_"))
    .map((warning) => warning.code);
  return {
    blockId: block.id,
    color: block.color ?? null,
    renderedTrail: renderBreadcrumb(trail),
    trailEntryCount: trail.length,
    trailComplete: !warningCodes.includes("breadcrumb_parent_resolve_failed"),
    warningCodes,
    trailEntries: trail.map((entry, index) => ({
      index,
      objectType: entry.objectType,
      objectId: entry.objectId,
      title: entry.title,
      url: entry.url,
      parentType: entry.parentType,
      parentId: entry.parentId,
    })),
  };
}

function tableOfContentsBlockFact(
  block: NotionBlockNode,
  headingOutline: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const headings = headingOutline.map((heading, index) => ({
    index,
    blockId: stringValue(heading.blockId) ?? stringValue(heading.id) ?? null,
    level: numberValue(heading.level) ?? null,
    title: stringValue(heading.title) ?? "",
    isToggleable: booleanValue(heading.isToggleable) ?? null,
    childBlockCount: numberValue(heading.childBlockCount) ?? null,
  }));
  return {
    blockId: block.id,
    color: block.color ?? null,
    headingCount: headings.length,
    headingBlockIds: headings.map((heading) => heading.blockId).filter((id): id is string => Boolean(id)),
    renderedOutline: renderTableOfContents(headings.flatMap((heading) =>
      heading.blockId && heading.level
        ? [{ id: heading.blockId, level: heading.level, title: heading.title }]
        : []
    )),
    headingOutline: headings,
  };
}

function displayContainerBlockFact(block: NotionBlockNode): Record<string, unknown> {
  const childMarkdown = renderBlocks(block.children).trim();
  const renderedMarkdown = block.markdown?.trim() || renderBlock(block).trim();
  const richText = block.richText ?? block.titleRichText ?? [];
  return {
    blockId: block.id,
    type: block.type,
    role: block.type === "toggle"
      ? "disclosure"
      : block.type === "template"
        ? "template"
        : block.type === "callout"
          ? "admonition"
          : "quote",
    text: block.text,
    richText,
    icon: block.icon ?? null,
    color: block.color ?? null,
    hasChildren: block.hasChildren,
    childBlockIds: block.children.map((child) => child.id),
    childBlockTypes: block.children.map((child) => child.type),
    childBlockCount: block.children.length,
    childMarkdown,
    childContentHash: hashContent(childMarkdown),
    renderedMarkdown,
    renderedHash: hashContent(renderedMarkdown),
  };
}

function blockCommentFact(block: NotionBlockNode): Record<string, unknown> {
  return {
    blockId: block.id,
    blockType: block.type,
    commentCount: block.comments.length,
    commentIds: block.comments.map((comment) => comment.commentId),
    discussionCount: commentDiscussionSummaries(block.comments).length,
    commentRetrieval: commentRetrievalFact(block.comments),
    discussions: commentDiscussionSummaries(block.comments),
    comments: block.comments.map(commentFact),
    attachmentCount: block.comments.reduce((sum, comment) => sum + (comment.attachments?.length ?? 0), 0),
    referenceCount: block.comments.reduce((sum, comment) => sum + (comment.references?.length ?? 0), 0),
    richTextSpanCount: block.comments.reduce((sum, comment) => sum + (comment.richText?.length ?? 0), 0),
    authors: Array.from(new Set(block.comments.map((comment) => comment.displayName?.resolvedName || comment.author).filter(Boolean))),
    createdTimes: block.comments.map((comment) => comment.createdTime).filter(Boolean),
  };
}

function listRunFact(block: NotionBlockNode, flatBlocks: NotionBlockNode[]): Record<string, unknown> {
  const group = siblingRun(block, flatBlocks, (candidate) =>
    (candidate.type === "bulleted_list_item" || candidate.type === "numbered_list_item")
    && candidate.type === block.type
    && (candidate.type !== "numbered_list_item" || (candidate.listFormat ?? "numbers") === (block.listFormat ?? "numbers")));
  const itemIndex = Math.max(0, group.findIndex((candidate) => candidate.id === block.id));
  const startIndex = block.type === "numbered_list_item" ? explicitListIndex(group[0]) ?? 1 : null;
  const ordinal = block.type === "numbered_list_item" && startIndex !== null ? startIndex + itemIndex : null;
  return {
    type: block.type,
    format: block.type === "numbered_list_item" ? block.listFormat ?? "numbers" : null,
    startIndex,
    explicitStartIndex: block.listStartIndex ?? null,
    itemIndex,
    ordinal,
    marker: block.type === "numbered_list_item" && ordinal !== null ? numberedListMarkerFor(block, ordinal) : "-",
    parentBlockId: block.parentId,
    groupBlockIds: group.map((item) => item.id),
    groupItemCount: group.length,
    previousBlockId: itemIndex > 0 ? group[itemIndex - 1]?.id ?? null : null,
    nextBlockId: itemIndex >= 0 && itemIndex < group.length - 1 ? group[itemIndex + 1]?.id ?? null : null,
    firstInGroup: itemIndex === 0,
    lastInGroup: itemIndex === group.length - 1,
  };
}

function taskRunFact(block: NotionBlockNode, flatBlocks: NotionBlockNode[]): Record<string, unknown> {
  const group = siblingRun(block, flatBlocks, (candidate) => candidate.type === "to_do");
  const itemIndex = Math.max(0, group.findIndex((candidate) => candidate.id === block.id));
  return {
    parentBlockId: block.parentId,
    groupBlockIds: group.map((item) => item.id),
    groupItemCount: group.length,
    itemIndex,
    checkedCount: group.filter((item) => item.checked === true).length,
    uncheckedCount: group.filter((item) => item.checked === false).length,
    previousBlockId: itemIndex > 0 ? group[itemIndex - 1]?.id ?? null : null,
    nextBlockId: itemIndex >= 0 && itemIndex < group.length - 1 ? group[itemIndex + 1]?.id ?? null : null,
    firstInGroup: itemIndex === 0,
    lastInGroup: itemIndex === group.length - 1,
  };
}

function siblingRun(
  block: NotionBlockNode,
  flatBlocks: NotionBlockNode[],
  matches: (candidate: NotionBlockNode) => boolean,
): NotionBlockNode[] {
  const siblings = flatBlocks
    .filter((candidate) => candidate.parentId === block.parentId)
    .sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((candidate) => candidate.id === block.id);
  if (index < 0) return [block];
  let start = index;
  while (start > 0 && matches(siblings[start - 1]!)) start -= 1;
  let end = index;
  while (end + 1 < siblings.length && matches(siblings[end + 1]!)) end += 1;
  return siblings.slice(start, end + 1);
}

function collectListGroupFacts(blocks: NotionBlockNode[]): Array<Record<string, unknown>> {
  const groups: Array<Record<string, unknown>> = [];
  visitSiblingRuns(blocks, (siblings) => {
    for (let index = 0; index < siblings.length;) {
      const block = siblings[index];
      if (!block || (block.type !== "bulleted_list_item" && block.type !== "numbered_list_item")) {
        index += 1;
        continue;
      }
      const type = block.type;
      const format = type === "numbered_list_item" ? block.listFormat ?? "numbers" : null;
      const group: NotionBlockNode[] = [];
      for (let cursor = index; cursor < siblings.length; cursor += 1) {
        const candidate = siblings[cursor];
        if (
          !candidate
          || candidate.type !== type
          || (type === "numbered_list_item" && (candidate.listFormat ?? "numbers") !== format)
        ) {
          break;
        }
        group.push(candidate);
      }
      if (group.length > 1) {
        groups.push({
          type,
          format,
          parentId: block.parentId,
          blockIds: group.map((item) => item.id),
          itemCount: group.length,
          startIndex: type === "numbered_list_item" ? explicitListIndex(group[0]) ?? 1 : null,
        });
      }
      index += Math.max(1, group.length);
    }
  });
  return groups;
}

function collectTaskGroupFacts(blocks: NotionBlockNode[]): Array<Record<string, unknown>> {
  const groups: Array<Record<string, unknown>> = [];
  visitSiblingRuns(blocks, (siblings) => {
    for (let index = 0; index < siblings.length;) {
      const block = siblings[index];
      if (!block || block.type !== "to_do") {
        index += 1;
        continue;
      }
      const group: NotionBlockNode[] = [];
      for (let cursor = index; cursor < siblings.length; cursor += 1) {
        const candidate = siblings[cursor];
        if (!candidate || candidate.type !== "to_do") break;
        group.push(candidate);
      }
      if (group.length > 1) {
        groups.push({
          parentId: block.parentId,
          blockIds: group.map((item) => item.id),
          itemCount: group.length,
          checkedCount: group.filter((item) => item.checked).length,
          uncheckedCount: group.filter((item) => item.checked === false).length,
        });
      }
      index += Math.max(1, group.length);
    }
  });
  return groups;
}

function visitSiblingRuns(blocks: NotionBlockNode[], visit: (siblings: NotionBlockNode[]) => void): void {
  visit(blocks);
  for (const block of blocks) visitSiblingRuns(block.children, visit);
}

async function hydratePaginatedProperties(userId: string, page: NotionPage): Promise<{
  properties: Record<string, unknown>;
  warnings: NotionSourceWarning[];
}> {
  const properties = { ...(page.properties ?? {}) } as Record<string, unknown>;
  const warnings: NotionSourceWarning[] = [];
  const hydratableProperties = Object.entries(page.properties ?? {}).flatMap(([name, raw]) => {
    const property = recordValue(raw);
    const type = stringValue(property.type);
    const propertyId = stringValue(property.id);
    return type && propertyId && PAGINATED_PROPERTY_TYPES.has(type) && propertyNeedsHydration(property, type)
      ? [{ name, property, type, propertyId }]
      : [];
  });

  if (hydratableProperties.length > PROPERTY_HYDRATION_MAX_PROPERTIES) {
    warnings.push({
      code: "property_hydration_property_count_capped",
      message: `Notion page ${page.id} has ${hydratableProperties.length} hydratable properties; hydrated the first ${PROPERTY_HYDRATION_MAX_PROPERTIES}.`,
    });
  }

  for (const { name, property, type, propertyId } of hydratableProperties.slice(0, PROPERTY_HYDRATION_MAX_PROPERTIES)) {
    try {
      const collection = await collectPropertyItems(userId, page.id, propertyId);
      properties[name] = {
        ...property,
        [type]: hydratedPropertyPayload(type, property, collection),
        has_more: collection.truncated,
        next_cursor: collection.truncated ? collection.nextCursor : null,
        next_url: collection.truncated ? collection.nextUrl : null,
        shepherd_hydrated: true,
        shepherd_truncated: collection.truncated,
        shepherd_hydration: {
          item_count: collection.items.length,
          page_count: collection.pageCount,
          max_items: PROPERTY_HYDRATION_MAX_ITEMS,
          truncated: collection.truncated,
          failed: collection.failed,
          cursor_missing: collection.cursorMissing,
          next_cursor: collection.nextCursor,
          next_url: collection.nextUrl,
          provider_error: collection.providerError,
        },
        shepherd_property_item: collection.terminalPropertyItem,
        shepherd_property_items: collection.items,
      };
      if (collection.truncated) {
        const code = collection.failed
          ? "property_hydration_failed"
          : collection.cursorMissing
            ? "property_hydration_cursor_missing"
            : "property_hydration_capped";
        warnings.push({
          code,
          propertyId,
          type,
          message: collection.failed
            ? `Notion property ${propertyId} hydration failed after ${collection.items.length} items.`
            : collection.cursorMissing
              ? `Notion property ${propertyId} reported more property items but did not return a usable next cursor.`
            : `Notion property ${propertyId} exceeded the hydration item cap ${PROPERTY_HYDRATION_MAX_ITEMS}.`,
          providerError: collection.providerError,
        });
      }
    } catch (err) {
      warnings.push({
        code: "property_hydration_failed",
        propertyId,
        type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { properties, warnings };
}

export async function hydrateNotionPageProperties(userId: string, page: NotionPage): Promise<{
  page: NotionPage;
  warnings: NotionSourceWarning[];
}> {
  const hydrated = await hydratePaginatedProperties(userId, page);
  return {
    page: {
      ...page,
      properties: hydrated.properties as NotionPage["properties"],
    },
    warnings: hydrated.warnings,
  };
}

async function fetchNotionComments(userId: string, blockId: string): Promise<{
  comments: NotionCommentSummary[];
  rawComments: NotionComment[];
  warnings: NotionSourceWarning[];
}> {
  const comments: NotionCommentSummary[] = [];
  const rawComments: NotionComment[] = [];
  const warnings: NotionSourceWarning[] = [];
  let cursor: string | null = null;
  let requestStatus: Record<string, unknown> | null = null;
  let incompleteReason: string | null = null;
  let hasMore = false;
  let nextCursor: string | null = null;
  let fetchFailed = false;

  try {
    do {
      const remaining = COMMENT_FETCH_MAX_COMMENTS - comments.length;
      if (remaining <= 0) {
        warnings.push({
          code: "comment_fetch_capped",
          blockId,
          message: `Notion comments for ${blockId} exceeded the comment cap ${COMMENT_FETCH_MAX_COMMENTS}.`,
        });
        break;
      }
      const response = await retrieveNotionComments(userId, blockId, {
        startCursor: cursor,
        pageSize: Math.min(100, remaining),
      });
      const pageStatus = recordValue(response.request_status);
      if (Object.keys(pageStatus).length > 0) {
        const pageIncompleteReason = stringValue(pageStatus.incomplete_reason);
        if (stringValue(pageStatus.type) === "incomplete" || requestStatus === null) {
          requestStatus = {
            ...pageStatus,
            ...(incompleteReason && !pageIncompleteReason ? { incomplete_reason: incompleteReason } : {}),
          };
        }
        incompleteReason = pageIncompleteReason ?? incompleteReason;
      }
      hasMore = response.has_more === true;
      nextCursor = hasMore ? stringValue(response.next_cursor) : null;
      for (const comment of response.results) {
        const summary = commentSummary(comment);
        if (summary) {
          comments.push(summary);
          rawComments.push(comment);
        }
      }
      cursor = nextCursor;
    } while (cursor);
  } catch (err) {
    fetchFailed = true;
    const providerError = notionApiErrorSummary(err);
    warnings.push({
      code: "comment_fetch_failed",
      blockId,
      message: err instanceof Error ? err.message : String(err),
      providerError,
    });
  }

  const complete = !fetchFailed && !hasMore && stringValue(requestStatus?.type) !== "incomplete";
  if (!complete) {
    warnings.push({
      code: "comment_fetch_incomplete",
      blockId,
      message: `Notion comments for ${blockId} were incomplete${incompleteReason ? ` (${incompleteReason})` : ""}.`,
    });
  }
  const annotatedComments = comments.map((comment) => ({
    ...comment,
    retrievalRequestStatus: requestStatus,
    retrievalComplete: complete,
    retrievalHasMore: hasMore,
    retrievalNextCursor: nextCursor,
  }));

  return { comments: annotateCommentDiscussionPositions(annotatedComments), rawComments, warnings };
}

function commentSummary(comment: NotionComment): NotionCommentSummary | null {
  const richText = summarizeNotionRichText(arrayValue(comment.rich_text));
  const text = richTextMarkdown(arrayValue(comment.rich_text)).trim();
  const displayName = recordValue(comment.display_name);
  const attachments = arrayValue(comment.attachments).map(commentAttachmentSummary);
  const references = richTextMentionReferences(arrayValue(comment.rich_text))
    .map((reference) => ({ ...reference, commentId: comment.id }));
  const parent = notionParentInfo(comment.parent);
  if (!comment.id) return null;
  const partial = !recordHasKeys(comment.parent)
    && !comment.discussion_id
    && !comment.created_time
    && !comment.last_edited_time
    && !recordHasKeys(comment.created_by)
    && arrayValue(comment.rich_text).length === 0
    && Object.keys(displayName).length === 0
    && attachments.length === 0;
  return {
    commentId: comment.id,
    objectType: stringValue(comment.object) ?? null,
    partial,
    parentType: parent.parentType,
    parentId: parent.parentId,
    parent: notionParentSummary(comment.parent),
    discussionId: comment.discussion_id ?? null,
    discussionKey: comment.discussion_id ?? `comment:${comment.id}`,
    discussionIndex: 0,
    discussionCommentCount: 1,
    text,
    author: personLabel(comment.created_by) || null,
    displayName: Object.keys(displayName).length > 0
      ? {
        type: stringValue(displayName.type),
        resolvedName: stringValue(displayName.resolved_name),
      }
      : undefined,
    richText,
    references,
    attachments,
    createdTime: comment.created_time ?? null,
    lastEditedTime: comment.last_edited_time ?? null,
  };
}

function annotateCommentDiscussionPositions(comments: NotionCommentSummary[]): NotionCommentSummary[] {
  const groups = new Map<string, NotionCommentSummary[]>();
  for (const comment of comments) {
    const key = commentDiscussionKey(comment);
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return comments.map((comment) => {
    const key = commentDiscussionKey(comment);
    const group = groups.get(key) ?? [comment];
    return {
      ...comment,
      discussionKey: key,
      discussionIndex: Math.max(0, group.findIndex((candidate) => candidate.commentId === comment.commentId)),
      discussionCommentCount: group.length,
    };
  });
}

function commentDiscussionKey(comment: NotionCommentSummary): string {
  return comment.discussionId ?? `comment:${comment.commentId}`;
}

function commentAttachmentSummary(value: unknown): NotionCommentAttachmentSummary {
  const attachment = recordValue(value);
  const file = recordValue(attachment.file);
  const type = stringValue(file.type)
    ?? stringValue(attachment.type)
    ?? (recordHasKeys(file.file) || stringValue(file.url) ? "file" : recordHasKeys(file.external) ? "external" : null);
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
        inTrash: booleanValue(upload.in_trash) ?? null,
        archived: booleanValue(upload.archived) ?? null,
        createdBy: lifecycle.fileUploadCreatedBy as NotionCommentAttachmentFileUploadSummary["createdBy"],
        numberOfParts: lifecycle.fileUploadNumberOfParts as NotionCommentAttachmentFileUploadSummary["numberOfParts"],
        importResult: lifecycle.fileUploadImportResult as NotionCommentAttachmentFileUploadSummary["importResult"],
        uploadUrlRedacted: lifecycle.fileUploadUploadUrlRedacted as boolean | undefined,
        completeUrlRedacted: lifecycle.fileUploadCompleteUrlRedacted as boolean | undefined,
      }
      : null,
  };
}

function recordHasKeys(value: unknown): boolean {
  return Object.keys(recordValue(value)).length > 0;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function collectPropertyItems(userId: string, pageId: string, propertyId: string): Promise<NotionPropertyItemCollection> {
  const items: unknown[] = [];
  let terminalPropertyItem: Record<string, unknown> | null = null;
  let cursor: string | null = null;
  let truncated = false;
  let failed = false;
  let cursorMissing = false;
  let nextCursor: string | null = null;
  let nextUrl: string | null = null;
  let providerError: NotionApiErrorSummary | null = null;
  let pageCount = 0;
  do {
    let response: unknown;
    try {
      response = await retrieveNotionPageProperty(userId, pageId, propertyId, {
        startCursor: cursor,
        pageSize: 100,
      });
    } catch (err) {
      failed = true;
      truncated = true;
      nextCursor = cursor;
      providerError = notionApiErrorSummary(err);
      break;
    }
    pageCount++;
    const record = recordValue(response);
    if (Array.isArray(record.results)) {
      items.push(...record.results);
      const responseHasMore = record.has_more === true;
      cursor = responseHasMore ? stringValue(record.next_cursor) : null;
      nextUrl = cursor ? stringValue(record.next_url) : null;
      const propertyItem = recordValue(record.property_item);
      if (Object.keys(propertyItem).length > 0) {
        terminalPropertyItem = propertyItem;
      }
      if (cursor && !nextUrl) {
        nextUrl = stringValue(propertyItem.next_url);
      }
      if (responseHasMore && !cursor) {
        cursorMissing = true;
        truncated = true;
        nextCursor = null;
        nextUrl = stringValue(record.next_url) ?? stringValue(propertyItem.next_url);
        break;
      }
    } else {
      items.push(response);
      terminalPropertyItem = record;
      cursor = null;
      nextUrl = null;
    }
    if (items.length >= PROPERTY_HYDRATION_MAX_ITEMS) {
      truncated = items.length > PROPERTY_HYDRATION_MAX_ITEMS || cursor !== null;
      nextCursor = cursor;
      items.length = PROPERTY_HYDRATION_MAX_ITEMS;
      break;
    }
  } while (cursor);
  return {
    items,
    terminalPropertyItem,
    pageCount,
    truncated,
    failed,
    cursorMissing,
    nextCursor,
    nextUrl: truncated ? nextUrl : null,
    providerError,
  };
}

function hydratedPropertyPayload(
  type: string,
  originalProperty: Record<string, unknown>,
  collection: NotionPropertyItemCollection,
): unknown {
  if (type === "rollup") {
    const terminalRollup = recordValue(collection.terminalPropertyItem?.rollup);
    if (Object.keys(terminalRollup).length > 0) {
      return {
        ...recordValue(originalProperty.rollup),
        ...terminalRollup,
      };
    }
  }
  if (type === "formula") {
    const terminalFormula = recordValue(collection.terminalPropertyItem?.formula);
    if (Object.keys(terminalFormula).length > 0) return terminalFormula;
  }

  if (collection.items.length === 0 && collection.failed) return originalProperty[type];
  return collection.items.map((item) => recordValue(item)[type] ?? item);
}

function propertyNeedsHydration(property: Record<string, unknown>, type: string): boolean {
  if (property.shepherd_hydrated === true) return false;
  if (type === "formula" || type === "relation" || type === "rollup") return true;
  if (property.has_more === true) return true;
  const value = property[type];
  return Array.isArray(value) && value.length >= 25;
}

function splitNotionMarkdown(title: string, markdown: string): NotionSection[] {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return [{
      sectionId: "section:0:empty",
      sectionTitle: title,
      content: "",
      contentHash: hashContent(""),
    }];
  }

  const lines = trimmed.split("\n");
  const protectedLines = protectedMarkdownLineIndexes(lines);
  const sections: NotionSection[] = [];
  let currentHeading = title;
  let currentLines: string[] = [];

  const flush = () => {
    const contentForFacts = currentLines.join("\n").trim();
    const content = stripRedactedMediaMarkers(contentForFacts).trim();
    if (!content && sections.length > 0) return;
    const index = sections.length;
    sections.push({
      sectionId: `section:${index}:${hashContent(currentHeading).slice(0, 8)}`,
      sectionTitle: currentHeading,
      content,
      contentHash: hashContent(content),
      structuredFacts: enhancedMarkdownStructureFacts(contentForFacts),
    });
  };

  for (const [lineIndex, line] of lines.entries()) {
    const heading = protectedLines.has(lineIndex) ? null : markdownHeading(line);
    if (heading) {
      if (currentLines.length > 0 && !containsOnlyMarkdownHeadings(currentLines)) {
        flush();
        currentLines = [];
      }
      currentHeading = heading;
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

function markdownHeading(line: string): string | null {
  const heading = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
  if (heading && isEscapedMarkdownSyntax(line, lineMarkerIndex(line))) return null;
  return heading ? heading[2].trim() : null;
}

function collectEnhancedMarkdownHeadingFacts(lines: string[]): Array<Record<string, unknown> & { title: string | null; type: string }> {
  const headings: Array<Record<string, unknown> & { title: string | null; type: string }> = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/u.exec(line.trim());
    if (!match || isEscapedMarkdownSyntax(line, lineMarkerIndex(line))) continue;
    const sourceLevel = match[1].length;
    const effectiveLevel = Math.min(sourceLevel, 4);
    const attributes = parseEnhancedMarkdownAttributes(/\{([^\}]*)\}\s*$/u.exec(match[2])?.[1] ?? "");
    const title = stripEnhancedMarkdownAttributeLists(match[2]).trim();
    headings.push({
      lineIndex,
      depth: /^\t*/u.exec(line)?.[0].length ?? 0,
      sourceLevel,
      effectiveLevel,
      type: `heading_${effectiveLevel}`,
      title: title || null,
      color: enhancedMarkdownLineColor(line),
      toggle: booleanString(attributes.toggle) ?? false,
      convertedToHeading4: sourceLevel > 4,
    });
  }
  return headings;
}

function containsOnlyMarkdownHeadings(lines: string[]): boolean {
  const nonBlank = lines.filter((line) => line.trim());
  return nonBlank.length > 0 && nonBlank.every((line) => markdownHeading(line) !== null);
}

function protectedMarkdownLineIndexes(lines: string[]): Set<number> {
  const protectedLines = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const fence = markdownFence(lines[index]);
    if (!fence) continue;
    protectedLines.add(index);
    for (index += 1; index < lines.length; index += 1) {
      protectedLines.add(index);
      if (closesMarkdownFence(lines[index], fence)) break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/<table\b/i.test(lines[index])) continue;
    protectedLines.add(index);
    for (index += 1; index < lines.length; index += 1) {
      protectedLines.add(index);
      if (/<\/table>/i.test(lines[index])) break;
    }
  }

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isMarkdownTableRow(lines[index]) || !isMarkdownTableSeparator(lines[index + 1])) continue;
    protectedLines.add(index);
    protectedLines.add(index + 1);
    index += 2;
    while (index < lines.length && isMarkdownTableRow(lines[index])) {
      protectedLines.add(index);
      index += 1;
    }
    index -= 1;
  }

  return protectedLines;
}

type MarkdownFence = {
  char: "`" | "~";
  length: number;
};

function markdownFence(line: string): MarkdownFence | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const marker = match[1];
  return {
    char: marker[0] as MarkdownFence["char"],
    length: marker.length,
  };
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const pattern = new RegExp(`^[ \\t]{0,3}${fence.char}{${fence.length},}[ \\t]*$`, "u");
  return pattern.test(line);
}

function markdownTableCells(line: string): string[] {
  let stripped = line.trim();
  if (!stripped.includes("|")) return [];
  if (stripped.startsWith("|")) stripped = stripped.slice(1);
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
  return stripped.split("|").map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-+:?$/u.test(cell.replace(/\s+/g, "")));
}

function enhancedMarkdownStructureFacts(markdown: string): Record<string, unknown> {
  const lines = markdown.split("\n");
  const protectedLines = protectedMarkdownLineIndexes(lines);
  const semanticLines = maskMarkdownLines(lines, protectedLines);
  const fencedLines = fencedMarkdownLineIndexes(lines);
  const text = maskMarkdownLines(lines, protectedLines).join("\n");
  const tagText = maskMarkdownLines(lines, fencedLines).join("\n");
  const htmlTags = collectEnhancedMarkdownTags(tagText)
    .filter((tag) => tag.name !== REDACTED_MEDIA_MARKDOWN_TAG);
  const plainBlockFacts = collectEnhancedMarkdownPlainBlockFacts(lines, semanticLines);
  const indentationFacts = collectEnhancedMarkdownIndentationFacts(semanticLines);
  const emptyBlockFacts = collectEnhancedMarkdownEmptyBlockFacts(semanticLines);
  const blockColors = collectEnhancedMarkdownColors(tagText);
  const mentions = collectEnhancedMarkdownMentions(text);
  const citations = collectEnhancedMarkdownCitations(text);
  const customEmojis = collectEnhancedMarkdownCustomEmojis(text);
  const inlineSpans = collectEnhancedMarkdownInlineSpans(tagText);
  const lineBreaks = htmlTags
    .filter((tag) => tag.name === "br")
    .map((tag) => ({ lineIndex: tag.lineIndex, depth: tag.depth }));
  const inlineMarkdown = collectEnhancedMarkdownInlineMarkdown(text);
  const tableAttributes = collectEnhancedMarkdownTableAttributes(tagText);
  const headingFacts = collectEnhancedMarkdownHeadingFacts(semanticLines);
  const mediaTags = htmlTags.filter((tag) => ["audio", "video", "file", "pdf"].includes(tag.name));
  const mediaMarkdownBlocks = collectEnhancedMarkdownMediaMarkdownBlocks(text);
  const detailToggles = collectEnhancedMarkdownDetailToggles(htmlTags);
  const callouts = collectEnhancedMarkdownCallouts(htmlTags);
  const columnLists = collectEnhancedMarkdownColumnLists(htmlTags);
  const syncedBlocks = collectEnhancedMarkdownSyncedBlocks(htmlTags);
  const tableOfContentsBlocks = collectEnhancedMarkdownTableOfContents(htmlTags, headingFacts);
  const pageReferences = collectEnhancedMarkdownReferenceTags(htmlTags, "page");
  const databaseReferences = collectEnhancedMarkdownReferenceTags(htmlTags, "database");
  const referenceBlocks = [...pageReferences, ...databaseReferences]
    .sort((left, right) => (numberValue(left.lineIndex) ?? 0) - (numberValue(right.lineIndex) ?? 0));
  const unknownBlocks = htmlTags.filter((tag) => tag.name === "unknown").map((tag) => ({
    lineIndex: tag.lineIndex,
    depth: tag.depth,
    alt: tag.attributes.alt ?? null,
    hasUrl: Boolean(tag.attributes.url),
    urlRedacted: Boolean(tag.attributes.url),
  }));

  return {
    source: "notion_enhanced_markdown",
    lineCount: lines.length,
    tabIndentedLineCount: lines.filter((line) => /^\t+/u.test(line)).length,
    maxTabIndentDepth: lines.reduce((max, line) => Math.max(max, /^\t*/u.exec(line)?.[0].length ?? 0), 0),
    indentation: indentationFacts,
    textBlockCount: plainBlockFacts.textBlocks.length,
    textBlocks: plainBlockFacts.textBlocks,
    headingCount: headingFacts.length,
    headingTitles: headingFacts.map((heading) => heading.title).filter((heading): heading is string => Boolean(heading)),
    headingTypes: countBy(headingFacts.map((heading) => heading.type)),
    headings: headingFacts,
    bulletedListItemCount: plainBlockFacts.bulletedListItemCount,
    numberedListItemCount: plainBlockFacts.numberedListItemCount,
    listItems: plainBlockFacts.listItems,
    emptyListItemCount: plainBlockFacts.listItems.filter((item) => Boolean(item.emptyContent)).length,
    taskCount: plainBlockFacts.listItems.filter((item) => item.type === "to_do").length,
    checkedTaskCount: plainBlockFacts.listItems.filter((item) => item.type === "to_do" && item.checked === true).length,
    uncheckedTaskCount: plainBlockFacts.listItems.filter((item) => item.type === "to_do" && item.checked === false).length,
    quoteBlockCount: plainBlockFacts.quoteBlockCount,
    quoteLineBreakCount: plainBlockFacts.quoteLineBreakCount,
    quotes: plainBlockFacts.quoteBlocks,
    toggleHeadingCount: headingFacts.filter((heading) => heading.toggle).length,
    codeBlockCount: plainBlockFacts.codeBlocks.length,
    codeBlockLanguages: plainBlockFacts.codeBlocks.map((block) => block.language).filter((language): language is string => Boolean(language)),
    codeBlocks: plainBlockFacts.codeBlocks,
    equationBlockCount: plainBlockFacts.equationBlockCount,
    equationBlocks: plainBlockFacts.equationBlocks,
    dividerCount: plainBlockFacts.dividerCount,
    dividers: plainBlockFacts.dividers,
    blockColors,
    coloredBlockCount: Object.values(blockColors).reduce((sum, count) => sum + count, 0),
    tagCounts: countBy(htmlTags.map((tag) => tag.name)),
    blockTagCounts: countBy(htmlTags.filter((tag) => ENHANCED_MARKDOWN_BLOCK_TAGS.has(tag.name)).map((tag) => tag.name)),
    lineBreakCount: lineBreaks.length,
    lineBreaks,
    inlineSpanCount: inlineSpans.length,
    underlineSpanCount: inlineSpans.filter((span) => span.underline).length,
    inlineTextColors: countBy(inlineSpans.map((span) => span.color).filter((color): color is string => Boolean(color))),
    inlineSpans,
    inlineMarkdown,
    customEmojiCount: customEmojis.length,
    customEmojiNames: customEmojis.map((emoji) => emoji.name).filter((name): name is string => typeof name === "string"),
    customEmojis,
    unknownBlockCount: unknownBlocks.length,
    unknownBlocks,
    detailToggleCount: detailToggles.length,
    detailToggles,
    calloutCount: callouts.length,
    callouts,
    columnListCount: columnLists.length,
    columnCount: columnLists.reduce((sum, columnList) => sum + (numberValue(columnList.columnCount) ?? 0), 0),
    columnLists,
    syncedBlockCount: syncedBlocks.filter((block) => block.type === "synced_block").length,
    syncedBlockReferenceCount: syncedBlocks.filter((block) => block.type === "synced_block_reference").length,
    syncedBlocks,
    tableOfContentsCount: tableOfContentsBlocks.length,
    tableOfContents: tableOfContentsBlocks,
    emptyBlockCount: emptyBlockFacts.emptyBlockCount,
    misplacedEmptyBlockCount: emptyBlockFacts.misplacedEmptyBlockCount,
    emptyBlocks: emptyBlockFacts.emptyBlocks,
    misplacedEmptyBlocks: emptyBlockFacts.misplacedEmptyBlocks,
    pageReferenceCount: pageReferences.length,
    pageReferences,
    databaseReferenceCount: databaseReferences.length,
    databaseReferences,
    referenceCount: referenceBlocks.length,
    references: referenceBlocks,
    mediaTagCount: mediaTags.length,
    mediaTags: mediaTags.map((tag) => ({
      type: tag.name,
      lineIndex: tag.lineIndex,
      depth: tag.depth,
      hasSource: Boolean(tag.attributes.src),
      sourceUrlRedacted: Boolean(tag.attributes.src),
      color: tag.attributes.color ?? null,
      caption: tag.text,
    })),
    mediaBlockCount: mediaMarkdownBlocks.length,
    imageMarkdownBlockCount: mediaMarkdownBlocks.filter((block) => block.type === "image").length,
    mediaMarkdownBlocks,
    tableCount: tableAttributes.length,
    tables: tableAttributes,
    mentionCount: mentions.length,
    mentionTypes: countBy(mentions.map((mention) => mention.type)),
    mentions,
    citationCount: citations.length,
    citations,
  };
}

const ENHANCED_MARKDOWN_BLOCK_TAGS = new Set([
  "audio",
  "callout",
  "column",
  "columns",
  "database",
  "details",
  "empty-block",
  "file",
  "page",
  "pdf",
  "synced_block",
  "synced_block_reference",
  "table",
  "table_of_contents",
  "unknown",
  "video",
]);

type EnhancedMarkdownTag = {
  name: string;
  attributes: Record<string, string>;
  text: string | null;
  rawText: string | null;
  bodyStartLineIndex: number | null;
  lineIndex: number;
  depth: number;
};

type EnhancedMarkdownMention = {
  type: string;
  title: string | null;
  hasUrl: boolean;
  urlRedacted: boolean;
  lineIndex: number;
  depth: number;
  start: string | null;
  end: string | null;
  startTime: string | null;
  timeZone: string | null;
};

function collectEnhancedMarkdownTags(markdown: string): EnhancedMarkdownTag[] {
  const tags: EnhancedMarkdownTag[] = [];
  const tagPattern = /<([a-z][a-z0-9_-]*)(\s[^<>]*?)?\/?>/giu;
  for (const match of markdown.matchAll(tagPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const bodyInfo = enhancedMarkdownPairedTagBodyInfo(markdown, match[1], match.index ?? -1);
    tags.push({
      name: match[1].toLowerCase(),
      attributes: parseEnhancedMarkdownAttributes(match[2] ?? ""),
      text: bodyInfo.body === null ? null : stripMarkupText(bodyInfo.body).trim() || null,
      rawText: bodyInfo.body,
      bodyStartLineIndex: bodyInfo.bodyStartLineIndex,
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
    });
  }
  return tags;
}

function lineIndexAtOffset(markdown: string, offset: number): number {
  return markdown.slice(0, Math.max(0, offset)).split("\n").length - 1;
}

function tagDepthAtOffset(markdown: string, offset: number): number {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, offset) - 1) + 1;
  const linePrefix = markdown.slice(lineStart, Math.max(0, offset));
  return /^\t*/u.exec(linePrefix)?.[0].length ?? 0;
}

function maskMarkdownLines(lines: string[], maskedLineIndexes: Set<number>): string[] {
  return lines.map((line, index) => maskedLineIndexes.has(index) ? " ".repeat(line.length) : line);
}

function fencedMarkdownLineIndexes(lines: string[]): Set<number> {
  const protectedLines = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const fence = markdownFence(lines[index]);
    if (!fence) continue;
    protectedLines.add(index);
    for (index += 1; index < lines.length; index += 1) {
      protectedLines.add(index);
      if (closesMarkdownFence(lines[index], fence)) break;
    }
  }
  return protectedLines;
}

function enhancedMarkdownPairedTagText(markdown: string, tagName: string, startIndex: number): string | null {
  const body = enhancedMarkdownPairedTagBody(markdown, tagName, startIndex);
  return body === null ? null : stripMarkupText(body).trim() || null;
}

function enhancedMarkdownPairedTagBody(markdown: string, tagName: string, startIndex: number): string | null {
  return enhancedMarkdownPairedTagBodyInfo(markdown, tagName, startIndex).body;
}

function enhancedMarkdownPairedTagBodyInfo(
  markdown: string,
  tagName: string,
  startIndex: number,
): { body: string | null; bodyStartLineIndex: number | null } {
  if (startIndex < 0) return { body: null, bodyStartLineIndex: null };
  const closing = new RegExp(`</${escapeRegExp(tagName)}>`, "iu");
  const rest = markdown.slice(startIndex);
  const openerEnd = rest.indexOf(">");
  if (openerEnd < 0 || rest.slice(0, openerEnd + 1).endsWith("/>")) return { body: null, bodyStartLineIndex: null };
  const match = closing.exec(rest.slice(openerEnd + 1));
  if (!match) return { body: null, bodyStartLineIndex: null };
  const rawBody = rest.slice(openerEnd + 1, openerEnd + 1 + match.index);
  const leadingNewlines = /^\n*/u.exec(rawBody)?.[0].length ?? 0;
  const body = rawBody.replace(/^\n+|\n+$/gu, "") || null;
  return {
    body,
    bodyStartLineIndex: body === null ? null : lineIndexAtOffset(markdown, startIndex + openerEnd + 1 + leadingNewlines),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isEscapedMarkdownSyntax(markdown: string, index: number): boolean {
  if (index <= 0) return false;
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function collectEnhancedMarkdownColors(markdown: string): Record<string, number> {
  const colors: string[] = [];
  const attributePattern = /\{[^\}]*\bcolor=["']?([^"'\s\}]+)["']?[^\}]*\}/giu;
  for (const match of markdown.matchAll(attributePattern)) {
    if (!isEscapedMarkdownSyntax(markdown, match.index ?? -1)) colors.push(match[1]);
  }
  const tagColorPattern = /<([a-z][a-z0-9_-]*)\b[^>]*\bcolor=["']([^"']+)["'][^>]*>/giu;
  for (const match of markdown.matchAll(tagColorPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    if (match[1].toLowerCase() !== "span") colors.push(match[2]);
  }
  return countBy(colors);
}

function collectEnhancedMarkdownMentions(markdown: string): EnhancedMarkdownMention[] {
  const mentions: EnhancedMarkdownMention[] = [];
  const mentionPattern = /<mention-([a-z][a-z0-9_-]*)(\s[^<>]*?)?(?:\/>|>([\s\S]*?)<\/mention-\1>)/giu;
  for (const match of markdown.matchAll(mentionPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const attributes = parseEnhancedMarkdownAttributes(match[2] ?? "");
    mentions.push({
      type: match[1].replace(/-/g, "_"),
      title: stripMarkupText(match[3] ?? "").trim() || null,
      hasUrl: Boolean(attributes.url),
      urlRedacted: Boolean(attributes.url),
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      start: attributes.start ?? null,
      end: attributes.end ?? null,
      startTime: attributes.startTime ?? null,
      timeZone: attributes.timeZone ?? null,
    });
  }
  return mentions;
}

function collectEnhancedMarkdownCitations(markdown: string): Array<Record<string, unknown>> {
  const citations: Array<Record<string, unknown>> = [];
  const citationPattern = /\[\^([^\]\s]+)\]/gu;
  for (const match of markdown.matchAll(citationPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const markerIndex = match.index ?? 0;
    citations.push({
      lineIndex: lineIndexAtOffset(markdown, markerIndex),
      depth: tagDepthAtOffset(markdown, markerIndex),
      hasUrl: /^https?:\/\//iu.test(match[1]),
      urlRedacted: /^https?:\/\//iu.test(match[1]),
      label: /^https?:\/\//iu.test(match[1]) ? null : match[1],
    });
  }
  return citations;
}

function collectEnhancedMarkdownCustomEmojis(markdown: string): Array<Record<string, unknown> & { name: string }> {
  const emojis: Array<Record<string, unknown> & { name: string }> = [];
  const customEmojiPattern = /(^|[^\w/]):([A-Za-z0-9_+-]+):(?=$|[^\w-])/gu;
  for (const match of markdown.matchAll(customEmojiPattern)) {
    const markerIndex = (match.index ?? -1) + match[1].length;
    if (isEscapedMarkdownSyntax(markdown, markerIndex)) continue;
    emojis.push({
      name: match[2],
      lineIndex: lineIndexAtOffset(markdown, markerIndex),
      depth: tagDepthAtOffset(markdown, markerIndex),
    });
  }
  return emojis;
}

function collectEnhancedMarkdownInlineSpans(markdown: string): Array<Record<string, unknown>> {
  const spans: Array<Record<string, unknown>> = [];
  const spanPattern = /<span\b([^>]*)>([\s\S]*?)<\/span>/giu;
  for (const match of markdown.matchAll(spanPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const attributes = parseEnhancedMarkdownAttributes(match[1] ?? "");
    spans.push({
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      underline: booleanString(attributes.underline) ?? false,
      color: attributes.color ?? null,
      text: stripMarkupText(match[2] ?? "").trim() || null,
    });
  }
  return spans;
}

function collectEnhancedMarkdownIndentationFacts(lines: string[], sourceLineIndexes?: number[]): Record<string, unknown> {
  const blocks: Array<
    Record<string, unknown> & { depth: number; hasChildren: boolean; sourceLineIndex: number; parentIndex: number | null }
  > = [];
  const stack: Array<{ depth: number; index: number }> = [];

  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const depth = /^\t*/u.exec(line)?.[0].length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parentIndex = stack.length > 0 ? stack[stack.length - 1]!.index : null;
    if (parentIndex !== null) blocks[parentIndex]!.hasChildren = true;
    const sourceLineIndex = sourceLineIndexes?.[lineIndex] ?? lineIndex;
    const parentBlock = parentIndex === null ? null : blocks[parentIndex] ?? null;
    const block = {
      index: blocks.length,
      sourceLineIndex,
      depth,
      type: enhancedMarkdownLineBlockType(line),
      parentIndex,
      parentSourceLineIndex: parentBlock?.sourceLineIndex ?? null,
      hasChildren: false,
      color: enhancedMarkdownLineColor(line),
      checked: enhancedMarkdownLineChecked(line),
    };
    blocks.push(block);
    stack.push({ depth, index: block.index });
  });

  return {
    blockCount: blocks.length,
    rootBlockCount: blocks.filter((block) => block.depth === 0).length,
    childBlockCount: blocks.filter((block) => block.depth > 0).length,
    maxDepth: blocks.reduce((max, block) => Math.max(max, block.depth), 0),
    depthCounts: countBy(blocks.map((block) => String(block.depth))),
    parentChildEdgeCount: blocks.filter((block) => block.parentIndex !== null).length,
    headingChildEdgeCount: blocks.filter((block) => {
      const parentIndex = numberValue(block.parentIndex);
      const parentBlock = typeof parentIndex === "number" ? blocks[parentIndex] : undefined;
      return headingBlockType(String(parentBlock?.type ?? ""));
    }).length,
    headingChildEdges: blocks
      .filter((block) => {
        const parentIndex = numberValue(block.parentIndex);
        const parentBlock = typeof parentIndex === "number" ? blocks[parentIndex] : undefined;
        return headingBlockType(String(parentBlock?.type ?? ""));
      })
      .map((block) => {
        const parentIndex = numberValue(block.parentIndex);
        const parentBlock = typeof parentIndex === "number" ? blocks[parentIndex] : undefined;
        return {
          parentIndex: parentIndex ?? null,
          parentType: parentBlock?.type ?? null,
          parentSourceLineIndex: parentBlock?.sourceLineIndex ?? null,
          childIndex: block.index,
          childType: block.type,
          childSourceLineIndex: block.sourceLineIndex,
        };
      }),
    blocks,
  };
}

function headingBlockType(type: string): boolean {
  return /^heading_[1-4]$/u.test(type);
}

function collectEnhancedMarkdownEmptyBlockFacts(lines: string[]): {
  emptyBlockCount: number;
  misplacedEmptyBlockCount: number;
  emptyBlocks: Array<Record<string, unknown>>;
  misplacedEmptyBlocks: Array<Record<string, unknown>>;
} {
  const emptyBlocks: Array<Record<string, unknown>> = [];
  const misplacedEmptyBlocks: Array<Record<string, unknown>> = [];
  lines.forEach((line, index) => {
    const markerMatches = [...line.matchAll(/<empty-block\s*\/>/giu)]
      .filter((match) => !isEscapedMarkdownSyntax(line, match.index ?? -1));
    if (markerMatches.length === 0) return;
    const ownLine = /^[\t ]*<empty-block\s*\/>[\t ]*$/iu.test(line);
    const depth = /^\t*/u.exec(line)?.[0].length ?? 0;
    if (ownLine) {
      emptyBlocks.push({ lineIndex: index, depth });
    } else {
      misplacedEmptyBlocks.push({
        lineIndex: index,
        markerCount: markerMatches.length,
        text: stripMarkupText(line).trim() || null,
      });
    }
  });
  return {
    emptyBlockCount: emptyBlocks.length,
    misplacedEmptyBlockCount: misplacedEmptyBlocks.reduce((sum, block) => sum + (numberValue(block.markerCount) ?? 0), 0),
    emptyBlocks,
    misplacedEmptyBlocks,
  };
}

function enhancedMarkdownLineBlockType(line: string): string {
  const trimmed = line.trim();
  const contentIndex = line.search(/\S/u);
  if (contentIndex >= 0 && isEscapedMarkdownSyntax(line, contentIndex)) return "text";
  const heading = /^(#{1,6})[ \t]+/u.exec(trimmed);
  if (heading) return `heading_${Math.min(heading[1].length, 4)}`;
  if (/^-\s+\[[ xX]\]/u.test(trimmed)) return "to_do";
  if (/^-\s+/u.test(trimmed)) return "bulleted_list_item";
  if (/^\d+\.\s+/u.test(trimmed)) return "numbered_list_item";
  if (/^>\s+/u.test(trimmed)) return "quote";
  if (/^---$/u.test(trimmed)) return "divider";
  if (/^\$\$$/u.test(trimmed)) return "equation_delimiter";
  const tag = /^<\/?([a-z][a-z0-9_-]*)\b/iu.exec(trimmed);
  if (tag) return tag[1].toLowerCase();
  return "text";
}

function enhancedMarkdownLineColor(line: string): string | null {
  const brace = /\{[^\}]*\bcolor=["']?([^"'\s\}]+)["']?[^\}]*\}/iu.exec(line);
  if (brace && !isEscapedMarkdownSyntax(line, brace.index)) return brace[1];
  const tag = /<([a-z][a-z0-9_-]*)\b[^>]*\bcolor=["']([^"']+)["'][^>]*>/iu.exec(line);
  return tag && !isEscapedMarkdownSyntax(line, tag.index) ? tag[2] : null;
}

function enhancedMarkdownLineChecked(line: string): boolean | null {
  const trimmed = line.trim();
  const contentIndex = line.search(/\S/u);
  if (contentIndex >= 0 && isEscapedMarkdownSyntax(line, contentIndex)) return null;
  if (/^-\s+\[[xX]\]/u.test(trimmed)) return true;
  if (/^-\s+\[ \]/u.test(trimmed)) return false;
  return null;
}

function collectEnhancedMarkdownPlainBlockFacts(lines: string[], semanticLines: string[]): {
  bulletedListItemCount: number;
  numberedListItemCount: number;
  textBlocks: Array<Record<string, unknown>>;
  listItems: Array<Record<string, unknown> & { type: string; checked?: boolean | null; emptyContent: boolean }>;
  quoteBlockCount: number;
  quoteLineBreakCount: number;
  quoteBlocks: Array<Record<string, unknown>>;
  dividerCount: number;
  dividers: Array<Record<string, unknown>>;
  equationBlockCount: number;
  equationBlocks: Array<Record<string, unknown>>;
  codeBlocks: Array<Record<string, unknown> & { language: string | null }>;
} {
  const equationBlocks = collectEnhancedMarkdownEquationBlocks(semanticLines);
  const quoteBlocks = collectEnhancedMarkdownQuoteBlocks(semanticLines);
  const listItems = collectEnhancedMarkdownListItems(semanticLines);
  const textBlocks = collectEnhancedMarkdownTextBlocks(semanticLines);
  const dividers = collectEnhancedMarkdownDividerBlocks(semanticLines);
  return {
    textBlocks,
    bulletedListItemCount: listItems.filter((item) => item.type === "bulleted_list_item").length,
    numberedListItemCount: listItems.filter((item) => item.type === "numbered_list_item").length,
    listItems,
    quoteBlockCount: quoteBlocks.length,
    quoteLineBreakCount: quoteBlocks.reduce((sum, quote) => sum + (numberValue(quote.lineBreakCount) ?? 0), 0),
    quoteBlocks,
    dividerCount: dividers.length,
    dividers,
    equationBlockCount: equationBlocks.length,
    equationBlocks,
    codeBlocks: collectEnhancedMarkdownCodeBlocks(lines),
  };
}

function collectEnhancedMarkdownDividerBlocks(lines: string[]): Array<Record<string, unknown>> {
  const dividers: Array<Record<string, unknown>> = [];
  lines.forEach((line, lineIndex) => {
    if (!unescapedLineMatch(line, /^[\t ]*---[ \t]*$/u)) return;
    dividers.push({
      lineIndex,
      depth: /^\t*/u.exec(line)?.[0].length ?? 0,
    });
  });
  return dividers;
}

function collectEnhancedMarkdownTextBlocks(lines: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    if (enhancedMarkdownLineBlockType(line) !== "text") return;
    const text = stripMediaUrlsFromText(stripMarkupText(stripEnhancedMarkdownAttributeLists(line))).trim();
    blocks.push({
      lineIndex,
      depth: /^\t*/u.exec(line)?.[0].length ?? 0,
      color: enhancedMarkdownLineColor(line),
      text: text || null,
      hasChildren: nextSemanticChildLineDepth(lines, lineIndex) > (/^\t*/u.exec(line)?.[0].length ?? 0),
    });
  });
  return blocks;
}

function collectEnhancedMarkdownListItems(lines: string[]): Array<Record<string, unknown> & { type: string; checked?: boolean | null; emptyContent: boolean }> {
  const items: Array<Record<string, unknown> & { type: string; checked?: boolean | null; emptyContent: boolean }> = [];
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const leadingTabs = /^\t*/u.exec(line)?.[0] ?? "";
    const depth = leadingTabs.length;
    const trimmed = line.slice(leadingTabs.length);
    if (isEscapedMarkdownSyntax(line, line.search(/\S/u))) return;

    const todoMatch = /^-\s+\[([ xX])\]\s*(.*)$/u.exec(trimmed);
    const bulletMatch = /^-\s+(?!\[[ xX]\])(.*)$/u.exec(trimmed);
    const numberedMatch = /^(\d+)\.\s+(.*)$/u.exec(trimmed);
    const match = todoMatch ?? bulletMatch ?? numberedMatch;
    if (!match) return;

    const type = todoMatch
      ? "to_do"
      : numberedMatch
        ? "numbered_list_item"
        : "bulleted_list_item";
    const body = todoMatch ? todoMatch[2] : numberedMatch ? numberedMatch[2] : bulletMatch?.[1] ?? "";
    const text = stripMediaUrlsFromText(stripMarkupText(stripEnhancedMarkdownAttributeLists(body))).trim();
    items.push({
      lineIndex,
      depth,
      type,
      marker: todoMatch ? `- [${todoMatch[1]}]` : numberedMatch ? `${numberedMatch[1]}.` : "-",
      number: numberedMatch ? Number(numberedMatch[1]) : null,
      checked: todoMatch ? /^[xX]$/u.test(todoMatch[1]) : null,
      color: enhancedMarkdownLineColor(line),
      text: text || null,
      emptyContent: text.length === 0,
      hasChildren: nextSemanticChildLineDepth(lines, lineIndex) > depth,
    });
  });
  return items;
}

function nextSemanticChildLineDepth(lines: string[], lineIndex: number): number {
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    return /^\t*/u.exec(line)?.[0].length ?? 0;
  }
  return -1;
}

function collectEnhancedMarkdownQuoteBlocks(lines: string[]): Array<Record<string, unknown>> {
  const quotes: Array<Record<string, unknown>> = [];
  lines.forEach((line, lineIndex) => {
    if (!unescapedLineMatch(line, /^[\t ]*>\s+/u)) return;
    const marker = /^[\t ]*>\s*/u.exec(line)?.[0] ?? "";
    const body = line.slice(marker.length);
    const rawSegments = splitEnhancedMarkdownLineBreaks(stripEnhancedMarkdownAttributeLists(body));
    const textSegments = rawSegments.map((segment) => {
      const normalized = stripMediaUrlsFromText(stripMarkupText(segment));
      return normalized.trim();
    });
    quotes.push({
      lineIndex,
      depth: /^\t*/u.exec(line)?.[0].length ?? 0,
      color: enhancedMarkdownLineColor(line),
      lineBreakCount: Math.max(0, rawSegments.length - 1),
      text: textSegments.join("\n").trim() || null,
      textSegments,
    });
  });
  return quotes;
}

function splitEnhancedMarkdownLineBreaks(value: string): string[] {
  const segments: string[] = [];
  const lineBreakPattern = /<br\s*\/?>/giu;
  let cursor = 0;
  for (const match of value.matchAll(lineBreakPattern)) {
    const index = match.index ?? -1;
    if (isEscapedMarkdownSyntax(value, index)) continue;
    segments.push(value.slice(cursor, index));
    cursor = index + match[0].length;
  }
  segments.push(value.slice(cursor));
  return segments;
}

function stripEnhancedMarkdownAttributeLists(value: string): string {
  return value.replace(/\s*\{[^\}]*\}/gu, (match, ...args: unknown[]) => {
    const offset = args.find((arg): arg is number => typeof arg === "number") ?? -1;
    return isEscapedMarkdownSyntax(value, offset) ? match : " ";
  });
}

function unescapedLineMatch(line: string, pattern: RegExp): boolean {
  const match = pattern.exec(line);
  return Boolean(match && !isEscapedMarkdownSyntax(line, line.search(/\S/u)));
}

function collectEnhancedMarkdownCodeBlocks(lines: string[]): Array<Record<string, unknown> & { language: string | null }> {
  const blocks: Array<Record<string, unknown> & { language: string | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fence = markdownFence(lines[index]);
    if (!fence) continue;
    if (isEscapedMarkdownSyntax(lines[index], lineMarkerIndex(lines[index]))) continue;
    const language = markdownFenceLanguage(lines[index]);
    const startLineIndex = index;
    let lineCount = 0;
    const contentLines: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      if (closesMarkdownFence(lines[index], fence)) break;
      lineCount += 1;
      contentLines.push(lines[index]);
    }
    blocks.push({
      language,
      lineCount,
      startLineIndex,
      endLineIndex: index < lines.length ? index : null,
      fence,
      content: stripMediaUrlsFromText(contentLines.join("\n")),
    });
  }
  return blocks;
}

function markdownFenceLanguage(line: string): string | null {
  const match = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]+)?/u.exec(line);
  return match?.[1] ?? null;
}

function collectEnhancedMarkdownEquationBlocks(lines: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^[ \t]*\$\$[ \t]*$/u.test(line)) continue;
    if (isEscapedMarkdownSyntax(line, lineMarkerIndex(line))) continue;
    const startLineIndex = index;
    const expressionLines: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      if (/^[ \t]*\$\$[ \t]*$/u.test(lines[index]) && !isEscapedMarkdownSyntax(lines[index], lineMarkerIndex(lines[index]))) break;
      expressionLines.push(lines[index]);
    }
    if (index < lines.length) {
      blocks.push({
        startLineIndex,
        endLineIndex: index,
        lineCount: expressionLines.length,
        expression: expressionLines.join("\n").trim(),
      });
    }
  }
  return blocks;
}

function lineMarkerIndex(line: string): number {
  const index = line.search(/\S/u);
  return index < 0 ? 0 : index;
}

function collectEnhancedMarkdownInlineMarkdown(markdown: string): Record<string, unknown> {
  const inlineCodeSpans = collectPatternTexts(markdown, /`([^`\n]+)`/gu, 1);
  const masked = maskUnescapedPattern(markdown, /`[^`\n]+`/gu);
  const boldTexts = collectPatternTexts(masked, /\*\*([^*\n]+)\*\*/gu, 1);
  const italicTexts = collectPatternTexts(masked, /(^|[^*])\*([^*\n]+)\*(?!\*)/gu, 2, 1);
  const strikethroughTexts = collectPatternTexts(masked, /~~([^~\n]+)~~/gu, 1);
  const inlineEquationExpressions = collectPatternTexts(masked, /(^|[^\$])\$([^\$\n]+)\$(?!\$)/gu, 2, 1);
  const links: Array<Record<string, unknown>> = [];
  const linkPattern = /(^|[^!])\[([^\]\n]+)\]\(([^\)\n]+)\)/gu;
  for (const match of masked.matchAll(linkPattern)) {
    const markerIndex = (match.index ?? -1) + match[1].length;
    if (isEscapedMarkdownSyntax(masked, markerIndex)) continue;
    links.push({
      lineIndex: lineIndexAtOffset(masked, markerIndex),
      depth: tagDepthAtOffset(masked, markerIndex),
      text: stripMarkupText(match[2] ?? "").trim() || null,
      hasUrl: Boolean((match[3] ?? "").trim()),
      urlRedacted: Boolean((match[3] ?? "").trim()),
    });
  }

  return {
    boldCount: boldTexts.length,
    boldTexts,
    italicCount: italicTexts.length,
    italicTexts,
    strikethroughCount: strikethroughTexts.length,
    strikethroughTexts,
    inlineCodeCount: inlineCodeSpans.length,
    inlineCodeSpans,
    inlineEquationCount: inlineEquationExpressions.length,
    inlineEquationExpressions,
    linkCount: links.length,
    links,
  };
}

function maskUnescapedPattern(markdown: string, pattern: RegExp): string {
  return markdown.replace(pattern, (match, ...args: unknown[]) => {
    const offset = args.find((arg): arg is number => typeof arg === "number") ?? -1;
    return isEscapedMarkdownSyntax(markdown, offset) ? match : " ".repeat(match.length);
  });
}

function collectPatternTexts(markdown: string, pattern: RegExp, groupIndex: number, markerPrefixGroupIndex?: number): string[] {
  const values: string[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const markerIndex = (match.index ?? -1) + (markerPrefixGroupIndex ? match[markerPrefixGroupIndex].length : 0);
    if (isEscapedMarkdownSyntax(markdown, markerIndex)) continue;
    const value = match[groupIndex]?.trim();
    if (value) values.push(value);
  }
  return values;
}

function collectEnhancedMarkdownMediaMarkdownBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const imagePattern = /^[ \t]*!\[([^\]\n]*)\]\(([^\)\n]+)\)([ \t]*\{[^\n]*\})?[ \t]*$/gmu;
  for (const match of markdown.matchAll(imagePattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const url = (match[2] ?? "").trim();
    const attributes = parseEnhancedMarkdownAttributes(match[3] ?? "");
    blocks.push({
      type: "image",
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      caption: (match[1] ?? "").trim() || null,
      hasSource: Boolean(url),
      sourceUrlRedacted: Boolean(url),
      color: attributes.color ?? null,
    });
  }
  const tagPattern = new RegExp(`<(${MEDIA_MARKDOWN_TAG})\\b([^>]*)(?:/>|>([\\s\\S]*?)</\\1>)`, "giu");
  for (const match of markdown.matchAll(tagPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const attributes = parseEnhancedMarkdownAttributes(match[2] ?? "");
    const hasSource = Boolean(attributes.src);
    blocks.push({
      type: match[1],
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      caption: stripMediaUrlsFromText(stripMarkupText(match[3] ?? "")).trim() || null,
      hasSource,
      sourceUrlRedacted: hasSource,
      color: attributes.color ?? null,
    });
  }
  const markerPattern = new RegExp(`<${REDACTED_MEDIA_MARKDOWN_TAG}\\b([^>]*)\\/>`, "giu");
  for (const match of markdown.matchAll(markerPattern)) {
    const attributes = parseEnhancedMarkdownAttributes(match[1] ?? "");
    const hasSource = booleanString(attributes["has-source"]) ?? true;
    blocks.push({
      type: attributes.type ?? "unknown",
      lineIndex: lineIndexAtOffset(markdown, match.index ?? 0),
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      caption: attributes.caption ?? null,
      hasSource,
      sourceUrlRedacted: hasSource,
      color: attributes.color ?? null,
    });
  }
  return blocks.sort((left, right) => (numberValue(left.lineIndex) ?? 0) - (numberValue(right.lineIndex) ?? 0));
}

function collectEnhancedMarkdownDetailToggles(tags: EnhancedMarkdownTag[]): Array<Record<string, unknown>> {
  return tags
    .filter((tag) => tag.name === "details")
    .map((tag) => {
      const body = tag.rawText ?? "";
      const summaryMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/iu.exec(body);
      const summary = summaryMatch?.[1] ?? "";
      const summaryLineIndex = summaryMatch?.index === undefined
        ? null
        : tag.lineIndex + lineIndexAtOffset(body, summaryMatch.index) + 1;
      const childText = body.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/iu, "");
      return {
        lineIndex: tag.lineIndex,
        depth: tag.depth,
        summaryLineIndex,
        title: stripMarkupText(summary).trim() || null,
        color: tag.attributes.color ?? null,
        childLineCount: childText.split("\n").filter((line) => line.trim()).length,
        childOutline: enhancedMarkdownContainerChildOutline(childText, tag.bodyStartLineIndex ?? tag.lineIndex),
      };
    });
}

function collectEnhancedMarkdownCallouts(tags: EnhancedMarkdownTag[]): Array<Record<string, unknown>> {
  return tags
    .filter((tag) => tag.name === "callout")
    .map((tag) => {
      const body = tag.rawText ?? "";
      return {
        lineIndex: tag.lineIndex,
        depth: tag.depth,
        icon: tag.attributes.icon ?? null,
        color: tag.attributes.color ?? null,
        text: stripMediaUrlsFromText(stripMarkupText(body)).trim() || null,
        childLineCount: body.split("\n").filter((line) => line.trim()).length,
        childOutline: enhancedMarkdownContainerChildOutline(body, tag.bodyStartLineIndex ?? tag.lineIndex),
      };
    });
}

function collectEnhancedMarkdownColumnLists(tags: EnhancedMarkdownTag[]): Array<Record<string, unknown>> {
  return tags
    .filter((tag) => tag.name === "columns")
    .map((tag) => {
      const body = tag.rawText ?? "";
      const columns = collectEnhancedMarkdownColumns(body, tag.lineIndex);
      return {
        lineIndex: tag.lineIndex,
        depth: tag.depth,
        columnCount: columns.length,
        childLineCount: body.split("\n").filter((line) => line.trim()).length,
        columns,
        childOutline: enhancedMarkdownContainerChildOutline(body, tag.bodyStartLineIndex ?? tag.lineIndex),
      };
    });
}

function collectEnhancedMarkdownColumns(markdown: string, parentLineIndex: number): Array<Record<string, unknown>> {
  const columns: Array<Record<string, unknown>> = [];
  const columnPattern = /<column\b([^>]*)>([\s\S]*?)<\/column>/giu;
  for (const match of markdown.matchAll(columnPattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const columnBody = match[2] ?? "";
    const relativeLineIndex = lineIndexAtOffset(markdown, match.index ?? 0);
    columns.push({
      index: columns.length,
      lineIndex: parentLineIndex + relativeLineIndex + 1,
      depth: tagDepthAtOffset(markdown, match.index ?? 0),
      text: stripMediaUrlsFromText(stripMarkupText(columnBody)).trim() || null,
      childLineCount: columnBody.split("\n").filter((line) => line.trim()).length,
      childOutline: enhancedMarkdownContainerChildOutline(columnBody, parentLineIndex + relativeLineIndex + 1),
    });
  }
  return columns;
}

function enhancedMarkdownContainerChildOutline(markdown: string, sourceLineIndexOffset = 0): Record<string, unknown> {
  const entries = normalizeEnhancedMarkdownChildLineEntries(markdown, sourceLineIndexOffset);
  const lines = entries.map((entry) => entry.line);
  const protectedLines = protectedMarkdownLineIndexes(lines);
  const semanticLines = maskMarkdownLines(lines, protectedLines);
  const indentation = collectEnhancedMarkdownIndentationFacts(
    semanticLines,
    entries.map((entry) => entry.sourceLineIndex),
  );
  const indentationBlocks = arrayValue(indentation.blocks);
  return {
    lineCount: lines.length,
    text: stripMediaUrlsFromText(stripMarkupText(lines.join("\n"))).trim() || null,
    blockTypes: countBy(semanticLines.filter((line) => line.trim()).map(enhancedMarkdownLineBlockType)),
    indentation: {
      ...indentation,
      blocks: indentationBlocks.map((block, index) => ({
        ...recordValue(block),
      })),
    },
  };
}

function normalizeEnhancedMarkdownChildLines(markdown: string): string[] {
  return normalizeEnhancedMarkdownChildLineEntries(markdown).map((entry) => entry.line);
}

function normalizeEnhancedMarkdownChildLineEntries(
  markdown: string,
  sourceLineIndexOffset = 0,
): Array<{ line: string; sourceLineIndex: number }> {
  const lines = markdown.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return [];
  const minTabDepth = lines.reduce((min, line) => {
    const depth = /^\t*/u.exec(line)?.[0].length ?? 0;
    return Math.min(min, depth);
  }, Number.POSITIVE_INFINITY);
  const tabsToTrim = Number.isFinite(minTabDepth) ? minTabDepth : 0;
  return markdown
    .split("\n")
    .map((line, lineIndex) => ({ line, sourceLineIndex: sourceLineIndexOffset + lineIndex }))
    .filter((entry) => entry.line.trim())
    .map((entry) => ({
      sourceLineIndex: entry.sourceLineIndex,
      line: entry.line.startsWith("\t".repeat(tabsToTrim)) ? entry.line.slice(tabsToTrim) : entry.line,
    }));
}

function collectEnhancedMarkdownSyncedBlocks(tags: EnhancedMarkdownTag[]): Array<Record<string, unknown>> {
  return tags
    .filter((tag) => tag.name === "synced_block" || tag.name === "synced_block_reference")
    .map((tag) => ({
      type: tag.name,
      lineIndex: tag.lineIndex,
      depth: tag.depth,
      hasUrl: Boolean(tag.attributes.url),
      urlRedacted: Boolean(tag.attributes.url),
      hasSource: Boolean(tag.attributes.url),
      sourceUrlRedacted: Boolean(tag.attributes.url),
      text: tag.text,
      childLineCount: tag.rawText?.split("\n").filter((line) => line.trim()).length ?? 0,
      childOutline: enhancedMarkdownContainerChildOutline(tag.rawText ?? "", tag.bodyStartLineIndex ?? tag.lineIndex),
    }));
}

function collectEnhancedMarkdownTableOfContents(
  tags: EnhancedMarkdownTag[],
  headingFacts: Array<Record<string, unknown> & { title: string | null; type: string }>,
): Array<Record<string, unknown>> {
  const headingOutline = headingFacts.map((heading) => ({
    lineIndex: heading.lineIndex ?? null,
    depth: heading.depth ?? null,
    title: heading.title,
    type: heading.type,
    sourceLevel: heading.sourceLevel ?? null,
    effectiveLevel: heading.effectiveLevel ?? null,
    color: heading.color ?? null,
    toggle: heading.toggle ?? false,
  }));
  return tags
    .filter((tag) => tag.name === "table_of_contents")
    .map((tag) => ({
      lineIndex: tag.lineIndex,
      depth: tag.depth,
      color: tag.attributes.color ?? null,
      headingCount: headingOutline.length,
      headingTitles: headingOutline.map((heading) => heading.title).filter((title): title is string => Boolean(title)),
      headingTypes: countBy(headingOutline.map((heading) => heading.type)),
      headingOutline,
    }));
}

function collectEnhancedMarkdownReferenceTags(tags: EnhancedMarkdownTag[], tagName: "page" | "database"): Array<Record<string, unknown>> {
  return tags
    .filter((tag) => tag.name === tagName)
    .map((tag) => ({
      kind: tagName,
      lineIndex: tag.lineIndex,
      depth: tag.depth,
      title: tag.text,
      hasUrl: Boolean(tag.attributes.url),
      urlRedacted: Boolean(tag.attributes.url),
      hasSource: Boolean(tag.attributes.url),
      sourceUrlRedacted: Boolean(tag.attributes.url),
      color: tag.attributes.color ?? null,
      inline: tagName === "database" ? booleanString(tag.attributes.inline) : null,
      icon: tagName === "database" ? tag.attributes.icon ?? null : null,
    }));
}

function collectEnhancedMarkdownTableAttributes(markdown: string): Array<Record<string, unknown>> {
  const tables: Array<Record<string, unknown>> = [];
  const tablePattern = /<table\b([^>]*)>([\s\S]*?)<\/table>/giu;
  for (const match of markdown.matchAll(tablePattern)) {
    if (isEscapedMarkdownSyntax(markdown, match.index ?? -1)) continue;
    const attributes = parseEnhancedMarkdownAttributes(match[1] ?? "");
    const body = match[2] ?? "";
    const tableRaw = match[0] ?? "";
    const tableOffset = match.index ?? 0;
    const bodyOffset = tableOffset + Math.max(0, tableRaw.indexOf(body));
    const columnColors = [...body.matchAll(/<col\b([^>]*)>/giu)]
      .map((colMatch) => parseEnhancedMarkdownAttributes(colMatch[1] ?? "").color ?? null);
    const rows: Array<Record<string, unknown>> = [];
    const rowPattern = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/giu;
    for (const rowMatch of body.matchAll(rowPattern)) {
      if (isEscapedMarkdownSyntax(body, rowMatch.index ?? -1)) continue;
      const rowAttributes = parseEnhancedMarkdownAttributes(rowMatch[1] ?? "");
      const rowColor = rowAttributes.color ?? null;
      const rowOffset = bodyOffset + (rowMatch.index ?? 0);
      const rowRaw = rowMatch[0] ?? "";
      const rowBody = rowMatch[2] ?? "";
      const rowBodyOffset = rowOffset + Math.max(0, rowRaw.indexOf(rowBody));
      const cells: Array<Record<string, unknown>> = [];
      const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/giu;
      for (const cellMatch of rowBody.matchAll(cellPattern)) {
        const cellAttributes = parseEnhancedMarkdownAttributes(cellMatch[1] ?? "");
        const columnColor = columnColors[cells.length] ?? null;
        const cellColor = cellAttributes.color ?? null;
        const cellOffset = rowBodyOffset + (cellMatch.index ?? 0);
        cells.push({
          index: cells.length,
          lineIndex: lineIndexAtOffset(markdown, cellOffset),
          depth: tagDepthAtOffset(markdown, cellOffset),
          text: stripMarkupText(cellMatch[2] ?? "") || null,
          color: cellColor,
          effectiveColor: cellColor ?? rowColor ?? columnColor,
          columnColor,
        });
      }
      rows.push({
        index: rows.length,
        lineIndex: lineIndexAtOffset(markdown, rowOffset),
        depth: tagDepthAtOffset(markdown, rowOffset),
        color: rowColor,
        cellCount: cells.length,
        cells,
      });
    }
    const rowCount = rows.length;
    const cellCount = rows.reduce((sum, row) => sum + (numberValue(row.cellCount) ?? 0), 0);
    const headerRow = booleanString(attributes["header-row"]);
    const headerColumn = booleanString(attributes["header-column"]);
    const columnCount = Math.max(
      columnColors.length,
      rowCount > 0 ? Math.max(...rows.map((row) => numberValue(row.cellCount) ?? 0)) : 0,
    );
    const normalizedRows = rows.map((row) => enhancedMarkdownTableRowFact(row, columnCount, headerRow === true, headerColumn === true));
    tables.push({
      lineIndex: lineIndexAtOffset(markdown, tableOffset),
      depth: tagDepthAtOffset(markdown, tableOffset),
      fitPageWidth: booleanString(attributes["fit-page-width"]),
      headerRow,
      headerColumn,
      hasColumnHeader: headerRow,
      hasRowHeader: headerColumn,
      tableWidth: columnCount,
      columnCount,
      rowCount,
      cellCount,
      coloredColumnCount: columnColors.filter(Boolean).length,
      coloredRowCount: rows.filter((row) => typeof row.color === "string").length,
      coloredCellCount: rows.reduce(
        (sum, row) => sum + arrayValue(row.cells).filter((cell) => typeof recordValue(cell).color === "string").length,
        0,
      ),
      columnColors,
      rowHeaderValues: headerColumn === true
        ? normalizedRows
          .slice(headerRow === true ? 1 : 0)
          .map((row) => {
            const firstCell = arrayValue(row.cells)[0];
            return stringValue(recordValue(firstCell).text) ?? "";
          })
          .filter((value) => value.trim().length > 0)
        : [],
      rows: normalizedRows,
    });
  }
  return tables;
}

function enhancedMarkdownTableRowFact(
  row: Record<string, unknown>,
  columnCount: number,
  hasColumnHeader: boolean,
  hasRowHeader: boolean,
): Record<string, unknown> {
  const rowIndex = numberValue(row.index) ?? 0;
  const rawCells = arrayValue(row.cells).map(recordValue);
  const rawCellCount = rawCells.length;
  const cellCount = Math.max(rawCellCount, columnCount);
  const isColumnHeader = hasColumnHeader && rowIndex === 0;
  return {
    ...row,
    rowIndex,
    isColumnHeader,
    rawCellCount,
    cellCount,
    cells: Array.from({ length: cellCount }, (_, columnIndex) => {
      const rawCell = rawCells[columnIndex] ?? {};
      const text = stringValue(rawCell.text) ?? "";
      return {
        ...rawCell,
        index: columnIndex,
        columnIndex,
        text,
        plainText: text,
        isColumnHeader,
        isRowHeader: hasRowHeader && !isColumnHeader && columnIndex === 0,
      };
    }),
  };
}

function parseEnhancedMarkdownAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([:\w-]+)=["']([^"']*)["']/gu;
  for (const match of value.matchAll(attributePattern)) attributes[match[1]] = match[2];
  return attributes;
}

function stripMarkupText(value: string): string {
  return value.replace(/<[^>]+>/gu, " ").replace(/\s+/g, " ").trim();
}

function booleanString(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function richTextMarkdown(value: unknown[]): string {
  return stripMediaUrlsFromText(value.map((item) => {
    const record = recordValue(item);
    const text = stringValue(record.plain_text)
      ?? stringValue(record.text && recordValue(record.text).content)
      ?? stringValue(record.equation && recordValue(record.equation).expression)
      ?? "";
    if (!text) return "";

    const equation = recordValue(record.equation);
    const equationExpression = stringValue(equation.expression);
    if (equationExpression) return `$${equationExpression}$`;

    const annotations = recordValue(record.annotations);
    let rendered = text;
    if (annotations.code === true) {
      rendered = `\`${rendered.replace(/`/g, "\\`")}\``;
    } else {
      if (annotations.bold === true) rendered = `**${rendered}**`;
      if (annotations.italic === true) rendered = `_${rendered}_`;
      if (annotations.strikethrough === true) rendered = `~~${rendered}~~`;
      if (annotations.underline === true) rendered = `<u>${rendered}</u>`;
    }

    const href = stringValue(record.href) ?? stringValue(record.text && recordValue(record.text).link && recordValue(recordValue(record.text).link).url);
    if (href && !isMediaUrl(href)) {
      return `[${escapeMarkdownLinkLabel(rendered)}](${escapeMarkdownLinkUrl(href)})`;
    }
    return rendered;
  }).join(""));
}

function richTextPlain(value: unknown[]): string {
  return stripMediaUrlsFromText(value.map((item) => {
    const record = recordValue(item);
    return stringValue(record.plain_text)
      ?? stringValue(record.text && recordValue(record.text).content)
      ?? stringValue(record.equation && recordValue(record.equation).expression)
      ?? "";
  }).join(""));
}

function richTextReferencesFromBlock(value: Record<string, unknown>): NotionReference[] {
  const textGroups = [
    arrayValue(value.rich_text),
    arrayValue(value.title),
    arrayValue(value.caption),
    ...arrayValue(value.cells).map((cell) => arrayValue(cell)),
  ];
  return textGroups.flatMap(richTextMentionReferences);
}

export function richTextMentionReferences(items: unknown[]): NotionReference[] {
  const refs: NotionReference[] = [];
  for (const item of items) {
    const record = recordValue(item);
    const mention = recordValue(record.mention);
    if (!stringValue(mention.type)) continue;
    const summary = richTextMentionSummary(mention, record);
    refs.push({
      kind: "mention",
      mentionType: summary.type,
      targetObjectType: summary.targetObjectType,
      targetPartial: summary.targetPartial,
      targetId: summary.targetId,
      title: summary.title ?? summary.type,
      url: summary.url ?? summary.linkPreview?.url ?? summary.linkMention?.href ?? null,
      date: summary.date,
      linkPreview: summary.linkPreview,
      linkMention: summary.linkMention,
      templateMention: summary.templateMention,
      customEmoji: summary.customEmoji,
    });
  }
  return refs;
}

function objectTypeForMention(type: string): string | null {
  if (type === "user") return "user";
  if (type === "page") return "page";
  if (type === "database") return "database";
  if (type === "custom_emoji") return "custom_emoji";
  return null;
}

function partialMentionTarget(
  type: string,
  payload: Record<string, unknown>,
  richText: Record<string, unknown>,
): boolean {
  if (type === "user") return partialUserObject(payload);
  if (type === "page" || type === "database") return partialPageOrDatabaseMention(payload, richText);
  return false;
}

function partialUserObject(user: Record<string, unknown>): boolean {
  return stringValue(user.object) === "user"
    && !stringValue(user.type)
    && !stringValue(user.name)
    && !recordHasKeys(user.person)
    && !recordHasKeys(user.bot);
}

function partialPageOrDatabaseMention(
  payload: Record<string, unknown>,
  richText: Record<string, unknown>,
): boolean {
  return Boolean(stringValue(payload.id))
    && Object.keys(payload).every((key) => key === "id")
    && stringValue(richText.plain_text) === "Untitled";
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/\)/g, "%29");
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function truncateFactText(value: string | null | undefined, maxLength = 500): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileUrl(value: Record<string, unknown>): string | null {
  const file = recordValue(value.file);
  const external = recordValue(value.external);
  return stringValue(file.url) ?? stringValue(external.url);
}

function blockIconSummary(value: unknown): NotionBlockIconSummary | null {
  const icon = recordValue(value);
  if (Object.keys(icon).length === 0) return null;
  const type = stringValue(icon.type) ?? mediaPayloadType(icon);
  const payload = type ? recordValue(icon[type]) : {};
  const fileUpload = recordValue(icon.file_upload);
  const file = recordValue(icon.file);
  const url = stringValue(payload.url);
  const customEmojiUrlRedacted = Boolean(type === "custom_emoji" && url && isNotionPrivateMediaUrl(url));
  const lifecycle = fileUploadLifecycleSummary(fileUpload, payload, type);
  return {
    type,
    fileObject: mediaFileObjectType(type)
      ? propertyFileObjectSummary(icon, type, payload, fileUpload, file, url, lifecycle)
      : null,
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

function pageCoverSummary(value: unknown): Record<string, unknown> | null {
  const cover = recordValue(value);
  if (Object.keys(cover).length === 0) return null;
  const type = stringValue(cover.type) ?? mediaPayloadType(cover);
  const payload = type ? recordValue(cover[type]) : {};
  const fileUpload = recordValue(cover.file_upload);
  const file = recordValue(cover.file);
  const url = stringValue(payload.url);
  const lifecycle = fileUploadLifecycleSummary(fileUpload, payload, type);
  return {
    type,
    fileObject: mediaFileObjectType(type)
      ? propertyFileObjectSummary(cover, type, payload, fileUpload, file, url, lifecycle)
      : null,
    fileUploadId: type === "file_upload" ? stringValue(payload.id) : null,
    fileUploadFilename: type === "file_upload" ? stringValue(payload.filename) : null,
    fileUploadContentType: type === "file_upload" ? stringValue(payload.content_type) : null,
    fileUploadContentLength: type === "file_upload" ? numberValue(payload.content_length) ?? null : null,
    fileUploadStatus: type === "file_upload" ? stringValue(payload.status) : null,
    ...lifecycle,
    expiryTime: stringValue(payload.expiry_time),
    url: url && !isMediaUrl(url) ? url : null,
    urlRedacted: Boolean(url && isMediaUrl(url)),
  };
}

function mediaFileObjectType(type: string | null): boolean {
  return type === "file" || type === "external" || type === "file_upload";
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
    fileUploadInTrash: booleanValue(upload.in_trash) ?? null,
    fileUploadArchived: booleanValue(upload.archived) ?? null,
    fileUploadCreatedBy: recordHasKeys(createdBy)
      ? { id: stringValue(createdBy.id), type: stringValue(createdBy.type) }
      : null,
    fileUploadNumberOfParts: recordHasKeys(parts)
      ? { total: numberValue(parts.total) ?? null, sent: numberValue(parts.sent) ?? null }
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
            statusCode: numberValue(error.status_code) ?? null,
          }
          : null,
      }
      : null,
    fileUploadUploadUrlRedacted: Boolean(stringValue(upload.upload_url)),
    fileUploadCompleteUrlRedacted: Boolean(stringValue(upload.complete_url)),
  };
}

function mediaPayloadType(value: Record<string, unknown>): string | null {
  if (recordHasKeys(value.file_upload)) return "file_upload";
  if (recordHasKeys(value.external)) return "external";
  if (recordHasKeys(value.file)) return "file";
  return null;
}

function databaseIdFromParent(parent: NotionParent | undefined): string | null {
  return parent?.type === "database_id" || parent?.type === "data_source_id" ? parent.database_id ?? null : null;
}

function blockParentId(parent: unknown): string | null {
  const value = recordValue(parent);
  return stringValue(value.page_id)
    ?? stringValue(value.block_id)
    ?? stringValue(value.data_source_id)
    ?? stringValue(value.database_id)
    ?? stringValue(value.agent_id);
}

function notionBlockDeletedState(block: NotionBlock | Record<string, unknown>): boolean {
  return notionBlockInTrashState(block) || notionBlockArchivedState(block);
}

function notionBlockInTrashState(block: NotionBlock | Record<string, unknown>): boolean {
  return (block as { in_trash?: unknown }).in_trash === true;
}

function notionBlockArchivedState(block: NotionBlock | Record<string, unknown>): boolean {
  return (block as { archived?: unknown }).archived === true;
}

function unsupportedBlockType(block: NotionBlock): string | null {
  return stringValue(recordValue(block.unsupported).block_type);
}

function mediaBlockHasPayload(block: NotionBlockNode): boolean {
  const value = recordValue(recordValue(block.rawBlock)[block.type]);
  return Boolean(
    block.url
      || stringValue(value.type)
      || stringValue(value.name)
      || recordHasKeys(value.file_upload)
      || recordHasKeys(value.file)
      || recordHasKeys(value.external),
  );
}

function knownBlockType(type: string): boolean {
  return (NOTION_KNOWN_BLOCK_TYPES as readonly string[]).includes(type);
}

function mediaBlockType(type: string): boolean {
  return (NOTION_MEDIA_BLOCK_TYPES as readonly string[]).includes(type);
}

function warningsForBlocks(blocks: NotionBlockNode[], warnings: NotionSourceWarning[]): NotionSourceWarning[] {
  const ids = new Set(flattenBlocks(blocks).map((block) => block.id));
  return warnings.filter((warning) => !warning.blockId || ids.has(warning.blockId));
}

function flattenBlocks(blocks: NotionBlockNode[]): NotionBlockNode[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(block.children)]);
}

function collectBlockReferences(blocks: NotionBlockNode[]): NotionReference[] {
  return flattenBlocks(blocks).flatMap((block) => [
    ...block.references,
    ...(block.inlineDataSources ?? []).flatMap((source) =>
      source.rows.flatMap((row) => [
        ...(row.bodyPagePath
          ? [{
            kind: "database_row_page" as const,
            blockId: block.id,
            targetId: row.pageId,
            title: row.title,
            url: row.url,
          }]
          : []),
        ...collectBlockReferences(row.bodyBlocks),
        ...collectCommentReferences(row.comments),
      ])),
    ...(block.childPage ? collectBlockReferences(block.childPage.bodyBlocks) : []),
    ...collectCommentReferences(block.comments),
  ]);
}

function collectCommentReferences(comments: NotionCommentSummary[]): NotionReference[] {
  return comments.flatMap((comment) => comment.references ?? []);
}

function collectChildPagePropertyReferences(childPage: NotionChildPage): NotionReference[] {
  return [
    ...propertyValueReferences(childPage.propertyValues, { pageId: childPage.pageId }),
    ...childPage.childPages.flatMap(collectChildPagePropertyReferences),
  ];
}

export function propertyValueReferences(
  values: NotionPropertyValueSummary[],
  source: { pageId: string },
): NotionReference[] {
  return values.flatMap((value) => propertySummaryReferences(value, source));
}

function propertySummaryReferences(
  value: NotionPropertyValueSummary,
  source: { pageId: string },
): NotionReference[] {
  const context = {
    pageId: source.pageId,
    propertyId: value.id,
    propertyName: value.name,
  };
  const references: NotionReference[] = [];

  for (const relationId of value.relationIds ?? []) {
    references.push({
      kind: "property_relation",
      ...context,
      targetObjectType: "page",
      targetId: relationId,
      title: value.display || null,
    });
  }

  for (const person of value.people ?? []) {
    references.push(propertyUserReference(person, context));
  }
  if (value.createdBy) references.push(propertyUserReference(value.createdBy, context));
  if (value.lastEditedBy) references.push(propertyUserReference(value.lastEditedBy, context));

  for (const mention of value.mentions ?? []) {
    references.push(propertyMentionReference(mention, context));
  }

  references.push(...typedPayloadReferences(value.rollup?.value, context));
  references.push(...typedPayloadReferences(value.formula?.value, context));
  return references;
}

function propertyUserReference(
  person: NotionUserSummary,
  context: { pageId: string; propertyId: string | null; propertyName: string },
): NotionReference {
  return {
    kind: "property_user",
    ...context,
    targetObjectType: person.objectType ?? "user",
    targetPartial: person.partial,
    targetId: person.id,
    title: person.name ?? person.email ?? person.id,
  };
}

function typedPayloadReferences(
  value: unknown,
  context: { pageId: string; propertyId: string | null; propertyName: string },
): NotionReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => typedPayloadReferences(item, context));
  }
  const record = recordValue(value);
  if (Object.keys(record).length === 0) return [];

  const type = stringValue(record.type);
  if (type) {
    if (type === "relation") {
      return arrayValue(record.value).map((targetId) => stringValue(targetId)).filter((id): id is string => Boolean(id)).map((targetId) => ({
        kind: "property_relation" as const,
        ...context,
        targetObjectType: "page",
        targetId,
        title: stringValue(record.display),
      }));
    }
    if (type === "people" || type === "created_by" || type === "last_edited_by") {
      const users = Array.isArray(record.value) ? arrayValue(record.value) : [record.value];
      return users.map((user) => propertyUserReference(userSummaryFromUnknown(user), context));
    }
    if (type === "title" || type === "rich_text") {
      return richTextMentionPayloadReferences(record.value, context);
    }
    if (NON_REFERENCE_PROPERTY_ITEM_TYPES.has(type)) return [];
    return typedPayloadReferences(record.value, context);
  }

  if (record.id || record.name || record.email || record.objectType) {
    const person = userSummaryFromUnknown(record);
    if (person.id || person.name || person.email) return [propertyUserReference(person, context)];
  }
  return Object.values(record).flatMap((item) => typedPayloadReferences(item, context));
}

const NON_REFERENCE_PROPERTY_ITEM_TYPES = new Set([
  "checkbox",
  "date",
  "email",
  "files",
  "multi_select",
  "number",
  "phone_number",
  "place",
  "select",
  "status",
  "unique_id",
  "url",
  "verification",
]);

function propertyMentionReference(
  mention: NotionRichTextMentionSummary,
  context: { pageId: string; propertyId: string | null; propertyName: string },
): NotionReference {
  return {
    kind: "mention",
    ...context,
    mentionType: mention.type,
    targetObjectType: mention.targetObjectType,
    targetPartial: mention.targetPartial,
    targetId: mention.targetId,
    title: mention.title,
    url: mention.url,
    date: mention.date,
    linkPreview: mention.linkPreview,
    linkMention: mention.linkMention,
    templateMention: mention.templateMention,
    customEmoji: mention.customEmoji,
  };
}

function richTextMentionPayloadReferences(
  value: unknown,
  context: { pageId: string; propertyId: string | null; propertyName: string },
): NotionReference[] {
  const payload = recordValue(value);
  const mentions = Array.isArray(value)
    ? richTextMentionSummaries(summarizeNotionRichText(value))
    : arrayValue(payload.mentions) as NotionRichTextMentionSummary[];
  return mentions.map((mention) => propertyMentionReference(mention, context));
}

function userSummaryFromUnknown(value: unknown): NotionUserSummary {
  const record = recordValue(value);
  if (record.objectType || record.email || record.partial !== undefined) {
    return {
      id: stringValue(record.id),
      objectType: stringValue(record.objectType),
      type: stringValue(record.type),
      name: stringValue(record.name),
      email: stringValue(record.email),
      emailVerified: booleanValue(record.emailVerified) ?? null,
      avatarUrlRedacted: record.avatarUrlRedacted === true,
      bot: recordHasKeys(record.bot) ? record.bot as NotionUserSummary["bot"] : null,
      partial: record.partial === true,
    };
  }
  return personSummary(value);
}

function dedupeReferences(references: NotionReference[]): NotionReference[] {
  const seen = new Set<string>();
  const deduped: NotionReference[] = [];
  for (const reference of references) {
    const key = JSON.stringify([
      reference.kind,
      reference.pageId ?? null,
      reference.blockId ?? null,
      reference.commentId ?? null,
      reference.propertyId ?? null,
      reference.propertyName ?? null,
      reference.mentionType ?? null,
      reference.targetObjectType ?? null,
      reference.targetPartial ?? null,
      reference.targetId ?? null,
      reference.title ?? null,
      reference.url ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function indentMarkdown(markdown: string): string {
  return markdown.split("\n").map((line) => line ? `  ${line}` : line).join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function blockFingerprint(block: NotionBlockNode): unknown {
  return {
    id: block.id,
    type: block.type,
    text: block.text,
    caption: block.caption,
    richText: block.richText,
    captionRichText: block.captionRichText,
    titleRichText: block.titleRichText,
    media: mediaBlockType(block.type) ? mediaBlockSummary(block) : null,
    icon: block.icon,
    meetingNotes: block.meetingNotes,
    childPage: block.childPage
      ? {
        pageId: block.childPage.pageId,
        title: block.childPage.title,
        relativePath: block.childPage.relativePath,
        bodyMarkdown: block.childPage.bodyMarkdown,
      }
      : null,
    checked: block.checked,
    color: block.color,
    isToggleable: block.isToggleable,
    listStartIndex: block.listStartIndex,
    listFormat: block.listFormat,
    widthRatio: block.widthRatio,
    tableWidth: block.tableWidth,
    hasColumnHeader: block.hasColumnHeader,
    hasRowHeader: block.hasRowHeader,
    url: block.url,
    language: block.language,
    tableCells: block.tableCells,
    tableCellRichText: block.tableCellRichText,
    references: block.references.map((reference) => ({
      kind: reference.kind,
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
    warnings: block.warnings.map((warning) => ({
      code: warning.code,
      type: warning.type ?? null,
      blockId: warning.blockId ?? null,
    })),
    comments: block.comments,
    inlineDataSources: block.inlineDataSources?.map(inlineDataSourceFingerprint),
    children: block.children.map(blockFingerprint),
  };
}

function inlineDataSourceFingerprint(source: NotionInlineDataSource): unknown {
  return {
    dataSourceId: source.dataSourceId,
    title: source.title,
    columns: source.columns,
    view: source.view
      ? {
        viewId: source.view.viewId,
        name: source.view.name,
        viewType: source.view.viewType,
        columns: source.view.columns,
        filter: source.view.filter,
        sorts: source.view.sorts,
        quickFilters: source.view.quickFilters,
        configurationSummary: source.view.configurationSummary,
        resultPageIds: source.view.resultPageIds,
        renderedResultPageIds: source.view.renderedResultPageIds,
        missingResultPageIds: source.view.missingResultPageIds,
        rowGroups: source.view.rowGroups,
        complete: source.view.complete,
      }
      : null,
    rows: source.rows.map((row) => ({
      pageId: row.pageId,
      title: row.title,
      values: row.values,
      bodyPagePath: row.bodyPagePath,
      body: row.bodyMarkdown,
      breadcrumbTrail: row.breadcrumbTrail,
      comments: row.comments,
    })),
    nestedDataSources: source.nestedDataSources.map((nested) => ({
      dataSourceId: nested.dataSourceId,
      title: nested.title,
      materializedDataSource: nested.materializedDataSource
        ? inlineDataSourceFingerprint(nested.materializedDataSource)
        : null,
    })),
  };
}

function childPageFingerprint(childPage: NotionChildPage): unknown {
  return {
    pageId: childPage.pageId,
    title: childPage.title,
    properties: propertyFingerprint(childPage.title, childPage.properties),
    bodyMarkdown: childPage.bodyMarkdown,
    breadcrumbTrail: childPage.breadcrumbTrail,
    comments: childPage.comments,
    childPages: childPage.childPages.map(childPageFingerprint),
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hashContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return shortHash(normalized, 16);
}

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function structuredIngestionEnabled(): boolean {
  return process.env.NOTION_STRUCTURED_INGESTION_ENABLED !== "false";
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
