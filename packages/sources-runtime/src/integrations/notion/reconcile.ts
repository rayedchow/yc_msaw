import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notionPageSummaries } from "../../db/schema.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import {
  notionApiErrorSummary,
  retrieveNotionDatabase,
  retrieveNotionDataSource,
  retrieveNotionPage,
  type NotionPage,
} from "./client.js";
import { discoverNotionPages, removeNotionPageContent } from "./poller.js";
import { emitNotionTombstoneEvent } from "./tombstone.js";

const NOTION_RECONCILE_LIST_MAX_PAGES = 5000;
const NOTION_RECONCILE_LIST_MAX_DATA_SOURCES = 500;
const NOTION_RECONCILE_VERIFY_CAP = 200;
const NOTION_RECONCILE_VERIFY_CONCURRENCY = parseConcurrencyEnv("NOTION_RECONCILE_VERIFY_CONCURRENCY", 5, { max: 10 });

type KnownNotionPageRow = {
  pageId: string;
  title: string;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  dataSourceId: string | null;
  lastEditedTime: Date | null;
};

export type NotionReconcileResult = {
  known: number;
  listed: number;
  missing: number;
  verified: number;
  tombstoned: number;
  stillAccessible: number;
  trashed: number;
  /** No-silent-skips accounting (persisted in the source_sync_runs result). */
  skips: {
    listingCapHit?: number;
    verifyCapDeferred?: number;
    verifyErrors?: number;
  };
  capHit: boolean;
};

/**
 * Unshare reconciliation: pages that vanish from Notion's search listing
 * (unshared from the integration, or trashed while unlisted) never produce a
 * webhook and are invisible to the poll's listing-based sweep. This task
 * compares the known set (notion_page_summaries) against a full listing and
 * tombstones pages that are BOTH missing from the listing AND confirmed
 * inaccessible by direct fetch (404/403 on the page, with data-source and
 * database fallbacks for standalone data-source pseudo-pages).
 *
 * False-positive guards:
 * - Listing hit its page cap -> skip the whole sweep (missing-from-listing is
 *   meaningless when the listing is truncated).
 * - Search is eventually consistent -> a page is only tombstoned when a direct
 *   fetch also fails with 404/403; any other status defers to the next run.
 */
