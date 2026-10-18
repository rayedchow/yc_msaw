import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enqueueTask } from "../../queue/queue.js";
import {
  notionDataSourceParentPageId,
  retrieveNotionBlock,
  retrieveNotionDatabase,
  retrieveNotionDataSource,
  retrieveNotionPage,
  type NotionParent,
} from "./client.js";
import {
  fetchAndMaterializeNotionPageContentSourceWiki,
  type StoredNotionSectionSummaries,
} from "./source-wiki.js";

const DEFAULT_NOTION_RENDER_LIMIT = 25;
const MAX_NOTION_RENDER_LIMIT = 100;

type DirtyNotionPageRow = {
  page_id: string;
  title: string;
  parent_type: string | null;
  parent_id: string | null;
  data_source_id: string | null;
  overview: string | null;
  section_summaries: StoredNotionSectionSummaries;
  dirty_at: string | Date;
};

export type NotionRenderResult = {
  rendered: number;
  failed: number;
  remaining: number;
};

export async function runNotionRender(userId: string, opts: {
  limit?: number | null;
  heartbeat?: () => Promise<void>;
} = {}): Promise<NotionRenderResult> {
  const limit = normalizeRenderLimit(opts.limit);
  const rows = await claimDirtyNotionPageRows(userId, limit);
  let rendered = 0;
  let failed = 0;
  const renderedTargets = new Set<string>();

  for (const row of rows) {
    const result = await renderDirtyNotionPageRow(userId, row, renderedTargets);
    if (result === "rendered") rendered++;
    if (result === "failed") failed++;
    await opts.heartbeat?.();
  }

  const remaining = await countRemainingDirtyNotionPages(userId);
  if (remaining > 0) {
    await enqueueNotionRender(userId, limit);
  }

  return { rendered, failed, remaining };
}

async function claimDirtyNotionPageRows(userId: string, limit: number): Promise<DirtyNotionPageRow[]> {
  return rowsFromExecute<DirtyNotionPageRow>(await db.execute(sql`
    SELECT
      page_id, title, parent_type, parent_id, data_source_id,
      overview, section_summaries, dirty_at
    FROM notion_page_summaries
    WHERE user_id = ${userId}
      AND dirty_at IS NOT NULL
    ORDER BY dirty_at ASC, page_id ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `));
}

