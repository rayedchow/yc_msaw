import { db } from "../../db/client.js";
import { enqueueTask } from "../../queue/queue.js";
import { getGoogleApiCredential, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES } from "../../vault/google-auth.js";
import { GoogleDwdNotApprovedError } from "../../vault/google-dwd-policy.js";
import { GoogleOAuthError } from "../../vault/google-oauth.js";
import { GoogleRateLimitError } from "../../vault/google-rate-limit.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { listGoogleMailboxes } from "../google/mailboxes.js";
import {
  base64UrlToBuffer,
  collectAttachmentParts,
  emptyGmailAttachmentStats,
  getPartHeader,
  gmailMessageForRawPayload,
  mergeGmailAttachmentStats,
  type GmailAttachmentStats,
  type GmailMessage,
  type HistoryRecord,
} from "./poller.js";
import { GmailHistoryExpiredError, GmailHttpError, GmailSourceClient, type GmailProfile } from "./source-client.js";
import {
  acquireMailboxLease,
  errorBackoffSeconds,
  gmailQuotaKey,
  readQuotaState,
  recordQuotaSuccess,
  recordRateLimit,
  releaseMailboxLease,
  WORKER_ID,
  type Executor,
} from "./source-quota.js";
import {
  addPending,
  applyLabelChange,
  attachmentStatuses,
  compareHistoryIds,
  duePending,
  dueRfc822Retries,
  ensureSyncState,
  getMessageRow,
  getMessageRows,
  getSyncState,
  historyIdOrNull,
  markMessageDeleted,
  markSeen,
  messagesAbsentFromGeneration,
  messagesWithDueAttachments,
  patchSyncState,
  putBlob,
  refreshFromMinimal,
  registerAttachmentParts,
  removePending,
  rowsOf,
  setAttachmentResult,
  setRfc822Result,
  startGeneration,
  storeHistoryPage,
  touchThreads,
  upsertFetchedMessage,
  type MailboxSyncState,
} from "./source-store.js";
import { sql } from "drizzle-orm";
import { gmailSourceConfig, type GmailSourceConfig } from "./source-config.js";

export { gmailSourceConfig, type GmailSourceConfig } from "./source-config.js";

/**
 * Gmail source-lane sync: resumable full-mailbox capture + History API deltas.
 *
 * Replaces the donor's bounded bootstrap (30 days / 500 messages) and its
 * history-404 fallback (7 days / 200 messages with the cursor jumped to "now"),
 * which skipped mail without ever saying so. Per (tenant, mailbox):
 *
 *  1. A full-capture *generation* starts by reading the mailbox historyId H0 from
 *     the profile BEFORE listing, and the history cursor is set to H0. Anything that
 *     changes after H0 arrives through history.list; everything that existed at H0
 *     is reached by the listing. No gap, no "latest N" window.
 *  2. messages.list pages are checkpointed (list_page_token advances only after
 *     every message of the page is stored or durably queued for retry), so a crash
 *     or rate limit resumes at the same page; stored messages are skipped cheaply.
 *  3. history.list is processed one page per checkpoint (cursor = last processed
 *     record id); labels are applied only when newer than the stored label state
 *     (Gmail historyId ordering), deletions write durable tombstones, unknown
 *     messages are fetched. Out-of-order or replayed records are harmless.
 *  4. history.list 404 (expired cursor) starts a NEW generation (full re-list, as
 *     Gmail's sync guide requires). Messages observed before the new H0 are
 *     re-verified (format=minimal); captured messages the finished listing never saw
 *     are tombstoned (`absent_from_listing`), so deletions inside the gap are not lost.
 *  5. The mailbox is `complete` only when the current generation's listing and sweep
 *     finished and no message fetch is pending; bounded work per run, continued by
 *     re-enqueued gmail.backfill tasks and by the 30s gmail.poll.
 *
 * Quota: one active sync and one durable cooldown per upstream mailbox
 * (source-quota.ts), Retry-After honoured as a floor with exponential backoff on
 * repeats; errors back off per mailbox; one mailbox's failure never stops the others.
 */

export type MailboxOutcome = "ok" | "busy" | "cooldown" | "backoff" | "blocked" | "error";

export interface GmailSourceMailboxResult {
  mailbox: string;
  outcome: MailboxOutcome;
  generation: number;
  scanned: number;
  stored: number;
  refreshed: number;
  labelChanges: number;
  deletions: number;
  historyPages: number;
  historyReset: boolean;
  failedFetches: number;
  complete: boolean;
  attachments: GmailAttachmentStats;
  quotaUnits: number;
  cooldownUntil?: string;
  error?: string;
}

