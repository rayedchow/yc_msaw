/**
 * Bounded, paced, fail-closed fetch of known-total changelog page ranges.
 *
 * Restores gigabrain 4a4d68fc (#657, in main 5448774): when the tiles give the
 * changelog length, every 1000-entry range is known up front and is fetched
 * through a bounded worker pool (`GDOCS_CHANGELOG_PAGE_CONCURRENCY`, default
 * 8, max 20) instead of strictly serially. Differences from the donor's
 * `mapWithConcurrency`, which ran every range to completion:
 *
 * - Fail-closed contiguous prefix: the first range (by index) that fails,
 *   throws or comes back short stops the run. Ranges after it are not
 *   dispatched, and in-flight ones past it are discarded, so the result is
 *   exactly what a serial run would have returned (prefix plus the short page,
 *   if that was the stop).
 * - Rate, not just concurrency: every request start of a multi-range pool is
 *   paced per credential (`GDOCS_CHANGELOG_MAX_RPS`, default 5 req/s, max 10;
 *   donor research/google-docs-ot/reliability.md "max 5-10 requests per
 *   second per user"). The pacer is process-local; Docs runs are serialized
 *   per tenant. A lone request (tiles, reuse check, a single-range pool,
 *   open-ended pagination) is at most one in flight, exactly like the donor's
 *   serial loop, and is not delayed.
 * - No 429 amplification: a slot is re-checked after the pacing wait, and the
 *   callers' fetchers check the per-identity and global Google cooldowns
 *   before touching the network. After a 429 at most the requests already in
 *   flight (< concurrency) reach Google; nothing new is sent.
 *
 * Open-ended pagination (no tile count) stays serial in the callers: the end
 * is only discovered by a short page.
 */
import { createHash } from "node:crypto";
import { parseConcurrencyEnv } from "../../../lib/concurrency.js";

export function changelogPageConcurrency(): number {
  return parseConcurrencyEnv("GDOCS_CHANGELOG_PAGE_CONCURRENCY", 8, { max: 20 });
}

export function changelogRequestsPerSecond(): number {
  return parseConcurrencyEnv("GDOCS_CHANGELOG_MAX_RPS", 5, { max: 10 });
}

export interface PageRange {
  start: number;
  end: number;
}

export type PageAttempt<P, F> =
  | { ok: true; page: P; /** false = short page; stops the run like a failure but the page is kept. */ complete: boolean }
  | { ok: false; failure: F };

export interface ContiguousPagesResult<P, F> {
  /** Ranges 0..k-1, all ok and complete, in range order; plus the short page at k when that is what stopped the run. */
  pages: P[];
  /** Index of the range that stopped the run, or null when every range was fetched complete. */
  stoppedAt: number | null;
  /** How the run stopped at `stoppedAt`. */
  stop: { kind: "failure"; failure: F } | { kind: "error"; error: unknown } | { kind: "short" } | null;
  /** Every thrown error (any index), e.g. to take the longest Retry-After. */
  errors: unknown[];
  /** fetchOne invocations (requests attempted). */
  dispatched: number;
  maxInFlight: number;
}

export interface ContiguousPagesOptions {
  concurrency: number;
  /** Awaited before each dispatch (rate pacing). */
  pace?: () => Promise<void>;
}

export async function fetchContiguousPages<P, F>(
  ranges: readonly PageRange[],
  fetchOne: (range: PageRange, index: number) => Promise<PageAttempt<P, F>>,
  options: ContiguousPagesOptions,
): Promise<ContiguousPagesResult<P, F>> {
  const attempts = new Array<{ kind: "ok"; page: P } | { kind: "short"; page: P } | { kind: "failure"; failure: F } | { kind: "error"; error: unknown } | undefined>(ranges.length);
  const errors: unknown[] = [];
  let next = 0;
  let stopAt = Number.POSITIVE_INFINITY;
  let inFlight = 0;
  let maxInFlight = 0;
  let dispatched = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= ranges.length || index > stopAt) return;
      next++;
      if (pace) await pace();
      // Stopped while waiting for a slot: anything past the stop is useless.
      if (index > stopAt) return;
      inFlight++;
      dispatched++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const attempt = await fetchOne(ranges[index], index);
        if (!attempt.ok) attempts[index] = { kind: "failure", failure: attempt.failure };
        else attempts[index] = attempt.complete ? { kind: "ok", page: attempt.page } : { kind: "short", page: attempt.page };
      } catch (error) {
        errors.push(error);
        attempts[index] = { kind: "error", error };
      } finally {
        inFlight--;
      }
      if (attempts[index]?.kind !== "ok") stopAt = Math.min(stopAt, index);
    }
  };

  // A single range is a serial request: no burst to pace.
  const pace = ranges.length > 1 ? options.pace : undefined;
  const workers = Math.min(ranges.length, Math.max(1, Math.floor(options.concurrency)));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const pages: P[] = [];
  const last = Number.isFinite(stopAt) ? stopAt : ranges.length;
  for (let i = 0; i < last; i++) {
    const a = attempts[i];
    if (a?.kind !== "ok") throw new Error(`changelog page pool invariant: range ${i} before stop ${last} is ${a?.kind ?? "missing"}`);
    pages.push(a.page);
  }
  let stop: ContiguousPagesResult<P, F>["stop"] = null;
  if (Number.isFinite(stopAt)) {
    const a = attempts[stopAt];
    if (a?.kind === "short") {
      pages.push(a.page);
      stop = { kind: "short" };
    } else if (a?.kind === "failure") stop = { kind: "failure", failure: a.failure };
    else if (a?.kind === "error") stop = { kind: "error", error: a.error };
  }
  return { pages, stoppedAt: Number.isFinite(stopAt) ? stopAt : null, stop, errors, dispatched, maxInFlight };
}

/** 1000-entry ranges from `start` to `total`, at most `maxPages`. */
export function knownTotalRanges(start: number, total: number, pageSize: number, maxPages: number): PageRange[] {
  const ranges: PageRange[] = [];
  for (let s = start; s <= total && ranges.length < maxPages; s += pageSize) ranges.push({ start: s, end: Math.min(s + pageSize - 1, total) });
  return ranges;
}

// ---------------------------------------------------------------------------
// Per-credential request pacing
// ---------------------------------------------------------------------------

const nextSlotByKey = new Map<string, number>();

export interface PacerClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Pacing key for the private docs.google.com changelog endpoint; hashed so no token is kept. */
export function changelogPaceKey(accessToken: string): string {
  return `gdocs-changelog:${createHash("sha256").update(accessToken).digest("hex").slice(0, 16)}`;
}

/**
 * Returns `pace()`: each call reserves the next start slot for `key`, at least
 * 1000/rps ms after the previous one (shared by every caller using the key),
 * and resolves when that slot arrives. `rps` <= 0 or non-finite disables pacing.
 */
export function changelogPacer(key: string, rps: number, clock: PacerClock = realClock): () => Promise<void> {
  if (!Number.isFinite(rps) || rps <= 0) return async () => {};
  const intervalMs = 1000 / rps;
  return async () => {
    const now = clock.now();
    if (nextSlotByKey.size > 1000) {
      for (const [k, slot] of nextSlotByKey) if (slot < now) nextSlotByKey.delete(k);
    }
    const slot = Math.max(now, nextSlotByKey.get(key) ?? 0);
    nextSlotByKey.set(key, slot + intervalMs);
    if (slot > now) await clock.sleep(slot - now);
  };
}

export function resetChangelogPacingForTests(): void {
  nextSlotByKey.clear();
}
