import { syncNotionPages } from "./poller.js";
import { reconcileNotionPages, type NotionReconcileResult } from "./reconcile.js";
import { runNotionRender, type NotionRenderResult } from "./render.js";

const NOTION_RECONCILE_MAX_PAGES = 300;

export async function runNotionPoll(userId: string): Promise<{ discovered: number; markedDirty: number; exhausted: boolean; capHit: boolean }> {
  const result = await syncNotionPages(userId, {
    maxPages: NOTION_RECONCILE_MAX_PAGES,
    includeDataSources: true,
    maxDataSources: 100,
  });
  if (result.markedDirty > 0) {
    console.log(`Notion poll: ${result.markedDirty} changed pages for user ${userId}`);
  }
  return result;
}

export async function runNotionBackfill(userId: string, opts: {
  days?: number | null;
  maxPages?: number | null;
} = {}): Promise<{ discovered: number; markedDirty: number; exhausted: boolean; capHit: boolean }> {
  const result = await syncNotionPages(userId, {
    days: opts.days ?? null,
    maxPages: opts.maxPages ?? 5000,
    includeDataSources: true,
    maxDataSources: 500,
  });
  console.log(`Notion backfill: ${result.discovered} pages discovered, ${result.markedDirty} marked dirty for user ${userId}`);
  return result;
}

export async function runNotionReconcile(userId: string): Promise<NotionReconcileResult> {
  const result = await reconcileNotionPages(userId);
  if (result.tombstoned > 0 || result.trashed > 0 || result.capHit) {
    console.log(`Notion reconcile: tombstoned=${result.tombstoned} trashed=${result.trashed} stillAccessible=${result.stillAccessible} capHit=${result.capHit} for user ${userId}`);
  }
  return result;
}

export async function runNotionRenderDirtyPages(userId: string, opts: {
  limit?: number | null;
  heartbeat?: () => Promise<void>;
} = {}): Promise<NotionRenderResult> {
  const result = await runNotionRender(userId, opts);
  if (result.rendered > 0 || result.failed > 0) {
    console.log(`Notion render: rendered=${result.rendered} failed=${result.failed} remaining=${result.remaining} for user ${userId}`);
  }
  return result;
}
