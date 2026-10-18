import { db } from "../../../db/client.js";
import { classifyCredentialFailure } from "../../../vault/credential-failure.js";
import type { DbExecutor } from "../../core/types.js";
import {
  backfillGranola,
  granolaCredentialIdentity,
  granolaRetryAfterFromError,
  pollGranola,
  refetchGranolaNotes,
  type GranolaBackfillOptions,
  type GranolaCredentialIdentity,
  type GranolaIngestionResult,
  type GranolaIngestOptions,
  type GranolaNoteFailure,
} from "../../../integrations/granola/poller.js";
import {
  ensureGranolaState,
  granolaCooldownUntil,
  granolaInventoryKey,
  granolaTranscriptRecheckCandidates,
  markGranolaTranscriptRechecked,
  recordGranolaRateLimit,
  updateGranolaState,
  type GranolaFailedNote,
  type GranolaSourceState,
} from "./state.js";

/**
 * Granola source lane around the donor poller (src/integrations/granola/poller.ts):
 *
 *  - inventory passes: `granola.backfill` lists every note the credential can see
 *    (no date bound), checkpointing the list cursor after every page, so a crash or a
 *    failed page resumes where it stopped. A pass is tied to the inventory key (auth mode,
 *    account, folder scope); a new account or scope starts a new pass, the old completion
 *    no longer counts. Only a pass that listed every page and fetched every note
 *    (after retries by id) marks the key complete.
 *  - polls: the donor `updated_after` watermark poll (resume cursor, failure holds the
 *    watermark, deletion sweep) plus: notes whose fetch failed are retried by id; notes
 *    without a transcript are re-fetched with backoff for a while (content revisions catch
 *    transcripts that arrive without an updated_at bump); a 429 whose Retry-After exceeds
 *    the in-request cap becomes a durable cooldown on the credential's quota key.
 *  - every outcome is recorded in granola_source_state for coverage (./coverage.ts).
 */

export interface GranolaLaneDeps {
  executor?: DbExecutor;
  now?: () => Date;
}

export type GranolaLanePollResult = GranolaIngestionResult & {
  deferredUntil?: string;
  /** No completed inventory pass for the current credential/scope: the task handler enqueues one. */
  inventoryRequired?: boolean;
  inventoryRunAt?: string;
  retriedFailed?: number;
  transcriptRechecked?: number;
};

export type GranolaLaneBackfillResult = GranolaIngestionResult & {
  deferredUntil?: string;
  inventoryGeneration?: number;
  inventoryComplete?: boolean;
};

const FAILED_RETRY_PER_POLL = 20;
const TRANSCRIPT_RECHECK_PER_POLL = 10;
const TRANSCRIPT_RECHECK_WINDOW_DAYS = 14;
const TRANSCRIPT_RECHECK_MAX = 6;
/** After this many failed fetches a note is no longer retried every poll; it stays listed (coverage partial). */
const FAILED_NOTE_RETRY_LIMIT = 50;