export interface GmailSourceRunResult {
  mailboxes: GmailSourceMailboxResult[];
  scanned: number;
  stored: number;
  failedFetches: number;
  /** True only when every rostered mailbox has a complete current generation. */
  exhausted: boolean;
  /** Always false: no run is bounded by a message cap that is then reported as done. */
  capHit: false;
  historyId: string;
  attachments: GmailAttachmentStats;
}

export interface GmailSourceRunOptions {
  mailbox?: string;
  executor?: Executor;
  config?: Partial<GmailSourceConfig>;
  /** Enqueue a continuation gmail.backfill when a mailbox is not finished (default true for backfill). */
  continueWork?: boolean;
}

type Mode = "poll" | "backfill";

class Budget {
  readonly deadline: number;
  used = 0;
  constructor(readonly maxMessages: number, maxMs: number) {
    this.deadline = Date.now() + maxMs;
  }
  get exhausted(): boolean {
    return this.used >= this.maxMessages || Date.now() >= this.deadline;
  }
}

class BudgetExhausted extends Error {
  constructor() {
    super("run budget exhausted");
    this.name = "BudgetExhausted";
  }
}

class MailboxBlocked extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MailboxBlocked";
  }
}

interface Ctx {
  executor: Executor;
  tenantId: string;
  mailbox: string;
  client: GmailSourceClient;
  config: GmailSourceConfig;
  budget: Budget;
  result: GmailSourceMailboxResult;
  state: MailboxSyncState;
}

/** Runs `fn` over items with bounded concurrency; stops taking new items after the first error and rethrows it. */
async function runLimited<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]!);
      } catch (error) {
        if (failure === null) failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, worker));
  if (failure !== null) throw failure;
}

function emptyMailboxResult(mailbox: string, generation: number): GmailSourceMailboxResult {
  return {
    mailbox,
    outcome: "ok",
    generation,
    scanned: 0,
    stored: 0,
    refreshed: 0,
    labelChanges: 0,
    deletions: 0,
    historyPages: 0,
    historyReset: false,
    failedFetches: 0,
    complete: false,
    attachments: emptyGmailAttachmentStats(),
    quotaUnits: 0,
  };
}

function errText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
}

// ------------------------------------------------------------------ entry points

export async function runGmailSourcePoll(tenantId: string, options: GmailSourceRunOptions = {}): Promise<GmailSourceRunResult> {
  return runGmailSource(tenantId, "poll", { continueWork: true, ...options });
}

export async function runGmailSourceBackfill(tenantId: string, options: GmailSourceRunOptions = {}): Promise<GmailSourceRunResult> {
  return runGmailSource(tenantId, "backfill", { continueWork: true, ...options });
}

async function runGmailSource(tenantId: string, mode: Mode, options: GmailSourceRunOptions): Promise<GmailSourceRunResult> {
  const executor = options.executor ?? db;
  const config = { ...gmailSourceConfig(), ...options.config };
  // The roster is this tenant's own active google connections; a mailbox named in a task
  // payload is honoured only if it is on that roster (payloads never widen access).
  const roster = await listGoogleMailboxes(tenantId, executor);
  const target = options.mailbox?.trim().toLowerCase();
  const mailboxes = target ? roster.filter((m) => m === target) : roster;
  const results: GmailSourceMailboxResult[] = [];
  for (const mailbox of mailboxes) {
    const r = await syncMailbox(executor, tenantId, mailbox, mode, config);
    results.push(r);
    if (options.continueWork) await scheduleContinuation(executor, tenantId, mailbox, r, mode);
  }
  const attachments = emptyGmailAttachmentStats();
  for (const r of results) mergeGmailAttachmentStats(attachments, r.attachments);
  const last = results.length ? await getSyncState(executor, tenantId, results[results.length - 1]!.mailbox) : null;
  return {
    mailboxes: results,
    scanned: results.reduce((n, r) => n + r.scanned, 0),
    stored: results.reduce((n, r) => n + r.stored, 0),
    failedFetches: results.reduce((n, r) => n + r.failedFetches, 0),
    exhausted: results.length > 0 && results.length === mailboxes.length && results.every((r) => r.complete),
    capHit: false,
    historyId: last?.historyId ?? "",
    attachments,
  };
}