export async function reconcileNotionPages(userId: string): Promise<NotionReconcileResult> {
  const listedPages = await discoverNotionPages(userId, {
    maxPages: NOTION_RECONCILE_LIST_MAX_PAGES,
    includeDataSources: true,
    maxDataSources: NOTION_RECONCILE_LIST_MAX_DATA_SOURCES,
  });

  const knownRows: KnownNotionPageRow[] = await db
    .select({
      pageId: notionPageSummaries.pageId,
      title: notionPageSummaries.title,
      url: notionPageSummaries.url,
      parentType: notionPageSummaries.parentType,
      parentId: notionPageSummaries.parentId,
      dataSourceId: notionPageSummaries.dataSourceId,
      lastEditedTime: notionPageSummaries.lastEditedTime,
    })
    .from(notionPageSummaries)
    .where(eq(notionPageSummaries.userId, userId));

  const result: NotionReconcileResult = {
    known: knownRows.length,
    listed: listedPages.length,
    missing: 0,
    verified: 0,
    tombstoned: 0,
    stillAccessible: 0,
    trashed: 0,
    skips: {},
    capHit: false,
  };

  if (listedPages.length >= NOTION_RECONCILE_LIST_MAX_PAGES) {
    result.capHit = true;
    result.skips.listingCapHit = knownRows.length;
    return result;
  }

  const listedIds = new Set(listedPages.map((page) => page.id));
  const missingRows = knownRows.filter((row) => !listedIds.has(row.pageId));
  result.missing = missingRows.length;
  if (missingRows.length === 0) return result;

  // Webhook stubs for data-source row pages (title === pageId) are expected to
  // be absent from the listing (rows collapse into their parent page); verify
  // real pages first so stubs can't starve the per-run cap.
  const orderedMissing = [
    ...missingRows.filter((row) => row.title !== row.pageId),
    ...missingRows.filter((row) => row.title === row.pageId),
  ];
  const toVerify = orderedMissing.slice(0, NOTION_RECONCILE_VERIFY_CAP);
  if (orderedMissing.length > toVerify.length) {
    result.skips.verifyCapDeferred = orderedMissing.length - toVerify.length;
  }

  let verifyErrors = 0;
  await mapWithConcurrency(toVerify, NOTION_RECONCILE_VERIFY_CONCURRENCY, async (row) => {
    const verification = await verifyNotionPageAccess(userId, row.pageId);
    result.verified++;

    if (verification.outcome === "accessible") {
      const page = verification.page;
      if (page && (page.in_trash || page.is_archived || page.archived)) {
        // Trashed pages drop out of search, so the poll's listing-based trash
        // sweep never sees them; tombstone through the same page.deleted path.
        await emitNotionTombstoneEvent(userId, {
          eventType: "page.deleted",
          externalId: row.pageId,
          versionRef: page.last_edited_time ?? row.lastEditedTime?.toISOString() ?? "unknown",
          timestamp: page.last_edited_time ? new Date(page.last_edited_time) : row.lastEditedTime,
          payload: {
            eventType: "page.deleted",
            detectedVia: "reconcile",
            pageId: row.pageId,
            inTrash: Boolean(page.in_trash),
            archived: Boolean(page.is_archived || page.archived),
            page,
          },
        });
        await removeNotionPageContent(userId, row.pageId);
        result.trashed++;
        return;
      }
      result.stillAccessible++;
      return;
    }

    if (verification.outcome === "inaccessible") {
      await emitNotionTombstoneEvent(userId, {
        eventType: "page.unshared",
        externalId: row.pageId,
        versionRef: row.lastEditedTime?.toISOString() ?? "unknown",
        timestamp: row.lastEditedTime,
        payload: {
          eventType: "page.unshared",
          detectedVia: "reconcile",
          pageId: row.pageId,
          title: row.title,
          url: row.url,
          parentType: row.parentType,
          parentId: row.parentId,
          dataSourceId: row.dataSourceId,
          lastEditedTime: row.lastEditedTime?.toISOString() ?? null,
          verification: verification.statuses,
        },
      });
      await removeNotionPageContent(userId, row.pageId);
      result.tombstoned++;
      return;
    }

    verifyErrors++;
  });
  if (verifyErrors > 0) result.skips.verifyErrors = verifyErrors;

  return result;
}

type NotionAccessVerification =
  | { outcome: "accessible"; page: NotionPage | null }
  | { outcome: "inaccessible"; statuses: Record<string, number> }
  | { outcome: "unverified" };

/**
 * A page is only confirmed inaccessible when the direct page fetch AND the
 * data-source/database fallbacks (for standalone data-source pseudo-pages,
 * whose summary rows reuse the data-source id) all fail with 404/403.
 */
async function verifyNotionPageAccess(userId: string, pageId: string): Promise<NotionAccessVerification> {
  const statuses: Record<string, number> = {};

  const pageStatus = await fetchStatus(() => retrieveNotionPage(userId, pageId));
  if (pageStatus.ok) return { outcome: "accessible", page: pageStatus.value };
  if (!isGoneStatus(pageStatus.status)) return { outcome: "unverified" };
  statuses.page = pageStatus.status;

  const dataSourceStatus = await fetchStatus(() => retrieveNotionDataSource(userId, pageId));
  if (dataSourceStatus.ok) return { outcome: "accessible", page: null };
  if (!isGoneStatus(dataSourceStatus.status)) return { outcome: "unverified" };
  statuses.dataSource = dataSourceStatus.status;

  const databaseStatus = await fetchStatus(() => retrieveNotionDatabase(userId, pageId));
  if (databaseStatus.ok) return { outcome: "accessible", page: null };
  if (!isGoneStatus(databaseStatus.status)) return { outcome: "unverified" };
  statuses.database = databaseStatus.status;

  return { outcome: "inaccessible", statuses };
}

async function fetchStatus<T>(fetch: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; status: number }> {
  try {
    return { ok: true, value: await fetch() };
  } catch (err) {
    const summary = notionApiErrorSummary(err);
    return { ok: false, status: summary?.status ?? 0 };
  }
}

function isGoneStatus(status: number): boolean {
  return status === 404 || status === 403;
}
