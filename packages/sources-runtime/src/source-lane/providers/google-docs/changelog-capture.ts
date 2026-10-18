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
 *   blocked  - 401/403/404 on the first page (credential rejected, writer+
 *              role / OAuth acceptance, or access lost; see auth-mode.ts)
 *   error    - transport/parse failure before any page
 *
 * Known-total ranges are fetched through the bounded, per-credential paced,
 * fail-closed pool in changelog-page-pool.ts (gigabrain 4a4d68fc); the result
 * is identical to a serial run. Open-ended pagination stays serial.
 *
 * Durable incremental fetch: complete 1000-entry pages from the last complete
 * capture are reused; the last reused page is re-fetched and compared, and any
 * mismatch discards reuse and refetches from entry 1, so a rewritten history
 * can never be silently stitched onto stale pages. Fetched responses pass
 * through `normalizeResponse` (the stored representation) before anything else
 * sees them, so the comparison is like-for-like with stored pages.
 */
import { createHash } from "node:crypto";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { parseXssiJson, type RevisionTile } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { changelogRefusalReason, type GoogleAuthMode } from "./auth-mode.js";
import {
  changelogPaceKey,
  changelogPacer,
  changelogPageConcurrency,
  changelogRequestsPerSecond,
  fetchContiguousPages,
  knownTotalRanges,
} from "./changelog-page-pool.js";
import { googleFetch, type GoogleCallContext } from "./google-fetch.js";

export const CHANGELOG_PAGE_SIZE = 1000;
export const MAX_CHANGELOG_PAGES = Math.max(1, Math.floor(Number(process.env.GDOCS_CHANGELOG_MAX_PAGES ?? 500)));

export interface RawChangelogPage {
  start: number;
  end: number;
  /** Raw 9-element tuples exactly as returned (after `normalizeResponse`, i.e. as stored). */
  changelog: unknown[][];
  /** Only meaningful on the page starting at entry 1. */
  chunkedSnapshot?: unknown;
  /** The complete parsed response object (every top-level key, not just `changelog`). */
  response?: Record<string, unknown>;
  fetchedAt: string;
}

export type ChangelogCaptureState = "complete" | "partial" | "blocked" | "error";

export interface ChangelogFetchStats {
  /** Requests attempted against /revisions/tiles + /revisions/load in this run. */
  requests: number;
  /** Highest number of concurrent /revisions/load requests. */
  maxInFlight: number;
  concurrency: number;
  requestsPerSecond: number;
}

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
  stats: ChangelogFetchStats;
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
  /** Pages from the last COMPLETE capture, in order, starting at entry 1 (stored representation). */
  reusablePages?: RawChangelogPage[];
  now?: () => Date;
  /**
   * Maps each parsed /revisions/load response to the representation that is
   * stored and replayed (history-export: length-preserving redaction). Must be
   * idempotent; stored pages are compared against normalized live pages.
   */
  normalizeResponse?: (response: Record<string, unknown>) => Record<string, unknown>;
  /** Credential lane, for honest 401/403 reasons. */
  authMode?: GoogleAuthMode;
  /** Known-total page concurrency (default GDOCS_CHANGELOG_PAGE_CONCURRENCY = 8). */
  pageConcurrency?: number;
  /** Per-credential request rate (default GDOCS_CHANGELOG_MAX_RPS = 5); <= 0 disables pacing. */
  requestsPerSecond?: number;
}

type PageFetch = { ok: true; page: RawChangelogPage } | { ok: false; status: number; reason: string };

