import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { imessageMessageTouchesBlockedHandle } from "../../../integrations/imessage/blocked-handles.js";
import { getImessageConversationPointer, parseImessageDmHandleFromChatId } from "../../../integrations/imessage/conversation-identity.js";
import {
  getCanonicalImessageSourceEventId,
  getImessageMessageIdentity,
  getLegacyImessageSourceEventId,
  type ImessageMessageIdentity,
} from "../../../integrations/imessage/event-identity.js";
import { activityEventTimes } from "../../../lib/activity-event-time.js";
import type { DeviceContext } from "./devices.js";
import { touchImessageDevice } from "./devices.js";
import {
  boundedString,
  isRecord,
  jsonb,
  lockTenant,
  monthKey,
  query,
  sanitizeForJsonb,
  sha256Hex,
  stableJson,
  stringValue,
  UUID_RE,
  validDate,
  type ImessageDb,
  type ImessageExecutor,
} from "./util.js";

/**
 * POST /api/imessage/ingest receiver.
 *
 * Port of gigabrain@5448774e brain/src/routes/imessage-ingest.ts (POST "/"), keeping its
 * payload shape (`_chat_*`, `_sender_handle`, `_normalized_conversation_id`,
 * `_canonical_source_event_id`, `_observed_raw_*`, `_original_text`, `_edit_history`,
 * `_retracted`), event types, canonical/legacy/GUID identity lookups, alias rows,
 * duplicate archiving and conversation watermarks. Adapted to the source lane:
 *
 *  - The tenant is the device's (yc_msaw-verified) tenant; `body.userId` is ignored.
 *  - Lifecycle is collected -> mirrored (projector.ts marks a row mirrored once its month
 *    file is rendered; an in-place change resets it to collected); no brain columns.
 *  - One transaction per batch under a per-tenant advisory lock: the batch is stored
 *    completely or not at all (the uploader re-sends from the earliest failed batch),
 *    and concurrent batches cannot lose edit history.
 *  - Messages repeated inside one batch fold into a single row (the donor counted the
 *    second as skipped and lost its alias chat id).
 *  - Local-row identities (no provider GUID) are device-scoped: chat.db ROWIDs are per Mac.
 *  - An older observation (no edit/unsend, or an earlier edit than stored) never rolls
 *    back a newer edited/unsent state; only its alias evidence is merged.
 *  - Every in-place change appends to imessage_message_mutations (exact previous payload).
 *  - Entries that cannot be stored are kept in imessage_ingest_rejections, not dropped.
 *  - Affected (conversation, month) projections are marked dirty in the same transaction.
 */

export const MAX_MESSAGES_PER_INGEST_BATCH = 10_000;
const INSERT_CHUNK = 500;
const LOOKUP_CHUNK = 1_000;
const MAX_CANDIDATES_PER_KEY = 25;

export class IngestInputError extends Error {}

export interface IngestResult {
  stored: number;
  updated: number;
  skipped: number;
  rejected: number;
  total: number;
  processingEnqueueFailed: 0;
  chatTrackingFailed: 0;
  duplicateArchiveFailed: 0;
  dirtyProjections: Array<{ conversationId: string; month: string }>;
  timingsMs: Record<string, number>;
}

type Payload = Record<string, unknown>;

interface IngestMessage {
  messageId: unknown;
  rowId: unknown;
  text: string | null;
  service: unknown;
  chatId: string;
  chatKind: unknown;
  chatName: unknown;
  participant: string | null;
  isFromMe: unknown;
  createdAt: unknown;
  deliveredAt: unknown;
  readAt: unknown;
  editedAt: unknown;
  retractedAt: unknown;
  reaction: Record<string, unknown> | null;
  attachments: Array<Record<string, unknown>>;
  hasAttachments?: unknown;
  replyToMessageId: unknown;
  threadRootMessageId: unknown;
  sendEffect: unknown;
  kind: unknown;
  isAudioMessage: unknown;
  isForwarded: unknown;
  affectedParticipant: unknown;
  newGroupName: unknown;
  participants?: unknown;
  _resolved_name?: unknown;
  _is_self_handle?: unknown;
  providerMessageGuid?: unknown;
  providerGuidExplicit?: unknown;
  _provider_guid_explicit?: unknown;
  _providerGuidExplicit?: unknown;
  localRowId?: unknown;
  deviceId?: unknown;
  agentVersion?: unknown;
  agentChannel?: unknown;
}

interface Prepared {
  index: number;
  msg: IngestMessage;
  eventType: string;
  payload: Payload;
  identity: ImessageMessageIdentity;
  deviceScope: string;
  sourceEventId: string;
  legacySourceEventId: string;
  timestamp: Date;
  participant: string | null;
  isSelfHandle: boolean;
  isEditOrUnsend: boolean;
  resolvedName: string | null;
  conversationId: string;
}

interface Candidate {
  id: string;
  source: string;
  sourceEventId: string;
  rawPayload: Payload;
  sourceUpdatedAt: string | null;
  timestamp: Date;
}

interface Working {
  id: string;
  isNew: boolean;
  sourceEventId: string;
  identity: ImessageMessageIdentity;
  payload: Payload;
  eventType: string;
  timestamp: Date;
  sourceUpdatedAt: Date | null;
  participant: string | null;
  isSelfHandle: boolean;
  resolvedName: string | null;
  changed: boolean;
  aliasEvents: Array<{ id: string; sourceEventId: string }>;
  previousConversations: Set<string>;
}

export interface Rejection {
  index: number;
  reason: string;
  uploaded: unknown;
}

// ----------------------------------------------------------------- classification (donor)

