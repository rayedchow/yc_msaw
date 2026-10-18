import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * Current state of a Slack message = its first-captured base row folded with the
 * append-only `_ledger` observations that reference it (`_object_ts`):
 *
 *   message.edited             realtime message_changed (new `message`, `previous_message`)
 *   message.deleted            realtime message_deleted (terminal)
 *   message.reaction_added /   realtime reaction events (idempotent per user)
 *   message.reaction_removed
 *   message.revision_observed  the poller saw a different version of a stored message
 *                              (edit / reaction / file change made while realtime was down)
 *   message.absent_observed    a complete reconcile sweep of the message's window no longer
 *                              returned it (deleted upstream, or hidden by retention)
 *
 * Raw rows are never rewritten (raw capture is capture-time-irreversible); renderers fold
 * on read. The folded payload keeps the base row's `_` stamps and exposes exactly the fields
 * the donor renderers read: text, edited, reactions, files, blocks, `_deleted`,
 * `_deleted_at`, `_deleted_reason`, `_edit_history`, `_mentions`.
 */

export interface SlackLedgerObservation {
  event_type: string;
  source_event_id: string;
  timestamp: Date | string;
  raw_payload: Record<string, unknown>;
}

export interface SlackFoldResult {
  payload: Record<string, unknown>;
  /** Number of ledger observations that changed the state. */
  applied: number;
  deleted: boolean;
}

type Reaction = { name: string; users: string[]; count: number };

const CONTENT_FIELDS = ["text", "blocks", "attachments", "files", "edited", "subtype", "reactions", "metadata"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isoOf(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function slackTsIso(ts: unknown): string | null {
  if (typeof ts !== "string" && typeof ts !== "number") return null;
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function reactionsOf(value: unknown): Reaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    if (!isRecord(r) || typeof r.name !== "string" || !r.name) return [];
    const users = Array.isArray(r.users) ? r.users.filter((u): u is string => typeof u === "string") : [];
    const count = typeof r.count === "number" && Number.isFinite(r.count) ? r.count : users.length;
    return [{ name: r.name, users: [...users], count }];
  });
}

function applyReaction(payload: Record<string, unknown>, name: string, user: string, added: boolean): boolean {
  const reactions = reactionsOf(payload.reactions);
  const existing = reactions.find((r) => r.name === name);
  if (added) {
    if (existing?.users.includes(user)) return false;
    if (existing) {
      existing.users.push(user);
      existing.count = Math.max(existing.count + 1, existing.users.length);
    } else {
      reactions.push({ name, users: [user], count: 1 });
    }
  } else {
    if (!existing || !existing.users.includes(user)) return false;
    existing.users = existing.users.filter((u) => u !== user);
    existing.count = Math.max(existing.users.length, existing.count - 1);
    if (existing.count <= 0 || existing.users.length === 0) reactions.splice(reactions.indexOf(existing), 1);
  }
  payload.reactions = reactions;
  return true;
}

function pushEditHistory(payload: Record<string, unknown>, previousText: unknown, editedAt: string): void {
  const history = Array.isArray(payload._edit_history) ? [...(payload._edit_history as unknown[])] : [];
  const prev = typeof previousText === "string" ? previousText : "";
  const last = history[history.length - 1];
  if (isRecord(last) && last.text === prev && last.edited_at === editedAt) return;
  history.push({ text: prev, edited_at: editedAt });
  payload._edit_history = history;
}

/** Replace content fields from an observed full message, keeping base `_` stamps; returns whether text changed. */
function applySnapshot(payload: Record<string, unknown>, message: Record<string, unknown>, editedAtFallback: string): boolean {
  const previousText = payload.text;
  let changed = false;
  for (const field of CONTENT_FIELDS) {
    const next = message[field];
    if (next === undefined) {
      if (field !== "text" && field !== "subtype" && payload[field] !== undefined && field !== "metadata") {
        delete payload[field];
        changed = true;
      }
      continue;
    }
    if (JSON.stringify(payload[field]) !== JSON.stringify(next)) {
      payload[field] = next;
      changed = true;
    }
  }
  const textChanged = typeof message.text === "string" && message.text !== previousText;
  if (textChanged) {
    const edited = isRecord(message.edited) ? str(message.edited.ts) : null;
    pushEditHistory(payload, previousText, edited ?? editedAtFallback);
  }
  return changed || textChanged;
}

function markDeleted(payload: Record<string, unknown>, at: string | null, reason: string): boolean {
  if (payload._deleted === true && payload._deleted_reason === reason) return false;
  payload._deleted = true;
  if (at) payload._deleted_at = at;
  payload._deleted_reason = reason;
  return true;
}

function sortObservations(observations: readonly SlackLedgerObservation[]): SlackLedgerObservation[] {
  return [...observations].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return ta - tb || a.source_event_id.localeCompare(b.source_event_id);
  });
}

