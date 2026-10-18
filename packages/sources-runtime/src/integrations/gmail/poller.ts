import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents, conversationWatermarks } from "../../db/schema.js";
import { getGoogleAccessToken, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES } from "../../vault/google-auth.js";
import { getGoogleMailboxState, listGoogleMailboxes, updateGoogleMailboxState } from "../google/mailboxes.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { getTokenMetadata, mergeTokenMetadata, updateTokenMetadata } from "../../vault/tokens.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { eq, and } from "drizzle-orm";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { normalizeGmailBody } from "./body.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import { GoogleRateLimitError, googleRateLimitErrorFromResponse, throwIfGoogleRateLimited } from "../../vault/google-rate-limit.js";
import {
  deleteGmailMessageSourceWiki,
  materializeGmailMessageSourceWiki,
  materializeSourceWikiIndexes,
} from "../../mirror/materializer.js";
import { intakeBinaryDocument } from "../binary/intake.js";

// SOURCE-LANE PATCH (gmail agent): the MIME/body/attachment parsers below are exported (no behaviour
// change) so src/integrations/gmail/source-sync.ts reuses them; jobs.ts now runs that resumable engine.
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const RATE_LIMIT_DELAY_MS = 100;

// Attachment BYTES go to the existing S3 + binary_documents lane (provider
// "gmail-attachment"). Metadata for EVERY attachment always lands in the raw
// event payload (full MIME tree incl. body.attachmentId) even when bytes are
// skipped. Bytes over the cap are skipped with a visible counter; Gmail's own
// send limit is 25MB, so the default cap skips nothing real.
const GMAIL_ATTACHMENT_MAX_BYTES = Math.max(1, Math.floor(Number(process.env.GMAIL_ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024)));

// Byte-capture scope: common document + image types. Anything outside lands
// as a metadata-only failed_unsupported binary_documents row (visible, never
// silent) - archives/audio/video/executables are deliberately out of scope.
const GMAIL_ATTACHMENT_BYTE_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "application/json",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "image/svg+xml",
]);
// Quota math: Gmail allows 250 quota units/sec/user; messages.get costs 5
// units, so the per-user ceiling is ~50 fetches/sec. 10 concurrent fetches
// with the 100ms stagger and real network latency lands at ~20-30/sec -
// roughly half the ceiling - and GoogleRateLimitError still backs off if
// Google pushes back.
const GMAIL_MESSAGE_CONCURRENCY = parseConcurrencyEnv("GMAIL_MESSAGE_CONCURRENCY", 10, { max: 10 });

export interface MimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: MimePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: MimePart;
}

export interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
}

interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  partId?: string;
}

/** Per-run visibility counters for attachment byte capture - never a silent skip. */
export interface GmailAttachmentStats {
  seen: number;
  stored: number;
  skippedExisting: number;
  skippedOversize: number;
  skippedUnsupportedType: number;
  failed: number;
}

export function mergeGmailAttachmentStats(into: GmailAttachmentStats, from: GmailAttachmentStats): void {
  into.seen += from.seen;
  into.stored += from.stored;
  into.skippedExisting += from.skippedExisting;
  into.skippedOversize += from.skippedOversize;
  into.skippedUnsupportedType += from.skippedUnsupportedType;
  into.failed += from.failed;
}

export function emptyGmailAttachmentStats(): GmailAttachmentStats {
  return { seen: 0, stored: 0, skippedExisting: 0, skippedOversize: 0, skippedUnsupportedType: 0, failed: 0 };
}

export function gmailMessageForRawPayload(msg: GmailMessage): Record<string, unknown> {
  const raw = { ...(msg as unknown as Record<string, unknown>) };
  if (msg.payload) raw.payload = gmailPartForRawPayload(msg.payload);
  return raw;
}

function gmailPartForRawPayload(part: MimePart): Record<string, unknown> {
  const raw = { ...(part as Record<string, unknown>) };
  if (part.body) {
    const body = { ...(part.body as Record<string, unknown>) };
    if (isGmailAttachmentPart(part)) delete body.data;
    raw.body = body;
  }
  if (part.parts) raw.parts = part.parts.map(gmailPartForRawPayload);
  return raw;
}

function isGmailAttachmentPart(part: MimePart): boolean {
  if (part.filename && part.filename.trim().length > 0) return true;
  if (part.body?.attachmentId) return true;
  if (isTextBodyPart(part)) return false;
  return Boolean(getPartHeader(part, "Content-ID") || /(?:^|;)\s*(?:attachment|inline)\b/iu.test(getPartHeader(part, "Content-Disposition") ?? ""));
}

function isTextBodyPart(part: MimePart): boolean {
  const mimeType = part.mimeType?.toLowerCase() ?? "";
  return mimeType === "text/plain" || mimeType === "text/html";
}

