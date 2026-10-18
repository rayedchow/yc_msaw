/**
 * Suggestion cards - the deterministic join of the three suggestion signals.
 *
 * Combines:
 *   1. Docs API `SUGGESTIONS_INLINE` → suggestion CONTENT + PLACEMENT
 *      (insertedText/deletedText + contextBefore/contextAfter), keyed `suggest.*`.
 *   2. OT changelog (`/revisions/load`) → suggestion AUTHOR + status/timestamps,
 *      keyed `sugId` - the SAME `suggest.*` namespace.
 *
 * The join is by exact suggestion ID (`suggest.*` == `sugId`), no timing
 * heuristic. Author display names come from the changelog `userMap`
 * (People-API-independent). This is the "who suggested what, where, and what
 * happened to it" card, deterministic end to end.
 *
 * Access: content needs commenter+ (SUGGESTIONS_INLINE 403s at reader); the
 * changelog needs writer+. So a full card requires writer+ on the doc - under
 * DWD, docs the impersonated user can edit. When the changelog is unavailable
 * (role/endpoint), cards still carry content + placement with author = null.
 */
import { fetchDocContent, type DocSuggestion, type DocContent } from "./content.js";
import { fetchDocChangelog } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { trackSuggestions, type SuggestionStatus } from "../../../polling/_archived-gdocs/gdocs-suggestion-tracker.js";
import { extractTabChanges, tabTreeSignature } from "./tab-changes.js";

export interface SuggestionCard {
  suggestionId: string;
  tabId: string;
  tabName: string;
  /** Proposed inserted text (empty if pure deletion). */
  insertedText: string;
  /** Existing text proposed for deletion (empty if pure insertion). */
  deletedText: string;
  /** Durable placement anchors from base content. */
  contextBefore: string;
  contextAfter: string;
  /** Author, from the changelog - null when the changelog wasn't available. */
  authorUserId: string | null;
  authorName: string | null;
  /** Lifecycle status from the changelog; "pending" fallback when unknown. */
  status: SuggestionStatus | "unknown";
  /** First-edit time - exact op timestamp from the changelog, not derived. */
  createdAt: Date | null;
  /**
   * Time of the latest modification to this suggestion (suggester kept
   * typing). Exact op timestamp from the changelog - Google records no
   * "EDITED" event anywhere else, so this is the ONLY non-heuristic source of
   * "when was the suggestion updated". Null if never modified after creation.
   */
  lastModifiedAt: Date | null;
  /** How many times the suggestion text was changed after creation. */
  modificationCount: number;
  /** When accepted/rejected, and by whom (exact op timestamp). */
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  /** True when author/status came from the changelog (deterministic), not defaulted. */
  authorshipResolved: boolean;
}

export interface SuggestionCardResult {
  docId: string;
  title: string;
  cards: SuggestionCard[];
  /** False when the OT changelog couldn't be fetched (role/endpoint); cards then lack authorship. */
  changelogAvailable: boolean;
  /**
   * False when we skipped the changelog fetch entirely because the doc has no
   * pending suggestions - nothing to attribute. Lets the sync distinguish
   * "skipped, no cost" from "tried, endpoint returned null" so the null-rate
   * tripwire isn't inflated by suggestion-free docs.
   */
  changelogAttempted: boolean;
}

type Changelog = Awaited<ReturnType<typeof fetchDocChangelog>>;

/** Pending suggestions with their tab, flattened across a doc's tabs. */
function pendingSuggestions(doc: DocContent): Array<{ tabId: string; tabName: string; suggestion: DocSuggestion }> {
  const out: Array<{ tabId: string; tabName: string; suggestion: DocSuggestion }> = [];
  for (const tab of doc.tabs) {
    for (const suggestion of tab.suggestions) {
      if (!suggestion.insertedText && !suggestion.deletedText) continue;
      out.push({ tabId: tab.tabId, tabName: tab.tabName, suggestion });
    }
  }
  return out;
}