/** Fold ledger observations of ONE message onto its base payload (pure; inputs are not mutated). */
export function foldSlackMessage(base: Record<string, unknown>, observations: readonly SlackLedgerObservation[]): SlackFoldResult {
  const payload: Record<string, unknown> = structuredClone(base);
  let applied = 0;
  let terminalDelete = payload._deleted === true && payload._deleted_reason === "message_deleted";
  for (const obs of sortObservations(observations)) {
    const p = obs.raw_payload;
    if (!isRecord(p)) continue;
    const at = isoOf(obs.timestamp);
    switch (obs.event_type) {
      case "message.edited": {
        if (terminalDelete) break;
        const message = isRecord(p.message) ? p.message : null;
        if (!message) break;
        if (str(message.subtype) === "tombstone") {
          if (markDeleted(payload, at, "tombstone")) applied += 1;
          if (typeof message.text === "string") payload.text = message.text;
          break;
        }
        const editTs = isRecord(message.edited) ? slackTsIso(message.edited.ts) ?? str(message.edited.ts) : null;
        if (applySnapshot(payload, message, String(editTs ?? at ?? ""))) applied += 1;
        break;
      }
      case "message.deleted": {
        if (markDeleted(payload, slackTsIso(p.event_ts) ?? at, "message_deleted")) applied += 1;
        terminalDelete = true;
        break;
      }
      case "message.reaction_added":
      case "message.reaction_removed": {
        if (terminalDelete) break;
        const name = str(p.reaction);
        const user = str(p.user);
        if (name && user && applyReaction(payload, name, user, obs.event_type === "message.reaction_added")) applied += 1;
        break;
      }
      case "message.revision_observed": {
        if (terminalDelete) break;
        const message = isRecord(p.message) ? p.message : null;
        if (!message) break;
        let changed = false;
        if (payload._deleted === true && payload._deleted_reason !== "message_deleted") {
          // Seen again after an absence: it exists upstream.
          delete payload._deleted;
          delete payload._deleted_at;
          delete payload._deleted_reason;
          changed = true;
        }
        if (str(message.subtype) === "tombstone") {
          changed = markDeleted(payload, at, "tombstone") || changed;
        } else {
          changed = applySnapshot(payload, message, at ?? "") || changed;
        }
        if (changed) applied += 1;
        break;
      }
      case "message.absent_observed": {
        if (terminalDelete) break;
        if (markDeleted(payload, at, "absent_from_history")) applied += 1;
        break;
      }
      default:
        break;
    }
  }
  return { payload, applied, deleted: payload._deleted === true };
}

/**
 * Canonical comparable content of a Slack message (post-redaction): what a poller compares
 * to decide whether it observed a new revision. Thread bookkeeping (reply_count,
 * latest_reply, reply_users) and `_` stamps are excluded.
 */