/**
 * Keeps exactly one gmail.backfill chain alive per unfinished mailbox. A backfill run enqueues its
 * successor unless another one is already queued; gmail.poll (every 30s) re-arms a chain that was
 * lost (crash, expired task, history reset detected by the poll) unless one is queued or running.
 */
async function scheduleContinuation(executor: Executor, tenantId: string, mailbox: string, r: GmailSourceMailboxResult, mode: Mode): Promise<void> {
  if (r.outcome === "blocked") return; // gmail.poll re-checks blocked mailboxes on its own backoff
  const state = await getSyncState(executor, tenantId, mailbox);
  // A complete generation needs no chain: owed retries (fetches, attachment / RFC822 bytes) are
  // picked up by gmail.poll's retry slice when due. Not started yet (busy / cooldown / transient
  // error before the first generation) still needs the chain.
  if (!state || r.complete) return;
  const states = mode === "poll" ? ["queued", "running"] : ["queued"];
  const existing = rowsOf<{ n: number }>(
    await executor.execute(sql`
      SELECT count(*)::int AS n FROM task_queue
      WHERE tenant_id = ${tenantId} AND kind = 'gmail.backfill' AND state IN (${sql.join(states.map((x) => sql`${x}`), sql`, `)})
        AND (NULLIF(payload->>'mailbox', '') IS NULL OR lower(payload->>'mailbox') = ${mailbox})
    `),
  )[0];
  if (Number(existing?.n ?? 0) > 0) return;
  let runAt = new Date(Date.now() + 2_000);
  if (r.cooldownUntil) runAt = new Date(r.cooldownUntil);
  else if (r.outcome === "busy") runAt = new Date(Date.now() + 30_000);
  else if (state.nextAttemptAt && state.nextAttemptAt.getTime() > Date.now()) runAt = state.nextAttemptAt;
  await patchSyncState(executor, tenantId, mailbox, { continuationSeqIncrement: true });
  await enqueueTask({
    queue: "backfill",
    tenantId,
    kind: "gmail.backfill",
    groupKey: `${tenantId}:gmail`,
    payload: { tenantId, mailbox, mode: "full", continuation: state.continuationSeq + 1 },
    // Distinct from the running task's key (dedupe keys are unique only among queued/running tasks).
    dedupeKey: `${tenantId}:google:gmail.backfill:continue:${mailbox}:${state.continuationSeq + 1}`,
    runAt,
    priority: -10,
  }, executor);
}

// ------------------------------------------------------------------ one mailbox

