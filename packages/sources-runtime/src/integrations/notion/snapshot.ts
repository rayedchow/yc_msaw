import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type {
  NotionBlockSnapshot,
  NotionCommentSnapshot,
  NotionDatabaseSnapshot,
  NotionDataSourceSnapshot,
  NotionDataSourceTemplateSnapshot,
  NotionNativeSnapshot,
  NotionObjectEdgeSnapshot,
  NotionObjectSnapshot,
  NotionViewSnapshot,
} from "./native.js";

type SnapshotDbClient = Pick<typeof db, "execute">;

export async function persistNotionNativeSnapshot(userId: string, pageId: string, snapshot: NotionNativeSnapshot): Promise<void> {
  await db.transaction(async (tx) => {
    const client = tx as SnapshotDbClient;
    const normalizedSnapshot = normalizeNotionNativeSnapshot(snapshot);
    await lockNotionNativeSnapshotUser(client, userId);
    await pruneStalePageSnapshot(client, userId, pageId, normalizedSnapshot);

    await upsertObjects(client, userId, normalizedSnapshot.objects);
    await upsertBlocks(client, userId, normalizedSnapshot.blocks);
    await upsertDataSources(client, userId, normalizedSnapshot.dataSources);
    await upsertDatabases(client, userId, normalizedSnapshot.databases);
    await upsertViews(client, userId, normalizedSnapshot.views);
    await upsertComments(client, userId, normalizedSnapshot.comments);
    await upsertEdges(client, userId, normalizedSnapshot.edges);

    await deleteOrphanedCollectionSnapshots(client, userId, normalizedSnapshot.objects.map((object) => object.objectId));
  });
}

export async function removeNotionNativePageSnapshot(userId: string, pageId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const client = tx as SnapshotDbClient;
    await lockNotionNativeSnapshotUser(client, userId);
    await client.execute(sql`
    WITH page_objects AS (
      SELECT object_id
      FROM notion_objects
      WHERE user_id = ${userId}
        AND (
          object_id = ${pageId}
          OR metadata->>'pageId' = ${pageId}
          OR metadata->>'containerPageId' = ${pageId}
          OR object_id IN (
            SELECT comment_id FROM notion_comment_snapshots
            WHERE user_id = ${userId} AND page_id = ${pageId}
          )
        )
    ),
    page_ids AS (
      SELECT object_id
      FROM page_objects
      WHERE object_id = ${pageId}
        OR object_id IN (
          SELECT object_id FROM notion_objects
          WHERE user_id = ${userId}
            AND metadata->>'containerPageId' = ${pageId}
            AND object_type = 'page'
        )
    ),
    deleted_edges AS (
      DELETE FROM notion_object_edges
      WHERE user_id = ${userId}
        AND (
          source_object_id = ${pageId}
          OR parent_object_id IN (SELECT object_id FROM page_objects)
          OR child_object_id IN (SELECT object_id FROM page_objects)
        )
      RETURNING 1
    ),
    deleted_blocks AS (
      DELETE FROM notion_block_snapshots
      WHERE user_id = ${userId}
        AND page_id IN (SELECT object_id FROM page_ids)
      RETURNING 1
    ),
    deleted_comments AS (
      DELETE FROM notion_comment_snapshots
      WHERE user_id = ${userId}
        AND (
          page_id = ${pageId}
          OR comment_id IN (SELECT object_id FROM page_objects)
        )
      RETURNING 1
    )
    DELETE FROM notion_objects
    WHERE user_id = ${userId}
      AND object_id IN (SELECT object_id FROM page_objects)
  `);
    await deleteOrphanedCollectionSnapshots(client, userId);
  });
}