function emptyResult(): GranolaIngestionResult {
  return {
    listed: 0,
    processed: 0,
    failed: 0,
    stored: 0,
    skipped: 0,
    tombstoned: 0,
    newestUpdatedAt: null,
    watermarkAdvancedTo: null,
    exhausted: true,
    capHit: false,
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

function mergeFailures(
  current: Record<string, GranolaFailedNote>,
  failures: readonly GranolaNoteFailure[],
  at: string,
): Record<string, GranolaFailedNote> {
  const next = { ...current };
  for (const f of failures) {
    next[f.id] = { error: f.error, at, attempts: (next[f.id]?.attempts ?? 0) + 1 };
  }
  return next;
}

async function cooldownFromFailure(
  ex: DbExecutor,
  identity: GranolaCredentialIdentity,
  errors: readonly unknown[],
  now: Date,
): Promise<Date | null> {
  let maxMs: number | null = null;
  for (const e of errors) {
    const ms = granolaRetryAfterFromError(e, now.getTime());
    if (ms !== null) maxMs = Math.max(maxMs ?? 0, ms);
  }
  if (maxMs === null) return null;
  // An unspecified Retry-After still backs off a minute: the in-request retries were exhausted.
  const until = new Date(now.getTime() + Math.max(maxMs, 60_000));
  await recordGranolaRateLimit(ex, identity.quotaKey, until, maxMs);
  return until;
}

async function recordFailure(ex: DbExecutor, tenantId: string, identity: GranolaCredentialIdentity, err: unknown, now: Date): Promise<void> {
  await cooldownFromFailure(ex, identity, [err], now);
  const permanent = classifyCredentialFailure(err) === "permanent";
  await updateGranolaState(ex, tenantId, {
    last_poll_error_at: now.toISOString(),
    last_poll_error: errText(err),
    ...(permanent ? { blocked_code: "auth", blocked_reason: errText(err) } : {}),
  });
}

/** Retry notes whose fetch failed earlier, by id; returns the remaining failures. */
async function retryFailedNotes(
  ex: DbExecutor,
  tenantId: string,
  identity: GranolaCredentialIdentity,
  failed: Record<string, GranolaFailedNote>,
  exclude: ReadonlySet<string>,
  now: Date,
): Promise<{ remaining: Record<string, GranolaFailedNote>; retried: number }> {
  const ids = Object.keys(failed)
    .filter((id) => !exclude.has(id) && (failed[id]?.attempts ?? 0) < FAILED_NOTE_RETRY_LIMIT)
    .slice(0, FAILED_RETRY_PER_POLL);
  if (ids.length === 0) return { remaining: failed, retried: 0 };
  const outcomes = await refetchGranolaNotes(tenantId, ids, { includeTranscript: identity.includeTranscript });
  const remaining = { ...failed };
  const errors: string[] = [];
  for (const o of outcomes) {
    if (o.outcome === "failed") {
      const prev = remaining[o.id];
      remaining[o.id] = { error: o.error ?? "unknown", at: now.toISOString(), attempts: (prev?.attempts ?? 0) + 1 };
      if (o.error) errors.push(o.error);
    } else {
      delete remaining[o.id];
    }
  }
  await cooldownFromFailure(ex, identity, errors.map((e) => new Error(e)), now);
  return { remaining, retried: outcomes.length };
}

async function recheckTranscripts(ex: DbExecutor, tenantId: string, identity: GranolaCredentialIdentity, now: Date): Promise<number> {
  if (!identity.includeTranscript) return 0;
  const due = await granolaTranscriptRecheckCandidates(ex, tenantId, now, {
    limit: TRANSCRIPT_RECHECK_PER_POLL,
    windowDays: TRANSCRIPT_RECHECK_WINDOW_DAYS,
    maxChecks: TRANSCRIPT_RECHECK_MAX,
  });
  if (due.length === 0) return 0;
  const outcomes = await refetchGranolaNotes(tenantId, due.map((d) => d.note_id), { includeTranscript: true });
  for (const o of outcomes) {
    // A stored revision re-arms the counter through the catalog trigger; mark after it.
    await markGranolaTranscriptRechecked(ex, tenantId, o.id, now);
  }
  await cooldownFromFailure(ex, identity, outcomes.filter((o) => o.error).map((o) => new Error(o.error!)), now);
  return outcomes.length;
}

function inventoryRequired(state: GranolaSourceState): boolean {
  return state.inventory_complete_key !== state.inventory_key;
}

/** Donor `granola.poll` with durable state, cooldowns, retries by id and transcript re-checks. */
export async function runGranolaSourcePoll(tenantId: string, options: GranolaIngestOptions = {}, deps: GranolaLaneDeps = {}): Promise<GranolaLanePollResult> {
  const ex = deps.executor ?? db;
  const now = deps.now?.() ?? new Date();
  const identity = await granolaCredentialIdentity(tenantId);
  if (!identity) return emptyResult();
  let state = await ensureGranolaState(ex, tenantId, identity);
  await updateGranolaState(ex, tenantId, { last_poll_at: now.toISOString() });

  const cooldown = await granolaCooldownUntil(ex, identity.quotaKey, now);
  if (cooldown) {
    return {
      ...emptyResult(),
      exhausted: false,
      deferredUntil: cooldown.toISOString(),
      ...(inventoryRequired(state) ? { inventoryRequired: true, inventoryRunAt: cooldown.toISOString() } : {}),
    };
  }

  let result: GranolaIngestionResult;
  try {
    result = await pollGranola(tenantId, { ...options, watermarkCeiling: state.poll_window_started_at ?? now.toISOString() });
  } catch (err) {
    await recordFailure(ex, tenantId, identity, err, deps.now?.() ?? new Date());
    throw err;
  }
  const after = deps.now?.() ?? new Date();
  const failures = result.failures ?? [];
  let failedNotes = mergeFailures(state.failed_notes, failures, after.toISOString());
  const cooldownAfterRun = await cooldownFromFailure(ex, identity, failures.map((f) => new Error(f.error)), after);

  let retriedFailed = 0;
  let transcriptRechecked = 0;
  if (!cooldownAfterRun) {
    const retried = await retryFailedNotes(ex, tenantId, identity, failedNotes, new Set(failures.map((f) => f.id)), after);
    failedNotes = retried.remaining;
    retriedFailed = retried.retried;
    if (!(await granolaCooldownUntil(ex, identity.quotaKey, after))) {
      transcriptRechecked = await recheckTranscripts(ex, tenantId, identity, after);
    }
  }

  // A capped run that saved a resume cursor keeps its window open; anything else closed it.
  const windowOpen = result.capHit && result.failed === 0 && !result.listingTruncated;
  const cleanPoll = result.failed === 0 && !result.listingTruncated;
  await updateGranolaState(ex, tenantId, {
    failed_notes: failedNotes,
    poll_window_started_at: windowOpen ? state.poll_window_started_at ?? now.toISOString() : null,
    ...(result.watermarkAdvancedTo ? { poll_watermark: result.watermarkAdvancedTo } : {}),
    ...(cleanPoll && !result.capHit ? { last_poll_ok_at: after.toISOString() } : {}),
    ...(result.failed > 0 ? { last_poll_error_at: after.toISOString(), last_poll_error: `${result.failed} note fetch(es) failed: ${failures[0]?.error ?? ""}`.slice(0, 1000) } : {}),
    listing_truncated_at: result.listingTruncated ? after.toISOString() : null,
    ...(result.deletionSweep ? { last_sweep_at: after.toISOString(), last_sweep: result.deletionSweep as unknown as Record<string, unknown> } : {}),
    blocked_code: null,
    blocked_reason: null,
  });
  state = { ...state, failed_notes: failedNotes };
  await maybeCompleteInventory(ex, tenantId, state, after);
  const refreshed = await ensureGranolaState(ex, tenantId, identity);
  const coolUntil = await granolaCooldownUntil(ex, identity.quotaKey, after);
  return {
    ...result,
    retriedFailed,
    transcriptRechecked,
    ...(coolUntil ? { deferredUntil: coolUntil.toISOString() } : {}),
    ...(inventoryRequired(refreshed) ? { inventoryRequired: true, inventoryRunAt: (coolUntil ?? after).toISOString() } : {}),
  };
}

/** A pass whose listing finished becomes complete once no note of it is still failing. */
async function maybeCompleteInventory(ex: DbExecutor, tenantId: string, state: GranolaSourceState, now: Date): Promise<boolean> {
  if (state.inventory_phase !== "complete" || state.inventory_complete_key === state.inventory_key) return false;
  if (!state.inventory_listing_complete || Object.keys(state.failed_notes).length > 0) return false;
  await updateGranolaState(ex, tenantId, { inventory_complete_key: state.inventory_key, inventory_complete_at: now.toISOString() });
  return true;
}

/**
 * Donor `granola.backfill` as a resumable inventory pass. A `days`/`maxNotes` bounded
 * backfill runs the donor code unchanged and never counts as an inventory.
 */
export async function runGranolaSourceBackfill(
  tenantId: string,
  options: GranolaBackfillOptions & { force?: boolean } = {},
  deps: GranolaLaneDeps = {},
): Promise<GranolaLaneBackfillResult> {
  const ex = deps.executor ?? db;
  const now = deps.now?.() ?? new Date();
  const identity = await granolaCredentialIdentity(tenantId);
  if (!identity) return emptyResult();
  const bounded = options.days != null || options.maxNotes != null;
  let state = await ensureGranolaState(ex, tenantId, identity);

  const cooldown = await granolaCooldownUntil(ex, identity.quotaKey, now);
  if (cooldown) return { ...emptyResult(), exhausted: false, deferredUntil: cooldown.toISOString() };

  if (bounded) {
    try {
      return await backfillGranola(tenantId, options);
    } catch (err) {
      await recordFailure(ex, tenantId, identity, err, deps.now?.() ?? new Date());
      throw err;
    }
  }

  // Already complete for this credential/scope: only notes still failing need work.
  if (!options.force && state.inventory_phase === "complete" && state.inventory_key === granolaInventoryKey(identity)) {
    const retried = await retryFailedNotes(ex, tenantId, identity, state.failed_notes, new Set(), now);
    await updateGranolaState(ex, tenantId, { failed_notes: retried.remaining });
    const completed = await maybeCompleteInventory(ex, tenantId, { ...state, failed_notes: retried.remaining }, now);
    return {
      ...emptyResult(),
      failed: Object.keys(retried.remaining).length,
      inventoryGeneration: state.inventory_generation,
      inventoryComplete: completed || state.inventory_complete_key === state.inventory_key,
    };
  }

  const resuming = state.inventory_phase === "running" && !options.force;
  if (!resuming) {
    await updateGranolaState(ex, tenantId, {
      inventory_generation: state.inventory_generation + 1,
      inventory_phase: "running",
      inventory_cursor: null,
      inventory_pages: 0,
      inventory_listed: 0,
      inventory_failed: 0,
      inventory_started_at: now.toISOString(),
      inventory_finished_at: null,
      inventory_listing_complete: false,
      failed_notes: {},
    });
    state = (await ensureGranolaState(ex, tenantId, identity));
  }
  const generation = state.inventory_generation;
  const baseListed = state.inventory_listed;
  let failedNotes = { ...state.failed_notes };
  let pages = state.inventory_pages;
  let failedCount = state.inventory_failed;

  let result: GranolaIngestionResult;
  try {
    result = await backfillGranola(tenantId, {
      ...options,
      cursor: state.inventory_cursor,
      onPage: async (checkpoint) => {
        pages += 1;
        failedCount += checkpoint.pageFailures.length;
        failedNotes = mergeFailures(failedNotes, checkpoint.pageFailures, (deps.now?.() ?? new Date()).toISOString());
        await updateGranolaState(ex, tenantId, {
          inventory_cursor: checkpoint.nextCursor,
          inventory_pages: pages,
          inventory_listed: baseListed + checkpoint.listed,
          inventory_failed: failedCount,
          failed_notes: failedNotes,
        });
      },
    });
  } catch (err) {
    const at = deps.now?.() ?? new Date();
    await recordFailure(ex, tenantId, identity, err, at);
    // A rejected resume cursor (expired/invalid: 4xx other than auth/429) restarts the pass next time.
    const message = errText(err);
    if (state.inventory_cursor && /\((400|404|410|422)\)/.test(message)) {
      await updateGranolaState(ex, tenantId, { inventory_phase: "none", inventory_cursor: null });
    }
    throw err;
  }

  const at = deps.now?.() ?? new Date();
  if (result.capHit || result.listingTruncated) {
    // hasMore without a cursor (or a cap): the listing cannot be drained; never complete.
    await updateGranolaState(ex, tenantId, {
      inventory_phase: "complete",
      inventory_cursor: null,
      inventory_finished_at: at.toISOString(),
      inventory_listing_complete: false,
      listing_truncated_at: at.toISOString(),
      failed_notes: failedNotes,
    });
    return { ...result, inventoryGeneration: generation, inventoryComplete: false };
  }
  await cooldownFromFailure(ex, identity, (result.failures ?? []).map((f) => new Error(f.error)), at);
  const retried = (await granolaCooldownUntil(ex, identity.quotaKey, at))
    ? { remaining: failedNotes, retried: 0 }
    : await retryFailedNotes(ex, tenantId, identity, failedNotes, new Set(), at);
  await updateGranolaState(ex, tenantId, {
    inventory_phase: "complete",
    inventory_cursor: null,
    inventory_finished_at: at.toISOString(),
    inventory_listing_complete: true,
    failed_notes: retried.remaining,
    listing_truncated_at: null,
  });
  const fresh = await ensureGranolaState(ex, tenantId, identity);
  const completed = await maybeCompleteInventory(ex, tenantId, fresh, at);
  const remaining = Object.keys(retried.remaining).length;
  // `failed` reports what is still failing after the retries by id, so the donor
  // re-enqueue (index.ts) only fires for real leftovers; it then retries by id.
  return { ...result, failed: remaining, exhausted: remaining === 0, inventoryGeneration: generation, inventoryComplete: completed };
}