async function renderDirtyNotionPageRow(
  userId: string,
  row: DirtyNotionPageRow,
  renderedTargets: Set<string>,
): Promise<"rendered" | "failed" | "skipped"> {
  try {
    const targetPageId = await renderTargetPageId(userId, row);
    if (!targetPageId) {
      console.warn(`[notion-render] Skipping dirty Notion stub ${row.page_id}: no renderable parent found.`);
      await clearDirtyNotionPage(userId, row);
      return "skipped";
    }

    try {
      await renderNotionPageTarget(userId, targetPageId, row, renderedTargets);
      await clearDirtyNotionPage(userId, row);
      return "rendered";
    } catch (err) {
      if (!isNotionNotFoundError(err)) throw err;

      const parentTarget = targetPageId === row.page_id
        ? await fallbackParentRenderTarget(userId, row)
        : null;
      if (parentTarget && parentTarget !== targetPageId) {
        await renderNotionPageTarget(userId, parentTarget, row, renderedTargets);
        await clearDirtyNotionPage(userId, row);
        return "rendered";
      }

      console.warn(`[notion-render] Skipping dirty Notion page ${row.page_id}: fetch returned 404 and no renderable parent was found.`);
      await clearDirtyNotionPage(userId, row);
      return "skipped";
    }
  } catch (err) {
    console.warn(`[notion-render] Failed to render Notion page ${row.page_id}:`, err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

async function renderNotionPageTarget(
  userId: string,
  pageId: string,
  row: DirtyNotionPageRow,
  renderedTargets: Set<string>,
): Promise<void> {
  if (renderedTargets.has(pageId)) return;
  await fetchAndMaterializeNotionPageContentSourceWiki({
    userId,
    pageId,
    overview: row.overview ?? "",
    sectionSummaries: row.section_summaries,
    refreshIndexes: false,
  });
  renderedTargets.add(pageId);
}

async function renderTargetPageId(userId: string, row: DirtyNotionPageRow): Promise<string | null> {
  if (shouldRenderStoredParent(row)) {
    const storedParentTarget = await renderTargetFromStoredParent(userId, row);
    if (storedParentTarget) return storedParentTarget;
  }

  if (!isStubDirtyRow(row)) return row.page_id;

  try {
    const page = await retrieveNotionPage(userId, row.page_id);
    return await renderTargetFromParent(userId, page.parent) ?? row.page_id;
  } catch (err) {
    if (!isNotionNotFoundError(err)) throw err;
    return await fallbackParentRenderTarget(userId, row);
  }
}

async function fallbackParentRenderTarget(userId: string, row: DirtyNotionPageRow): Promise<string | null> {
  return await renderTargetFromStoredParent(userId, row)
    ?? await renderTargetFromDataSource(userId, row.data_source_id)
    ?? await renderTargetFromDataSource(userId, row.page_id)
    ?? null;
}

function shouldRenderStoredParent(row: DirtyNotionPageRow): boolean {
  return row.parent_type === "data_source_id"
    || row.parent_type === "database_id"
    || isStubDirtyRow(row);
}

async function renderTargetFromStoredParent(userId: string, row: DirtyNotionPageRow): Promise<string | null> {
  if (row.parent_type === "data_source_id" || row.parent_type === "database_id") {
    return await renderTargetFromDataSource(userId, row.parent_id ?? row.data_source_id);
  }
  if (row.parent_type === "page_id") return row.parent_id;
  if (row.parent_type === "block_id" && row.parent_id) {
    return await renderTargetFromBlockParent(userId, row.parent_id);
  }
  return null;
}

async function renderTargetFromParent(userId: string, parent: NotionParent | undefined): Promise<string | null> {
  if (!parent?.type) return null;
  if (parent.type === "page_id") return parent.page_id ?? null;
  if (parent.type === "block_id" && parent.block_id) {
    return await renderTargetFromBlockParent(userId, parent.block_id);
  }
  if (parent.type === "data_source_id") {
    return await renderTargetFromDataSource(userId, parent.data_source_id);
  }
  if (parent.type === "database_id") {
    return await renderTargetFromDataSource(userId, parent.database_id);
  }
  return null;
}

async function renderTargetFromBlockParent(userId: string, blockId: string): Promise<string | null> {
  const seen = new Set<string>();
  let current: string | null = blockId;
  while (current && !seen.has(current) && seen.size < 20) {
    seen.add(current);
    const block = await retrieveNotionBlock(userId, current);
    const parent = block.parent;
    if (parent?.type === "page_id") return parent.page_id ?? null;
    if (parent?.type === "data_source_id") {
      return await renderTargetFromDataSource(userId, parent.data_source_id);
    }
    if (parent?.type === "database_id") {
      return await renderTargetFromDataSource(userId, parent.database_id);
    }
    current = parent?.type === "block_id" ? parent.block_id ?? null : null;
  }
  return null;
}

async function renderTargetFromDataSource(userId: string, dataSourceId: string | null | undefined): Promise<string | null> {
  if (!dataSourceId) return null;
  try {
    const source = await retrieveNotionDataSource(userId, dataSourceId);
    return notionDataSourceParentPageId(source) ?? dataSourceId;
  } catch (sourceErr) {
    if (!isNotionNotFoundError(sourceErr)) throw sourceErr;
    try {
      const database = await retrieveNotionDatabase(userId, dataSourceId);
      return database.parent?.page_id ?? dataSourceId;
    } catch (databaseErr) {
      if (isNotionNotFoundError(databaseErr)) return null;
      throw databaseErr;
    }
  }
}

async function clearDirtyNotionPage(userId: string, row: DirtyNotionPageRow): Promise<void> {
  await db.execute(sql`
    UPDATE notion_page_summaries
    SET dirty_at = NULL,
        last_synced_at = NOW(),
        updated_at = NOW()
    WHERE user_id = ${userId}
      AND page_id = ${row.page_id}
      AND dirty_at IS NOT NULL
      AND dirty_at <= ${dirtyAtSql(row.dirty_at)}::timestamptz
  `);
}

async function countRemainingDirtyNotionPages(userId: string): Promise<number> {
  const rows = rowsFromExecute<{ remaining: number | string }>(await db.execute(sql`
    SELECT count(*)::int AS remaining
    FROM notion_page_summaries
    WHERE user_id = ${userId}
      AND dirty_at IS NOT NULL
  `));
  return Number(rows[0]?.remaining ?? 0);
}

async function enqueueNotionRender(userId: string, limit: number): Promise<void> {
  await enqueueTask({
    queue: "sync",
    tenantId: userId,
    kind: "notion.render",
    payload: { userId, limit },
    groupKey: `${userId}:notion`,
    dedupeKey: `${userId}:notion:render`,
  });
}

function normalizeRenderLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_NOTION_RENDER_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_NOTION_RENDER_LIMIT));
}

function isStubDirtyRow(row: DirtyNotionPageRow): boolean {
  return row.title === row.page_id;
}

function dirtyAtSql(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isNotionNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("(404)") || message.toLowerCase().includes("could not find");
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