/** Donor classifyEventType. */
export function classifyImessageEventType(msg: {
  reaction?: unknown;
  kind?: unknown;
  retractedAt?: unknown;
  isAudioMessage?: unknown;
  attachments?: Array<Record<string, unknown>>;
  isFromMe?: unknown;
  chatKind?: unknown;
}): string {
  if (msg.reaction) return (msg.reaction as { isRemoved?: unknown }).isRemoved ? "tapback_removed" : "tapback";
  if (msg.kind === "memberAdded") return "member_added";
  if (msg.kind === "memberRemoved") return "member_removed";
  if (msg.kind === "nameChanged") return "name_changed";
  if (msg.retractedAt) return "message_unsent";
  if (msg.isAudioMessage) return "audio_message";
  if ((msg.attachments ?? []).some((a) => a?.isSticker)) return "sticker";
  if (msg.isFromMe) return "message_sent";
  if (msg.chatKind === "group") return "group_message";
  return "message_received";
}

function observedStrings(...values: unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const string = stringValue(entry);
        if (string) seen.add(string);
      }
      continue;
    }
    const string = stringValue(value);
    if (string) seen.add(string);
  }
  return [...seen];
}

/** Donor normalizeParticipantsForStorage. */
function normalizeParticipantsForStorage(participants: unknown): unknown[] | undefined {
  if (!Array.isArray(participants) || participants.length === 0) return undefined;
  const normalized = new Map<string, unknown>();
  for (const participant of participants) {
    if (typeof participant === "string") {
      const trimmed = participant.trim();
      if (trimmed) normalized.set(participantStorageKey({ handle: trimmed }), trimmed);
      continue;
    }
    if (!isRecord(participant)) continue;
    const record: Record<string, unknown> = {};
    for (const key of ["name", "displayName", "handle", "phone", "email", "isSelf", "self"] as const) {
      const value = participant[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) record[key] = trimmed;
      } else if (typeof value === "boolean" && value) {
        record[key] = value;
      }
    }
    if (Object.keys(record).length === 0) continue;
    const key = participantStorageKey(record);
    const existing = normalized.get(key);
    normalized.set(key, existing && typeof existing === "object" ? { ...(existing as object), ...record } : record);
  }
  return [...normalized.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
}

function participantStorageKey(participant: Record<string, unknown>): string {
  const identity =
    stringValue(participant.handle) ??
    stringValue(participant.phone) ??
    stringValue(participant.email) ??
    stringValue(participant.name) ??
    stringValue(participant.displayName) ??
    stableJson(participant);
  return `p:${identity.toLowerCase()}`;
}

// ----------------------------------------------------------------- validation

function validateMessage(value: unknown): { msg: IngestMessage } | { reject: string } | { skip: string } {
  if (!isRecord(value)) return { reject: "message must be a JSON object" };
  const raw = value as Record<string, unknown>;
  // Donor: messages without messageId or chatId are skipped.
  if (!raw.messageId) return { reject: "messageId is required" };
  if (typeof raw.chatId !== "string" || !raw.chatId) return { reject: "chatId is required" };
  if (!validDate(raw.createdAt)) return { reject: "createdAt must be a valid timestamp" };
  if (raw.text !== undefined && raw.text !== null && typeof raw.text !== "string") return { reject: "text must be a string or null" };
  if (raw.participant !== undefined && raw.participant !== null && typeof raw.participant !== "string") return { reject: "participant must be a string or null" };
  if (raw.reaction !== undefined && raw.reaction !== null && !isRecord(raw.reaction)) return { reject: "reaction must be an object or null" };
  if (raw.attachments !== undefined && raw.attachments !== null && !Array.isArray(raw.attachments)) return { reject: "attachments must be an array" };
  for (const field of ["editedAt", "retractedAt"] as const) {
    if (raw[field] !== undefined && raw[field] !== null && !validDate(raw[field])) return { reject: `${field} must be a valid timestamp or null` };
  }
  const msg = {
    ...raw,
    text: (raw.text as string | null | undefined) ?? null,
    participant: (raw.participant as string | null | undefined) ?? null,
    reaction: (raw.reaction as Record<string, unknown> | null | undefined) ?? null,
    attachments: ((raw.attachments as unknown[] | null | undefined) ?? []).filter(isRecord) as Array<Record<string, unknown>>,
    chatId: raw.chatId,
    editedAt: raw.editedAt ?? null,
    retractedAt: raw.retractedAt ?? null,
  } as IngestMessage;
  if (imessageMessageTouchesBlockedHandle(msg as { chatId?: string | null; participant?: string | null; affectedParticipant?: string | null })) {
    return { skip: "blocked_handle" };
  }
  return { msg };
}

/** Where a local-row (no GUID) identity lives: the uploading Mac's chat.db. */
function deviceScopeFor(msg: IngestMessage, device: DeviceContext): string {
  const deviceId = stringValue(msg.deviceId);
  return deviceId && UUID_RE.test(deviceId) ? `device:${deviceId.toLowerCase()}` : `binding:${device.bindingId}`;
}