export async function syncMailbox(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  mode: Mode,
  config: GmailSourceConfig = gmailSourceConfig(),
): Promise<GmailSourceMailboxResult> {
  const quotaKey = gmailQuotaKey(mailbox);
  let state = await ensureSyncState(executor, tenantId, mailbox, quotaKey);
  const result = emptyMailboxResult(mailbox, state.generation);

  if (state.nextAttemptAt && state.nextAttemptAt.getTime() > Date.now()) {
    result.outcome = state.blockedCode ? "blocked" : "backoff";
    result.error = state.blockedReason ?? state.lastError ?? undefined;
    return result;
  }
  const quota = await readQuotaState(executor, quotaKey);
  if (quota.cooldownUntil && quota.cooldownUntil.getTime() > Date.now()) {
    result.outcome = "cooldown";
    result.cooldownUntil = quota.cooldownUntil.toISOString();
    return result;
  }
  const leaseOwner = `${WORKER_ID}:${tenantId}`;
  if (!(await acquireMailboxLease(executor, quotaKey, leaseOwner, Math.ceil(config.runMaxMs / 1000) + 120))) {
    result.outcome = "busy";
    return result;
  }

  let client: GmailSourceClient | null = null;
  try {
    let credential;
    try {
      credential = await getGoogleApiCredential(tenantId, mailbox, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code !== "token_refresh_failed") throw new MailboxBlocked(error.code, error.message);
      if (error instanceof GoogleDwdNotApprovedError) throw new MailboxBlocked(error.code, error.message);
      throw error;
    }
    client = new GmailSourceClient(credential, quotaKey);
    if (state.authMode !== credential.mode || state.blockedCode) {
      await patchSyncState(executor, tenantId, mailbox, { authMode: credential.mode, blocked: null });
    }

    const budget = new Budget(mode === "poll" ? config.pollMaxMessages : config.backfillMaxMessages, config.runMaxMs);
    const ctx: Ctx = { executor, tenantId, mailbox, client, config, budget, result, state };

    if (state.generation === 0) await beginGeneration(ctx, "initial");

    try {
      if (mode === "poll") {
        await historySlice(ctx);
        await retrySlice(ctx);
        const stalled = !ctx.state.listExhaustedAt
          && (!ctx.state.lastListProgressAt || Date.now() - ctx.state.lastListProgressAt.getTime() > config.listStallSeconds * 1000);
        if (stalled) await listSlice(ctx);
      } else {
        await listSlice(ctx);
        await retrySlice(ctx);
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
    }
    await finishGenerationIfDone(ctx);

    state = (await getSyncState(executor, tenantId, mailbox))!;
    result.generation = state.generation;
    result.complete = state.fullCompleteGeneration === state.generation && state.generation > 0;
    await patchSyncState(executor, tenantId, mailbox, { success: true, error: null });
    await recordQuotaSuccess(executor, quotaKey);
  } catch (error) {
    if (error instanceof GoogleRateLimitError) {
      const until = await recordRateLimit(executor, quotaKey, { status: error.status, reason: error.reason, retryAfterSeconds: error.retryAfterSeconds });
      result.outcome = "cooldown";
      result.cooldownUntil = until.toISOString();
    } else if (error instanceof MailboxBlocked || (error instanceof GmailHttpError && error.status === 403)) {
      // A non-quota 403 (API disabled for the project, mail service off, scope not granted) is an
      // access problem, not a transient one: report it blocked and re-check on the blocked backoff.
      const code = error instanceof MailboxBlocked ? error.code : `gmail_forbidden${error.reason ? `:${error.reason}` : ""}`;
      result.outcome = "blocked";
      result.error = error.message;
      await patchSyncState(executor, tenantId, mailbox, {
        blocked: { code, reason: error.message.slice(0, 500) },
        nextAttemptAt: new Date(Date.now() + config.blockedRetrySeconds * 1000),
      });
    } else {
      result.outcome = "error";
      result.error = errText(error);
      const fresh = await getSyncState(executor, tenantId, mailbox);
      await patchSyncState(executor, tenantId, mailbox, { error: { message: result.error, backoffSeconds: errorBackoffSeconds((fresh?.errorStreak ?? 0) + 1) } });
    }
    const fresh = await getSyncState(executor, tenantId, mailbox);
    result.generation = fresh?.generation ?? result.generation;
    result.complete = Boolean(fresh && fresh.generation > 0 && fresh.fullCompleteGeneration === fresh.generation);
  } finally {
    if (client) result.quotaUnits = client.stats.units;
    await releaseMailboxLease(executor, quotaKey, leaseOwner);
  }
  return result;
}

async function reloadState(ctx: Ctx): Promise<void> {
  ctx.state = (await getSyncState(ctx.executor, ctx.tenantId, ctx.mailbox))!;
}

async function verifiedProfile(ctx: Ctx): Promise<GmailProfile> {
  const profile = await ctx.client.profile();
  if (profile.emailAddress.trim().toLowerCase() !== ctx.mailbox) {
    // The credential reaches a different mailbox than the roster entry: never store its mail here.
    throw new MailboxBlocked("mailbox_identity_mismatch", "The Google credential for this roster entry resolves to a different mailbox.");
  }
  const h = historyIdOrNull(profile.historyId);
  if (!h) throw new GmailHttpError("profile", 502, null, "Gmail profile historyId is not a decimal history id");
  return { ...profile, historyId: h };
}

async function beginGeneration(ctx: Ctx, reason: "initial" | "history_expired" | "reset"): Promise<void> {
  const profile = await verifiedProfile(ctx);
  await startGeneration(ctx.executor, ctx.tenantId, ctx.mailbox, { reason, startHistoryId: profile.historyId, includeSpamTrash: ctx.config.includeSpamTrash });
  await reloadState(ctx);
  ctx.result.generation = ctx.state.generation;
  if (reason !== "initial") ctx.result.historyReset = true;
}

// ------------------------------------------------------------------ message capture

type FetchOutcome = "stored" | "exists" | "gone" | "deleted";

/** messages.get(full) -> raw row (+ attachments, RFC822 on first capture). Rate limits propagate. */
async function fetchAndStore(ctx: Ctx, messageId: string): Promise<FetchOutcome> {
  ctx.budget.used += 1;
  ctx.result.scanned += 1;
  const msg = await ctx.client.getMessageFull(messageId);
  if (!msg) {
    await removePending(ctx.executor, ctx.tenantId, ctx.mailbox, messageId);
    return "gone";
  }
  const historyId = historyIdOrNull(msg.historyId) ?? "0";
  const rawObject = gmailMessageForRawPayload(msg);
  const rawJson = JSON.stringify(redactProviderPayload("gmail", rawObject));
  const redactionApplied = rawJson !== JSON.stringify(rawObject);
  const sizeEstimate = typeof msg.sizeEstimate === "number" ? msg.sizeEstimate : null;
  const rfc822Status = !ctx.config.captureRfc822
    ? "disabled"
    : redactionApplied
      ? "withheld_redaction" // the exact bytes would bypass the JSON-field redaction
      : sizeEstimate !== null && sizeEstimate > ctx.config.rfc822MaxBytes
        ? "oversize"
        : "pending";
  const internalMs = msg.internalDate ? Number(msg.internalDate) : NaN;
  const stored = await upsertFetchedMessage(ctx.executor, ctx.tenantId, ctx.mailbox, {
    messageId: msg.id,
    threadId: msg.threadId ?? null,
    internalDate: Number.isFinite(internalMs) ? new Date(internalMs) : null,
    sizeEstimate,
    historyId,
    rawJson,
    redactionApplied,
    labelIds: msg.labelIds ?? [],
    rfc822Status,
    seenGeneration: ctx.state.generation,
  });
  await removePending(ctx.executor, ctx.tenantId, ctx.mailbox, messageId);
  await touchThreads(ctx.executor, ctx.tenantId, ctx.mailbox, [msg.threadId ?? null]);
  if (stored.deleted) return "deleted";
  if (!stored.capturedRaw) return "exists";
  ctx.result.stored += 1;
  await captureAttachments(ctx, msg, null);
  if (rfc822Status === "pending") await captureRfc822(ctx, msg.id);
  return "stored";
}

/** Fetch with failure isolation: 404 = gone, rate limit propagates, other errors -> durable pending retry. */
async function fetchOrQueue(ctx: Ctx, messageId: string, reason: string): Promise<FetchOutcome | "queued"> {
  try {
    return await fetchAndStore(ctx, messageId);
  } catch (error) {
    if (error instanceof GoogleRateLimitError || error instanceof MailboxBlocked) throw error;
    if (error instanceof GmailHttpError && (error.status === 401 || (error.status === 403 && !error.transient))) throw error;
    ctx.result.failedFetches += 1;
    await addPending(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, reason, errText(error), 60);
    return "queued";
  }
}

function partDisposition(part: { headers?: Array<{ name: string; value: string }> }): string | null {
  const v = getPartHeader(part, "Content-Disposition");
  return v ? v.split(";")[0]!.trim().toLowerCase().slice(0, 40) || null : null;
}

/** Attachment/inline part bytes, keyed by (message, part); `only` limits to parts still owed. */
async function captureAttachments(ctx: Ctx, msg: GmailMessage, only: ReadonlySet<string> | null): Promise<void> {
  if (!msg.payload) return;
  const parts = collectAttachmentParts(msg.payload);
  await registerAttachmentParts(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, parts.map(({ part, ref }) => ({
    partRef: ref,
    partId: part.partId ?? null,
    filename: part.filename?.trim() ? part.filename : null,
    mimeType: part.mimeType ?? null,
    declaredSize: typeof part.body?.size === "number" ? part.body.size : null,
    contentId: getPartHeader(part, "Content-ID")?.slice(0, 300) ?? null,
    disposition: partDisposition(part),
  })));
  const stats = ctx.result.attachments;
  for (const { part, ref } of parts) {
    if (only && !only.has(ref)) continue;
    stats.seen += 1;
    const declared = part.body?.size ?? 0;
    if (declared > ctx.config.attachmentMaxBytes) {
      stats.skippedOversize += 1;
      await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "skipped_oversize", error: `declared ${declared} bytes > cap ${ctx.config.attachmentMaxBytes}` });
      continue;
    }
    try {
      let bytes: Buffer | null = null;
      let capture: "inline" | "attachments.get" = "inline";
      if (part.body?.data) bytes = base64UrlToBuffer(part.body.data);
      else if (part.body?.attachmentId) {
        capture = "attachments.get";
        const got = await ctx.client.getAttachment(msg.id, part.body.attachmentId);
        if (got?.data !== undefined) bytes = base64UrlToBuffer(got.data);
        else if (got === null) {
          await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "failed", error: "attachments.get 404 (attachment id rotated?)", backoffSeconds: 300 });
          stats.failed += 1;
          continue;
        }
      }
      if (!bytes) {
        stats.failed += 1;
        await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "failed", error: "no attachment data returned", backoffSeconds: 600 });
        continue;
      }
      if (bytes.length > ctx.config.attachmentMaxBytes) {
        stats.skippedOversize += 1;
        await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "skipped_oversize", error: `${bytes.length} bytes > cap ${ctx.config.attachmentMaxBytes}` });
        continue;
      }
      const blob = await putBlob(ctx.executor, ctx.tenantId, bytes);
      await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "stored", sha256: blob.sha256, size: blob.size, capture });
      stats.stored += 1;
    } catch (error) {
      if (error instanceof GoogleRateLimitError) throw error;
      stats.failed += 1;
      await setAttachmentResult(ctx.executor, ctx.tenantId, ctx.mailbox, msg.id, ref, { status: "failed", error: errText(error), backoffSeconds: 300 });
    }
  }
}

