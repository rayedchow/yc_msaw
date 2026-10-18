import { and, eq, inArray, sql } from "drizzle-orm";
import { deleteNotionPageSourceWiki } from "../../mirror/materializer.js";
import { db } from "../../db/client.js";
import { notionPageSummaries } from "../../db/schema.js";
import { mergeTokenMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import {
  collectNotionDataSources,
  isNotionDataSourceRow,
  notionDataSourceParentPageId,
  notionEmbeddingDocId,
  retrieveNotionDatabase,
  retrieveNotionDataSource,
  retrieveNotionPage,
  searchNotionPages,
  type NotionDatabase,
  type NotionDataSource,
  type NotionPage,
} from "./client.js";
import {
  notionPageSummaryMetadataPayload,
  notionPageSummaryStoredPropertiesPayload,
  summarizeNotionPageMetadata,
  type NotionPageMetadataSummary,
} from "./content.js";
import { removeNotionNativeDataSourceSnapshot, removeNotionNativePageSnapshot } from "./snapshot.js";
import { emitNotionTombstoneEvent } from "./tombstone.js";

const NOTION_METADATA_WRITE_CONCURRENCY = parseConcurrencyEnv("NOTION_METADATA_WRITE_CONCURRENCY", 8, { max: 10 });
const NOTION_DATA_SOURCE_CONCURRENCY = parseConcurrencyEnv("NOTION_DATA_SOURCE_CONCURRENCY", 5, { max: 10 });

export async function syncNotionPages(userId: string, opts: {
  maxPages?: number | null;
  days?: number | null;
  includeDataSources?: boolean;
  maxDataSources?: number | null;
} = {}): Promise<{ discovered: number; markedDirty: number; exhausted: boolean; capHit: boolean }> {
  const maxPages = Math.max(1, Math.min(Math.floor(opts.maxPages ?? 100), 5000));
  const cutoff = opts.days ? Date.now() - Math.max(1, Math.floor(opts.days)) * 24 * 60 * 60 * 1000 : null;
  const pages = await discoverNotionPages(userId, {
    maxPages,
    includeDataSources: opts.includeDataSources === true,
    maxDataSources: opts.maxDataSources ?? null,
  });
  const inactivePages = pages.filter((page) => page.in_trash || page.is_archived || page.archived);
  await mapWithConcurrency(inactivePages, NOTION_METADATA_WRITE_CONCURRENCY, async (page) => {
    // Ledger first, removal second: the webhook path writes a page.deleted
    // signal event before content removal; the poll path must leave the same
    // tombstone so poll-detected trash never disappears silently.
    await emitNotionTombstoneEvent(userId, {
      eventType: "page.deleted",
      externalId: page.id,
      versionRef: page.last_edited_time ?? "unknown",
      timestamp: page.last_edited_time ? new Date(page.last_edited_time) : null,
      payload: {
        eventType: "page.deleted",
        detectedVia: "poll",
        pageId: page.id,
        inTrash: Boolean(page.in_trash),
        archived: Boolean(page.is_archived || page.archived),
        page,
      },
    });
    await removeNotionPageContent(userId, page.id);
  });
  const activePages = pages
    .filter((page) => !page.in_trash && !page.is_archived && !page.archived)
    .map(summarizeNotionPageMetadata)
    .filter((page) => !cutoff || !page.lastEditedTime || page.lastEditedTime.getTime() >= cutoff);

  if (activePages.length === 0) {
    await mergeTokenMetadata(userId, "notion", { lastPollAt: new Date().toISOString() });
    return { discovered: 0, markedDirty: 0, exhausted: pages.length < maxPages, capHit: pages.length >= maxPages };
  }

  const existingRows = await db
    .select({
      pageId: notionPageSummaries.pageId,
      lastEditedTime: notionPageSummaries.lastEditedTime,
      dirtyAt: notionPageSummaries.dirtyAt,
    })
    .from(notionPageSummaries)
    .where(and(
      eq(notionPageSummaries.userId, userId),
      inArray(notionPageSummaries.pageId, activePages.map((page) => page.pageId)),
    ));
  const existing = new Map(existingRows.map((row) => [row.pageId, {
    lastEditedTime: row.lastEditedTime?.toISOString() ?? null,
    dirtyAt: row.dirtyAt,
  }]));

  let markedDirty = 0;
  const dirtyFlags = await mapWithConcurrency(activePages, NOTION_METADATA_WRITE_CONCURRENCY, async (page): Promise<number> => {
    const edited = page.lastEditedTime?.toISOString() ?? null;
    const previous = existing.get(page.pageId);
    const changed = previous === undefined || previous.lastEditedTime !== edited;
    // Poll-path update signal: webhooks are the only other path that writes
    // page signal events and they may not be enabled, so a poll-detected
    // last_edited_time advance leaves a versioned ledger row
    // (`notion:page_content_updated:<pageId>:<last_edited_time>`) before the
    // summary upsert / re-render. First-time discovery (previous === undefined)
    // is backfill, not an edit - no event, or every initial sync would flood
    // one row per page.
    if (previous !== undefined && changed) {
      await emitNotionTombstoneEvent(userId, {
        eventType: "page.content_updated",
        externalId: page.pageId,
        versionRef: edited ?? "unknown",
        timestamp: page.lastEditedTime ?? null,
        payload: {
          eventType: "page.content_updated",
          detectedVia: "poll",
          pageId: page.pageId,
          title: page.title,
          url: page.url,
          lastEditedTime: edited,
          previousLastEditedTime: previous.lastEditedTime,
        },
      });
    }
    const storedPropertiesPayloadIncludingMetadata = redactProviderPayload("notion", notionPageSummaryPropertiesPayload(page));
    const storedPageMetadataPayload = redactProviderPayload("notion", notionPageSummaryMetadataPayload(page));

    await db.execute(sql`
      INSERT INTO notion_page_summaries (
        user_id, page_id, title, url, parent_type, parent_id, data_source_id,
        properties, page_metadata, last_edited_time, dirty_at, updated_at
      )
      VALUES (
        ${userId}, ${page.pageId}, ${page.title}, ${page.url}, ${page.parentType}, ${page.parentId},
        ${page.dataSourceId}, ${JSON.stringify(storedPropertiesPayloadIncludingMetadata)}::jsonb,
        ${JSON.stringify(storedPageMetadataPayload)}::jsonb, ${page.lastEditedTime?.toISOString() ?? null}::timestamptz,
        ${changed ? new Date().toISOString() : null}::timestamptz, NOW()
      )
      ON CONFLICT (user_id, page_id)
      DO UPDATE SET
        title = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.title
          ELSE notion_page_summaries.title
        END,
        url = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.url
          ELSE notion_page_summaries.url
        END,
        parent_type = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.parent_type
          ELSE notion_page_summaries.parent_type
        END,
        parent_id = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.parent_id
          ELSE notion_page_summaries.parent_id
        END,
        data_source_id = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.data_source_id
          ELSE notion_page_summaries.data_source_id
        END,
        properties = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.properties
          ELSE notion_page_summaries.properties
        END,
        page_metadata = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.page_metadata
          ELSE notion_page_summaries.page_metadata
        END,
        last_edited_time = CASE
          WHEN notion_page_summaries.dirty_at IS NULL
            OR notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN EXCLUDED.last_edited_time
          ELSE notion_page_summaries.last_edited_time
        END,
        dirty_at = CASE
          WHEN notion_page_summaries.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time
          THEN NOW()
          ELSE notion_page_summaries.dirty_at
        END,
        updated_at = NOW()
    `);
    return changed && !previous?.dirtyAt ? 1 : 0;
  });
  markedDirty = dirtyFlags.reduce((sum, value) => sum + value, 0);

  await mergeTokenMetadata(userId, "notion", {
    lastPollAt: new Date().toISOString(),
    lastDiscoveredPageCount: activePages.length,
    lastPollIncludedDataSources: opts.includeDataSources === true,
    lastPollReachedPageLimit: pages.length >= maxPages,
  });
  const capHit = pages.length >= maxPages;
  return { discovered: activePages.length, markedDirty, exhausted: !capHit, capHit };
}

export function notionPageSummaryPropertiesPayload(page: NotionPageMetadataSummary): Record<string, unknown> {
  return notionPageSummaryStoredPropertiesPayload(page);
}

export async function discoverNotionPages(userId: string, opts: {
  maxPages: number;
  includeDataSources: boolean;
  maxDataSources: number | null;
}): Promise<NotionPage[]> {
  const pages = new Map<string, NotionPage>();
  const rowDataSourceIds = new Set<string>();
  for (const page of await searchNotionPages(userId, { maxPages: opts.maxPages })) {
    if (isNotionDataSourceRow(page)) {
      const dataSourceId = page.parent?.data_source_id ?? page.parent?.database_id;
      if (dataSourceId) rowDataSourceIds.add(dataSourceId);
      continue;
    }
    pages.set(page.id, page);
  }

  await addDataSourceDocuments(userId, pages, [...rowDataSourceIds], opts.maxPages);

  if (!opts.includeDataSources || pages.size >= opts.maxPages) return [...pages.values()];

  const dataSources = await collectNotionDataSources(userId, {
    maxDataSources: opts.maxDataSources ?? 100,
  });
  await addDataSourceDocuments(userId, pages, dataSources, opts.maxPages);

  return [...pages.values()];
}

async function addDataSourceDocuments(
  userId: string,
  pages: Map<string, NotionPage>,
  dataSourcesOrIds: Array<NotionDataSource | string>,
  maxPages: number,
): Promise<void> {
  for (let offset = 0; offset < dataSourcesOrIds.length && pages.size < maxPages; offset += NOTION_DATA_SOURCE_CONCURRENCY) {
    const batch = dataSourcesOrIds.slice(offset, offset + NOTION_DATA_SOURCE_CONCURRENCY);
    const dataSourceResults = await mapWithConcurrency(batch, NOTION_DATA_SOURCE_CONCURRENCY, async (dataSource) => {
      try {
        return await parentPageForDataSource(userId, dataSource);
      } catch (err) {
        const id = typeof dataSource === "string" ? dataSource : dataSource.id;
        console.warn(`[notion-poll] Failed to inspect data source ${id}:`, err instanceof Error ? err.message : String(err));
        return null;
      }
    });
    for (const page of dataSourceResults) {
      if (pages.size >= maxPages) break;
      if (page) pages.set(page.id, mergeDiscoveredPage(pages.get(page.id), page));
    }
  }
}

async function parentPageForDataSource(userId: string, dataSource: NotionDataSource | string): Promise<NotionPage | null> {
  let source = typeof dataSource === "string" ? await retrieveNotionDataSourceWithDatabaseFallback(userId, dataSource) : dataSource;
  let parentPageId = notionDataSourceParentPageId(source);
  if (!parentPageId) {
    source = await retrieveNotionDataSourceWithDatabaseFallback(userId, source.id);
    parentPageId = notionDataSourceParentPageId(source);
  }
  if (!parentPageId) return pseudoPageForStandaloneDataSource(source);

  const page = await retrieveNotionPage(userId, parentPageId);
  if (source.last_edited_time && latestIso(source.last_edited_time, page.last_edited_time) === source.last_edited_time) {
    return { ...page, last_edited_time: source.last_edited_time };
  }
  return page;
}

async function retrieveNotionDataSourceWithDatabaseFallback(userId: string, id: string): Promise<NotionDataSource> {
  try {
    return await retrieveNotionDataSource(userId, id);
  } catch (err) {
    const database = await retrieveNotionDatabase(userId, id);
    return dataSourceFromDatabase(database, err);
  }
}

function dataSourceFromDatabase(database: NotionDatabase, cause: unknown): NotionDataSource {
  return {
    object: "data_source",
    id: database.id,
    title: database.title,
    url: database.url,
    parent: database.parent,
    database_parent: database.parent,
    created_time: database.created_time,
    last_edited_time: database.last_edited_time,
    properties: database.properties,
    shepherd_database_fallback_error: cause instanceof Error ? cause.message : String(cause),
  } as NotionDataSource;
}

function pseudoPageForStandaloneDataSource(dataSource: NotionDataSource): NotionPage {
  return {
    object: "page",
    id: dataSource.id,
    url: dataSource.url,
    parent: dataSource.database_parent ?? dataSource.parent,
    properties: {
      Title: {
        type: "title",
        title: dataSource.title ?? [],
      },
      ...(dataSource.properties ?? {}),
    },
    last_edited_time: dataSource.last_edited_time,
    in_trash: false,
    is_archived: false,
    archived: false,
  };
}

function mergeDiscoveredPage(existing: NotionPage | undefined, next: NotionPage): NotionPage {
  if (!existing) return next;
  const lastEditedTime = latestIso(existing.last_edited_time, next.last_edited_time);
  return { ...existing, ...next, last_edited_time: lastEditedTime ?? existing.last_edited_time ?? next.last_edited_time };
}

function latestIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export async function markNotionPageDirty(userId: string, pageId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO notion_page_summaries (user_id, page_id, title, dirty_at, updated_at)
    VALUES (${userId}, ${pageId}, ${pageId}, NOW(), NOW())
    ON CONFLICT (user_id, page_id)
      DO UPDATE SET dirty_at = NOW(), updated_at = NOW()
  `);
}

export async function markNotionDataSourcePagesDirty(userId: string, dataSourceId: string): Promise<void> {
  await db
    .update(notionPageSummaries)
    .set({ dirtyAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(notionPageSummaries.userId, userId),
      eq(notionPageSummaries.dataSourceId, dataSourceId),
    ));
  try {
    const dataSource = await retrieveNotionDataSourceWithDatabaseFallback(userId, dataSourceId);
    const parentPageId = notionDataSourceParentPageId(dataSource);
    await markNotionPageDirty(userId, parentPageId ?? dataSourceId);
  } catch (err) {
    console.warn(`[notion-poll] Failed to mark parent page for data source ${dataSourceId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function removeNotionPageContent(userId: string, pageId: string): Promise<void> {
  await deleteNotionPageSourceWiki(userId, pageId);
  await removeNotionNativePageSnapshot(userId, pageId);
  await db.delete(notionPageSummaries).where(and(
    eq(notionPageSummaries.userId, userId),
    eq(notionPageSummaries.pageId, pageId),
  ));
}

export async function removeNotionDataSourceContent(userId: string, dataSourceId: string): Promise<void> {
  const rows = await db
    .select({ pageId: notionPageSummaries.pageId })
    .from(notionPageSummaries)
    .where(and(
      eq(notionPageSummaries.userId, userId),
      eq(notionPageSummaries.dataSourceId, dataSourceId),
  ));

  await mapWithConcurrency(rows, NOTION_METADATA_WRITE_CONCURRENCY, async (row) => {
    await deleteNotionPageSourceWiki(userId, row.pageId);
    await removeNotionNativePageSnapshot(userId, row.pageId);
  });

  await removeNotionNativeDataSourceSnapshot(userId, dataSourceId);

  if (rows.length === 0) return;

  await db.delete(notionPageSummaries).where(and(
    eq(notionPageSummaries.userId, userId),
    eq(notionPageSummaries.dataSourceId, dataSourceId),
  ));
}