/** Build the stored payload exactly as the donor does (field order included), plus source-lane provenance. */
export function prepareImessageMessage(msg: IngestMessage, index: number, device: DeviceContext): Prepared {
  const eventType = classifyImessageEventType(msg);
  const rawDmHandle = parseImessageDmHandleFromChatId(msg.chatId);
  const participant = rawDmHandle && (!msg.participant || msg._is_self_handle) ? rawDmHandle : msg.participant;
  const isSelfHandle = participant === msg.participant ? ((msg._is_self_handle as boolean | undefined) ?? false) : false;
  const chatKind = msg.chatKind === "unknown" && rawDmHandle ? "dm" : msg.chatKind;
  const identity = getImessageMessageIdentity(msg);
  const isEditOrUnsend = Boolean(msg.editedAt || msg.retractedAt);
  const participants = normalizeParticipantsForStorage(msg.participants);
  const resolvedName = stringValue(msg._resolved_name);
  const deviceScope = deviceScopeFor(msg, device);

  const payload: Payload = {
    messageId: msg.messageId,
    providerMessageGuid: identity.kind === "provider_guid" ? identity.value : null,
    _provider_guid_explicit: identity.kind === "provider_guid" ? identity.explicit : null,
    deviceId: stringValue(msg.deviceId),
    agentVersion: boundedString(msg.agentVersion, 64),
    agentChannel: boundedString(msg.agentChannel, 64),
    localRowId: msg.localRowId ?? msg.rowId,
    rowId: msg.rowId,
    text: msg.text,
    service: msg.service,
    chatId: msg.chatId,
    chatKind,
    chatName: msg.chatName,
    participant,
    isFromMe: msg.isFromMe,
    createdAt: msg.createdAt,
    deliveredAt: msg.deliveredAt,
    readAt: msg.readAt,
    editedAt: msg.editedAt,
    retractedAt: msg.retractedAt,
    reaction: msg.reaction,
    hasAttachments: Boolean(msg.hasAttachments ?? msg.attachments.length > 0),
    attachments: msg.attachments.length > 0 ? msg.attachments : null,
    replyToMessageId: msg.replyToMessageId,
    threadRootMessageId: msg.threadRootMessageId,
    sendEffect: msg.sendEffect,
    kind: msg.kind,
    isAudioMessage: msg.isAudioMessage,
    isForwarded: msg.isForwarded,
    affectedParticipant: msg.affectedParticipant,
    newGroupName: msg.newGroupName,
    ...(participants ? { participants } : {}),
    _chat_id: msg.chatId,
    _chat_name: msg.chatName,
    _chat_type: chatKind === "dm" ? "direct" : chatKind === "group" ? "group" : "unknown",
    _sender_handle: participant,
    _resolved_name: resolvedName,
    _is_self_handle: isSelfHandle,
    _is_from_me: msg.isFromMe,
    _has_attachments: Boolean(msg.hasAttachments ?? msg.attachments.length > 0),
    _is_reaction: msg.reaction !== null,
  };
  const pointer = getImessageConversationPointer(payload);
  if (pointer) {
    payload._raw_chat_id = pointer.rawChatId;
    payload._normalized_conversation_id = pointer.normalizedConversationId;
    payload._counterpart_handle = pointer.counterpartHandle;
  }
  const conversationId = pointer?.normalizedConversationId ?? msg.chatId;
  let sourceEventId: string;
  let legacySourceEventId: string;
  if (identity.kind === "provider_guid") {
    sourceEventId = getCanonicalImessageSourceEventId(msg, identity, pointer?.normalizedConversationId ?? null);
    legacySourceEventId = getLegacyImessageSourceEventId(msg);
  } else {
    // Donor: imessage:local:<conv>:<rowId> / imessage:<chatId>:<messageId>, scoped here to the device.
    sourceEventId = `imessage:local:${deviceScope}:${conversationId}:${identity.value}`;
    legacySourceEventId = `imessage:${deviceScope}:${getLegacyImessageSourceEventId(msg).slice("imessage:".length)}`;
  }
  payload._canonical_source_event_id = sourceEventId;
  payload._raw_source_event_id = legacySourceEventId;
  payload._observed_raw_source_event_ids = observedStrings(legacySourceEventId);
  payload._observed_raw_chat_ids = observedStrings(msg.chatId);
  payload._device_scope = deviceScope;
  payload._observed_binding_ids = [device.bindingId];
  const times = activityEventTimes(validDate(msg.createdAt)!, (msg.editedAt ?? msg.retractedAt ?? null) as string | null);
  return {
    index,
    msg,
    eventType,
    payload,
    identity,
    deviceScope,
    sourceEventId,
    legacySourceEventId,
    timestamp: times.timestamp,
    participant,
    isSelfHandle,
    isEditOrUnsend,
    resolvedName,
    conversationId,
  };
}

function extractedEntities(participant: string | null, isSelfHandle: boolean, resolvedName: string | null): unknown {
  return participant && !isSelfHandle
    ? [{ type: "imessage_contact", id: participant, handle: participant, ...(resolvedName ? { name: resolvedName } : {}) }]
    : null;
}

function timeOf(value: unknown): number | null {
  return validDate(value)?.getTime() ?? null;
}

/**
 * True when `incoming` is an older observation of a message whose stored state is newer:
 * the stored copy is unsent and the incoming one is not, or the stored edit is later.
 * (Two Macs, a queued retry, or the 30-minute rescan can deliver an older state late.)
 */
export function isStaleImessageObservation(stored: Payload, incoming: { editedAt?: unknown; retractedAt?: unknown }): boolean {
  const storedRetracted = stored._retracted === true || Boolean(stored.retractedAt);
  if (incoming.retractedAt) return false;
  if (storedRetracted) return true;
  const storedEdit = timeOf(stored.editedAt);
  if (storedEdit === null) return false;
  const incomingEdit = timeOf(incoming.editedAt);
  return incomingEdit === null || incomingEdit < storedEdit;
}

