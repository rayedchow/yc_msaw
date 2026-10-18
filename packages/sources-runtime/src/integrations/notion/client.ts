import { mapWithConcurrency } from "../../lib/concurrency.js";

export const NOTION_PROVIDER = "notion";
export const NOTION_VERSION = "2026-03-11";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_TOKEN_URL = `${NOTION_API}/oauth/token`;
const MAX_RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const NOTION_VIEW_DETAIL_CONCURRENCY = 5;

type StoredNotionToken = {
  token: string;
  refreshToken: string | null;
  metadata: Record<string, unknown> | null;
};

let notionAccessTokenOverride: string | null = null;

export interface NotionRichText {
  type: string;
  plain_text?: string;
  text?: { content?: string; link?: { url?: string } | null };
  mention?: Record<string, unknown>;
  equation?: { expression?: string };
  annotations?: Record<string, unknown>;
  href?: string | null;
  [key: string]: unknown;
}

export interface NotionComment {
  object: "comment";
  id: string;
  parent?: NotionParent;
  discussion_id?: string;
  created_time?: string;
  last_edited_time?: string;
  created_by?: Record<string, unknown>;
  rich_text?: NotionRichText[];
  display_name?: Record<string, unknown>;
  attachments?: Array<Record<string, unknown>>;
}

export interface NotionParent {
  type?: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  workspace?: boolean;
  block_id?: string;
  agent_id?: string;
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time?: string;
  created_by?: Record<string, unknown>;
  last_edited_time?: string;
  last_edited_by?: Record<string, unknown>;
  in_trash?: boolean;
  is_archived?: boolean;
  archived?: boolean;
  is_locked?: boolean;
  url?: string;
  public_url?: string | null;
  parent?: NotionParent;
  properties?: Record<string, Record<string, unknown>>;
  icon?: unknown;
  cover?: unknown;
}

export interface NotionBlock {
  object: "block";
  id: string;
  parent?: NotionParent;
  type?: string;
  created_time?: string;
  created_by?: Record<string, unknown>;
  last_edited_time?: string;
  last_edited_by?: Record<string, unknown>;
  archived?: boolean;
  in_trash?: boolean;
  has_children?: boolean;
  [key: string]: unknown;
}

export interface NotionDataSource {
  object: "data_source";
  id: string;
  title?: NotionRichText[];
  description?: NotionRichText[];
  url?: string;
  public_url?: string | null;
  parent?: NotionParent;
  database_parent?: NotionParent;
  is_inline?: boolean;
  archived?: boolean;
  in_trash?: boolean;
  created_time?: string;
  created_by?: Record<string, unknown>;
  last_edited_time?: string;
  last_edited_by?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  icon?: unknown;
  cover?: unknown;
}

export interface NotionDataSourceTemplate {
  id: string;
  name: string;
  is_default: boolean;
  [key: string]: unknown;
}