export async function removeNotionNativeDataSourceSnapshot(userId: string, dataSourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const client = tx as SnapshotDbClient;
    await lockNotionNativeSnapshotUser(client, userId);
    await client.execute(sql`
    WITH direct_source_objects AS (
      SELECT object_id
      FROM notion_objects
      WHERE user_id = ${userId}
        AND (
          object_id = ${dataSourceId}
          OR data_source_id = ${dataSourceId}
          OR parent_id = ${dataSourceId}
          OR metadata->>'dataSourceId' = ${dataSourceId}
        )
    ),
    source_page_ids AS (
      SELECT object_id
      FROM direct_source_objects
      WHERE object_id IN (
        SELECT object_id FROM notion_objects
        WHERE user_id = ${userId} AND object_type = 'page'
      )
    ),
    source_objects AS (
      SELECT object_id FROM direct_source_objects
      UNION
      SELECT object_id
      FROM notion_objects
      WHERE user_id = ${userId}
        AND (
          metadata->>'pageId' IN (SELECT object_id FROM source_page_ids)
          OR metadata->>'containerPageId' IN (SELECT object_id FROM source_page_ids)
          OR object_id IN (
            SELECT comment_id FROM notion_comment_snapshots
            WHERE user_id = ${userId}
              AND page_id IN (SELECT object_id FROM source_page_ids)
          )
        )
    ),
    deleted_edges AS (
      DELETE FROM notion_object_edges
      WHERE user_id = ${userId}
        AND (
          source_object_id = ${dataSourceId}
          OR parent_object_id = ${dataSourceId}
          OR child_object_id = ${dataSourceId}
          OR parent_object_id IN (SELECT object_id FROM source_objects)
          OR child_object_id IN (SELECT object_id FROM source_objects)
        )
      RETURNING 1
    ),
    deleted_blocks AS (
      DELETE FROM notion_block_snapshots
      WHERE user_id = ${userId}
        AND page_id IN (SELECT object_id FROM source_page_ids)
      RETURNING 1
    ),
    deleted_comments AS (
      DELETE FROM notion_comment_snapshots
      WHERE user_id = ${userId}
        AND (
          page_id IN (SELECT object_id FROM source_page_ids)
          OR comment_id IN (SELECT object_id FROM source_objects)
        )
      RETURNING 1
    )
    DELETE FROM notion_objects
    WHERE user_id = ${userId}
      AND object_id IN (SELECT object_id FROM source_objects)
  `);
    await client.execute(sql`DELETE FROM notion_view_snapshots WHERE user_id = ${userId} AND data_source_id = ${dataSourceId}`);
    await client.execute(sql`DELETE FROM notion_data_source_snapshots WHERE user_id = ${userId} AND data_source_id = ${dataSourceId}`);
    await deleteOrphanedCollectionSnapshots(client, userId);
  });
}

async function pruneStalePageSnapshot(client: SnapshotDbClient, userId: string, pageId: string, snapshot: NotionNativeSnapshot): Promise<void> {
  await client.execute(sql`DELETE FROM notion_object_edges WHERE user_id = ${userId} AND source_object_id = ${pageId}`);

  await deleteStaleBlocks(client, userId, pageId, snapshot.blocks.map((block) => block.blockId));
  await deleteStaleComments(client, userId, pageId, snapshot.comments.map((comment) => comment.commentId));
  await deleteStaleObjects(client, userId, pageId, snapshot.objects.map((object) => object.objectId));
}

async function lockNotionNativeSnapshotUser(client: SnapshotDbClient, userId: string): Promise<void> {
  await client.execute(sql`SELECT pg_advisory_xact_lock(hashtext('notion_native_snapshot'), hashtext(${userId}))`);
}

export function normalizeNotionNativeSnapshot(snapshot: NotionNativeSnapshot): NotionNativeSnapshot {
  return {
    objects: dedupeByLast(snapshot.objects, (object) => object.objectId),
    edges: dedupeByLast(
      snapshot.edges,
      (edge) => `${edge.parentObjectId}\u0000${edge.childObjectId}\u0000${edge.relationType}`,
    ),
    blocks: dedupeByLast(snapshot.blocks, (block) => block.blockId),
    dataSources: dedupeByLast(snapshot.dataSources, (source) => source.dataSourceId),
    databases: dedupeByLast(snapshot.databases, (database) => database.databaseId),
    views: dedupeByLast(snapshot.views, (view) => view.viewId),
    templates: dedupeByLast(snapshot.templates, templateSnapshotKey),
    comments: dedupeByLast(snapshot.comments, (comment) => comment.commentId),
  };
}

function templateSnapshotKey(template: NotionDataSourceTemplateSnapshot): string {
  return `${template.dataSourceId}\u0000${template.templateId}`;
}

function dedupeByLast<T>(items: T[], keyFor: (item: T) => string | null | undefined): T[] {
  const byKey = new Map<string, T>();
  const keyOrder: string[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    if (!byKey.has(key)) keyOrder.push(key);
    byKey.set(key, item);
  }
  return keyOrder.map((key) => byKey.get(key)).filter((item): item is T => Boolean(item));
}