/** Donor update merge (gigabrain imessage-ingest.ts lines 1328-1357) plus the stale-observation guard. */
export function mergeImessagePayload(oldPayload: Payload, prepared: Pick<Prepared, "payload" | "msg" | "legacySourceEventId" | "isEditOrUnsend">): { next: Payload; stale: boolean } {
  const { payload, msg, legacySourceEventId, isEditOrUnsend } = prepared;
  const observed = {
    _observed_raw_source_event_ids: observedStrings(oldPayload._observed_raw_source_event_ids, oldPayload._raw_source_event_id, legacySourceEventId),
    _observed_raw_chat_ids: observedStrings(oldPayload._observed_raw_chat_ids, oldPayload._raw_chat_id, oldPayload.chatId, msg.chatId),
    _observed_binding_ids: observedStrings(oldPayload._observed_binding_ids, payload._observed_binding_ids),
  };
  if (isStaleImessageObservation(oldPayload, msg)) {
    return { next: { ...oldPayload, ...observed }, stale: true };
  }
  // Donor: _original_text ?? text. When the stored row was itself first seen already edited or
  // unsent, its text is not the original, so it stays unknown (null) instead.
  const oldEditedOrUnsent = Boolean(oldPayload.editedAt) || oldPayload._retracted === true || Boolean(oldPayload.retractedAt);
  const originalText =
    (oldPayload._original_text as string | null | undefined) ?? (oldEditedOrUnsent ? null : ((oldPayload.text as string | null | undefined) ?? null));
  const editHistory = Array.isArray(oldPayload._edit_history) ? ([...oldPayload._edit_history] as Array<{ text: string; at: string }>) : [];
  // Donor pushed whenever editedAt was set and the text differed, so an unsend (text null,
  // editedAt still set) of an edited message was recorded as a fake edit to "null".
  if (msg.editedAt && !msg.retractedAt && typeof msg.text === "string" && oldPayload.text && oldPayload.text !== msg.text) {
    editHistory.push({ text: oldPayload.text as string, at: msg.editedAt as string });
  }
  // Source-lane addition: the text an unsend removed (the donor kept only the first text in
  // _original_text, so an edited-then-unsent message lost its last version).
  const oldRetracted = oldPayload._retracted === true || Boolean(oldPayload.retractedAt);
  const textBeforeUnsend = msg.retractedAt
    ? (oldRetracted ? (oldPayload._text_before_unsend ?? null) : ((oldPayload.text as string | null | undefined) ?? (oldPayload._text_before_unsend as string | null | undefined) ?? null))
    : undefined;
  return {
    next: {
      ...payload,
      ...observed,
      _original_text: isEditOrUnsend ? originalText : (oldPayload._original_text ?? null),
      _edit_history: editHistory.length > 0 ? editHistory : null,
      _retracted: Boolean(msg.retractedAt),
      ...(textBeforeUnsend !== undefined && textBeforeUnsend !== null ? { _text_before_unsend: textBeforeUnsend } : {}),
    },
    stale: false,
  };
}

/**
 * Stored form of a first observation: the donor merge's bookkeeping keys are set up front, so
 * replaying the same upload is an unchanged payload (skipped) instead of the donor's one extra
 * update on the first replay.
 */
export function initialImessagePayload(prepared: Pick<Prepared, "payload" | "msg">): Payload {
  return { ...prepared.payload, _original_text: null, _edit_history: null, _retracted: Boolean(prepared.msg.retractedAt) };
}

const MUTATION_FIELDS: Array<[string, string[]]> = [
  ["text", ["text"]],
  ["edit", ["editedAt", "_edit_history"]],
  ["unsend", ["retractedAt", "_retracted"]],
  ["reaction", ["reaction"]],
  ["attachments", ["attachments", "hasAttachments", "_has_attachments"]],
  ["conversation", ["_normalized_conversation_id", "chatName", "_chat_name", "chatKind", "participant", "_sender_handle", "_counterpart_handle"]],
  ["contact", ["_resolved_name"]],
  ["alias", ["_observed_raw_source_event_ids", "_observed_raw_chat_ids", "_observed_binding_ids"]],
];

export function mutationKinds(before: Payload, after: Payload): string[] {
  const kinds: string[] = [];
  const covered = new Set<string>();
  for (const [kind, fields] of MUTATION_FIELDS) {
    for (const f of fields) covered.add(f);
    if (fields.some((f) => stableJson(before[f]) !== stableJson(after[f]))) kinds.push(kind);
  }
  const rest = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !covered.has(k)));
  if ([...rest].some((k) => stableJson(before[k]) !== stableJson(after[k]))) kinds.push("metadata");
  return kinds;
}

function recordKindFor(payload: Payload): "snapshot" | "tombstone" {
  return payload._retracted === true || payload.retractedAt ? "tombstone" : "snapshot";
}

function objectIdFor(identity: ImessageMessageIdentity, deviceScope: string): string {
  return identity.kind === "provider_guid" ? `message:${identity.value}` : `local:${deviceScope}:${identity.value}`;
}

/** Donor existingImessageEventPreference. */
function preference(row: Candidate, canonicalSourceEventId: string): number {
  const raw = row.rawPayload;
  let score = 0;
  if (row.sourceEventId === canonicalSourceEventId) score -= 1000;
  if (stringValue(raw._normalized_conversation_id)?.startsWith("imessage:dm:")) score -= 100;
  if (stringValue(raw._normalized_conversation_id)?.startsWith("imessage:group:")) score -= 80;
  if (stringValue(raw._resolved_name)) score -= 40;
  if (stringValue(raw._counterpart_handle)) score -= 20;
  score -= Object.keys(raw).length / 1000;
  return score;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function list(values: string[]): SQL {
  return sql.join(values.map((v) => sql`${v}`), sql`, `);
}

const CANDIDATE_COLUMNS = sql.raw("id::text AS id, source, source_event_id, raw_payload, source_updated_at, timestamp");

interface CandidateRow {
  id: string;
  source: string;
  source_event_id: string;
  raw_payload: Payload;
  source_updated_at: string | Date | null;
  timestamp: string | Date;
  key?: string;
}

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    rawPayload: isRecord(row.raw_payload) ? row.raw_payload : {},
    sourceUpdatedAt: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null,
    timestamp: new Date(row.timestamp),
  };
}

