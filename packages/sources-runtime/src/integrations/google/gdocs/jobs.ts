import { backfillGoogleDocsDetailed, discoverGoogleDocs, pollGoogleDocs, refreshCommentEdits, repairUnresolvedActors, sweepCommentActivity, type GoogleDocsBackfillResult, type GoogleDocsDiscoveryOptions, type GoogleDocsDiscoveryResult } from "./poller.js";

export async function runGdocsPoll(userId: string): Promise<{ events: number }> {
  const count = await pollGoogleDocs(userId);
  if (count > 0) {
    console.log(`Google Docs poll: ${count} document changes for user ${userId}`);
  }
  // Source lane: export changed Sheets/Slides/Drive files promptly, bounded
  // (file count + time budget) so the poll stays the freshness backbone.
  // Never fails the poll; deferred files stay due on their checkpoints.
  try {
    const { runGdocsSourceSweep, GDOCS_POLL_SWEEP_MAX_FILES, GDOCS_POLL_SWEEP_BUDGET_MS } = await import("../../../source-lane/providers/google-docs/sweep.js");
    await runGdocsSourceSweep(userId, { maxFiles: GDOCS_POLL_SWEEP_MAX_FILES, budgetMs: GDOCS_POLL_SWEEP_BUDGET_MS, includeDocs: false });
  } catch (err) {
    console.warn(`[gdocs] source sweep (poll) failed for ${userId}:`, err instanceof Error ? err.message : err);
  }
  // Source lane: advance the resumable full Drive inventory a few pages per poll, so files untouched since
  // connect are checkpointed (and then exported by the sweep). Bounded and fail-soft like the sweep.
  try {
    const { runDriveInventory, INVENTORY_POLL_MAX_PAGES, INVENTORY_POLL_BUDGET_MS } = await import("../../../source-lane/providers/google-docs/inventory.js");
    await runDriveInventory(userId, { maxPages: INVENTORY_POLL_MAX_PAGES, budgetMs: INVENTORY_POLL_BUDGET_MS });
  } catch (err) {
    console.warn(`[gdocs] drive inventory (poll) failed for ${userId}:`, err instanceof Error ? err.message : err);
  }
  return { events: count };
}

export async function runGdocsBackfill(userId: string, days?: number | null): Promise<GoogleDocsBackfillResult> {
  const result = await backfillGoogleDocsDetailed(userId, days ?? null);
  console.log(`Google Docs backfill: ${result.stored} documents stored for user ${userId} (lineage failures=${result.lineageFailures})`);
  return result;
}

export async function runGdocsDiscovery(userId: string, opts: GoogleDocsDiscoveryOptions): Promise<GoogleDocsDiscoveryResult> {
  const result = await discoverGoogleDocs(userId, opts);
  console.log(
    `Google Docs discovery (${result.mode}): ${result.tracked} doc(s) tracked` +
      ` (drives=${result.drivesScanned} folders=${result.foldersScanned}${result.foldersTruncated ? " TRUNCATED" : ""} lineage failures=${result.lineageFailures}) for user ${userId}`,
  );
  return result;
}

export async function runGdocsCommentSweep(userId: string): Promise<{ events: number }> {
  const count = await sweepCommentActivity(userId);
  if (count > 0) {
    console.log(`Google Docs comment sweep: ${count} comment events for user ${userId}`);
  }
  return { events: count };
}

export async function runGdocsActorRepair(userId: string): Promise<{ repaired: number }> {
  const repaired = await repairUnresolvedActors(userId);
  if (repaired > 0) {
    console.log(`Google Docs actor repair: ${repaired} events repaired for user ${userId}`);
  }
  return { repaired };
}

export async function runGdocsCommentRefresh(userId: string): Promise<{ updated: number }> {
  const updated = await refreshCommentEdits(userId);
  if (updated > 0) {
    console.log(`Google Docs comment refresh: ${updated} edited comments updated for user ${userId}`);
  }
  return { updated };
}

export async function runGdocsContentSnapshot(
  userId: string,
  docId: string,
  options?: {
    modifiedTime?: string | null;
    authorEmail?: string | null;
    authorName?: string | null;
    updatedByEmail?: string | null;
    updatedByName?: string | null;
  },
): Promise<{ status: string; revisionId: string | null; tabRowsInserted: number }> {
  const { snapshotDocContent } = await import("./content-snapshot.js");
  const source = await import("../../../source-lane/providers/google-docs/sweep.js");
  const { getCheckpoint, clearRematerializePending } = await import("../../../source-lane/providers/google-docs/checkpoints.js");
  const checkpoint = await getCheckpoint(userId, docId).catch(() => null);
  // A restored doc (trash -> untrash) had its mirror + source files
  // tombstoned: re-fetch past the modifiedTime dedupe and re-stage the mirror.
  const restored = checkpoint?.rematerializePending === true;
  const result = await snapshotDocContent(userId, docId, {
    ...(options ?? {}),
    ...(restored ? { modifiedTime: null, forceMaterialize: true } : {}),
  });
  if (restored) await clearRematerializePending(userId, docId).catch(() => {});
  if (result.status === "captured") {
    console.log(
      `Google Docs content snapshot: ${result.tabRowsInserted} tab row(s) at revision ${result.revisionId} for doc ${docId} (user ${userId})`,
    );
  }
  // Source lane: OT change history (raw changelog, sessions, suggestions,
  // tabs). Fail-closed and fail-soft: partial/blocked outcomes are recorded
  // on the checkpoint + status file and retried by the sweep.
  const title = result.title ?? checkpoint?.name ?? null;
  if (title) {
    await source.runDocHistoryAfterSnapshot(userId, docId, title, { modifiedTime: options?.modifiedTime ?? null });
  }
  return { status: result.status, revisionId: result.revisionId, tabRowsInserted: result.tabRowsInserted };
}

export async function runGdocsSuggestionSync(
  userId: string,
  docIds?: string[],
): Promise<{ suggestionsUpserted: number; changelogOk: number; changelogNull: number }> {
  const { syncDocSuggestions } = await import("./suggestion-cards.js");
  const r = await syncDocSuggestions(userId, docIds && docIds.length > 0 ? { docIds } : {});
  // Source lane: the hourly full sync also retries due source exports
  // (Docs content + history, Sheets/Slides/Drive files) at their checkpoint
  // retry times (Retry-After / exponential backoff).
  if (!docIds || docIds.length === 0) {
    try {
      const { runGdocsSourceSweep, GDOCS_FULL_SWEEP_MAX_FILES } = await import("../../../source-lane/providers/google-docs/sweep.js");
      await runGdocsSourceSweep(userId, { maxFiles: GDOCS_FULL_SWEEP_MAX_FILES, budgetMs: 10 * 60 * 1000, includeDocs: true });
    } catch (err) {
      console.warn(`[gdocs] source sweep failed for ${userId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (r.suggestionsUpserted > 0 || r.tabEventsUpserted > 0 || r.changelogNull > 0) {
    const scope = docIds && docIds.length > 0 ? `targeted ${docIds.length} doc(s)` : `${r.docsSeen} active docs`;
    console.log(
      `Google Docs changelog sync (${scope}): ${r.suggestionsUpserted} suggestions, ${r.tabEventsUpserted} tab events, ${r.tabsUpserted} tabs (changelog ok=${r.changelogOk} null=${r.changelogNull}) for user ${userId}`,
    );
  }
  return { suggestionsUpserted: r.suggestionsUpserted, changelogOk: r.changelogOk, changelogNull: r.changelogNull };
}