/** Pure join: pending suggestions (content/placement) × changelog (authorship). */
function suggestionCardsFromParts(
  contentByTab: Array<{ tabId: string; tabName: string; suggestion: DocSuggestion }>,
  changelog: Changelog,
): SuggestionCard[] {
  const lifecycleById = new Map<string, import("../../../polling/_archived-gdocs/gdocs-suggestion-tracker.js").SuggestionLifecycle>();
  const nameOf = (userId: string | undefined): string | null =>
    userId ? changelog?.userMap.get(userId)?.name ?? null : null;
  if (changelog) {
    for (const life of trackSuggestions(changelog).suggestions) lifecycleById.set(life.sugId, life);
  }
  return contentByTab.map(({ tabId, tabName, suggestion }) => {
    const life = lifecycleById.get(suggestion.suggestionId);
    return {
      suggestionId: suggestion.suggestionId,
      tabId,
      tabName,
      insertedText: suggestion.insertedText,
      deletedText: suggestion.deletedText,
      contextBefore: suggestion.contextBefore,
      contextAfter: suggestion.contextAfter,
      authorUserId: life?.authorUserId ?? null,
      authorName: nameOf(life?.authorUserId),
      status: life?.status ?? "unknown",
      createdAt: life?.createdAt ?? null,
      lastModifiedAt: life?.lastModifiedAt ?? null,
      modificationCount: life?.modificationCount ?? 0,
      resolvedAt: life?.resolvedAt ?? null,
      resolvedByUserId: life?.resolvedByUserId ?? null,
      resolvedByName: nameOf(life?.resolvedByUserId),
      authorshipResolved: Boolean(life),
    };
  });
}

export async function buildSuggestionCards(userId: string, docId: string): Promise<SuggestionCardResult> {
  const doc = await fetchDocContent(userId, docId);
  const contentByTab = pendingSuggestions(doc);

  // No pending suggestions → no cards to build and nothing to attribute. Skip
  // the (undocumented, writer+-gated) changelog call entirely. Most active
  // docs land here, so this is the dominant cost saver at org scale.
  if (contentByTab.length === 0) {
    return { docId: doc.docId, title: doc.title, cards: [], changelogAvailable: false, changelogAttempted: false };
  }

  // Fails soft: if the undocumented endpoint is unavailable or the caller lacks
  // writer+, changelog is null and cards carry content+placement without author.
  const changelog = await fetchDocChangelog(userId, docId);
  const cards = suggestionCardsFromParts(contentByTab, changelog);
  return { docId: doc.docId, title: doc.title, cards, changelogAvailable: Boolean(changelog), changelogAttempted: true };
}

export interface SuggestionSyncResult {
  docsSeen: number;
  /** Docs where the OT changelog resolved (writer+ access, endpoint up). */
  changelogOk: number;
  /** Docs where the changelog returned null (no access, or endpoint down). */
  changelogNull: number;
  suggestionsUpserted: number;
  tabEventsUpserted: number;
  tabsUpserted: number;
}

const SYNC_INTER_DOC_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Changelog sync: from ONE changelog fetch per doc, derive and persist both
 * suggestion cards (`google_doc_suggestions`) and tab changes
 * (`google_doc_tab_events` + `google_doc_tabs`).
 *
 * Two entry modes:
 *  - Full sweep (hourly, `opts.docIds` omitted): every doc active in the last
 *    72h. Backstop coverage; paced between docs.
 *  - Targeted (`opts.docIds`): just those docs - enqueued by the comment sweep
 *    on a suggestion Activity event, for near-60s freshness.
 *
 * Changelog-fetch gate (the cost saver): the undocumented, writer+-gated
 * changelog is fetched only when the doc has **pending suggestions** OR its
 * **tab tree drifted** since the last sync (cheap Docs-API signature vs. stored
 * `google_doc_tabs`). A doc with neither skips the fetch entirely. Fail-soft:
 * if the endpoint is down / access lost, the fetch returns null and the doc
 * still persists content-only suggestion cards; tab data needs the changelog,
 * so it's simply absent for that run.
 */