async function prefetch(tx: ImessageExecutor, tenantId: string, prepared: Prepared[]) {
  const bySourceEventId = new Map<string, Candidate>();
  const byAlias = new Map<string, string>();
  const byId = new Map<string, Candidate>();
  const byGuid = new Map<string, Candidate[]>();
  const byMessageId = new Map<string, Candidate[]>();
  const ids = [...new Set(prepared.flatMap((p) => [p.sourceEventId, p.legacySourceEventId]))];
  for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
    for (const r of await query<CandidateRow>(tx, sql`SELECT ${CANDIDATE_COLUMNS} FROM activity_events WHERE user_id = ${tenantId} AND source_event_id IN (${list(chunk)})`)) {
      const c = toCandidate(r);
      bySourceEventId.set(c.sourceEventId, c);
      byId.set(c.id, c);
    }
    for (const r of await query<{ alias_source_event_id: string; canonical_event_id: string }>(
      tx,
      sql`SELECT alias_source_event_id, canonical_event_id::text AS canonical_event_id FROM activity_event_source_aliases WHERE user_id = ${tenantId} AND alias_source_event_id IN (${list(chunk)})`,
    )) {
      byAlias.set(r.alias_source_event_id, r.canonical_event_id);
    }
  }
  const missing = [...new Set([...byAlias.values()].filter((id) => !byId.has(id)))];
  for (const chunk of chunks(missing, LOOKUP_CHUNK)) {
    for (const r of await query<CandidateRow>(tx, sql`SELECT ${CANDIDATE_COLUMNS} FROM activity_events WHERE user_id = ${tenantId} AND id::text IN (${list(chunk)})`)) {
      const c = toCandidate(r);
      byId.set(c.id, c);
    }
  }
  const guids = [...new Set(prepared.filter((p) => p.identity.kind === "provider_guid").map((p) => p.identity.value))];
  for (const chunk of chunks(guids, LOOKUP_CHUNK)) {
    for (const [map, field] of [[byGuid, "providerMessageGuid"], [byMessageId, "messageId"]] as const) {
      const found = await query<CandidateRow>(
        tx,
        sql`SELECT ${CANDIDATE_COLUMNS}, raw_payload ->> ${field} AS key FROM activity_events
            WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> ${field} IN (${list(chunk)})`,
      );
      for (const r of found) {
        const key = stringValue(r.key);
        if (!key) continue;
        const c = toCandidate(r);
        byId.set(c.id, c);
        const entries = map.get(key) ?? [];
        if (entries.length < MAX_CANDIDATES_PER_KEY) entries.push(c);
        map.set(key, entries);
      }
    }
  }
  return { bySourceEventId, byAlias, byId, byGuid, byMessageId };
}

/**
 * Store one uploaded batch for an authenticated device. Throws IngestInputError for an
 * unusable body (400); database failures propagate (the whole batch rolls back).
 */