export interface NotionDataSourceTemplateListResponse {
  templates: NotionDataSourceTemplate[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotionDataSourceTemplateCollection {
  templates: NotionDataSourceTemplate[];
  complete: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  truncated: boolean;
  maxTemplates: number;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  title?: NotionRichText[];
  description?: NotionRichText[];
  url?: string;
  public_url?: string | null;
  properties?: Record<string, unknown>;
  parent?: NotionParent;
  data_sources?: Array<{
    id?: string;
    name?: string;
    title?: NotionRichText[];
  }>;
  is_inline?: boolean;
  is_locked?: boolean;
  created_by?: Record<string, unknown>;
  last_edited_by?: Record<string, unknown>;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  archived?: boolean;
  icon?: unknown;
  cover?: unknown;
}

export interface NotionView {
  object?: "view";
  id: string;
  name?: string;
  type?: string;
  parent?: NotionParent;
  database_id?: string;
  data_source_id?: string | null;
  created_time?: string;
  created_by?: Record<string, unknown> | null;
  last_edited_time?: string;
  last_edited_by?: Record<string, unknown> | null;
  url?: string;
  filter?: unknown;
  sorts?: unknown[];
  quick_filters?: unknown;
  configuration?: unknown;
  [key: string]: unknown;
}

export interface NotionPaginatedResponse<T> {
  object: "list";
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
  type?: string;
  request_status?: {
    type?: string;
    incomplete_reason?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface NotionMeetingNotesQueryResponse {
  results: NotionBlock[];
  has_more: boolean;
  [key: string]: unknown;
}

export interface NotionMarkdownResponse {
  object: "page_markdown";
  id: string;
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

export interface NotionViewQueryResponse {
  object?: "view_query" | "list";
  id?: string;
  query_id?: string;
  view_id?: string;
  expires_at?: string;
  total_count?: number;
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
  deleted?: boolean;
  request_status?: unknown;
  [key: string]: unknown;
}

export type NotionApiErrorSummary = {
  status: number;
  code: string | null;
  message: string;
  retryAfterMs: number | null;
};

export interface NotionDataSourcePageCollection {
  pages: NotionPage[];
  dataSources: NotionDataSource[];
  complete: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  requestStatus: Record<string, unknown> | null;
  incompleteReason: string | null;
}

export interface NotionDataSourceCollectionOptions {
  /**
   * Caps total provider results processed from Notion's paginated data-source
   * query endpoint. Results may be row pages or nested data_source objects.
   */
  maxResults?: number;
  /**
   * Backwards-compatible alias for maxResults. Prefer maxResults for new
   * callers because Notion data-source query results are not page-only.
   */
  maxPages?: number;
}

export function setNotionAccessTokenOverride(token: string | null): void {
  const trimmed = token?.trim();
  notionAccessTokenOverride = trimmed || null;
}

export async function getNotionAccessToken(userId: string): Promise<string> {
  if (notionAccessTokenOverride) return notionAccessTokenOverride;
  const stored = await getStoredNotionToken(userId);
  if (!stored) throw new Error(`No Notion token found for user ${userId}`);
  return stored.token;
}

export async function notionApi<T>(
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (notionAccessTokenOverride) {
    return notionApiWithToken<T>(notionAccessTokenOverride, path, init);
  }

  const stored = await getStoredNotionToken(userId);
  if (!stored) throw new Error(`No Notion token found for user ${userId}`);
  try {
    return await notionApiWithToken<T>(stored.token, path, init);
  } catch (err) {
    if (!isNotionUnauthorizedError(err) || !stored.refreshToken) throw err;
    const refreshed = await refreshStoredNotionToken(userId, stored);
    return notionApiWithToken<T>(refreshed, path, init);
  }
}

// Proactive pacer: Notion's rate limit is ~3 requests/second average per
// integration, and bulk paging (e.g. /search walks up to 100 pages
// back-to-back) previously fired requests with no client-side spacing,
// relying only on reactive 429 handling. Space request starts a minimum
// interval apart so we stay under the limit instead of tripping it.
const NOTION_MIN_REQUEST_INTERVAL_MS = 334; // ~3 req/s
let notionRequestGate: Promise<void> = Promise.resolve();

function nextNotionRequestSlot(): Promise<void> {
  const slot = notionRequestGate;
  notionRequestGate = slot.then(() => sleep(NOTION_MIN_REQUEST_INTERVAL_MS));
  return slot;
}

export async function notionApiWithToken<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    await nextNotionRequestSlot();
    const { headers, ...request } = init;
    const res = await fetch(`${NOTION_API}${path}`, {
      ...request,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    const body = parseJson(text);

    if (res.ok) return body as T;

    const retryMs = retryDelayMs(res);
    if (isRetryableNotionStatus(res.status) && retryMs !== null && attempt < MAX_RETRY_ATTEMPTS) {
      await sleep(retryMs);
      continue;
    }

    const errorBody = body && typeof body === "object"
      ? body as { code?: unknown; message?: unknown }
      : {};
    const message = typeof errorBody.message === "string"
      ? errorBody.message
      : text || res.statusText;
    const code = typeof errorBody.code === "string" ? errorBody.code : null;
    throw new NotionApiError(res.status, message, { code, retryAfterMs: retryMs });
  }

  throw new Error("Notion API retry loop exited unexpectedly");
}

async function refreshStoredNotionToken(
  userId: string,
  stored: StoredNotionToken,
): Promise<string> {
  const [{ env }, { storeToken }] = await Promise.all([
    import("../../env.js"),
    import("../../vault/tokens.js"),
  ]);

  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET || !stored.refreshToken) {
    throw new Error("Notion token expired and refresh is not configured. Please reconnect Notion.");
  }

  const res = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    }),
  });