async function captureRfc822(ctx: Ctx, messageId: string): Promise<void> {
  try {
    const raw = await ctx.client.getMessageRaw(messageId);
    if (!raw) {
      await setRfc822Result(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, { status: "unavailable", error: "messages.get(raw) 404" });
      return;
    }
    if (typeof raw.raw !== "string") {
      await setRfc822Result(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, { status: "failed", error: "messages.get(raw) returned no raw field", backoffSeconds: 600 });
      return;
    }
    const bytes = base64UrlToBuffer(raw.raw);
    if (bytes.length > ctx.config.rfc822MaxBytes) {
      await setRfc822Result(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, { status: "oversize", error: `${bytes.length} bytes > cap ${ctx.config.rfc822MaxBytes}` });
      return;
    }
    const blob = await putBlob(ctx.executor, ctx.tenantId, bytes);
    await setRfc822Result(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, { status: "captured", sha256: blob.sha256, size: blob.size });
  } catch (error) {
    if (error instanceof GoogleRateLimitError) throw error;
    await setRfc822Result(ctx.executor, ctx.tenantId, ctx.mailbox, messageId, { status: "failed", error: errText(error), backoffSeconds: 300 });
  }
}

// ------------------------------------------------------------------ listing

async function listSlice(ctx: Ctx): Promise<void> {
  const { executor, tenantId, mailbox } = ctx;
  while (!ctx.state.listExhaustedAt) {
    if (ctx.budget.exhausted) throw new BudgetExhausted();
    const generation = ctx.state.generation;
    const startHistoryId = ctx.state.generationStartHistoryId ?? "0";
    const page = await ctx.client.listMessages({ pageToken: ctx.state.listPageToken, includeSpamTrash: ctx.config.includeSpamTrash });
    const ids = [...new Set(page.messages.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0))];
    const existing = await getMessageRows(executor, tenantId, mailbox, ids);
    const seen: string[] = [];
    const refresh: string[] = [];
    const fetch: string[] = [];
    for (const id of ids) {
      const row = existing.get(id);
      if (!row) fetch.push(id);
      else if (row.deletedReason === "provider_deleted") continue;
      else if (!row.hasRaw) fetch.push(id);
      else if (row.deletedReason === "absent_from_listing") refresh.push(id);
      else if (row.seenGeneration >= generation) continue;
      else if (row.observedHistoryId && compareHistoryIds(row.observedHistoryId, startHistoryId) >= 0) seen.push(id);
      else refresh.push(id);
    }
    await markSeen(executor, tenantId, mailbox, seen, generation);

    let budgetHit = false;
    const touched: Array<string | null> = [];
    await runLimited([...refresh.map((id) => ({ id, kind: "refresh" as const })), ...fetch.map((id) => ({ id, kind: "fetch" as const }))], ctx.config.fetchConcurrency, async (item) => {
      if (ctx.budget.exhausted) {
        budgetHit = true;
        return;
      }
      if (item.kind === "fetch") {
        await fetchOrQueue(ctx, item.id, "list_fetch_failed");
        return;
      }
      // Re-verify a message captured before this generation's start (labels may have changed in a history gap).
      ctx.budget.used += 1;
      ctx.result.scanned += 1;
      try {
        const min = await ctx.client.getMessageMinimal(item.id);
        if (!min) {
          const r = await markMessageDeleted(executor, tenantId, mailbox, item.id, { historyId: null, reason: "provider_deleted" });
          if (r.newlyDeleted) ctx.result.deletions += 1;
          touched.push(r.threadId);
          return;
        }
        await refreshFromMinimal(executor, tenantId, mailbox, { messageId: item.id, historyId: historyIdOrNull(min.historyId) ?? "0", labelIds: min.labelIds ?? [], generation });
        ctx.result.refreshed += 1;
        touched.push(min.threadId ?? null);
      } catch (error) {
        if (error instanceof GoogleRateLimitError || error instanceof MailboxBlocked) throw error;
        ctx.result.failedFetches += 1;
        await addPending(executor, tenantId, mailbox, item.id, "resync_refresh_failed", errText(error), 60);
      }
    });
    await touchThreads(executor, tenantId, mailbox, touched);
    if (budgetHit) throw new BudgetExhausted(); // the page token is NOT advanced; the page is redone (stored ids skip)

    await patchSyncState(executor, tenantId, mailbox, {
      listIncludeSpamTrash: ctx.config.includeSpamTrash,
      listPageToken: page.nextPageToken ?? null,
      listPagesDoneIncrement: 1,
      listMessagesSeenIncrement: ids.length,
      listProgress: true,
      ...(page.nextPageToken ? {} : { listExhausted: true }),
    });
    await reloadState(ctx);
  }
}