export async function ingestImessageBatch(database: ImessageDb, device: DeviceContext, body: unknown): Promise<IngestResult> {
  const started = Date.now();
  let mark = started;
  const timingsMs: Record<string, number> = {};
  const lap = (name: string) => {
    const now = Date.now();
    timingsMs[name] = now - mark;
    mark = now;
  };
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) throw new IngestInputError("messages array is required");
  if (body.messages.length > MAX_MESSAGES_PER_INGEST_BATCH) throw new IngestInputError(`Maximum ${MAX_MESSAGES_PER_INGEST_BATCH} messages per batch`);
  const uploaded = body.messages as unknown[];

  let skipped = 0;
  const rejections: Rejection[] = [];
  const prepared: Prepared[] = [];
  uploaded.forEach((value, index) => {
    const v = validateMessage(value);
    if ("reject" in v) {
      skipped++;
      rejections.push({ index, reason: v.reject, uploaded: value });
      return;
    }
    if ("skip" in v) {
      skipped++;
      return;
    }
    prepared.push(prepareImessageMessage(v.msg, index, device));
  });
  lap("prepare");

  const tenantId = device.tenantId;
  const result = await database.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const found = await prefetch(tx, tenantId, prepared);
    lap("prefetchExisting");

    const working = new Map<string, Working>();
    const workingBySourceEventId = new Map<string, Working>();
    const mutations: Array<{ w: Working; previous: Payload; uploaded: unknown; kinds: string[] }> = [];
    const aliasRows: Array<{ canonicalEventId: string; canonicalSourceEventId: string; aliasSourceEventId: string; aliasEventId: string | null; providerIdentity: string; reason: string }> = [];
    const chatJobs = new Map<string, { prepared: Prepared; rawChatIds: Set<string> }>();
    const dirty = new Set<string>();
    let stored = 0;
    let updated = 0;

    for (const p of prepared) {
      const scopeOk = (c: Candidate) => c.source === "imessage" && (p.identity.kind === "provider_guid" || c.rawPayload._device_scope === p.deviceScope);
      // Rows already touched in this batch win over their database state.
      let w = workingBySourceEventId.get(p.sourceEventId) ?? workingBySourceEventId.get(p.legacySourceEventId);
      let addedDuplicates = 0;
      if (!w) {
        const candidates: Candidate[] = [];
        for (const key of [p.sourceEventId, p.legacySourceEventId]) {
          const direct = found.bySourceEventId.get(key);
          if (direct) candidates.push(direct);
          const viaAlias = found.byAlias.get(key);
          if (viaAlias && found.byId.get(viaAlias)) candidates.push(found.byId.get(viaAlias)!);
          // An archived duplicate points at its canonical row.
          const archivedCanonical = direct && direct.source === "imessage_alias" ? stringValue(direct.rawPayload._canonical_event_id) : null;
          if (archivedCanonical && found.byId.get(archivedCanonical)) candidates.push(found.byId.get(archivedCanonical)!);
        }
        if (p.identity.kind === "provider_guid") {
          const byGuid = found.byGuid.get(p.identity.value) ?? [];
          candidates.push(...byGuid);
          if (byGuid.length === 0) candidates.push(...(found.byMessageId.get(p.identity.value) ?? []));
        }
        const unique = new Map<string, Candidate>();
        for (const c of candidates) if (scopeOk(c)) unique.set(c.id, c);
        const ranked = [...unique.values()].sort((a, b) => preference(a, p.sourceEventId) - preference(b, p.sourceEventId));
        const selected = ranked[0];
        if (selected) {
          w = working.get(selected.id);
          if (!w) {
            w = {
              id: selected.id,
              isNew: false,
              sourceEventId: selected.sourceEventId,
              identity: p.identity,
              payload: selected.rawPayload,
              eventType: "",
              timestamp: selected.timestamp,
              sourceUpdatedAt: selected.sourceUpdatedAt ? new Date(selected.sourceUpdatedAt) : null,
              participant: null,
              isSelfHandle: false,
              resolvedName: null,
              changed: false,
              aliasEvents: [],
              previousConversations: new Set(observedStrings(selected.rawPayload._normalized_conversation_id)),
            };
            working.set(w.id, w);
          }
          for (const dup of ranked.slice(1)) {
            if (dup.id === w.id || w.aliasEvents.some((a) => a.id === dup.id) || working.has(dup.id)) continue;
            w.aliasEvents.push({ id: dup.id, sourceEventId: dup.sourceEventId });
            addedDuplicates++;
          }
        }
      }

      if (!w) {
        const nw: Working = {
          id: randomUUID(),
          isNew: true,
          sourceEventId: p.sourceEventId,
          identity: p.identity,
          payload: initialImessagePayload(p),
          eventType: p.eventType,
          timestamp: p.timestamp,
          sourceUpdatedAt: validDate(p.msg.editedAt ?? p.msg.retractedAt ?? null),
          participant: p.participant,
          isSelfHandle: p.isSelfHandle,
          resolvedName: p.resolvedName,
          changed: true,
          aliasEvents: [],
          previousConversations: new Set(),
        };
        working.set(nw.id, nw);
        workingBySourceEventId.set(p.sourceEventId, nw);
        workingBySourceEventId.set(p.legacySourceEventId, nw);
        stored++;
        dirty.add(`${p.conversationId}\u0000${monthKey(p.timestamp)}`);
        rememberChat(chatJobs, p);
        continue;
      }

      workingBySourceEventId.set(p.sourceEventId, w);
      workingBySourceEventId.set(p.legacySourceEventId, w);
      const previous = w.payload;
      const { next, stale } = mergeImessagePayload(previous, p);
      const payloadChanged = stableJson(previous) !== stableJson(next);
      if (!payloadChanged && addedDuplicates === 0) {
        // Donor: an unchanged raw payload is a skipped duplicate upload.
        skipped++;
        continue;
      }
      if (payloadChanged) {
        w.payload = next;
        w.changed = true;
        if (!stale) {
          w.eventType = p.eventType;
          w.participant = p.participant;
          w.isSelfHandle = p.isSelfHandle;
          w.resolvedName = p.resolvedName;
          const editOrUnsend = validDate(p.msg.editedAt ?? p.msg.retractedAt ?? null);
          if (editOrUnsend) w.sourceUpdatedAt = editOrUnsend;
        }
        mutations.push({ w, previous, uploaded: p.msg, kinds: mutationKinds(previous, next) });
      }
      updated++;
      for (const conv of w.previousConversations) dirty.add(`${conv}\u0000${monthKey(w.timestamp)}`);
      dirty.add(`${p.conversationId}\u0000${monthKey(w.timestamp)}`);
      rememberChat(chatJobs, p);
    }
    lap("processExistingAndStageNew");

    const newRows = [...working.values()].filter((w) => w.isNew);
    for (const chunk of chunks(newRows, INSERT_CHUNK)) {
      const values = chunk.map((w) => {
        const conv = stringValue(w.payload._normalized_conversation_id) ?? String(w.payload.chatId);
        return sql`(${w.id}::uuid, ${tenantId}, 'imessage', ${`conversation:${conv}`}, ${objectIdFor(w.identity, String(w.payload._device_scope))},
          ${recordKindFor(w.payload)}, ${w.eventType}, ${w.timestamp.toISOString()}::timestamptz, ${w.sourceUpdatedAt?.toISOString() ?? null}::timestamptz,
          ${jsonb(w.payload)}, ${jsonb(extractedEntities(w.participant, w.isSelfHandle, w.resolvedName))}, ${w.sourceEventId}, 'collected')`;
      });
      const inserted = await query<{ id: string }>(
        tx,
        sql`INSERT INTO activity_events (id, user_id, source, source_namespace, source_object_id, record_kind, event_type, timestamp, source_updated_at,
              raw_payload, extracted_entities, source_event_id, processing_status)
            VALUES ${sql.join(values, sql`, `)}
            ON CONFLICT DO NOTHING RETURNING id::text AS id`,
      );
      // The tenant lock makes a conflict impossible unless another writer bypassed it; never count a lost row as stored.
      if (inserted.length !== chunk.length) throw new Error(`iMessage ingest conflict: ${chunk.length - inserted.length} row(s) were written concurrently; retry the batch`);
    }
    for (const w of working.values()) {
      if (w.isNew || !w.changed) continue;
      const conv = stringValue(w.payload._normalized_conversation_id) ?? String(w.payload.chatId);
      const entities = w.eventType ? sql`, extracted_entities = ${jsonb(extractedEntities(w.participant, w.isSelfHandle, w.resolvedName))}, event_type = ${w.eventType}` : sql``;
      await tx.execute(sql`
        UPDATE activity_events
        SET raw_payload = ${jsonb(w.payload)}, source_updated_at = ${w.sourceUpdatedAt?.toISOString() ?? null}::timestamptz,
            source_namespace = ${`conversation:${conv}`},
            source_object_id = COALESCE(source_object_id, ${objectIdFor(w.identity, String(w.payload._device_scope))}),
            record_kind = ${recordKindFor(w.payload)}, processing_status = 'collected' ${entities}
        WHERE id = ${w.id}::uuid AND user_id = ${tenantId}
      `);
    }
    lap("writeEvents");

    for (const w of working.values()) {
      const providerIdentity = w.identity.kind === "provider_guid" ? `provider_guid:${w.identity.value}` : `local_row:${w.payload._device_scope}:${w.identity.value}`;
      for (const alias of observedStrings(w.payload._observed_raw_source_event_ids).filter((a) => a !== w.sourceEventId)) {
        aliasRows.push({ canonicalEventId: w.id, canonicalSourceEventId: w.sourceEventId, aliasSourceEventId: alias, aliasEventId: null, providerIdentity, reason: "imessage_canonical_identity" });
      }
      const canonical = stringValue(w.payload._canonical_source_event_id);
      if (canonical && canonical !== w.sourceEventId) {
        aliasRows.push({ canonicalEventId: w.id, canonicalSourceEventId: w.sourceEventId, aliasSourceEventId: canonical, aliasEventId: null, providerIdentity, reason: "imessage_canonical_identity" });
      }
      for (const dup of w.aliasEvents) {
        if (dup.sourceEventId === w.sourceEventId) continue;
        aliasRows.push({ canonicalEventId: w.id, canonicalSourceEventId: w.sourceEventId, aliasSourceEventId: dup.sourceEventId, aliasEventId: dup.id, providerIdentity, reason: "imessage_canonical_duplicate" });
      }
    }
    // Alias rows: duplicate archiving (alias_event_id set) wins over a plain identity alias for the same id.
    const aliasByKey = new Map<string, (typeof aliasRows)[number]>();
    for (const a of aliasRows) if (!aliasByKey.has(a.aliasSourceEventId) || a.aliasEventId) aliasByKey.set(a.aliasSourceEventId, a);
    for (const chunk of chunks([...aliasByKey.values()], INSERT_CHUNK)) {
      await tx.execute(sql`
        INSERT INTO activity_event_source_aliases (user_id, source, alias_event_id, canonical_event_id, alias_source_event_id, canonical_source_event_id, provider_identity, reason)
        VALUES ${sql.join(chunk.map((a) => sql`(${tenantId}, 'imessage', ${a.aliasEventId}::uuid, ${a.canonicalEventId}::uuid, ${a.aliasSourceEventId}, ${a.canonicalSourceEventId}, ${a.providerIdentity}, ${a.reason})`), sql`, `)}
        ON CONFLICT DO NOTHING
      `);
    }
    // Donor archiveDuplicateImessageEvents: the duplicate stays a raw record, marked and moved out of source 'imessage'.
    for (const w of working.values()) {
      for (const dup of w.aliasEvents) {
        await tx.execute(sql`
          UPDATE activity_events
          SET source = 'imessage_alias',
              raw_payload = raw_payload || jsonb_build_object(
                '_archived_duplicate_source', 'imessage',
                '_archived_duplicate_at', now(),
                '_canonical_event_id', ${w.id}::text,
                '_canonical_source_event_id', ${w.sourceEventId}::text,
                '_original_source', source,
                '_original_source_event_id', source_event_id)
          WHERE id = ${dup.id}::uuid AND user_id = ${tenantId} AND source = 'imessage'
        `);
        const conv = stringValue(found.byId.get(dup.id)?.rawPayload._normalized_conversation_id);
        if (conv) dirty.add(`${conv}\u0000${monthKey(w.timestamp)}`);
      }
    }
    lap("aliases");

    for (const m of mutations) {
      await tx.execute(sql`
        INSERT INTO imessage_message_mutations (tenant_id, event_id, source_event_id, binding_id, kinds, previous_payload, next_payload_sha256, uploaded, event_timestamp)
        VALUES (${tenantId}, ${m.w.id}::uuid, ${m.w.sourceEventId}, ${device.bindingId}, ${JSON.stringify(m.kinds)}::jsonb, ${jsonb(m.previous)},
                ${sha256Hex(stableJson(sanitizeForJsonb(m.w.payload)))}, ${jsonb(m.uploaded)}, ${m.w.timestamp.toISOString()}::timestamptz)
      `);
    }
    for (const r of rejections) {
      await tx.execute(sql`
        INSERT INTO imessage_ingest_rejections (tenant_id, binding_id, reason, batch_index, uploaded)
        VALUES (${tenantId}, ${device.bindingId}, ${r.reason}, ${r.index}, ${jsonb(r.uploaded ?? null)})
      `);
    }
    // A reaction changes the current-reactions line of its target, which may live in another month.
    const targets = [
      ...new Set(
        [...working.values()]
          .filter((w) => w.changed && isRecord(w.payload.reaction))
          .map((w) => stringValue((w.payload.reaction as Record<string, unknown>).targetMessageId)?.replace(/^(?:p:\d+\/|bp:)/u, ""))
          .filter((g): g is string => Boolean(g)),
      ),
    ];
    for (const chunk of chunks(targets, LOOKUP_CHUNK)) {
      for (const r of await query<{ conv: string | null; month: string }>(
        tx,
        sql`SELECT DISTINCT raw_payload ->> '_normalized_conversation_id' AS conv, to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM') AS month
            FROM activity_events WHERE user_id = ${tenantId} AND source = 'imessage'
              AND (raw_payload ->> 'providerMessageGuid' IN (${list(chunk)}) OR raw_payload ->> 'messageId' IN (${list(chunk)}))`,
      )) {
        if (r.conv) dirty.add(`${r.conv}\u0000${r.month}`);
      }
    }
    await trackChats(tx, tenantId, chatJobs.values());
    const dirtyPairs = [...dirty].map((k) => {
      const [conversationId, month] = k.split("\u0000") as [string, string];
      return { conversationId, month };
    });
    for (const chunk of chunks(dirtyPairs, INSERT_CHUNK)) {
      await tx.execute(sql`
        INSERT INTO imessage_projection_dirty (tenant_id, conversation_id, month)
        VALUES ${sql.join(chunk.map((d) => sql`(${tenantId}, ${d.conversationId}, ${d.month})`), sql`, `)}
        ON CONFLICT (tenant_id, conversation_id, month) DO UPDATE SET marked_at = clock_timestamp()
      `);
    }
    await recordSyncProgress(tx, device, body.syncProgress, { uploaded: uploaded.length, stored, updated, skipped, rejected: rejections.length });
    const last = prepared.at(-1)?.msg;
    await touchImessageDevice(tx, device, {
      deviceId: last ? stringValue(last.deviceId) : null,
      agentVersion: last ? boundedString(last.agentVersion, 64) : null,
      agentChannel: last ? boundedString(last.agentChannel, 64) : null,
    });
    lap("ledgers");
    return { stored, updated, dirtyPairs };
  });

  return {
    stored: result.stored,
    updated: result.updated,
    skipped,
    rejected: rejections.length,
    total: uploaded.length,
    processingEnqueueFailed: 0,
    chatTrackingFailed: 0,
    duplicateArchiveFailed: 0,
    dirtyProjections: result.dirtyPairs,
    timingsMs: { ...timingsMs, total: Date.now() - started },
  };
}

