import { createHash } from "node:crypto";
import { imessageHandleVariants } from "../../../lib/imessage-handles.js";
import { slugify } from "../../../lib/utils.js";
import { isRecord, stringValue, validDate } from "./util.js";

/**
 * iMessage projection renderer (pure; no database access).
 *
 * One chronological markdown file per conversation per UTC month, like the donor
 * (aqueduct mirror/materializer.ts materializeImessageMonthSourceWiki), but it renders the
 * fields the donor dropped or garbled:
 *  - reactions are the uploader's object `{kind, targetMessageId, emoji, isRemoved}`
 *    (the donor read `raw_payload->>'reaction'` and printed the JSON text); they render as
 *    "Loved “…”" lines resolved against the target message, removals as "removed …",
 *    and every message lists its current reactions (added minus removed, per sender);
 *  - unsent messages render as unsent (the donor printed nothing or the stale text), with
 *    the text captured before the unsend;
 *  - edits show the current text, the edit time and every earlier version (`_edit_history`);
 *  - attachments are metadata only and say so (the uploader sends no bytes);
 *  - membership / rename events, replies, effects, audio and forwarded markers;
 *  - message text keeps its line breaks, and nothing is truncated or elided.
 */

export const IMESSAGE_PROJECTION_ROOT = "sources/imessage/conversations";
export const IMESSAGE_CONTACTS_PATH = "sources/imessage/contacts.json";

export interface ProjectionRow {
  id: string;
  sourceEventId: string;
  eventType: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export interface ReactionTarget {
  /** Short excerpt of the target message, or null when it has no text. */
  excerpt: string | null;
  isFromMe: boolean;
  senderLabel: string;
}

export interface RenderMonthInput {
  conversationId: string;
  conversationName: string;
  conversationType: string;
  month: string;
  rows: ProjectionRow[];
  /** Contact names keyed by every handle variant (imessage_contacts). */
  contacts: Map<string, string>;
  /** Targets of reactions/replies that live outside this month, by GUID. */
  externalTargets: Map<string, ReactionTarget>;
  /** Reaction rows (any month) targeting messages of this month. */
  reactionsOnMonth: ProjectionRow[];
}

const REACTION_LABEL: Record<string, { emoji: string; verb: string }> = {
  love: { emoji: "❤️", verb: "Loved" },
  like: { emoji: "👍", verb: "Liked" },
  dislike: { emoji: "👎", verb: "Disliked" },
  laugh: { emoji: "😂", verb: "Laughed at" },
  emphasize: { emoji: "‼️", verb: "Emphasized" },
  emphasis: { emoji: "‼️", verb: "Emphasized" },
  question: { emoji: "❓", verb: "Questioned" },
};

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** sources/imessage/conversations/<slug(name)>-chat-<sha256(conversationId)[:12]> (donor titledEntityDirectory scheme). */
export function conversationDirectory(conversationId: string, conversationName: string | null): string {
  const slug = slugify((conversationName ?? "").trim() || "Unnamed Conversation").slice(0, 80).replace(/-$/u, "");
  return `${IMESSAGE_PROJECTION_ROOT}/${slug || "untitled"}-chat-${shortHash(conversationId)}`;
}

export function conversationDirectorySuffix(conversationId: string): string {
  return `-chat-${shortHash(conversationId)}`;
}

/** Strip the chat.db associated-message prefixes ("p:0/", "bp:") so a reaction target matches the target GUID. */
export function normalizeTargetGuid(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  return raw.replace(/^(?:p:\d+\/|bp:)/u, "") || null;
}

export function messageGuid(payload: Record<string, unknown>): string | null {
  return stringValue(payload.providerMessageGuid) ?? stringValue(payload.messageId);
}

export function contactName(contacts: Map<string, string>, handle: unknown): string | null {
  const h = stringValue(handle);
  if (!h) return null;
  for (const v of imessageHandleVariants(h)) {
    const name = contacts.get(v);
    if (name) return name;
  }
  return null;
}

export function senderLabel(payload: Record<string, unknown>, contacts: Map<string, string>): string {
  if (payload.isFromMe === true || payload._is_from_me === true) return "me";
  const handle = stringValue(payload._sender_handle) ?? stringValue(payload.participant);
  return contactName(contacts, handle) ?? stringValue(payload._resolved_name) ?? handle ?? "unknown";
}

function stamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function stampOf(value: unknown): string | null {
  const d = validDate(value);
  return d ? stamp(d) : null;
}

function quote(text: string, max = 80): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `“${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}”`;
}