/** After a finished listing: tombstone captured messages the listing never saw, then mark complete. */
async function finishGenerationIfDone(ctx: Ctx): Promise<void> {
  const { executor, tenantId, mailbox } = ctx;
  if (!ctx.state.listExhaustedAt || ctx.state.fullCompleteGeneration === ctx.state.generation) return;
  const startHistoryId = ctx.state.generationStartHistoryId ?? "0";
  for (;;) {
    const absent = await messagesAbsentFromGeneration(executor, tenantId, mailbox, ctx.state.generation, startHistoryId, 500);
    if (absent.length === 0) break;
    for (const a of absent) {
      const r = await markMessageDeleted(executor, tenantId, mailbox, a.messageId, { historyId: null, reason: "absent_from_listing" });
      if (r.newlyDeleted) ctx.result.deletions += 1;
    }
    await touchThreads(executor, tenantId, mailbox, absent.map((a) => a.threadId));
    if (absent.length < 500) break;
    if (Date.now() >= ctx.budget.deadline) return;
  }
  const pending = rowsOf<{ n: number }>(
    await executor.execute(sql`SELECT count(*)::int AS n FROM gmail_source_pending WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}`),
  )[0];
  if (Number(pending?.n ?? 0) > 0) return; // completeness waits for every queued fetch
  await patchSyncState(executor, tenantId, mailbox, { fullComplete: true });
  await reloadState(ctx);
}