async function deleteOrphanedCollectionSnapshots(client: SnapshotDbClient, userId: string, keepObjectIds: string[] = []): Promise<void> {
  const keep = [...new Set(keepObjectIds)].filter(Boolean);
  const keepCondition = keep.length > 0
    ? sql`AND object_id NOT IN (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  await client.execute(sql`
    WITH orphan_collection_objects AS (
      SELECT object_id, object_type
      FROM notion_objects
      WHERE user_id = ${userId}
        AND object_type IN ('data_source', 'database', 'view', 'data_source_template')
        ${keepCondition}
        AND NOT EXISTS (
          SELECT 1
          FROM notion_object_edges
          WHERE user_id = ${userId}
            AND (
              parent_object_id = notion_objects.object_id
              OR child_object_id = notion_objects.object_id
            )
        )
    ),
    deleted_views AS (
      DELETE FROM notion_view_snapshots
      WHERE user_id = ${userId}
        AND view_id IN (
          SELECT object_id FROM orphan_collection_objects WHERE object_type = 'view'
        )
      RETURNING 1
    ),
    deleted_data_sources AS (
      DELETE FROM notion_data_source_snapshots
      WHERE user_id = ${userId}
        AND data_source_id IN (
          SELECT object_id FROM orphan_collection_objects WHERE object_type = 'data_source'
        )
      RETURNING 1
    ),
    deleted_databases AS (
      DELETE FROM notion_database_snapshots
      WHERE user_id = ${userId}
        AND database_id IN (
          SELECT object_id FROM orphan_collection_objects WHERE object_type = 'database'
        )
      RETURNING 1
    )
    DELETE FROM notion_objects
    WHERE user_id = ${userId}
      AND object_id IN (SELECT object_id FROM orphan_collection_objects)
  `);
}

async function deleteStaleObjects(client: SnapshotDbClient, userId: string, pageId: string, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  await client.execute(sql`
    DELETE FROM notion_objects
    WHERE user_id = ${userId}
      AND (
        object_id = ${pageId}
        OR metadata->>'pageId' = ${pageId}
        OR metadata->>'containerPageId' = ${pageId}
        OR object_id IN (
          SELECT comment_id FROM notion_comment_snapshots
          WHERE user_id = ${userId} AND page_id = ${pageId}
        )
      )
      AND object_id NOT IN (${sql.join(objectIds.map((id) => sql`${id}`), sql`, `)})
  `);
}

async function deleteStaleBlocks(client: SnapshotDbClient, userId: string, pageId: string, blockIds: string[]): Promise<void> {
  if (blockIds.length === 0) {
    await client.execute(sql`
      DELETE FROM notion_block_snapshots
      WHERE user_id = ${userId}
        AND page_id IN (
          SELECT object_id FROM notion_objects
          WHERE user_id = ${userId}
            AND (
              object_id = ${pageId}
              OR metadata->>'containerPageId' = ${pageId}
            )
            AND object_type = 'page'
        )
    `);
    return;
  }
  await client.execute(sql`
    DELETE FROM notion_block_snapshots
    WHERE user_id = ${userId}
      AND page_id IN (
        SELECT object_id FROM notion_objects
        WHERE user_id = ${userId}
          AND (
            object_id = ${pageId}
            OR metadata->>'containerPageId' = ${pageId}
          )
          AND object_type = 'page'
      )
      AND block_id NOT IN (${sql.join(blockIds.map((id) => sql`${id}`), sql`, `)})
  `);
}

async function deleteStaleComments(client: SnapshotDbClient, userId: string, pageId: string, commentIds: string[]): Promise<void> {
  if (commentIds.length === 0) {
    await client.execute(sql`
      DELETE FROM notion_comment_snapshots
      WHERE user_id = ${userId}
        AND page_id IN (
          SELECT object_id FROM notion_objects
          WHERE user_id = ${userId}
            AND (
              object_id = ${pageId}
              OR metadata->>'containerPageId' = ${pageId}
            )
            AND object_type = 'page'
        )
    `);
    return;
  }
  await client.execute(sql`
    DELETE FROM notion_comment_snapshots
    WHERE user_id = ${userId}
      AND page_id IN (
        SELECT object_id FROM notion_objects
        WHERE user_id = ${userId}
          AND (
            object_id = ${pageId}
            OR metadata->>'containerPageId' = ${pageId}
          )
          AND object_type = 'page'
      )
      AND comment_id NOT IN (${sql.join(commentIds.map((id) => sql`${id}`), sql`, `)})
  `);
}

async function upsertObjects(client: SnapshotDbClient, userId: string, objects: NotionObjectSnapshot[]): Promise<void> {
  if (objects.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_objects (
      user_id, object_id, object_type, title, url, parent_type, parent_id, data_source_id, database_id,
      block_type, has_children, archived, in_trash, plain_text, object_hash, properties, metadata, raw,
      created_time, last_edited_time, created_by, last_edited_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(objects.map((object) => sql`(
      ${userId}, ${object.objectId}, ${object.objectType}, ${object.title}, ${object.url}, ${object.parentType},
      ${object.parentId}, ${object.dataSourceId}, ${object.databaseId}, ${object.blockType}, ${object.hasChildren},
      ${object.archived}, ${object.inTrash}, ${object.plainText}, ${object.objectHash},
      ${jsonb(object.properties)}, ${jsonb(object.metadata)}, ${jsonb(object.raw)},
      ${dateIso(object.createdTime)}::timestamptz, ${dateIso(object.lastEditedTime)}::timestamptz,
      ${jsonb(object.createdBy)}, ${jsonb(object.lastEditedBy)}, NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, object_id)
    DO UPDATE SET
      object_type = EXCLUDED.object_type,
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      data_source_id = EXCLUDED.data_source_id,
      database_id = EXCLUDED.database_id,
      block_type = EXCLUDED.block_type,
      has_children = EXCLUDED.has_children,
      archived = EXCLUDED.archived,
      in_trash = EXCLUDED.in_trash,
      plain_text = EXCLUDED.plain_text,
      object_hash = EXCLUDED.object_hash,
      properties = EXCLUDED.properties,
      metadata = EXCLUDED.metadata,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

async function upsertEdges(client: SnapshotDbClient, userId: string, edges: NotionObjectEdgeSnapshot[]): Promise<void> {
  if (edges.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_object_edges (
      user_id, parent_object_id, child_object_id, relation_type, position, source_object_id, metadata, child_hash, updated_at
    )
    VALUES ${sql.join(edges.map((edge) => sql`(
      ${userId}, ${edge.parentObjectId}, ${edge.childObjectId}, ${edge.relationType}, ${edge.position},
      ${edge.sourceObjectId}, ${jsonb(edge.metadata)}, ${edge.childHash}, NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, parent_object_id, child_object_id, relation_type)
    DO UPDATE SET
      position = EXCLUDED.position,
      source_object_id = EXCLUDED.source_object_id,
      metadata = EXCLUDED.metadata,
      child_hash = EXCLUDED.child_hash,
      updated_at = NOW()
  `);
}

async function upsertBlocks(client: SnapshotDbClient, userId: string, blocks: NotionBlockSnapshot[]): Promise<void> {
  if (blocks.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_block_snapshots (
      user_id, block_id, page_id, parent_type, parent_id, block_type, has_children, archived, in_trash,
      plain_text, markdown, content_hash, children_hash, table_cell_rich_text, raw, created_time, last_edited_time,
      created_by, last_edited_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(blocks.map((block) => sql`(
      ${userId}, ${block.blockId}, ${block.pageId}, ${block.parentType}, ${block.parentId}, ${block.blockType},
      ${block.hasChildren}, ${block.archived}, ${block.inTrash}, ${block.plainText}, ${block.markdown},
      ${block.contentHash}, ${block.childrenHash}, ${jsonb(block.tableCellRichText ?? null)}, ${jsonb(block.raw)}, ${dateIso(block.createdTime)}::timestamptz,
      ${dateIso(block.lastEditedTime)}::timestamptz, ${jsonb(block.createdBy)}, ${jsonb(block.lastEditedBy)}, NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, block_id)
    DO UPDATE SET
      page_id = EXCLUDED.page_id,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      block_type = EXCLUDED.block_type,
      has_children = EXCLUDED.has_children,
      archived = EXCLUDED.archived,
      in_trash = EXCLUDED.in_trash,
      plain_text = EXCLUDED.plain_text,
      markdown = EXCLUDED.markdown,
      content_hash = EXCLUDED.content_hash,
      children_hash = EXCLUDED.children_hash,
      table_cell_rich_text = EXCLUDED.table_cell_rich_text,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

async function upsertDataSources(client: SnapshotDbClient, userId: string, sources: NotionDataSourceSnapshot[]): Promise<void> {
  if (sources.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_data_source_snapshots (
      user_id, data_source_id, database_id, title, description, url, public_url, parent_type, parent_id,
      is_inline, archived, in_trash, icon, cover, properties, property_hash, raw, created_time, last_edited_time,
      created_by, last_edited_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(sources.map((source) => sql`(
      ${userId}, ${source.dataSourceId}, ${source.databaseId}, ${source.title}, ${jsonb(source.description)},
      ${source.url}, ${source.publicUrl}, ${source.parentType}, ${source.parentId}, ${source.isInline},
      ${source.archived}, ${source.inTrash}, ${jsonb(source.icon)}, ${jsonb(source.cover)},
      ${jsonb(source.properties)}, ${source.propertyHash}, ${jsonb(source.raw)}, ${dateIso(source.createdTime)}::timestamptz,
      ${dateIso(source.lastEditedTime)}::timestamptz, ${jsonb(source.createdBy)}, ${jsonb(source.lastEditedBy)},
      NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, data_source_id)
    DO UPDATE SET
      database_id = EXCLUDED.database_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      url = EXCLUDED.url,
      public_url = EXCLUDED.public_url,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      is_inline = EXCLUDED.is_inline,
      archived = EXCLUDED.archived,
      in_trash = EXCLUDED.in_trash,
      icon = EXCLUDED.icon,
      cover = EXCLUDED.cover,
      properties = EXCLUDED.properties,
      property_hash = EXCLUDED.property_hash,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

async function upsertDatabases(client: SnapshotDbClient, userId: string, databases: NotionDatabaseSnapshot[]): Promise<void> {
  if (databases.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_database_snapshots (
      user_id, database_id, title, description, url, public_url, parent_type, parent_id,
      is_inline, is_locked, in_trash, icon, cover, properties, data_sources, raw,
      created_time, last_edited_time, created_by, last_edited_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(databases.map((database) => sql`(
      ${userId}, ${database.databaseId}, ${database.title}, ${jsonb(database.description)}, ${database.url},
      ${database.publicUrl}, ${database.parentType}, ${database.parentId}, ${database.isInline},
      ${database.isLocked}, ${database.inTrash}, ${jsonb(database.icon)}, ${jsonb(database.cover)},
      ${jsonb(database.properties)}, ${jsonb(database.dataSources)}, ${jsonb(database.raw)},
      ${dateIso(database.createdTime)}::timestamptz, ${dateIso(database.lastEditedTime)}::timestamptz,
      ${jsonb(database.createdBy)}, ${jsonb(database.lastEditedBy)}, NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, database_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      url = EXCLUDED.url,
      public_url = EXCLUDED.public_url,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      is_inline = EXCLUDED.is_inline,
      is_locked = EXCLUDED.is_locked,
      in_trash = EXCLUDED.in_trash,
      icon = EXCLUDED.icon,
      cover = EXCLUDED.cover,
      properties = EXCLUDED.properties,
      data_sources = EXCLUDED.data_sources,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

async function upsertViews(client: SnapshotDbClient, userId: string, views: NotionViewSnapshot[]): Promise<void> {
  if (views.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_view_snapshots (
      user_id, view_id, database_id, data_source_id, name, view_type, url, parent_type, parent_id,
      dashboard_view_id, filter, sorts, quick_filters, configuration, query_result_page_ids, query_total_count, query_has_more,
      query_next_cursor, query_request_status, query_expires_at, query_fetched_at, query_raw,
      raw, created_time, last_edited_time, created_by, last_edited_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(views.map((view) => sql`(
      ${userId}, ${view.viewId}, ${view.databaseId}, ${view.dataSourceId}, ${view.name}, ${view.viewType},
      ${view.url}, ${view.parentType}, ${view.parentId}, ${view.dashboardViewId},
      ${jsonb(view.filter)}, ${jsonb(view.sorts)}, ${jsonb(view.quickFilters)}, ${jsonb(view.configuration)},
      ${jsonb(view.query?.resultPageIds ?? [])}, ${view.query?.totalCount ?? null}, ${view.query?.hasMore ?? false},
      ${view.query?.nextCursor ?? null}, ${jsonb(view.query?.requestStatus ?? null)},
      ${view.query?.expiresAt ?? null}::timestamptz, ${view.query?.fetchedAt ?? null}::timestamptz,
      ${jsonb(view.query?.raw ?? null)}, ${jsonb(view.raw)}, ${dateIso(view.createdTime)}::timestamptz,
      ${dateIso(view.lastEditedTime)}::timestamptz, ${jsonb(view.createdBy)}, ${jsonb(view.lastEditedBy)}, NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, view_id)
    DO UPDATE SET
      database_id = EXCLUDED.database_id,
      data_source_id = EXCLUDED.data_source_id,
      name = EXCLUDED.name,
      view_type = EXCLUDED.view_type,
      url = EXCLUDED.url,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      dashboard_view_id = EXCLUDED.dashboard_view_id,
      filter = EXCLUDED.filter,
      sorts = EXCLUDED.sorts,
      quick_filters = EXCLUDED.quick_filters,
      configuration = EXCLUDED.configuration,
      -- View metadata refreshes can succeed when the optional query fetch fails;
      -- keep the last valid query snapshot unless this write has a fresh fetched_at.
      query_result_page_ids = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_result_page_ids ELSE notion_view_snapshots.query_result_page_ids END,
      query_total_count = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_total_count ELSE notion_view_snapshots.query_total_count END,
      query_has_more = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_has_more ELSE notion_view_snapshots.query_has_more END,
      query_next_cursor = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_next_cursor ELSE notion_view_snapshots.query_next_cursor END,
      query_request_status = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_request_status ELSE notion_view_snapshots.query_request_status END,
      query_expires_at = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_expires_at ELSE notion_view_snapshots.query_expires_at END,
      query_fetched_at = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_fetched_at ELSE notion_view_snapshots.query_fetched_at END,
      query_raw = CASE WHEN EXCLUDED.query_fetched_at IS NOT NULL THEN EXCLUDED.query_raw ELSE notion_view_snapshots.query_raw END,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

async function upsertComments(client: SnapshotDbClient, userId: string, comments: NotionCommentSnapshot[]): Promise<void> {
  if (comments.length === 0) return;
  await client.execute(sql`
    INSERT INTO notion_comment_snapshots (
      user_id, comment_id, page_id, block_id, parent_type, parent_id, discussion_id, plain_text,
      rich_text, retrieval_request_status, retrieval_complete, retrieval_has_more, retrieval_next_cursor,
      raw, created_time, last_edited_time, created_by, last_synced_at, updated_at
    )
    VALUES ${sql.join(comments.map((comment) => sql`(
      ${userId}, ${comment.commentId}, ${comment.pageId}, ${comment.blockId}, ${comment.parentType},
      ${comment.parentId}, ${comment.discussionId}, ${comment.plainText}, ${jsonb(comment.richText)},
      ${jsonb(comment.retrievalRequestStatus)}, ${comment.retrievalComplete}, ${comment.retrievalHasMore}, ${comment.retrievalNextCursor},
      ${jsonb(comment.raw)}, ${dateIso(comment.createdTime)}::timestamptz,
      ${dateIso(comment.lastEditedTime)}::timestamptz, ${jsonb(comment.createdBy)}, NOW(), NOW()
    )`), sql`, `)}
    ON CONFLICT (user_id, comment_id)
    DO UPDATE SET
      page_id = EXCLUDED.page_id,
      block_id = EXCLUDED.block_id,
      parent_type = EXCLUDED.parent_type,
      parent_id = EXCLUDED.parent_id,
      discussion_id = EXCLUDED.discussion_id,
      plain_text = EXCLUDED.plain_text,
      rich_text = EXCLUDED.rich_text,
      retrieval_request_status = EXCLUDED.retrieval_request_status,
      retrieval_complete = EXCLUDED.retrieval_complete,
      retrieval_has_more = EXCLUDED.retrieval_has_more,
      retrieval_next_cursor = EXCLUDED.retrieval_next_cursor,
      raw = EXCLUDED.raw,
      created_time = EXCLUDED.created_time,
      last_edited_time = EXCLUDED.last_edited_time,
      created_by = EXCLUDED.created_by,
      last_synced_at = NOW(),
      updated_at = NOW()
  `);
}

function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`${JSON.stringify(redactProviderPayload("notion", value ?? null))}::jsonb`;
}

function dateIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