function rememberChat(jobs: Map<string, { prepared: Prepared; rawChatIds: Set<string> }>, p: Prepared): void {
  const existing = jobs.get(p.conversationId);
  const rowId = Number(p.msg.rowId);
  if (!existing || rowId >= Number(existing.prepared.msg.rowId)) {
    jobs.set(p.conversationId, { prepared: p, rawChatIds: new Set([...(existing?.rawChatIds ?? []), p.msg.chatId]) });
    return;
  }
  existing.rawChatIds.add(p.msg.chatId);
}

/** Donor trackImessageChatsBulk (conversation_watermarks, monotonic last_seen_ts, stale raw-chat rows removed). */
async function trackChats(tx: ImessageExecutor, tenantId: string, jobs: Iterable<{ prepared: Prepared; rawChatIds: Set<string> }>): Promise<void> {
  const values: SQL[] = [];
  const toDelete = new Set<string>();
  for (const job of jobs) {
    const pointer = getImessageConversationPointer(job.prepared.payload);
    const msg = job.prepared.msg;
    const conversationId = pointer?.normalizedConversationId ?? msg.chatId;
    const conversationType = pointer?.conversationType ?? (msg.chatKind === "dm" ? "direct" : msg.chatKind === "group" ? "group" : "unknown");
    const conversationName = pointer?.conversationName ?? stringValue(msg.chatName) ?? msg.participant ?? msg.chatId;
    const rowId = Number(msg.rowId);
    values.push(sql`(${tenantId}, 'imessage', ${conversationId}, ${conversationType}, ${conversationName}, ${Number.isFinite(rowId) ? String(Math.trunc(rowId)) : ""}, now(), true)`);
    for (const raw of job.rawChatIds) if (raw && raw !== conversationId) toDelete.add(raw);
  }
  for (const chunk of chunks(values, INSERT_CHUNK)) {
    await tx.execute(sql`
      INSERT INTO conversation_watermarks (user_id, provider, conversation_id, conversation_type, conversation_name, last_seen_ts, last_polled_at, is_active)
      VALUES ${sql.join(chunk, sql`, `)}
      ON CONFLICT (user_id, provider, conversation_id) DO UPDATE
      SET last_seen_ts = GREATEST(
            COALESCE(NULLIF(conversation_watermarks.last_seen_ts, '')::bigint, 0),
            COALESCE(NULLIF(excluded.last_seen_ts, '')::bigint, 0))::text,
          last_polled_at = excluded.last_polled_at,
          conversation_name = excluded.conversation_name,
          is_active = true
    `);
  }
  for (const chunk of chunks([...toDelete], LOOKUP_CHUNK)) {
    await tx.execute(sql`DELETE FROM conversation_watermarks WHERE user_id = ${tenantId} AND provider = 'imessage' AND conversation_id IN (${list(chunk)})`);
  }
}