  const text = await res.text();
  const body = parseJson(text);
  if (!res.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : text || res.statusText;
    throw new Error(`Notion token refresh failed (${res.status}): ${message}`);
  }

  if (!body || typeof body !== "object" || typeof (body as { access_token?: unknown }).access_token !== "string") {
    throw new Error("Notion token refresh did not return an access token.");
  }

  const tokenBody = body as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string };
  const refreshToken = typeof tokenBody.refresh_token === "string" ? tokenBody.refresh_token : stored.refreshToken;
  await storeToken(userId, NOTION_PROVIDER, tokenBody.access_token, {
    ...(stored.metadata ?? {}),
    auth_mode: "oauth",
    token_type: tokenBody.token_type ?? "bearer",
    expires_at: typeof tokenBody.expires_in === "number" ? Date.now() + tokenBody.expires_in * 1000 : null,
    refreshed_at: new Date().toISOString(),
  }, refreshToken);

  return tokenBody.access_token;
}

async function getStoredNotionToken(userId: string): Promise<StoredNotionToken | null> {
  const { getTokenFull } = await import("../../vault/tokens.js");
  return getTokenFull(userId, NOTION_PROVIDER);
}

function isNotionUnauthorizedError(err: unknown): boolean {
  return err instanceof NotionApiError && (err.status === 401 || err.status === 403);
}

class NotionApiError extends Error {
  readonly code: string | null;
  readonly retryAfterMs: number | null;