// ------------------------------------------------------------------ history

async function historySlice(ctx: Ctx): Promise<void> {
  const { executor, tenantId, mailbox } = ctx;
  for (let pages = 0; pages < ctx.config.historyMaxPages; pages++) {
    const cursor = ctx.state.historyId;
    if (!cursor) return;
    let page;
    try {
      page = await ctx.client.listHistory(cursor);
    } catch (error) {
      if (!(error instanceof GmailHistoryExpiredError)) throw error;
      // Gmail sync guide: an expired startHistoryId requires a full sync. New generation:
      // fresh H0 + cursor, complete re-list, absent-message sweep. Nothing is assumed captured.
      await beginGeneration(ctx, "history_expired");
      return;
    }
    const records = [...(page.history ?? [])]
      .filter((r): r is HistoryRecord => Boolean(r && historyIdOrNull(r.id)))
      .sort((a, b) => compareHistoryIds(historyIdOrNull(a.id)!, historyIdOrNull(b.id)!));
    const firstId = records.length ? historyIdOrNull(records[0]!.id) : null;
    const lastId = records.length ? historyIdOrNull(records[records.length - 1]!.id) : null;
    if (records.length) {
      await storeHistoryPage(executor, tenantId, mailbox, {
        startHistoryId: cursor,
        responseHistoryId: historyIdOrNull(page.historyId),
        firstRecordId: firstId,
        lastRecordId: lastId,
        recordCount: records.length,
        rawJson: JSON.stringify(redactProviderPayload("gmail", page)),
      });
    }

    const toFetch = new Set<string>();
    const touched: Array<string | null> = [];
    for (const record of records) {
      const recordId = historyIdOrNull(record.id)!;
      for (const added of record.messagesAdded ?? []) {
        const id = added?.message?.id;
        if (!id) continue;
        const row = await getMessageRow(executor, tenantId, mailbox, id);
        if (row?.deletedReason === "provider_deleted") continue;
        if (row?.hasRaw && !row.deletedAt && Array.isArray(added.message.labelIds)) {
          const r = await applyLabelChange(executor, tenantId, mailbox, id, recordId, { set: added.message.labelIds });
          if (r === "applied") ctx.result.labelChanges += 1;
          touched.push(row.threadId);
        } else if (!row?.hasRaw || row.deletedAt) toFetch.add(id);
      }
      for (const [list, op] of [[record.labelsAdded, "add"], [record.labelsRemoved, "remove"]] as const) {
        for (const change of list ?? []) {
          const id = change?.message?.id;
          if (!id) continue;
          const labels = Array.isArray(change.labelIds) ? change.labelIds : [];
          const r = await applyLabelChange(executor, tenantId, mailbox, id, recordId, op === "add" ? { add: labels } : { remove: labels });
          if (r === "applied") {
            ctx.result.labelChanges += 1;
            touched.push(change.message.threadId ?? null);
          } else if (r === "unknown") toFetch.add(id);
        }
      }
      for (const deleted of record.messagesDeleted ?? []) {
        const id = deleted?.message?.id;
        if (!id) continue;
        toFetch.delete(id);
        const r = await markMessageDeleted(executor, tenantId, mailbox, id, { historyId: recordId, reason: "provider_deleted" });
        if (r.newlyDeleted) ctx.result.deletions += 1;
        touched.push(r.threadId ?? deleted.message.threadId ?? null);
      }
    }
    await touchThreads(executor, tenantId, mailbox, touched);

    let budgetHit = false;
    await runLimited([...toFetch], ctx.config.fetchConcurrency, async (id) => {
      if (ctx.budget.exhausted) {
        budgetHit = true;
        return;
      }
      await fetchOrQueue(ctx, id, "history_fetch_failed");
    });
    if (budgetHit) throw new BudgetExhausted(); // cursor NOT advanced: the page is replayed (idempotent)

    // Advance past this page only now. With more pages, resume after the last processed record;
    // at the end, jump to the mailbox historyId the response reported.
    let next = page.nextPageToken ? lastId : historyIdOrNull(page.historyId) ?? lastId;
    if (!next || compareHistoryIds(next, cursor) < 0) next = cursor;
    await patchSyncState(executor, tenantId, mailbox, { historyId: next, historyChecked: true });
    await reloadState(ctx);
    ctx.result.historyPages += 1;
    if (!page.nextPageToken) return;
  }
}