export function getPartHeader(part: MimePart, name: string): string | undefined {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export function getHeader(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export function parseEmailAddress(raw: string): { name: string; email: string } {
  if (!raw || !raw.trim()) return { name: "", email: "" };
  const match = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].replace(/^"|"$/g, "").trim(), email: match[2].trim() };
  return { name: raw.trim(), email: raw.trim() };
}

function sanitizeText(s: string): string {
  return s.replace(/\x00/g, "").replace(/\\u0000/g, "");
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return sanitizeText(Buffer.from(base64, "base64").toString("utf-8"));
}

export function extractBodyText(part: MimePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractBodyText(child);
      if (text) return text;
    }
  }
  return "";
}

export function extractHtmlBody(part: MimePart): string {
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const child of part.parts) {
      const html = extractHtmlBody(child);
      if (html) return html;
    }
  }
  return "";
}

export function extractAttachments(part: MimePart): Attachment[] {
  const attachments: Attachment[] = [];

  if (part.filename && part.filename.length > 0) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
      ...(part.partId ? { partId: part.partId } : {}),
    });
  }

  if (part.parts) {
    for (const child of part.parts) {
      attachments.push(...extractAttachments(child));
    }
  }

  return attachments;
}

/**
 * Every part whose bytes are stripped from the raw payload (attachments,
 * inline images/files) - the byte-capture candidates. Text body parts are
 * excluded by isGmailAttachmentPart. `ref` is the Gmail partId when present,
 * else a synthetic walk-order key, so the binary row's external_id is stable
 * per (message, part) - Gmail attachmentIds are volatile across fetches and
 * must not key anything.
 */
export function collectAttachmentParts(part: MimePart, refs: Array<{ part: MimePart; ref: string }> = [], path = "0"): Array<{ part: MimePart; ref: string }> {
  if (isGmailAttachmentPart(part) && (part.body?.attachmentId || part.body?.data)) {
    refs.push({ part, ref: part.partId && part.partId.length > 0 ? part.partId : `p${path}` });
  }
  for (const [index, child] of (part.parts ?? []).entries()) {
    collectAttachmentParts(child, refs, `${path}.${index}`);
  }
  return refs;
}

export function classifyMessage(msg: GmailMessage, userEmail: string): string {
  const from = getHeader(msg, "From") ?? "";
  const fromParsed = parseEmailAddress(from);
  const labels = msg.labelIds ?? [];

  if (fromParsed.email.toLowerCase() === userEmail.toLowerCase()) return "message_sent";
  if (labels.includes("DRAFT")) return "draft";
  if (labels.includes("CATEGORY_PROMOTIONS")) return "promotion";
  if (labels.includes("CATEGORY_UPDATES")) return "update";
  if (labels.includes("CATEGORY_SOCIAL")) return "social";
  return "message_received";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GmailFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GmailFetchError";
  }
}

async function gmailFetch(url: string, accessToken: string, quotaUser?: string): Promise<Response> {
  // Cooldowns are scoped per quota principal: one throttled mailbox must not
  // insta-fail every other mailbox's traffic (live 2026-07-12: philip@'s
  // backfill died 20x on cooldowns triggered by ishan@'s 429s).
  throwIfGoogleRateLimited(quotaUser ? `gmail:${quotaUser}` : "gmail");

  // With domain-wide delegation Google charges per-user quota to the service
  // account by default, pooling every customer's traffic into one bucket.
  // X-Goog-Quota-User attributes each call to the actual end user so per-user
  // quotas apply per customer instead of collectively.
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(quotaUser ? { "X-Goog-Quota-User": quotaUser } : {}),
    },
  });

  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.clone().json();
    } catch {
      data = null;
    }
    const rateLimit = googleRateLimitErrorFromResponse(quotaUser ? `gmail:${quotaUser}` : "gmail", res, data);
    if (rateLimit) {
      console.log(`Gmail API rate limited - pausing for ${rateLimit.retryAfterSeconds}s`);
      throw rateLimit;
    }
  }

  return res;
}