/** Message text with its line breaks kept: continuation lines are indented under the bullet. */
function multiline(text: string): string {
  return text.replace(/\r\n?/gu, "\n").split("\n").join("\n    ");
}

function inline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function reactionInfo(reaction: Record<string, unknown>): { emoji: string; verb: string; key: string } {
  const kind = stringValue(reaction.kind)?.toLowerCase() ?? "reaction";
  const known = REACTION_LABEL[kind];
  if (known) return { ...known, key: kind };
  const emoji = stringValue(reaction.emoji);
  if (emoji) return { emoji, verb: `Reacted ${emoji} to`, key: `emoji:${emoji}` };
  if (kind === "sticker") return { emoji: "🏷️", verb: "Stuck a sticker on", key: "sticker" };
  return { emoji: `(${kind})`, verb: `Reacted (${kind}) to`, key: kind };
}

function formatBytes(n: unknown): string | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentLabel(a: Record<string, unknown>): string {
  const name = stringValue(a.fileName) ?? stringValue(a.id) ?? "attachment";
  const details = [stringValue(a.mimeType), formatBytes(a.sizeBytes), a.isSticker ? "sticker" : null, stringValue(a.transferStatus) && a.transferStatus !== "complete" ? `transfer ${a.transferStatus}` : null]
    .filter(Boolean)
    .join(", ");
  return `[attachment: ${inline(name)}${details ? ` (${details})` : ""}; metadata only]`;
}

function targetFor(guid: string | null, local: Map<string, ProjectionRow>, external: Map<string, ReactionTarget>, contacts: Map<string, string>): ReactionTarget | null {
  if (!guid) return null;
  const row = local.get(guid);
  if (row) return targetSummary(row.payload, contacts);
  return external.get(guid) ?? null;
}

export function targetSummary(payload: Record<string, unknown>, contacts: Map<string, string>): ReactionTarget {
  const retracted = payload._retracted === true || Boolean(payload.retractedAt);
  const text = retracted ? null : stringValue(payload.text);
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  return {
    excerpt: text ?? (retracted ? "[unsent message]" : attachments.length ? "[attachment]" : null),
    isFromMe: payload.isFromMe === true,
    senderLabel: senderLabel(payload, contacts),
  };
}

function describeTarget(t: ReactionTarget | null): string {
  if (!t) return "a message not in this archive";
  return t.excerpt ? quote(t.excerpt) : `a message from ${t.senderLabel}`;
}

