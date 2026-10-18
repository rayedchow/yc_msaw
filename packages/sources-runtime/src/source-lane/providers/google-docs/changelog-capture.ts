/**
 * Raw OT changelog capture with explicit completeness.
 *
 * Same endpoint contract as the donor `fetchDocChangelog` (anti-XSSI JSON,
 * 1-indexed entries, 1000-entry pages, tiles for the total, open-ended
 * pagination when tiles give no count, 400 on page 1 = empty changelog), but
 * instead of collapsing every outcome into `DocChangelog | null` it returns the
 * raw pages plus a state:
 *
 *   complete - every entry 1..N fetched (or the doc has no changelog)
 *   partial  - some pages fetched, then a failure / short page / page cap /
 *              rate limit; the prefix is real data but is NOT the history
 *   blocked  - 401/403/404 on the first page (writer+ role required,
 *              endpoint blocked, or access lost)
 *   error    - transport/parse failure before any page
 *
 * Durable incremental fetch: complete 1000-entry pages from the last complete
 * capture are reused; the last reused page is re-fetched and compared, and any
 * mismatch discards reuse and refetches from entry 1, so a rewritten history
 * can never be silently stitched onto stale pages.
 */
import { createHash } from "node:crypto";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { parseXssiJson, type RevisionTile } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { googleFetch, type GoogleCallContext } from "./google-fetch.js";

export const CHANGELOG_PAGE_SIZE = 1000;
export const MAX_CHANGELOG_PAGES = Math.max(1, Math.floor(Number(process.env.GDOCS_CHANGELOG_MAX_PAGES ?? 500)));

export interface RawChangelogPage {
  start: number;
  end: number;
  /** Raw 9-element tuples exactly as returned (post-redaction when stored). */
  changelog: unknown[][];
  /** Only meaningful on the page starting at entry 1. */
  chunkedSnapshot?: unknown;
  /** The complete parsed response object (every top-level key, not just `changelog`). */
  response?: Record<string, unknown>;
  fetchedAt: string;
}

export type ChangelogCaptureState = "complete" | "partial" | "blocked" | "error";

export interface ChangelogCaptureResult {
  state: ChangelogCaptureState;
  reason: string | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  /** Total from tiles (null = tiles unavailable, open-ended pagination). */
  tilesTotal: number | null;
  tiles: RevisionTile[];
  /** Raw tiles userMap object (display names; post-redaction when stored). */
  userMap: Record<string, Record<string, unknown>>;
  /** All pages covering 1..fetchedEntries in order (reused + fetched). */
  pages: RawChangelogPage[];
  /** Pages actually fetched in this run (subset of `pages`). */
  fetchedPages: RawChangelogPage[];
  reusedPages: number;
  fetchedEntries: number;
  failedRange: { start: number; end: number } | null;
}

function changelogUrl(fileId: string, kind: "tiles" | "load", start: number, end?: number): string {
  const base = `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/revisions/${kind}?id=${encodeURIComponent(fileId)}&start=${start}`;
  return kind === "tiles" ? `${base}&showDetailedRevisions=true` : `${base}&end=${end}`;
}

export function pageDigest(page: Pick<RawChangelogPage, "changelog">): string {
  return createHash("sha256").update(JSON.stringify(page.changelog)).digest("hex");
}

function parseTiles(data: Record<string, unknown>): { tiles: RevisionTile[]; total: number | null; userMap: Record<string, Record<string, unknown>> } {
  const rawTiles = Array.isArray(data.tileInfo) ? (data.tileInfo as Array<Record<string, unknown>>) : [];
  const tiles: RevisionTile[] = rawTiles.map((t) => ({
    start: (t.start as number) ?? 0,
    end: (t.end as number) ?? 0,
    endMillis: (t.endMillis as number) ?? 0,
    users: (t.users as string[]) ?? [],
  }));
  const total = tiles.length > 0 ? (tiles[tiles.length - 1].end || null) : null;
  const userMap = (data.userMap && typeof data.userMap === "object" ? data.userMap : {}) as Record<string, Record<string, unknown>>;
  return { tiles, total, userMap };
}

export interface CaptureChangelogOptions {
  /** Pages from the last COMPLETE capture, in order, starting at entry 1. */
  reusablePages?: RawChangelogPage[];
  now?: () => Date;
}