async function fetchMessage(accessToken: string, messageId: string, quotaUser?: string): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_API}/messages/${messageId}`);
  url.searchParams.set("format", "full");

  const res = await gmailFetch(url.toString(), accessToken, quotaUser);
  if (!res.ok) {
    throw new GmailFetchError(`Gmail messages.get failed (${res.status})`, res.status);
  }
  return res.json();
}

async function fetchAttachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  quotaUser?: string,
): Promise<Buffer> {
  const url = new URL(`${GMAIL_API}/messages/${messageId}/attachments/${attachmentId}`);
  const res = await gmailFetch(url.toString(), accessToken, quotaUser);
  if (!res.ok) {
    throw new GmailFetchError(`Gmail attachments.get failed (${res.status})`, res.status);
  }
  const data = await res.json() as { data?: string };
  if (!data.data) {
    throw new Error("Gmail attachments.get returned no data");
  }
  return base64UrlToBuffer(data.data);
}

export function base64UrlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Capture attachment bytes into the shared S3 + binary_documents lane
 * (provider "gmail-attachment"). Runs on every message pass - poll AND
 * backfill - and is idempotent: external_id/version_ref are stable per
 * (message, part) and messages are immutable, so a row that exists skips the
 * fetch. That also means a re-run of gmail.backfill backfills attachment
 * bytes for messages captured before this lane existed. Fail-soft: attachment
 * problems never fail message ingestion; every skip is counted.
 */
async function captureGmailAttachments(
  userId: string,
  accessToken: string,
  msg: GmailMessage,
  fromEmail: string | null,
  stats: GmailAttachmentStats,
): Promise<void> {
  if (!msg.payload) return;
  const timestamp = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : null;

  for (const { part, ref } of collectAttachmentParts(msg.payload)) {
    stats.seen++;
    const declaredSize = part.body?.size ?? 0;
    if (declaredSize > GMAIL_ATTACHMENT_MAX_BYTES) {
      stats.skippedOversize++;
      console.log(
        `[gmail] attachment bytes skipped (oversize ${declaredSize} > ${GMAIL_ATTACHMENT_MAX_BYTES}) for message ${msg.id} part ${ref}`,
      );
      continue;
    }

    try {
      const attachmentId = part.body?.attachmentId;
      const inlineData = part.body?.data;
      const result = await intakeBinaryDocument({
        tenantId: userId,
        provider: "gmail-attachment",
        externalId: `${msg.id}:${ref}`,
        fetchBytes: attachmentId
          ? () => fetchAttachmentBytes(accessToken, msg.id, attachmentId, userId)
          : async () => base64UrlToBuffer(inlineData ?? ""),
        mimeType: part.mimeType ?? "application/octet-stream",
        // Messages are immutable, so (message, part) fully identifies the
        // bytes - a constant versionRef makes re-runs skip without a fetch.
        versionRef: `gmail:${msg.id}:${ref}`,
        sourceUpdatedAt: timestamp,
        authorEmail: fromEmail,
        sourceAcl: {
          provider: "gmail-attachment",
          gmailId: msg.id,
          threadId: msg.threadId,
          partId: ref,
          filename: part.filename ?? null,
          mimeType: part.mimeType ?? null,
        },
        supportedMimeTypes: GMAIL_ATTACHMENT_BYTE_MIMES,
      });
      if (result.status === "stored") stats.stored++;
      else if (result.status === "skipped") stats.skippedExisting++;
      else if (result.status === "failed_unsupported") stats.skippedUnsupportedType++;
      else stats.failed++;
    } catch (err) {
      if (err instanceof GoogleRateLimitError) throw err;
      stats.failed++;
      const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : "";
      console.warn(
        `[gmail] attachment capture failed for message ${msg.id} part ${ref}:`,
        err instanceof Error ? `${err.message.split("\n")[0]}${cause}` : err,
      );
    }
  }
}

async function fetchHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
  quotaUser?: string,
): Promise<{ history: HistoryRecord[]; historyId: string; nextPageToken?: string }> {
  const url = new URL(`${GMAIL_API}/history`);
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("maxResults", "500");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await gmailFetch(url.toString(), accessToken, quotaUser);

  if (res.status === 404) {
    throw new Error("HISTORY_EXPIRED");
  }
  if (!res.ok) {
    throw new Error(`Gmail history.list failed (${res.status})`);
  }
  return res.json();
}

async function fetchProfile(accessToken: string, quotaUser?: string): Promise<{ historyId: string; emailAddress: string }> {
  const res = await gmailFetch(`${GMAIL_API}/profile`, accessToken, quotaUser);
  if (!res.ok) {
    throw new Error(`Gmail profile fetch failed (${res.status})`);
  }
  const data = await res.json() as { historyId: string; emailAddress: string };
  if (!data.historyId) {
    throw new Error("Gmail profile returned no historyId");
  }
  return data;
}

// Significant label changes worth tracking as events
const TRACKED_LABELS = new Set([
  "STARRED", "UNREAD", "IMPORTANT", "TRASH", "SPAM",
  "CATEGORY_PERSONAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES",
  "CATEGORY_SOCIAL", "CATEGORY_FORUMS",
]);

function redactGmailPayload(value: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload("gmail", value) as Record<string, unknown>;
}

async function handleLabelChanges(
  userId: string,
  records: HistoryRecord[],
  accessToken: string,
  userEmail: string,
): Promise<number> {
  let count = 0;

  for (const record of records) {
    for (const added of record.labelsAdded ?? []) {
      const significant = added.labelIds.filter((l) => TRACKED_LABELS.has(l));
      if (significant.length === 0) continue;

      const sourceEventId = `gmail:${added.message.id}:labels:${record.id}:added`;

      const [existing] = await db
        .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload, timestamp: activityEvents.timestamp })
        .from(activityEvents)
        .where(and(eq(activityEvents.userId, userId), eq(activityEvents.sourceEventId, `gmail:${added.message.id}`)))
        .limit(1);

      if (existing) {
        const oldPayload = existing.rawPayload as Record<string, unknown>;
        const currentLabels = (oldPayload.labelIds as string[]) ?? [];
        const newLabels = [...new Set([...currentLabels, ...added.labelIds])];
        const mergedPayload = redactGmailPayload({ ...oldPayload, labelIds: newLabels });
        await mirrorGmailMessageSourceWiki(userId, {
          eventId: existing.id,
          sourceEventId: `gmail:${added.message.id}`,
          timestamp: existing.timestamp,
          rawPayload: mergedPayload,
        });
      }

      const times = activityEventTimes(new Date(), new Date());
      const rawPayload = redactGmailPayload({
        gmailId: added.message.id,
        threadId: added.message.threadId,
        labelsAdded: significant,
        _user_email: userEmail,
      });
      const [inserted] = await db
        .insert(activityEvents)
        .values({
          userId,
          source: "gmail",
          ...deriveActivityEventSourceContract({ source: "gmail", eventType: "label_added", rawPayload }),
          eventType: "label_added",
          timestamp: times.timestamp,
          sourceUpdatedAt: times.sourceUpdatedAt,
          wikiEligibilityAt: times.wikiEligibilityAt,
          rawPayload,
          sourceEventId,
          processingStatus: "received",
        })
        .onConflictDoNothing()
        .returning({ id: activityEvents.id });

      if (inserted) {
        count++;
        await enqueueCollectedEventForProcessing(inserted.id, userId);
      }
    }

    for (const removed of record.labelsRemoved ?? []) {
      const significant = removed.labelIds.filter((l) => TRACKED_LABELS.has(l));
      if (significant.length === 0) continue;

      const sourceEventId = `gmail:${removed.message.id}:labels:${record.id}:removed`;

      const [existing] = await db
        .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload, timestamp: activityEvents.timestamp })
        .from(activityEvents)
        .where(and(eq(activityEvents.userId, userId), eq(activityEvents.sourceEventId, `gmail:${removed.message.id}`)))
        .limit(1);

      if (existing) {
        const oldPayload = existing.rawPayload as Record<string, unknown>;
        const currentLabels = (oldPayload.labelIds as string[]) ?? [];
        const newLabels = currentLabels.filter((l) => !removed.labelIds.includes(l));
        const mergedPayload = redactGmailPayload({ ...oldPayload, labelIds: newLabels });
        await mirrorGmailMessageSourceWiki(userId, {
          eventId: existing.id,
          sourceEventId: `gmail:${removed.message.id}`,
          timestamp: existing.timestamp,
          rawPayload: mergedPayload,
        });
      }

      const times = activityEventTimes(new Date(), new Date());
      const rawPayload = redactGmailPayload({
        gmailId: removed.message.id,
        threadId: removed.message.threadId,
        labelsRemoved: significant,
        _user_email: userEmail,
      });
      const [inserted] = await db
        .insert(activityEvents)
        .values({
          userId,
          source: "gmail",
          ...deriveActivityEventSourceContract({ source: "gmail", eventType: "label_removed", rawPayload }),
          eventType: "label_removed",
          timestamp: times.timestamp,
          sourceUpdatedAt: times.sourceUpdatedAt,
          wikiEligibilityAt: times.wikiEligibilityAt,
          rawPayload,
          sourceEventId,
          processingStatus: "received",
        })
        .onConflictDoNothing()
        .returning({ id: activityEvents.id });

      if (inserted) {
        count++;
        await enqueueCollectedEventForProcessing(inserted.id, userId);
      }
    }

    for (const deleted of record.messagesDeleted ?? []) {
      const [existing] = await db
        .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload })
        .from(activityEvents)
        .where(and(eq(activityEvents.userId, userId), eq(activityEvents.sourceEventId, `gmail:${deleted.message.id}`)))
        .limit(1);

      if (existing) {
        // Explicit immutable deletion observation. Stable key + conflict
        // no-op keeps repeat history deliveries idempotent. Scoped to messages
        // we actually captured so purges of never-ingested mail stay quiet.
        const deletedAt = new Date().toISOString();
        const tombstoneTimes = activityEventTimes(new Date(deletedAt), deletedAt);
        const tombstonePayload = redactGmailPayload({
          gmailId: deleted.message.id,
          threadId: deleted.message.threadId,
          _user_email: userEmail,
          _deleted: true,
          _deleted_at: deletedAt,
        });
        const [tombstone] = await db
          .insert(activityEvents)
          .values({
            userId,
            source: "gmail",
            ...deriveActivityEventSourceContract({ source: "gmail", eventType: "message_deleted", rawPayload: tombstonePayload }),
            eventType: "message_deleted",
            timestamp: tombstoneTimes.timestamp,
            sourceUpdatedAt: tombstoneTimes.sourceUpdatedAt,
            wikiEligibilityAt: tombstoneTimes.wikiEligibilityAt,
            rawPayload: tombstonePayload,
            sourceEventId: `gmail:${deleted.message.id}:deleted`,
            processingStatus: "received",
          })
          .onConflictDoNothing()
          .returning({ id: activityEvents.id });
        if (tombstone) {
          await enqueueCollectedEventForProcessing(tombstone.id, userId);
        }

        try {
          await deleteGmailMessageSourceWiki(userId, deleted.message.id, { refreshIndexes: false });
        } catch (err) {
          console.warn(`Gmail source mirror delete failed for gmail:${deleted.message.id}:`, err instanceof Error ? err.name : "unknown error");
        }
        count++;
      }
    }
  }

  return count;
}

async function trackThread(
  userId: string,
  threadId: string,
  messageId: string,
  subject: string | undefined,
): Promise<void> {
  const [existing] = await db
    .select({ id: conversationWatermarks.id })
    .from(conversationWatermarks)
    .where(
      and(
        eq(conversationWatermarks.userId, userId),
        eq(conversationWatermarks.provider, "gmail"),
        eq(conversationWatermarks.conversationId, threadId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(conversationWatermarks)
      .set({
        lastSeenTs: messageId,
        lastPolledAt: new Date(),
        isActive: true,
      })
      .where(eq(conversationWatermarks.id, existing.id));
  } else {
    await db
      .insert(conversationWatermarks)
      .values({
        userId,
        provider: "gmail",
        conversationId: threadId,
        conversationType: "thread",
        conversationName: subject ?? threadId,
        lastSeenTs: messageId,
        lastPolledAt: new Date(),
        isActive: true,
      })
      .onConflictDoNothing();
  }
}

export interface GmailPollResult {
  newMessages: number;
  attachments: GmailAttachmentStats;
}

export async function pollGmail(userId: string): Promise<GmailPollResult> {
  // One tenant, many delegated mailboxes: poll each active google connection.
  // Sequential — per-user Gmail quota is charged per impersonated subject.
  const mailboxes = await listGoogleMailboxes(userId);
  const total: GmailPollResult = { newMessages: 0, attachments: emptyGmailAttachmentStats() };
  for (const mailbox of mailboxes) {
    const result = await pollGmailMailbox(userId, mailbox);
    total.newMessages += result.newMessages;
    mergeGmailAttachmentStats(total.attachments, result.attachments);
  }
  return total;
}

async function pollGmailMailbox(userId: string, userEmail: string): Promise<GmailPollResult> {
  const attachmentStats = emptyGmailAttachmentStats();
  const state = await getGoogleMailboxState(userId, userEmail);
  const historyId = state.historyId ?? undefined;
  if (!historyId) return { newMessages: 0, attachments: attachmentStats };

  const lastBackfillAt = state.lastBackfillAt ?? undefined;
  if (lastBackfillAt && Date.now() - lastBackfillAt < 120_000) return { newMessages: 0, attachments: attachmentStats };

  const accessToken = await getGoogleAccessToken(userId, userEmail, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
  let newMessageCount = 0;
  let labelChangeCount = 0;
  let currentHistoryId = historyId;
  let pageToken: string | undefined;
  let fetchFailures = 0;

  try {
    do {
      const result = await fetchHistory(accessToken, currentHistoryId, pageToken, userEmail || userId);
      const records = result.history ?? [];

      const messageIds = new Set<string>();
      for (const record of records) {
        for (const added of record.messagesAdded ?? []) {
          messageIds.add(added.message.id);
        }
      }

      const messageResults = await mapWithConcurrency([...messageIds], GMAIL_MESSAGE_CONCURRENCY, async (msgId, index) => {
        await sleep(RATE_LIMIT_DELAY_MS * (index % GMAIL_MESSAGE_CONCURRENCY));
        try {
          const msg = await fetchMessage(accessToken, msgId, userEmail || userId);
          const wasStored = await storeGmailEvent(userId, accessToken, msg, userEmail, attachmentStats);
          return { stored: wasStored ? 1 : 0, failed: 0 };
        } catch (err) {
          if (err instanceof GoogleRateLimitError) throw err;
          if (err instanceof GmailFetchError && err.status === 404) {
            console.warn(`Skipping unavailable Gmail message ${msgId}: ${err.message}`);
            return { stored: 0, failed: 0 };
          }
          console.error(`Failed to fetch Gmail message ${msgId}:`, err instanceof Error ? err.message : err);
          return { stored: 0, failed: 1 };
        }
      });
      for (const result of messageResults) {
        newMessageCount += result.stored;
        fetchFailures += result.failed;
      }

      labelChangeCount += await handleLabelChanges(userId, records, accessToken, userEmail);

      currentHistoryId = result.historyId ?? currentHistoryId;
      pageToken = result.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof Error && err.message === "HISTORY_EXPIRED") {
      console.log("Gmail historyId expired, re-syncing with backfill");
      try {
        const profile = await fetchProfile(accessToken, userEmail || userId);
        await recoverExpiredGmailHistory(userId, profile.historyId, userEmail);
      } catch (profileErr) {
        console.error("Failed to recover from expired historyId:", profileErr instanceof Error ? profileErr.message : profileErr);
        throw profileErr;
      }
      return { newMessages: newMessageCount, attachments: attachmentStats };
    }
    throw err;
  }

  if (newMessageCount > 0 || labelChangeCount > 0) {
    await refreshGmailSourceWikiIndexes(userId);
  }

  logGmailAttachmentSkips(userId, attachmentStats);

  if (fetchFailures > 0) {
    console.warn(`Gmail poll: ${fetchFailures} message fetches failed - not advancing historyId`);
    return { newMessages: newMessageCount, attachments: attachmentStats };
  }

  await updateGoogleMailboxState(userId, userEmail, { historyId: currentHistoryId });

  if (labelChangeCount > 0) {
    console.log(`Gmail poll: ${labelChangeCount} label changes for user ${userId}`);
  }

  return { newMessages: newMessageCount, attachments: attachmentStats };
}

function logGmailAttachmentSkips(userId: string, stats: GmailAttachmentStats): void {
  if (stats.skippedOversize > 0 || stats.skippedUnsupportedType > 0 || stats.failed > 0) {
    console.log(
      `[gmail] attachment capture for ${userId}: seen=${stats.seen} stored=${stats.stored} existing=${stats.skippedExisting}` +
        ` oversize=${stats.skippedOversize} unsupported_type=${stats.skippedUnsupportedType} failed=${stats.failed}`,
    );
  }
}

export async function recoverExpiredGmailHistory(userId: string, nextHistoryId: string, mailbox?: string): Promise<void> {
  const { enqueueTask } = await import("../../queue/queue.js");
  await enqueueTask({
    queue: "backfill",
    tenantId: userId,
    groupKey: `${userId}:gmail`,
    kind: "gmail.backfill",
    payload: { userId, days: 7, maxMessages: 200, ...(mailbox ? { mailbox } : {}) },
    dedupeKey: `gmail.backfill:history-expired:${userId}:${mailbox ?? "default"}`,
  });
  if (mailbox) await updateGoogleMailboxState(userId, mailbox, { historyId: nextHistoryId });
  else await mergeTokenMetadata(userId, "google", { historyId: nextHistoryId });
}

/**
 * Best-effort file mirror alongside ingestion: a mirror failure must never
 * fail or retry the ingest path, and logs stay free of message content.
 */
async function mirrorGmailMessageSourceWiki(
  userId: string,
  input: { eventId?: string | null; sourceEventId: string; timestamp?: string | Date | null; rawPayload: Record<string, unknown> },
): Promise<void> {
  try {
    await materializeGmailMessageSourceWiki(userId, input, { refreshIndexes: false });
  } catch (err) {
    console.warn(`Gmail source mirror failed for ${input.sourceEventId}:`, err instanceof Error ? err.name : "unknown error");
  }
}

async function refreshGmailSourceWikiIndexes(userId: string): Promise<void> {
  try {
    await materializeSourceWikiIndexes(userId);
  } catch (err) {
    console.warn("Gmail source mirror index refresh failed:", err instanceof Error ? err.name : "unknown error");
  }
}

async function storeGmailEvent(
  userId: string,
  accessToken: string,
  msg: GmailMessage,
  userEmail: string,
  attachmentStats: GmailAttachmentStats,
): Promise<boolean> {
  const from = getHeader(msg, "From");
  const to = getHeader(msg, "To");
  const subject = getHeader(msg, "Subject");
  const date = getHeader(msg, "Date");
  const messageId = getHeader(msg, "Message-ID");
  const inReplyTo = getHeader(msg, "In-Reply-To");
  const references = getHeader(msg, "References");

  const fromParsed = from ? parseEmailAddress(from) : null;
  const eventType = classifyMessage(msg, userEmail);

  // Extract full body text and HTML
  const rawBodyText = msg.payload ? extractBodyText(msg.payload) : "";
  const bodyHtml = msg.payload ? extractHtmlBody(msg.payload) : "";
  const normalizedBody = normalizeGmailBody({
    bodyText: rawBodyText,
    bodyHtml,
    snippet: msg.snippet,
  }, { includeMarkdown: true });

  // Extract attachments
  const attachments = msg.payload ? extractAttachments(msg.payload) : [];

  // Attachment BYTES to the binary lane. Runs before the insert-dedupe so a
  // re-scan (e.g. a repeated backfill) captures bytes for messages whose
  // events already exist; already-captured rows skip without a fetch.
  await captureGmailAttachments(userId, accessToken, msg, fromParsed?.email || null, attachmentStats);

  const timestamp = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10))
    : new Date();
  const times = activityEventTimes(timestamp, timestamp);

  const isThreadReply = Boolean(inReplyTo || references);

  const rawPayload = redactGmailPayload({
    ...gmailMessageForRawPayload(msg),
    gmailId: msg.id,
    from: from ?? null,
    to: to ?? null,
    cc: getHeader(msg, "Cc") ?? null,
    bcc: getHeader(msg, "Bcc") ?? null,
    subject: subject ?? null,
    date: date ?? null,
    messageId: messageId ?? null,
    inReplyTo: inReplyTo ?? null,
    references: references ?? null,
    replyTo: getHeader(msg, "Reply-To") ?? null,
    listUnsubscribe: getHeader(msg, "List-Unsubscribe") ?? null,
    bodyText: normalizedBody.bodyText || null,
    bodyHtml: bodyHtml || null,
    bodyMarkdown: normalizedBody.bodyMarkdown || null,
    bodySource: normalizedBody.bodySource,
    attachments: attachments.length > 0 ? attachments : null,
    _from_name: fromParsed?.name ?? null,
    _from_email: fromParsed?.email ?? null,
    _user_email: userEmail,
    _is_thread_reply: isThreadReply,
    _has_attachments: attachments.length > 0,
  });

  const [inserted] = await db
    .insert(activityEvents)
    .values({
      userId,
      source: "gmail",
      ...deriveActivityEventSourceContract({
        source: "gmail",
        eventType: isThreadReply ? "thread_reply" : eventType,
        rawPayload,
      }),
      eventType: isThreadReply ? "thread_reply" : eventType,
      timestamp: times.timestamp,
      sourceUpdatedAt: times.sourceUpdatedAt,
      wikiEligibilityAt: times.wikiEligibilityAt,
      rawPayload,
      sourceEventId: `gmail:${msg.id}`,
      processingStatus: "received",
      extractedEntities: fromParsed && fromParsed.email
        ? [{ type: "email_contact", id: fromParsed.email, name: fromParsed.name, email: fromParsed.email }]
        : null,
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (inserted) {
    await enqueueCollectedEventForProcessing(inserted.id, userId);
    await mirrorGmailMessageSourceWiki(userId, {
      eventId: inserted.id,
      sourceEventId: `gmail:${msg.id}`,
      timestamp,
      rawPayload,
    });

    // Track the email thread
    await trackThread(userId, msg.threadId, msg.id, subject ?? undefined);

    return true;
  }
  return false;
}

export interface GmailBackfillOptions {
  /** Restrict to one delegated mailbox; default = every active google connection. */
  mailbox?: string;
  days?: number | null;
  maxMessages?: number | null;
  maxScannedMessages?: number | null;
  progressEvery?: number;
  query?: string;
}

export interface GmailBackfillResult {
  scanned: number;
  stored: number;
  failedFetches: number;
  exhausted: boolean;
  capHit: boolean;
  historyId: string;
  attachments: GmailAttachmentStats;
}

export async function backfillGmailDetailed(
  userId: string,
  options?: GmailBackfillOptions,
): Promise<GmailBackfillResult> {
  // Empty roster (no google connection rows, no stored admin email) keeps the
  // legacy behavior: one pass under the default delegation subject, with the
  // mailbox derived from the impersonated profile.
  const roster = options?.mailbox ? [options.mailbox] : await listGoogleMailboxes(userId);
  const mailboxes: Array<string | undefined> = roster.length > 0 ? roster : [undefined];
  let combined: GmailBackfillResult | null = null;
  for (const mailbox of mailboxes) {
    const result = await backfillGmailMailbox(userId, mailbox, options);
    if (!combined) combined = result;
    else {
      combined.stored += result.stored;
      combined.scanned += result.scanned;
      combined.failedFetches += result.failedFetches;
      combined.exhausted = combined.exhausted && result.exhausted;
      combined.capHit = combined.capHit || result.capHit;
      combined.historyId = result.historyId;
      mergeGmailAttachmentStats(combined.attachments, result.attachments);
    }
  }
  return combined ?? { stored: 0, scanned: 0, failedFetches: 0, exhausted: true, capHit: false, historyId: "", attachments: emptyGmailAttachmentStats() };
}

async function backfillGmailMailbox(
  userId: string,
  mailbox: string | undefined,
  options?: GmailBackfillOptions,
): Promise<GmailBackfillResult> {
  const accessToken = await getGoogleAccessToken(userId, mailbox, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
  const initialProfile = await fetchProfile(accessToken, mailbox ?? userId);
  let resultHistoryId = initialProfile.historyId;
  const userEmail = initialProfile.emailAddress;
  const quotaPrincipal = mailbox ?? userEmail;

  const days = options?.days ?? null;
  const maxMessages = options?.maxMessages ?? Number.POSITIVE_INFINITY;
  const maxScannedMessages = options?.maxScannedMessages ?? Number.POSITIVE_INFINITY;
  const progressEvery = options?.progressEvery ?? 100;
  const after = typeof days === "number"
    ? Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000)
    : null;
  const query = options?.query?.trim() || (after ? `after:${after}` : "");

  const attachmentStats = emptyGmailAttachmentStats();
  let storedCount = 0;
  let scannedCount = 0;
  let failedFetchCount = 0;
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("maxResults", "100");
    if (query) url.searchParams.set("q", query);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gmailFetch(url.toString(), accessToken, quotaPrincipal);
    if (!res.ok) {
      throw new Error(`Gmail messages.list failed (${res.status})`);
    }

    const data = await res.json() as { messages?: Array<{ id: string }>; nextPageToken?: string };
    const messages = data.messages ?? [];

    for (let offset = 0; offset < messages.length && storedCount < maxMessages && scannedCount < maxScannedMessages;) {
      const remainingScan = Math.max(0, maxScannedMessages - scannedCount);
      const remainingStore = Math.max(0, maxMessages - storedCount);
      const batchSize = Math.min(
        GMAIL_MESSAGE_CONCURRENCY,
        messages.length - offset,
        remainingScan,
        Number.isFinite(remainingStore) ? remainingStore : GMAIL_MESSAGE_CONCURRENCY,
      );
      if (batchSize <= 0) break;
      const batch = messages.slice(offset, offset + batchSize);
      offset += batchSize;
      scannedCount += batch.length;
      const messageResults = await mapWithConcurrency(batch, GMAIL_MESSAGE_CONCURRENCY, async (stub, index): Promise<number> => {
        await sleep(RATE_LIMIT_DELAY_MS * (index % GMAIL_MESSAGE_CONCURRENCY));
        try {
          const msg = await fetchMessage(accessToken, stub.id, quotaPrincipal);
          const wasStored = await storeGmailEvent(userId, accessToken, msg, userEmail, attachmentStats);
          return wasStored ? 1 : 0;
        } catch (err) {
          if (err instanceof GoogleRateLimitError) throw err;
          failedFetchCount++;
          console.error(`Backfill: failed to fetch message ${stub.id}:`, err instanceof Error ? err.message : err);
          return 0;
        }
      });
      storedCount += messageResults.reduce((sum, value) => sum + value, 0);
      if (progressEvery > 0 && scannedCount % progressEvery === 0) {
        console.log(`Gmail backfill progress: scanned=${scannedCount} stored=${storedCount}`);
      }
    }

    // Per-page index refresh keeps sources/gmail/index.md counts live while
    // the mailbox pours in, so mirror consumers see progress mid-backfill.
    if (storedCount > 0) {
      await refreshGmailSourceWikiIndexes(userId);
    }

    pageToken = data.nextPageToken;
  } while (pageToken && storedCount < maxMessages && scannedCount < maxScannedMessages);

  if (storedCount > 0) {
    await refreshGmailSourceWikiIndexes(userId);
  }

  if (failedFetchCount === 0) {
    const profile = await fetchProfile(accessToken, quotaPrincipal);
    resultHistoryId = profile.historyId;
    await updateGoogleMailboxState(userId, mailbox ?? profile.emailAddress, { historyId: profile.historyId, lastBackfillAt: Date.now() });
  }

  console.log(`Gmail backfill complete: scanned=${scannedCount} stored=${storedCount}`);
  logGmailAttachmentSkips(userId, attachmentStats);
  const capHit = Boolean(pageToken) && (storedCount >= maxMessages || scannedCount >= maxScannedMessages);
  return {
    scanned: scannedCount,
    stored: storedCount,
    failedFetches: failedFetchCount,
    exhausted: !pageToken && failedFetchCount === 0,
    capHit,
    historyId: resultHistoryId,
    attachments: attachmentStats,
  };
}

export async function backfillGmail(
  userId: string,
  options?: GmailBackfillOptions,
): Promise<number> {
  const result = await backfillGmailDetailed(userId, options);
  return result.stored;
}