/** Current reactions on each target GUID: for each (sender, reaction key) the latest add/remove wins. */
export function currentReactions(reactions: ProjectionRow[], contacts: Map<string, string>): Map<string, string[]> {
  const latest = new Map<string, { at: number; removed: boolean; emoji: string; sender: string; target: string }>();
  const sorted = [...reactions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || (a.sourceEventId < b.sourceEventId ? -1 : 1));
  for (const r of sorted) {
    const reaction = r.payload.reaction;
    if (!isRecord(reaction) || r.payload._retracted === true) continue;
    const target = normalizeTargetGuid(reaction.targetMessageId);
    if (!target) continue;
    const info = reactionInfo(reaction);
    const sender = senderLabel(r.payload, contacts);
    const key = `${target}\u0000${sender}\u0000${info.key}`;
    latest.set(key, { at: r.timestamp.getTime(), removed: reaction.isRemoved === true, emoji: info.emoji, sender, target });
  }
  const out = new Map<string, string[]>();
  for (const v of latest.values()) {
    if (v.removed) continue;
    const list = out.get(v.target) ?? [];
    list.push(`${v.emoji} ${v.sender}`);
    out.set(v.target, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}

function sortRows(rows: ProjectionRow[]): ProjectionRow[] {
  return [...rows].sort((a, b) => {
    const t = a.timestamp.getTime() - b.timestamp.getTime();
    if (t) return t;
    const ra = Number(a.payload.rowId);
    const rb = Number(b.payload.rowId);
    if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb;
    return a.sourceEventId < b.sourceEventId ? -1 : a.sourceEventId > b.sourceEventId ? 1 : 0;
  });
}

/** The lines for one stored message (first line is the bullet; the rest are indented details). */
export function renderMessage(
  row: ProjectionRow,
  ctx: { contacts: Map<string, string>; local: Map<string, ProjectionRow>; external: Map<string, ReactionTarget>; reactionsByTarget: Map<string, string[]> },
): string[] {
  const p = row.payload;
  const sender = senderLabel(p, ctx.contacts);
  const head = `- **${stamp(row.timestamp)}** ${inline(sender)}:`;
  const details: string[] = [];
  const reaction = isRecord(p.reaction) ? p.reaction : null;
  const retracted = p._retracted === true || Boolean(p.retractedAt);
  const lines: string[] = [];

  if (reaction) {
    const info = reactionInfo(reaction);
    const target = describeTarget(targetFor(normalizeTargetGuid(reaction.targetMessageId), ctx.local, ctx.external, ctx.contacts));
    const range = isRecord(reaction.textRange) ? " (part of the message)" : "";
    lines.push(reaction.isRemoved === true ? `${head} removed ${info.emoji} (${info.verb.toLowerCase()}) from ${target}${range}` : `${head} ${info.emoji} ${info.verb} ${target}${range}`);
    if (retracted) details.push(`unsent ${stampOf(p.retractedAt) ?? ""}`.trim());
    return [...lines, ...details.map((d) => `    - ${d}`)];
  }

  const kind = stringValue(p.kind);
  if (kind === "memberAdded" || kind === "memberRemoved") {
    const who = contactName(ctx.contacts, p.affectedParticipant) ?? stringValue(p.affectedParticipant) ?? "someone";
    lines.push(`${head} ${kind === "memberAdded" ? "added" : "removed"} ${inline(who)} ${kind === "memberAdded" ? "to" : "from"} the conversation`);
    return lines;
  }
  if (kind === "nameChanged") {
    const name = stringValue(p.newGroupName);
    lines.push(`${head} ${name ? `renamed the conversation to ${quote(name, 200)}` : "removed the conversation name"}`);
    return lines;
  }

  const parts: string[] = [];
  const reply = normalizeTargetGuid(p.replyToMessageId);
  if (reply) parts.push(`↩ reply to ${describeTarget(targetFor(reply, ctx.local, ctx.external, ctx.contacts))}:`);
  if (p.isForwarded === true) parts.push("[forwarded]");
  const text = stringValue(p.text);
  if (retracted) {
    parts.push(`[unsent${stampOf(p.retractedAt) ? ` ${stampOf(p.retractedAt)}` : ""}]`);
  } else if (text) {
    parts.push(multiline(String(p.text).trim()));
  }
  if (p.isAudioMessage === true) parts.push("[audio message]");
  const attachments = (Array.isArray(p.attachments) ? p.attachments : []).filter(isRecord);
  if (!retracted) for (const a of attachments) parts.push(attachmentLabel(a));
  if (!retracted && !attachments.length && p.hasAttachments === true) parts.push("[attachment; details not uploaded]");
  if (!parts.length) parts.push("[no text]");
  const effect = stringValue(p.sendEffect);
  if (effect) parts.push(`(sent with effect ${effect.replace(/^com\.apple\.(?:MobileSMS\.expressivesend|messages\.effect)\./u, "")})`);
  if (!retracted && validDate(p.editedAt)) parts.push(`(edited ${stampOf(p.editedAt)})`);
  lines.push(`${head} ${parts.join(" ")}`);

  const history = Array.isArray(p._edit_history) ? p._edit_history.filter(isRecord) : [];
  for (const h of history) {
    const t = stringValue(h.text);
    if (t) details.push(`earlier version (replaced ${stampOf(h.at) ?? "at an unknown time"}): ${quote(t, 2_000)}`);
  }
  const original = stringValue(p._original_text);
  if (retracted) {
    const before = stringValue(p._text_before_unsend) ?? original;
    if (before) details.push(`text before unsend: ${quote(before, 2_000)}`);
    else details.push("text before unsend was not captured (the message was first uploaded already unsent)");
    if (original && before !== original && !history.some((h) => stringValue(h.text) === original)) details.push(`original text: ${quote(original, 2_000)}`);
    if (attachments.length) details.push(`had ${attachments.length} attachment(s): ${attachments.map(attachmentLabel).join(" ")}`);
  } else if (original && original !== text && !history.some((h) => stringValue(h.text) === original)) {
    details.push(`original text: ${quote(original, 2_000)}`);
  }
  const guid = messageGuid(p);
  const reactions = guid ? ctx.reactionsByTarget.get(guid) : undefined;
  if (reactions?.length) details.push(`reactions: ${reactions.join(", ")}`);
  return [...lines, ...details.map((d) => `    - ${d}`)];
}

/** The month file content, or null when the month has no messages. */
export function renderConversationMonth(input: RenderMonthInput): string | null {
  const rows = sortRows(input.rows);
  if (rows.length === 0) return null;
  const local = new Map<string, ProjectionRow>();
  for (const r of rows) {
    const g = messageGuid(r.payload);
    if (g && !local.has(g)) local.set(g, r);
  }
  const ctx = { contacts: input.contacts, local, external: input.externalTargets, reactionsByTarget: currentReactions(input.reactionsOnMonth, input.contacts) };
  const body = rows.flatMap((r) => renderMessage(r, ctx));
  const counts = {
    messages: rows.filter((r) => !isRecord(r.payload.reaction)).length,
    reactions: rows.filter((r) => isRecord(r.payload.reaction)).length,
    edited: rows.filter((r) => Array.isArray(r.payload._edit_history) || validDate(r.payload.editedAt)).length,
    unsent: rows.filter((r) => r.payload._retracted === true || Boolean(r.payload.retractedAt)).length,
    attachments: rows.reduce((n, r) => n + (Array.isArray(r.payload.attachments) ? r.payload.attachments.length : 0), 0),
  };
  return [
    `# ${inline(input.conversationName) || "Unnamed Conversation"} - ${input.month}`,
    "",
    `- Source: iMessage (uploaded by the user's Mac; times are UTC)`,
    `- Conversation ID: ${input.conversationId}`,
    `- Conversation type: ${input.conversationType}`,
    `- Month: ${input.month}`,
    `- Messages: ${counts.messages}; reactions: ${counts.reactions}; edited: ${counts.edited}; unsent: ${counts.unsent}; attachments: ${counts.attachments} (metadata only, no attachment bytes are uploaded)`,
    `- Raw records: sources/imessage/_raw/ (one JSON file per message, mutation history under _mutations/)`,
    "",
    "## Messages",
    "",
    ...body,
    "",
  ].join("\n");
}

export interface ConversationSummary {
  conversationId: string;
  conversationType: string;
  name: string;
  counterpartHandle: string | null;
  rawChatIds: string[];
  months: Array<{ month: string; path: string; rows: number }>;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export function renderConversationJson(s: ConversationSummary): string {
  return `${JSON.stringify(
    {
      schema: "procmem.imessage.conversation/v1",
      conversationId: s.conversationId,
      conversationType: s.conversationType,
      name: s.name,
      counterpartHandle: s.counterpartHandle,
      rawChatIds: s.rawChatIds,
      firstMessageAt: s.firstMessageAt,
      lastMessageAt: s.lastMessageAt,
      months: s.months,
      attachments: "metadata only: the Mac uploader does not send attachment bytes",
    },
    null,
    2,
  )}\n`;
}

export function renderContactsJson(contacts: Array<{ handle: string; name: string; variants: string[]; updatedAt: string }>): string {
  return `${JSON.stringify({ schema: "procmem.imessage.contacts/v1", source: "Mac address book via the Messages uploader (POST /api/imessage/ingest/sync-contacts)", contacts }, null, 2)}\n`;
}

/** Display name of a conversation from its latest row (and contacts for DMs). */
export function conversationDisplayName(
  conversationId: string,
  latest: Record<string, unknown> | null,
  latestGroupName: string | null,
  contacts: Map<string, string>,
): string {
  if (conversationId.startsWith("imessage:dm:")) {
    const handle = conversationId.slice("imessage:dm:".length);
    return contactName(contacts, handle) ?? stringValue(latest?._resolved_name) ?? stringValue(latest?.chatName) ?? handle;
  }
  return latestGroupName ?? stringValue(latest?.chatName) ?? stringValue(latest?._chat_name) ?? stringValue(latest?.chatId) ?? conversationId;
}