function count(value: unknown): number | null {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Donor recordImessageSyncProgress, persisted per device; only counters and enums are kept (no titles/names). */
async function recordSyncProgress(
  tx: ImessageExecutor,
  device: DeviceContext,
  body: unknown,
  delta: { uploaded: number; stored: number; updated: number; skipped: number; rejected: number },
): Promise<void> {
  const b = isRecord(body) ? body : {};
  const operationId = (stringValue(b.operationId) ?? "imessage-default").slice(0, 200);
  const syncKind = (stringValue(b.syncKind) ?? "first_fill").slice(0, 64);
  const status = b.status === "paused" || b.status === "completed" || b.status === "failed" ? b.status : "running";
  const progress: Record<string, unknown> = {};
  for (const k of ["totalCount", "scannedCount", "uploadedCount", "backlogCount", "etaSeconds"]) {
    const n = count(b[k]);
    if (n !== null) progress[k] = n;
  }
  for (const k of ["startedAt", "lastProgressAt", "completedAt"]) {
    const d = validDate(b[k]);
    if (d) progress[k] = d.toISOString();
  }
  await tx.execute(sql`
    INSERT INTO imessage_sync_progress (tenant_id, binding_id, operation_id, sync_kind, status, progress, uploaded, stored, updated, skipped, rejected)
    VALUES (${device.tenantId}, ${device.bindingId}, ${operationId}, ${syncKind}, ${status}, ${JSON.stringify(progress)}::jsonb,
            ${delta.uploaded}, ${delta.stored}, ${delta.updated}, ${delta.skipped}, ${delta.rejected})
    ON CONFLICT (tenant_id, binding_id, operation_id) DO UPDATE
    SET sync_kind = excluded.sync_kind, status = excluded.status,
        progress = imessage_sync_progress.progress || excluded.progress,
        uploaded = imessage_sync_progress.uploaded + excluded.uploaded,
        stored = imessage_sync_progress.stored + excluded.stored,
        updated = imessage_sync_progress.updated + excluded.updated,
        skipped = imessage_sync_progress.skipped + excluded.skipped,
        rejected = imessage_sync_progress.rejected + excluded.rejected,
        updated_at = now()
  `);
}