export function slackComparableState(message: Record<string, unknown>): string {
  const reactions = reactionsOf(message.reactions)
    .map((r) => ({ name: r.name, users: [...r.users].sort(), count: r.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = Array.isArray(message.files)
    ? message.files.map((f) => (isRecord(f) ? { id: f.id ?? null, mode: f.mode ?? null, title: f.title ?? null, name: f.name ?? null } : null))
    : [];
  return JSON.stringify({
    text: typeof message.text === "string" ? message.text : null,
    edited: isRecord(message.edited) ? message.edited.ts ?? null : null,
    subtype: message.subtype ?? null,
    reactions,
    files,
    blocks: message.blocks ?? null,
    attachments: message.attachments ?? null,
  });
}

export function slackComparableHash(message: Record<string, unknown>): string {
  return createHash("sha256").update(slackComparableState(message)).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ renderer integration

type Executor = Pick<typeof db, "execute">;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

function payloadOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function observationsOf(value: unknown): SlackLedgerObservation[] {
  const list = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((o) => (isRecord(o) && typeof o.event_type === "string" && typeof o.source_event_id === "string"
    ? [{ event_type: o.event_type, source_event_id: o.source_event_id, timestamp: String(o.timestamp), raw_payload: payloadOf(o.raw_payload) }]
    : []));
}

/**
 * Column for a SELECT over base `activity_events` rows (unaliased FROM activity_events): the
 * message's ledger observations as a jsonb array, ordered. Ledger rows carry the same
 * (source_namespace, source_object_id) as their base message (`workspace:<team>`,
 * `message:<channel>:<ts>`), so this is an index lookup (idx_event_object_history) per row.
 */
export function slackLedgerColumn(): SQL {
  return sql`(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'event_type', l.event_type, 'source_event_id', l.source_event_id,
             'timestamp', l."timestamp", 'raw_payload', l.raw_payload
           ) ORDER BY l."timestamp", l.source_event_id), '[]'::jsonb)
    FROM activity_events l
    WHERE l.user_id = activity_events.user_id
      AND l.source = 'slack'
      AND l.source_namespace = activity_events.source_namespace
      AND l.source_object_id = activity_events.source_object_id
      AND l.raw_payload->>'_ledger' = 'true'
  ) AS fold_ledger`;
}

/**
 * Channel-day rows (materializer.ts materializeSlackChannelDaySourceWiki) selected with
 * slackLedgerColumn(): raw_payload becomes the folded current state, source_updated_at the
 * latest observation; rows without observations are returned unchanged.
 */
export function foldSlackChannelDayRows<T extends { raw_payload: Record<string, unknown>; source_updated_at?: Date | string | null; fold_ledger?: unknown }>(
  rows: readonly T[],
): Array<Omit<T, "fold_ledger">> {
  return rows.map((row) => {
    const { fold_ledger, ...rest } = row;
    const observations = observationsOf(fold_ledger);
    if (observations.length === 0) return rest;
    const folded = foldSlackMessage(payloadOf(row.raw_payload), observations);
    if (folded.applied === 0) return rest;
    const latest = observations.reduce<string | null>((acc, o) => {
      const at = isoOf(o.timestamp);
      return at && (!acc || at > acc) ? at : acc;
    }, isoOf(row.source_updated_at ?? null));
    return { ...rest, raw_payload: folded.payload, ...("source_updated_at" in row ? { source_updated_at: latest } : {}) };
  });
}

/** Row shape consumed by backfill.ts mirrorSlackChannelWindows (SlackMessageRow). */
export interface SlackWindowRow {
  ts: string | null;
  source_event_id: string | null;
  text: string | null;
  deleted: boolean;
  sender_name: string | null;
  sender_handle: string | null;
  thread_ts: string | null;
  channel_name: string | null;
  reactions: unknown;
  mentions: unknown;
}

/** Extra columns for the window SELECT: the base payload and its ledger observations. */
export function slackWindowFoldColumns(): SQL {
  return sql`raw_payload AS fold_base, ${slackLedgerColumn()}`;
}

/**
 * Window rows (backfill.ts mirrorSlackChannelWindows) selected with slackWindowFoldColumns():
 * text / deleted / reactions / mentions are recomputed from the folded payload. Rows selected
 * without the fold columns (or without observations) pass through unchanged.
 */
export function foldSlackWindowRows<T extends SlackWindowRow & { fold_base?: unknown; fold_ledger?: unknown }>(rows: readonly T[]): SlackWindowRow[] {
  return rows.map((row) => {
    const { fold_base, fold_ledger, ...rest } = row;
    const observations = observationsOf(fold_ledger);
    if (observations.length === 0 || fold_base === undefined) return rest;
    const payload = foldSlackMessage(payloadOf(fold_base), observations).payload;
    return {
      ...rest,
      text: typeof payload.text === "string" ? payload.text : null,
      deleted: payload._deleted === true,
      reactions: payload.reactions ?? null,
      mentions: payload._mentions ?? rest.mentions ?? null,
    };
  });
}

/**
 * Ledger observations for messages (by ts) of one channel in one workspace, grouped by ts
 * (capture-side reads: revision comparison, reconcile). Index-backed through
 * (source_namespace, source_object_id) when the workspace is known.
 */
export async function loadSlackLedgerObservations(
  executor: Executor,
  userId: string,
  channelId: string,
  tsList: readonly string[],
  teamId?: string | null,
): Promise<Map<string, SlackLedgerObservation[]>> {
  const out = new Map<string, SlackLedgerObservation[]>();
  const unique = [...new Set(tsList.filter((t) => typeof t === "string" && t))];
  for (let i = 0; i < unique.length; i += 500) {
    const part = unique.slice(i, i + 500);
    const objects = JSON.stringify(part.map((t) => `message:${channelId}:${t}`));
    const rows = rowsOf<{ event_type: string; source_event_id: string; timestamp: Date | string; raw_payload: unknown }>(await executor.execute(teamId
      ? sql`
        SELECT event_type, source_event_id, timestamp, raw_payload
        FROM activity_events
        WHERE user_id = ${userId} AND source = 'slack'
          AND source_namespace = ${`workspace:${teamId}`}
          AND source_object_id IN (SELECT jsonb_array_elements_text(${objects}::jsonb))
          AND raw_payload->>'_ledger' = 'true'
        ORDER BY timestamp ASC, source_event_id ASC`
      : sql`
        SELECT event_type, source_event_id, timestamp, raw_payload
        FROM activity_events
        WHERE user_id = ${userId} AND source = 'slack'
          AND source_object_id IN (SELECT jsonb_array_elements_text(${objects}::jsonb))
          AND raw_payload->>'_channel' = ${channelId}
          AND raw_payload->>'_ledger' = 'true'
        ORDER BY timestamp ASC, source_event_id ASC`));
    for (const row of rows) {
      const payload = payloadOf(row.raw_payload);
      const ts = str(payload._object_ts);
      if (!ts) continue;
      const list = out.get(ts) ?? [];
      list.push({ event_type: row.event_type, source_event_id: row.source_event_id, timestamp: row.timestamp, raw_payload: payload });
      out.set(ts, list);
    }
  }
  return out;
}