// ------------------------------------------------------------------ retries

async function retrySlice(ctx: Ctx): Promise<void> {
  const { executor, tenantId, mailbox } = ctx;
  const pending = await duePending(executor, tenantId, mailbox, 50);
  await runLimited(pending, ctx.config.fetchConcurrency, async (id) => {
    if (ctx.budget.exhausted) return;
    await fetchOrQueue(ctx, id, "retry_failed");
  });
  if (ctx.budget.exhausted) return;

  // Attachments owed bytes: re-fetch the message for current (volatile) attachment ids.
  for (const id of await messagesWithDueAttachments(executor, tenantId, mailbox, 20)) {
    if (ctx.budget.exhausted) return;
    ctx.budget.used += 1;
    const statuses = await attachmentStatuses(executor, tenantId, mailbox, id);
    const owed = new Set([...statuses].filter(([, s]) => s === "pending" || s === "failed").map(([ref]) => ref));
    try {
      const msg = await ctx.client.getMessageFull(id);
      if (!msg) {
        for (const ref of owed) await setAttachmentResult(executor, tenantId, mailbox, id, ref, { status: "unavailable", error: "message no longer exists" });
        continue;
      }
      await captureAttachments(ctx, msg, owed);
    } catch (error) {
      if (error instanceof GoogleRateLimitError) throw error;
      for (const ref of owed) await setAttachmentResult(executor, tenantId, mailbox, id, ref, { status: "failed", error: errText(error), backoffSeconds: 600 });
    }
  }

  for (const id of await dueRfc822Retries(executor, tenantId, mailbox, 20)) {
    if (ctx.budget.exhausted) return;
    ctx.budget.used += 1;
    await captureRfc822(ctx, id);
  }
}

