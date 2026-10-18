/**
 * Google Docs OT changelog - deterministic edit/suggestion attribution.
 *
 * Thin façade over the ported `/revisions/load` client
 * (`src/polling/_archived-gdocs/gdocs-revisions-load.ts`, from
 * harvard-vpal/gdocrevisions). Exposes the DETERMINISTIC capabilities only.
 * The upstream `enrichPhase1Events` (a ±5-min timestamp-window join between
 * Activity events and OT ops) was DELETED, not just un-exported - the
 * changelog-native paths here key on `sugId`/`sessionId` and need no window.
 *
 * ACCESS: undocumented endpoint, works under DWD (and 3-legged OAuth) with
 * drive.readonly + documents + drive.activity.readonly. It reads
 * version-history data, so it is role-gated to writer+ like the UI - readers
 * likely get 403/empty. Undocumented = no SLA, may break or be blocked.
 * Not scheduled yet; call sites opt in explicitly. See
 * docs/integrations/google-docs.md "Not ported" → now "Ported".
 */
export {
  fetchDocChangelog,
  buildAuthorAttribution,
  extractPendingSuggestions,
  type DocChangelog,
  type ChangelogOperation,
  type AuthorAttribution,
} from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";

export {
  trackSuggestions,
  summarizeSuggestions,
  type SuggestionSummary,
  type SuggestionLifecycle,
  type SuggestionStatus,
} from "../../../polling/_archived-gdocs/gdocs-suggestion-tracker.js";

import { fetchDocChangelog } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { trackSuggestions, type SuggestionSummary } from "../../../polling/_archived-gdocs/gdocs-suggestion-tracker.js";

/**
 * Fetch the changelog and return the full suggestion lifecycle in one call -
 * the deterministic "who suggested what, and what happened to it" view.
 * Returns null if the changelog can't be fetched (permissions, endpoint
 * change, etc.).
 */
export async function fetchSuggestionLifecycles(
  userId: string,
  docId: string,
): Promise<SuggestionSummary | null> {
  const changelog = await fetchDocChangelog(userId, docId);
  if (!changelog) return null;
  return trackSuggestions(changelog);
}