export async function captureChangelogPages(
  ctx: GoogleCallContext,
  fileId: string,
  options: CaptureChangelogOptions = {},
): Promise<ChangelogCaptureResult> {
  const now = options.now ?? (() => new Date());
  const normalize = options.normalizeResponse ?? ((r: Record<string, unknown>) => r);
  const mode = options.authMode ?? "unknown";
  const concurrency = Math.max(1, Math.floor(options.pageConcurrency ?? changelogPageConcurrency()));
  const rps = options.requestsPerSecond ?? changelogRequestsPerSecond();
  const pace = changelogPacer(changelogPaceKey(ctx.accessToken), rps);
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
    stats: { requests: 0, maxInFlight: 0, concurrency, requestsPerSecond: rps },
  };
  let currentRange: { start: number; end: number } | null = null;
  const fetchPage = async (start: number, end: number): Promise<PageFetch> => {
    result.stats.requests++;
    const res = await googleFetch(ctx, changelogUrl(fileId, "load", start, end));
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, reason: `load_http_${res.status}` };
    }
    const parsed = parseXssiJson(await res.text());
    if (!parsed) return { ok: false, status: res.status, reason: "load_malformed_json" };
    const data = normalize(parsed);
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
  const refuse = (status: number) => {
    result.state = "blocked";
    result.reason = changelogRefusalReason(status, mode);
    result.httpStatus = status;
  };

  try {
    // Step 1: tiles (total + Google's revision grouping + display names).
    result.stats.requests++;
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

    // Verify the newest reused page still matches (history is append-only; a
    // mismatch means our checkpoint is not a prefix of the current changelog).
    // Both sides are in the stored (normalized) representation.
    let start = 1;
    if (reuseCount > 0) {
      const last = offered[reuseCount - 1];
      currentRange = { start: last.start, end: last.end };
      const check = await fetchPage(last.start, last.end);
      if (check.ok && check.page.changelog.length === CHANGELOG_PAGE_SIZE && pageDigest(check.page) === pageDigest(last)) {
        result.pages.push(...offered.slice(0, reuseCount - 1), check.page);
        result.fetchedPages.push(check.page);
        result.reusedPages = reuseCount - 1;
        start = last.end + 1;
      } else if (!check.ok && (check.status === 401 || check.status === 403 || check.status === 404)) {
        refuse(check.status);
        return finish(result);
      }
      // else: mismatch or transient failure -> refetch everything from entry 1.
    }

    if (total != null) {
      await captureKnownTotal(start, total);
    } else {
      await captureOpenEnded(start);
    }
  } catch (err) {
    recordThrown(err, currentRange);
  }
  return finish(result);

  function recordThrown(err: unknown, range: { start: number; end: number } | null): void {
    result.state = result.pages.length > 0 ? "partial" : "error";
    if (range) result.failedRange = range;
    if (err instanceof GoogleRateLimitError) {
      result.reason = "rate_limited";
      result.httpStatus = err.status;
      result.retryAfterSeconds = Math.max(result.retryAfterSeconds ?? 0, err.retryAfterSeconds);
    } else {
      result.reason = `transport_error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** A failed page at `start` (first page of the run only when nothing precedes it). */
  function recordFailure(failure: { status: number; reason: string }, range: { start: number; end: number }): void {
    result.httpStatus = failure.status;
    if (range.start === 1 && result.pages.length === 0) {
      if (failure.status === 400) {
        // No changelog at all (empty or imported doc) - a complete, empty history.
        result.state = "complete";
        result.reason = "empty_changelog";
        return;
      }
      if (failure.status === 401 || failure.status === 403 || failure.status === 404) {
        refuse(failure.status);
        return;
      }
      result.state = "error";
      result.reason = failure.reason;
      result.failedRange = range;
      return;
    }
    result.state = "partial";
    result.reason = failure.reason;
    result.failedRange = range;
  }

  async function captureKnownTotal(from: number, total: number): Promise<void> {
    if (from > total) {
      result.state = "complete";
      return;
    }
    const needed = Math.ceil((total - from + 1) / CHANGELOG_PAGE_SIZE);
    const ranges = knownTotalRanges(from, total, CHANGELOG_PAGE_SIZE, MAX_CHANGELOG_PAGES);
    const pool = await fetchContiguousPages<RawChangelogPage, { status: number; reason: string }>(
      ranges,
      async (range) => {
        const fetched = await fetchPage(range.start, range.end);
        if (!fetched.ok) return { ok: false, failure: fetched };
        return { ok: true, page: fetched.page, complete: fetched.page.changelog.length === range.end - range.start + 1 };
      },
      { concurrency, pace },
    );
    result.stats.maxInFlight = Math.max(result.stats.maxInFlight, pool.maxInFlight);
    result.pages.push(...pool.pages);
    result.fetchedPages.push(...pool.pages);
    // Honour the longest Retry-After seen by any sibling, even when another page stopped the run first.
    for (const err of pool.errors) {
      if (err instanceof GoogleRateLimitError) result.retryAfterSeconds = Math.max(result.retryAfterSeconds ?? 0, err.retryAfterSeconds);
    }
    if (pool.stop === null) {
      if (ranges.length < needed) {
        result.state = "partial";
        result.reason = "page_cap_reached";
      } else {
        result.state = "complete";
      }
      return;
    }
    const range = ranges[pool.stoppedAt as number];
    if (pool.stop.kind === "short") {
      const got = pool.pages[pool.pages.length - 1].changelog.length;
      result.state = "partial";
      result.reason = `short_page_expected_${range.end - range.start + 1}_got_${got}`;
      result.failedRange = range;
    } else if (pool.stop.kind === "failure") {
      recordFailure(pool.stop.failure, range);
    } else {
      recordThrown(pool.stop.error, range);
    }
  }

  async function captureOpenEnded(from: number): Promise<void> {
    let start = from;
    let pageCount = 0;
    for (;;) {
      if (pageCount >= MAX_CHANGELOG_PAGES) {
        result.state = "partial";
        result.reason = "page_cap_reached";
        return;
      }
      pageCount++;
      const end = start + CHANGELOG_PAGE_SIZE - 1;
      currentRange = { start, end };
      result.stats.maxInFlight = Math.max(result.stats.maxInFlight, 1);
      const fetched = await fetchPage(start, end);
      if (!fetched.ok) {
        recordFailure(fetched, { start, end });
        return;
      }
      const page = fetched.page;
      result.pages.push(page);
      result.fetchedPages.push(page);
      if (page.changelog.length < CHANGELOG_PAGE_SIZE) {
        // Open-ended mode ends at the first short page (donor semantics).
        page.end = start + page.changelog.length - 1;
        result.state = "complete";
        return;
      }
      start = end + 1;
    }
  }
}

function finish(result: ChangelogCaptureResult): ChangelogCaptureResult {
  result.fetchedEntries = result.pages.reduce((sum, p) => sum + p.changelog.length, 0);
  return result;
}

/** Flatten complete pages back into the entry array the production parser takes. */
export function entriesFromPages(pages: RawChangelogPage[]): unknown[][] {
  const out: unknown[][] = [];
  for (const page of pages) out.push(...page.changelog);
  return out;
}