export async function syncDocSuggestions(
  userId: string,
  opts: { docIds?: string[]; lookbackHours?: number; accessToken?: string } = {},
): Promise<SuggestionSyncResult> {
  const { db } = await import("../../../db/client.js");
  const { googleDocSuggestions, googleDocTabEvents, googleDocTabs, googleDocSyncState } = await import("../../../db/schema.js");
  const { sql } = await import("drizzle-orm");

  const targeted = Boolean(opts.docIds && opts.docIds.length > 0);
  const rowsToArr = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as T[];
  // Bind a JS string list for `col IN (...)`. drizzle interpolates a bare array
  // as a parenthesized *param list*, which `= ANY()` reads as a record, not a
  // Postgres array (it errors). Spreading each element as its own param is the
  // portable form. Empty list → a fragment that matches nothing.
  const inList = (values: string[]) =>
    values.length ? sql.join(values.map((v) => sql`${v}`), sql`, `) : sql`NULL`;

  // Candidate docs with their current modifiedTime watermark. Targeted docs
  // always process (the event fired because something changed); the sweep uses
  // last_seen_ts for the skip-unchanged check below.
  let docs: Array<{ docId: string; lastSeenTs: string | null }>;
  if (targeted) {
    const ids = [...new Set(opts.docIds!)];
    const seenRows = rowsToArr<{ doc_id: string; last_seen_ts: string | null; is_active: boolean }>(await db.execute(sql`
      SELECT conversation_id AS doc_id, last_seen_ts, is_active FROM conversation_watermarks
      WHERE user_id = ${userId} AND provider = 'gdocs' AND conversation_id IN (${inList(ids)})
    `));
    const seen = new Map(seenRows.map((r) => [r.doc_id, r]));
    // A deactivated watermark means the doc was removed/trashed - a targeted
    // event that raced the removal must not resurrect its derived rows.
    // Untracked docs (no watermark row) still process; only explicit
    // deactivation skips.
    const dead = ids.filter((docId) => seen.get(docId)?.is_active === false);
    if (dead.length > 0) {
      console.log(`[gdocs] targeted sync: skipping ${dead.length} removed/trashed doc(s): ${dead.join(", ")}`);
    }
    docs = ids
      .filter((docId) => seen.get(docId)?.is_active !== false)
      .map((docId) => ({ docId, lastSeenTs: seen.get(docId)?.last_seen_ts ?? null }));
  } else {
    const activeSinceIso = new Date(Date.now() - (opts.lookbackHours ?? 72) * 60 * 60 * 1000).toISOString();
    const docRows = rowsToArr<{ doc_id: string; last_seen_ts: string | null }>(await db.execute(sql`
      SELECT conversation_id AS doc_id, last_seen_ts
      FROM conversation_watermarks
      WHERE user_id = ${userId} AND provider = 'gdocs' AND is_active = true
        AND last_seen_ts IS NOT NULL AND last_seen_ts >= ${activeSinceIso}
      ORDER BY last_seen_ts DESC
      LIMIT 200
    `));
    docs = docRows.map((r) => ({ docId: r.doc_id, lastSeenTs: r.last_seen_ts }));
  }

  // Preload the last-successful-sync watermark per doc (skip-unchanged check).
  const syncStateRows = rowsToArr<{ doc_id: string; last_synced_seen_ts: string | null }>(await db.execute(sql`
    SELECT doc_id, last_synced_seen_ts FROM google_doc_sync_state
    WHERE user_id = ${userId} AND doc_id IN (${inList(docs.map((d) => d.docId))})
  `));
  const lastSynced = new Map(syncStateRows.map((r) => [r.doc_id, r.last_synced_seen_ts]));

  const result: SuggestionSyncResult = {
    docsSeen: 0, changelogOk: 0, changelogNull: 0, suggestionsUpserted: 0, tabEventsUpserted: 0, tabsUpserted: 0,
  };

  let processedIndex = -1;
  for (const { docId, lastSeenTs } of docs) {
    // Sweep-only skip: a doc whose modifiedTime hasn't advanced since its last
    // successful sync has no new suggestions or tab changes (both bump
    // modifiedTime) - nothing to sync, no info lost. Targeted docs never skip.
    if (!targeted && lastSeenTs && (lastSynced.get(docId) ?? "") >= lastSeenTs) continue;

    processedIndex++;
    if (processedIndex > 0) await sleep(SYNC_INTER_DOC_DELAY_MS);
    result.docsSeen++;

    let doc: DocContent;
    try {
      doc = await fetchDocContent(userId, docId, opts.accessToken);
    } catch (err) {
      console.warn(`[gdocs] sync: content fetch failed for ${docId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    const contentByTab = pendingSuggestions(doc);

    // Cheap tab-drift check vs. stored state - decides whether tab changes are
    // worth a changelog fetch without one.
    const currentSig = tabTreeSignature(
      doc.tabs.map((t, idx) => ({ tabId: t.tabId, tabName: t.tabName, parentTabId: t.parentTabId, order: idx })),
    );
    const storedRows = (await db.execute(sql`
      SELECT tab_id, name, parent_tab_id FROM google_doc_tabs
      WHERE user_id = ${userId} AND doc_id = ${docId} AND deleted_at IS NULL
      ORDER BY position
    `)) as unknown;
    const stored = (Array.isArray(storedRows) ? storedRows : (storedRows as { rows?: unknown[] }).rows ?? []) as Array<{ tab_id: string; name: string | null; parent_tab_id: string | null }>;
    const storedSig = tabTreeSignature(
      stored.map((r, idx) => ({ tabId: r.tab_id, tabName: r.name, parentTabId: r.parent_tab_id, order: idx })),
    );
    const tabsDrifted = currentSig !== storedSig;

    // Stored rows still marked open whose suggestion no longer appears in
    // SUGGESTIONS_INLINE were accepted, rejected, or deleted since the last
    // sync - without closing them out, cards read as pending forever. The
    // changelog (fetched below) says which resolution happened.
    const currentPendingIds = new Set(contentByTab.map((s) => s.suggestion.suggestionId));
    const openRows = rowsToArr<{ suggestion_id: string; status: string }>(await db.execute(sql`
      SELECT suggestion_id, status FROM google_doc_suggestions
      WHERE user_id = ${userId} AND doc_id = ${docId}
        AND status IN ('pending', 'modified', 'unknown')
    `));
    const notPending = openRows.filter((r) => !currentPendingIds.has(r.suggestion_id));
    // Only genuinely-open rows drive a changelog fetch. `unknown` is a settled
    // outcome ("no longer pending; resolution unknowable here") - treating it
    // as open would refetch the changelog and rewrite the same row every sweep
    // forever on docs where the changelog never resolves (view-only role).
    // Instead, `unknown` rows are upgraded opportunistically below whenever a
    // changelog was fetched for other reasons.
    const staleIds = notPending.filter((r) => r.status !== "unknown").map((r) => r.suggestion_id);
    const upgradableIds = notPending.filter((r) => r.status === "unknown").map((r) => r.suggestion_id);

    const needChangelog = contentByTab.length > 0 || tabsDrifted || staleIds.length > 0;
    const changelog = needChangelog ? await fetchDocChangelog(userId, docId, undefined, opts.accessToken) : null;

    if (needChangelog) {
      if (changelog) result.changelogOk++;
      else result.changelogNull++;
    }

    const now = new Date();

    // --- Suggestions ---
    if (contentByTab.length > 0) {
      const cards = suggestionCardsFromParts(contentByTab, changelog);
      for (const c of cards) {
        const values = {
          userId, docId,
          suggestionId: c.suggestionId, tabId: c.tabId, tabName: c.tabName,
          insertedText: c.insertedText, deletedText: c.deletedText,
          contextBefore: c.contextBefore, contextAfter: c.contextAfter,
          authorUserId: c.authorUserId, authorName: c.authorName, status: c.status,
          createdAt: c.createdAt, lastModifiedAt: c.lastModifiedAt, modificationCount: c.modificationCount,
          resolvedAt: c.resolvedAt, resolvedByName: c.resolvedByName,
          changelogResolved: c.authorshipResolved, syncedAt: now,
        };
        const { userId: _u, docId: _d, suggestionId: _s, ...updatable } = values;
        await db.insert(googleDocSuggestions).values(values).onConflictDoUpdate({
          target: [googleDocSuggestions.userId, googleDocSuggestions.docId, googleDocSuggestions.suggestionId],
          set: updatable,
        });
        result.suggestionsUpserted++;
      }
    }

    // --- Close out suggestions that left the pending set ---
    // Stale open rows always resolve to SOMETHING this pass (terminal status
    // from the changelog, or `unknown`). Previously-`unknown` rows are only
    // touched when this sync fetched a changelog anyway and it knows their
    // terminal status - they never force fetches or rewrites of their own.
    if (staleIds.length > 0 || (changelog && upgradableIds.length > 0)) {
      const lifecycleById = new Map(
        changelog ? trackSuggestions(changelog).suggestions.map((life) => [life.sugId, life]) : [],
      );
      const closeOut = async (suggestionId: string, allowUnknownFallback: boolean): Promise<void> => {
        const life = lifecycleById.get(suggestionId);
        if (life && life.status !== "pending" && life.status !== "modified") {
          const resolvedName = life.resolvedByUserId
            ? changelog?.userMap.get(life.resolvedByUserId)?.name ?? null
            : null;
          await db.update(googleDocSuggestions)
            .set({
              status: life.status,
              resolvedAt: life.resolvedAt ?? null,
              resolvedByName: resolvedName,
              changelogResolved: true,
              syncedAt: now,
            })
            .where(sql`user_id = ${userId} AND doc_id = ${docId} AND suggestion_id = ${suggestionId}`);
          result.suggestionsUpserted++;
        } else if (allowUnknownFallback) {
          // Gone from the pending view but the changelog couldn't say why
          // (unavailable, or it still reads open) - record that it is no
          // longer pending rather than leave a stale open card.
          await db.update(googleDocSuggestions)
            .set({ status: "unknown", syncedAt: now })
            .where(sql`user_id = ${userId} AND doc_id = ${docId} AND suggestion_id = ${suggestionId}`);
          result.suggestionsUpserted++;
        }
      };
      for (const suggestionId of staleIds) await closeOut(suggestionId, true);
      if (changelog) {
        for (const suggestionId of upgradableIds) await closeOut(suggestionId, false);
      }
    }

    // --- Tab changes (from the same changelog) ---
    if (changelog) {
      const { events, state } = extractTabChanges(changelog);
      for (const e of events) {
        await db.insert(googleDocTabEvents).values({
          userId, docId, tabId: e.tabId, eventType: e.eventType, changelogIndex: e.changelogIndex,
          actorUserId: e.actorUserId, actorName: e.actorName,
          oldName: e.oldName, newName: e.newName,
          fromPosition: e.fromPosition, toPosition: e.toPosition,
          occurredAt: e.occurredAt, syncedAt: now,
        }).onConflictDoNothing({
          target: [googleDocTabEvents.userId, googleDocTabEvents.docId, googleDocTabEvents.tabId, googleDocTabEvents.eventType, googleDocTabEvents.changelogIndex],
        });
        result.tabEventsUpserted++;
      }
      // Current tab tree: names/parent/order are AUTHORITATIVE from the Docs
      // API (`doc.tabs`) - the changelog reconstruction carries stale/default
      // names (it showed "Tab 2" where the live name is "second tab").
      // created/deleted timestamps are enriched from the changelog by tabId.
      const changelogByTab = new Map(state.map((t) => [t.tabId, t]));
      const liveTabIds = new Set<string>();
      for (let ti = 0; ti < doc.tabs.length; ti++) {
        const tab = doc.tabs[ti];
        liveTabIds.add(tab.tabId);
        const cl = changelogByTab.get(tab.tabId);
        const values = {
          userId, docId, tabId: tab.tabId,
          name: tab.tabName,
          position: cl?.position ?? [ti],
          parentTabId: tab.parentTabId,
          createdAt: cl?.createdAt ?? null,
          deletedAt: null as Date | null,
          syncedAt: now,
        };
        const { userId: _u, docId: _d, tabId: _t, ...upd } = values;
        await db.insert(googleDocTabs).values(values).onConflictDoUpdate({
          target: [googleDocTabs.userId, googleDocTabs.docId, googleDocTabs.tabId],
          set: upd,
        });
        result.tabsUpserted++;
      }
      // Tabs the changelog knows but that are gone from the current Docs tree
      // = deleted. Persist them with a deletedAt so history stays complete.
      for (const t of state) {
        if (liveTabIds.has(t.tabId)) continue;
        const values = {
          userId, docId, tabId: t.tabId, name: t.name, position: t.position,
          parentTabId: t.parentTabId, createdAt: t.createdAt, deletedAt: t.deletedAt ?? now, syncedAt: now,
        };
        const { userId: _u, docId: _d, tabId: _t, ...upd } = values;
        await db.insert(googleDocTabs).values(values).onConflictDoUpdate({
          target: [googleDocTabs.userId, googleDocTabs.docId, googleDocTabs.tabId],
          set: upd,
        });
        result.tabsUpserted++;
      }
    }

    // Advance the skip-unchanged watermark ONLY on success: either the doc
    // needed no changelog (nothing to attribute) or the changelog was fetched.
    // If the changelog was needed but null (transient endpoint failure / access
    // lost), leave the watermark so the next sweep retries this doc.
    const succeeded = !needChangelog || changelog !== null;
    if (succeeded && lastSeenTs) {
      await db.insert(googleDocSyncState).values({ userId, docId, lastSyncedSeenTs: lastSeenTs, syncedAt: now })
        .onConflictDoUpdate({
          target: [googleDocSyncState.userId, googleDocSyncState.docId],
          set: { lastSyncedSeenTs: lastSeenTs, syncedAt: now },
        });
    }
  }

  // Monitoring: warn when the changelog failed for EVERY doc we actually tried.
  const attempted = result.changelogOk + result.changelogNull;
  if (attempted >= 5 && result.changelogNull === attempted) {
    console.warn(
      `[gdocs] changelog sync: null for ALL ${attempted} docs that needed it (user ${userId}) - endpoint may be blocked or access lost.`,
    );
  }

  return result;
}