export async function captureChangelogPages(
  ctx: GoogleCallContext,
  fileId: string,
  options: CaptureChangelogOptions = {},
): Promise<ChangelogCaptureResult> {
  const now = options.now ?? (() => new Date());
  const result: ChangelogCaptureResult = {
    state: "error",
    reason: null,
    httpStatus: null,
    retryAfterSeconds: null,
    tilesTotal: null,
    tiles: [],
    userMap: {},
    pages: [],
    fetchedPages: [],
    reusedPages: 0,
    fetchedEntries: 0,
    failedRange: null,
  };

  try {
    // Step 1: tiles (total + Google's revision grouping + display names).
    const tilesRes = await googleFetch(ctx, changelogUrl(fileId, "tiles", 1));
    if (tilesRes.ok) {
      const parsed = parseXssiJson(await tilesRes.text());
      if (parsed) {
        const tiles = parseTiles(parsed);
        result.tiles = tiles.tiles;
        result.tilesTotal = tiles.total;
        result.userMap = tiles.userMap;
      }
    } else {
      // Donor semantics: tiles failure falls back to open-ended pagination;
      // the load call decides whether access is actually blocked.
      await tilesRes.body?.cancel().catch(() => {});
    }

    const total = result.tilesTotal;

    // Step 2: decide which complete pages can be reused.
    // Only a contiguous prefix of full, page-aligned pages is reusable.
    const offered = options.reusablePages ?? [];
    let reuseCount = 0;
    while (reuseCount < offered.length) {
      const p = offered[reuseCount];
      const aligned = p.start === reuseCount * CHANGELOG_PAGE_SIZE + 1 && p.end === p.start + CHANGELOG_PAGE_SIZE - 1;
      if (!aligned || p.changelog.length !== CHANGELOG_PAGE_SIZE || (total != null && p.end > total)) break;
      reuseCount++;
    }

    const fetchPage = async (start: number, end: number): Promise<{ ok: true; page: RawChangelogPage } | { ok: false; status: number; reason: string }> => {
      const res = await googleFetch(ctx, changelogUrl(fileId, "load", start, end));
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status, reason: `load_http_${res.status}` };
      }
      const data = parseXssiJson(await res.text());
      if (!data) return { ok: false, status: res.status, reason: "load_malformed_json" };
      const changelog = Array.isArray(data.changelog) ? (data.changelog as unknown[][]) : [];
      return {
        ok: true,
        page: {
          start,
          end,
          changelog,
          ...(start === 1 ? { chunkedSnapshot: data.chunkedSnapshot ?? null } : {}),
          response: data,
          fetchedAt: now().toISOString(),
        },
      };
    };

    // Verify the newest reused page still matches (history is append-only; a
    // mismatch means our checkpoint is not a prefix of the current changelog).
    let start = 1;
    if (reuseCount > 0) {
      const last = offered[reuseCount - 1];
      const check = await fetchPage(last.start, last.end);
      if (check.ok && check.page.changelog.length === CHANGELOG_PAGE_SIZE && pageDigest(check.page) === pageDigest(last)) {
        result.pages.push(...offered.slice(0, reuseCount - 1), check.page);
        result.fetchedPages.push(check.page);
        result.reusedPages = reuseCount - 1;
        start = last.end + 1;
      } else if (!check.ok && (check.status === 401 || check.status === 403 || check.status === 404)) {
        result.state = "blocked";
        result.reason = check.reason;
        result.httpStatus = check.status;
        return result;
      }
      // else: mismatch or transient failure -> refetch everything from entry 1.
    }

    let pageCount = 0;
    for (;;) {
      if (total != null && start > total) {
        result.state = "complete";
        break;
      }
      if (pageCount >= MAX_CHANGELOG_PAGES) {
        result.state = "partial";
        result.reason = "page_cap_reached";
        break;
      }
      pageCount++;
      const end = total == null ? start + CHANGELOG_PAGE_SIZE - 1 : Math.min(start + CHANGELOG_PAGE_SIZE - 1, total);
      const fetched = await fetchPage(start, end);
      if (!fetched.ok) {
        result.httpStatus = fetched.status;
        if (start === 1 && result.pages.length === 0) {
          if (fetched.status === 400) {
            // No changelog at all (empty or imported doc) - a complete, empty history.
            result.state = "complete";
            result.reason = "empty_changelog";
            break;
          }
          if (fetched.status === 401 || fetched.status === 403 || fetched.status === 404) {
            result.state = "blocked";
            result.reason = fetched.status === 404 ? "changelog_not_found" : "changelog_forbidden_writer_role_required";
            break;
          }
          result.state = "error";
          result.reason = fetched.reason;
          result.failedRange = { start, end };
          break;
        }
        result.state = "partial";
        result.reason = fetched.reason;
        result.failedRange = { start, end };
        break;
      }
      const page = fetched.page;
      result.pages.push(page);
      result.fetchedPages.push(page);
      if (total != null) {
        if (page.changelog.length !== end - start + 1) {
          result.state = "partial";
          result.reason = `short_page_expected_${end - start + 1}_got_${page.changelog.length}`;
          result.failedRange = { start, end };
          break;
        }
      } else if (page.changelog.length < CHANGELOG_PAGE_SIZE) {
        // Open-ended mode ends at the first short page (donor semantics).
        page.end = start + page.changelog.length - 1;
        result.state = "complete";
        break;
      }
      start = end + 1;
    }
  } catch (err) {
    if (err instanceof GoogleRateLimitError) {
      result.state = result.pages.length > 0 ? "partial" : "error";
      result.reason = "rate_limited";
      result.httpStatus = err.status;
      result.retryAfterSeconds = err.retryAfterSeconds;
    } else {
      result.state = result.pages.length > 0 ? "partial" : "error";
      result.reason = `transport_error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  result.fetchedEntries = result.pages.reduce((sum, p) => sum + p.changelog.length, 0);
  return result;
}

/** Flatten complete pages back into the entry array the production parser takes. */
export function entriesFromPages(pages: RawChangelogPage[]): unknown[][] {
  const out: unknown[][] = [];
  for (const page of pages) out.push(...page.changelog);
  return out;
}