  constructor(readonly status: number, message: string, opts: { code?: string | null; retryAfterMs?: number | null } = {}) {
    super(`Notion API error (${status}): ${message}`);
    this.name = "NotionApiError";
    this.code = opts.code ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function notionApiErrorSummary(err: unknown): NotionApiErrorSummary | null {
  if (!(err instanceof NotionApiError)) return null;
  return {
    status: err.status,
    code: err.code,
    message: err.message,
    retryAfterMs: err.retryAfterMs,
  };
}

export async function searchNotionPages(userId: string, opts: {
  query?: string;
  maxPages?: number;
  startCursor?: string | null;
} = {}): Promise<NotionPage[]> {
  const maxPages = Math.max(1, Math.min(Math.floor(opts.maxPages ?? 100), 5000));
  const pages: NotionPage[] = [];
  let cursor = opts.startCursor ?? null;

  while (pages.length < maxPages) {
    const pageSize = Math.min(100, maxPages - pages.length);
    const body: Record<string, unknown> = {
      page_size: pageSize,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (opts.query) body.query = opts.query;
    if (cursor) body.start_cursor = cursor;

    const res = await notionApi<NotionPaginatedResponse<NotionPage>>(userId, "/search", {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const page of res.results) {
      if (page.object === "page") pages.push(page);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  return pages;
}

export async function searchNotionDataSources(userId: string, opts: {
  query?: string;
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionPaginatedResponse<NotionDataSource>> {
  const body: Record<string, unknown> = {
    page_size: Math.max(1, Math.min(Math.floor(opts.pageSize ?? 20), 100)),
    filter: { property: "object", value: "data_source" },
  };
  if (opts.query) body.query = opts.query;
  if (opts.startCursor) body.start_cursor = opts.startCursor;
  return notionApi<NotionPaginatedResponse<NotionDataSource>>(userId, "/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function collectNotionDataSources(userId: string, opts: {
  maxDataSources?: number;
} = {}): Promise<NotionDataSource[]> {
  const maxDataSources = Math.max(1, Math.min(Math.floor(opts.maxDataSources ?? 500), 5000));
  const dataSources: NotionDataSource[] = [];
  let cursor: string | null = null;

  while (dataSources.length < maxDataSources) {
    const pageSize = Math.min(100, maxDataSources - dataSources.length);
    const res = await searchNotionDataSources(userId, { pageSize, startCursor: cursor });
    for (const source of res.results) {
      if (source.object === "data_source") dataSources.push(source);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  return dataSources;
}

export async function searchNotionDatabases(userId: string, opts: {
  query?: string;
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionPaginatedResponse<NotionDatabase>> {
  const body: Record<string, unknown> = {
    page_size: Math.max(1, Math.min(Math.floor(opts.pageSize ?? 20), 100)),
    filter: { property: "object", value: "database" },
  };
  if (opts.query) body.query = opts.query;
  if (opts.startCursor) body.start_cursor = opts.startCursor;
  return notionApi<NotionPaginatedResponse<NotionDatabase>>(userId, "/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function collectNotionDatabases(userId: string, opts: {
  maxDatabases?: number;
} = {}): Promise<NotionDatabase[]> {
  const maxDatabases = Math.max(1, Math.min(Math.floor(opts.maxDatabases ?? 500), 5000));
  const databases: NotionDatabase[] = [];
  let cursor: string | null = null;

  while (databases.length < maxDatabases) {
    const pageSize = Math.min(100, maxDatabases - databases.length);
    const res = await searchNotionDatabases(userId, { pageSize, startCursor: cursor });
    for (const database of res.results) {
      if (database.object === "database") databases.push(database);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  return databases;
}

export async function retrieveNotionPage(userId: string, pageId: string): Promise<NotionPage> {
  return notionApi<NotionPage>(userId, `/pages/${encodeURIComponent(pageId)}`);
}

export async function retrieveNotionPageProperty(
  userId: string,
  pageId: string,
  propertyId: string,
  opts: { startCursor?: string | null; pageSize?: number } = {},
): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  if (opts.pageSize) params.set("page_size", String(Math.max(1, Math.min(Math.floor(opts.pageSize), 100))));
  const suffix = params.size > 0 ? `?${params}` : "";
  return notionApi<unknown>(
    userId,
    `/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(propertyId)}${suffix}`,
  );
}

export async function retrieveNotionPageMarkdown(userId: string, pageId: string): Promise<NotionMarkdownResponse> {
  const params = new URLSearchParams({ include_transcript: "true" });
  return notionApi<NotionMarkdownResponse>(userId, `/pages/${encodeURIComponent(pageId)}/markdown?${params}`);
}

export async function retrieveNotionComments(
  userId: string,
  blockId: string,
  opts: { startCursor?: string | null; pageSize?: number } = {},
): Promise<NotionPaginatedResponse<NotionComment>> {
  const params = new URLSearchParams({ block_id: blockId });
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  params.set("page_size", String(Math.max(1, Math.min(Math.floor(opts.pageSize ?? 100), 100))));
  return notionApi<NotionPaginatedResponse<NotionComment>>(userId, `/comments?${params}`);
}

export async function retrieveNotionBlock(userId: string, blockId: string): Promise<NotionBlock> {
  return notionApi<NotionBlock>(userId, `/blocks/${encodeURIComponent(blockId)}`);
}

export async function retrieveNotionBlockChildren(
  userId: string,
  blockId: string,
  opts: { startCursor?: string | null; pageSize?: number } = {},
): Promise<NotionPaginatedResponse<NotionBlock>> {
  const params = new URLSearchParams();
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  params.set("page_size", String(Math.max(1, Math.min(Math.floor(opts.pageSize ?? 100), 100))));
  return notionApi<NotionPaginatedResponse<NotionBlock>>(
    userId,
    `/blocks/${encodeURIComponent(blockId)}/children?${params}`,
  );
}

export async function retrieveNotionDatabase(userId: string, databaseId: string): Promise<NotionDatabase> {
  return notionApi<NotionDatabase>(userId, `/databases/${encodeURIComponent(databaseId)}`);
}

export async function retrieveNotionDataSource(userId: string, dataSourceId: string): Promise<NotionDataSource> {
  return notionApi<NotionDataSource>(userId, `/data_sources/${encodeURIComponent(dataSourceId)}`);
}

export async function listNotionDataSourceTemplates(userId: string, dataSourceId: string, opts: {
  name?: string | null;
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionDataSourceTemplateListResponse> {
  const params = new URLSearchParams({
    page_size: String(Math.max(1, Math.min(Math.floor(opts.pageSize ?? 100), 100))),
  });
  if (opts.name) params.set("name", opts.name);
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  return notionApi<NotionDataSourceTemplateListResponse>(
    userId,
    `/data_sources/${encodeURIComponent(dataSourceId)}/templates?${params}`,
  );
}

export async function collectNotionDataSourceTemplates(userId: string, dataSourceId: string, opts: {
  name?: string | null;
  maxTemplates?: number;
} = {}): Promise<NotionDataSourceTemplate[]> {
  const collection = await collectNotionDataSourceTemplateCollection(userId, dataSourceId, opts);
  if (collection.truncated) {
    throw new Error("Notion data source templates were truncated; use collectNotionDataSourceTemplateCollection for pagination metadata");
  }
  return collection.templates;
}

export async function collectNotionDataSourceTemplateCollection(userId: string, dataSourceId: string, opts: {
  name?: string | null;
  maxTemplates?: number;
} = {}): Promise<NotionDataSourceTemplateCollection> {
  const maxTemplates = Math.max(1, Math.min(Math.floor(opts.maxTemplates ?? 500), 5000));
  const templates: NotionDataSourceTemplate[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  let nextCursor: string | null = null;

  while (true) {
    const remaining = maxTemplates - templates.length;
    if (remaining <= 0) break;
    const pageSize = Math.min(100, remaining);
    const res = await listNotionDataSourceTemplates(userId, dataSourceId, {
      name: opts.name,
      pageSize,
      startCursor: cursor,
    });
    templates.push(...res.templates.slice(0, maxTemplates - templates.length));
    hasMore = res.has_more;
    nextCursor = res.next_cursor;
    if (!res.has_more || !res.next_cursor || templates.length >= maxTemplates) break;
    cursor = res.next_cursor;
  }

  return {
    templates,
    complete: !hasMore,
    hasMore,
    nextCursor,
    truncated: hasMore,
    maxTemplates,
  };
}

export async function queryNotionDataSource(
  userId: string,
  dataSourceId: string,
  body: Record<string, unknown>,
  opts: { filterProperties?: string[] } = {},
): Promise<NotionPaginatedResponse<NotionPage | NotionDataSource>> {
  const params = new URLSearchParams();
  for (const property of opts.filterProperties ?? []) params.append("filter_properties", property);
  const query = params.toString();
  return notionApi<NotionPaginatedResponse<NotionPage | NotionDataSource>>(userId, `/data_sources/${encodeURIComponent(dataSourceId)}/query${query ? `?${query}` : ""}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function queryNotionMeetingNotes(
  userId: string,
  body: Record<string, unknown>,
): Promise<NotionMeetingNotesQueryResponse> {
  return notionApi<NotionMeetingNotesQueryResponse>(userId, "/blocks/meeting_notes/query", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listNotionViews(userId: string, opts: {
  databaseId?: string | null;
  dataSourceId?: string | null;
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionPaginatedResponse<NotionView>> {
  const params = new URLSearchParams({
    page_size: String(Math.max(1, Math.min(Math.floor(opts.pageSize ?? 100), 100))),
  });
  if (opts.databaseId) params.set("database_id", opts.databaseId);
  if (opts.dataSourceId) params.set("data_source_id", opts.dataSourceId);
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  return notionApi<NotionPaginatedResponse<NotionView>>(userId, `/views?${params}`);
}

export async function retrieveNotionView(userId: string, viewId: string): Promise<NotionView> {
  return notionApi<NotionView>(userId, `/views/${encodeURIComponent(viewId)}`);
}

export async function collectNotionViews(userId: string, opts: {
  databaseId?: string | null;
  dataSourceId?: string | null;
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionPaginatedResponse<NotionView>> {
  const listed = await listNotionViews(userId, opts);
  const hydrated = await mapWithConcurrency(listed.results, NOTION_VIEW_DETAIL_CONCURRENCY, async (ref): Promise<NotionView | null> => {
    if (!ref.id) return null;
    try {
      return await retrieveNotionView(userId, ref.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("(403)") || message.includes("(404)")) {
        return ref;
      }
      throw err;
    }
  });
  const results = hydrated.filter((view): view is NotionView => view !== null);
  return { ...listed, results };
}

export async function createNotionViewQuery(userId: string, viewId: string, body: Record<string, unknown>): Promise<NotionViewQueryResponse> {
  return notionApi<NotionViewQueryResponse>(userId, `/views/${encodeURIComponent(viewId)}/queries`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function retrieveNotionViewQuery(userId: string, viewId: string, queryId: string, opts: {
  pageSize?: number;
  startCursor?: string | null;
} = {}): Promise<NotionViewQueryResponse> {
  const params = new URLSearchParams({
    page_size: String(Math.max(1, Math.min(Math.floor(opts.pageSize ?? 100), 100))),
  });
  if (opts.startCursor) params.set("start_cursor", opts.startCursor);
  return notionApi<NotionViewQueryResponse>(
    userId,
    `/views/${encodeURIComponent(viewId)}/queries/${encodeURIComponent(queryId)}?${params}`,
  );
}

export async function deleteNotionViewQuery(userId: string, viewId: string, queryId: string): Promise<NotionViewQueryResponse> {
  return notionApi<NotionViewQueryResponse>(
    userId,
    `/views/${encodeURIComponent(viewId)}/queries/${encodeURIComponent(queryId)}`,
    { method: "DELETE" },
  );
}

export async function collectNotionDataSourcePages(userId: string, dataSourceId: string, opts: NotionDataSourceCollectionOptions = {}): Promise<NotionPage[]> {
  return (await collectNotionDataSourcePageCollection(userId, dataSourceId, opts)).pages;
}

/**
 * Collect a Notion data-source query response. Notion can return both row pages
 * and nested data_source objects from this endpoint, so maxResults caps total
 * provider results processed. maxPages is accepted as a legacy alias.
 */
export async function collectNotionDataSourcePageCollection(
  userId: string,
  dataSourceId: string,
  opts: NotionDataSourceCollectionOptions = {},
): Promise<NotionDataSourcePageCollection> {
  const requestedMaxResults = opts.maxResults ?? opts.maxPages ?? 1000;
  const maxResults = Math.max(1, Math.min(Math.floor(requestedMaxResults), 5000));
  const pages: NotionPage[] = [];
  const dataSources: NotionDataSource[] = [];
  let resultCount = 0;
  let cursor: string | null = null;
  let hasMore = false;
  let nextCursor: string | null = null;
  let requestStatus: Record<string, unknown> | null = null;
  let incompleteReason: string | null = null;
  let locallyTruncated = false;

  while (resultCount < maxResults && !locallyTruncated) {
    const pageSize = Math.min(100, maxResults - resultCount);
    const body: Record<string, unknown> = {
      page_size: pageSize,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionApi<NotionPaginatedResponse<NotionPage | NotionDataSource>>(userId, `/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const status = recordValue(res.request_status);
    const pageStatus = Object.keys(status).length > 0 ? status : null;
    if (!incompleteReason && typeof pageStatus?.incomplete_reason === "string") {
      incompleteReason = pageStatus.incomplete_reason;
    }
    requestStatus = mergePaginatedRequestStatus(requestStatus, pageStatus, incompleteReason);
    for (const result of res.results) {
      if (resultCount >= maxResults) {
        locallyTruncated = true;
        break;
      }
      resultCount++;
      if (result.object === "page") pages.push(result);
      if (result.object === "data_source") dataSources.push(result);
    }
    if (locallyTruncated && !incompleteReason) {
      incompleteReason = "local_result_cap_reached";
      requestStatus = mergePaginatedRequestStatus(
        requestStatus,
        { type: "incomplete", incomplete_reason: incompleteReason },
        incompleteReason,
      );
    }
    hasMore = res.has_more || locallyTruncated;
    nextCursor = res.next_cursor;
    if (locallyTruncated || !res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  return {
    pages,
    dataSources,
    complete: !hasMore && incompleteReason === null && requestStatus?.type !== "incomplete",
    hasMore,
    nextCursor,
    requestStatus,
    incompleteReason,
  };
}

function mergePaginatedRequestStatus(
  previousStatus: Record<string, unknown> | null,
  pageStatus: Record<string, unknown> | null,
  incompleteReason: string | null,
): Record<string, unknown> | null {
  if (!pageStatus) {
    return previousStatus && previousStatus.type === "incomplete" && incompleteReason
      ? { ...previousStatus, incomplete_reason: incompleteReason }
      : previousStatus;
  }

  if (previousStatus?.type === "incomplete" || pageStatus.type === "incomplete") {
    return {
      ...(previousStatus ?? {}),
      ...pageStatus,
      type: "incomplete",
      ...(incompleteReason ? { incomplete_reason: incompleteReason } : {}),
    };
  }

  return pageStatus;
}

export function extractNotionTitle(page: Pick<NotionPage, "properties"> | NotionDataSource | NotionDatabase): string {
  if ("title" in page && Array.isArray(page.title)) {
    return notionRichTextPlain(page.title).trim();
  }

  for (const prop of Object.values(page.properties ?? {}) as Array<Record<string, unknown>>) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return notionRichTextPlain(prop.title as NotionRichText[]).trim();
    }
  }
  return "";
}

export function notionParentInfo(parent: NotionParent | undefined): {
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
} {
  const parentType = typeof parent?.type === "string" ? parent.type : null;
  const parentId = parentType === "page_id"
    ? parent?.page_id ?? null
    : parentType === "database_id"
      ? parent?.database_id ?? null
      : parentType === "data_source_id"
        ? parent?.data_source_id ?? null
        : parentType === "block_id"
          ? parent?.block_id ?? null
          : parentType === "agent_id"
            ? parent?.agent_id ?? null
            : parent?.page_id ?? parent?.database_id ?? parent?.data_source_id ?? parent?.block_id ?? parent?.agent_id ?? null;
  return {
    parentType,
    parentId,
    dataSourceId: parent?.data_source_id ?? parent?.database_id ?? null,
  };
}

export function isNotionDataSourceRow(page: Pick<NotionPage, "parent">): boolean {
  const parentType = page.parent?.type;
  return parentType === "data_source_id" || parentType === "database_id";
}

export function notionDataSourceParentPageId(dataSource: Pick<NotionDataSource, "database_parent" | "parent">): string | null {
  return dataSource.database_parent?.page_id
    ?? dataSource.parent?.page_id
    ?? null;
}

export function notionEmbeddingDocId(pageId: string): string {
  return `notion:${pageId}`;
}

export function notionRichTextPlain(value: NotionRichText[]): string {
  return value.map((item) => item.plain_text ?? item.text?.content ?? "").join("");
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function retryDelayMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return 1000;
  const seconds = Number(header);
  const retryMs = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
  return retryMs;
}

function isRetryableNotionStatus(status: number): boolean {
  return status === 409
    || status === 429
    || status === 502
    || status === 503
    || status === 504
    || status === 529;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
