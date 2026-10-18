import { posix } from "node:path";
import { gmailMessageSourcePath } from "../../../mirror/materializer.js";
import { encodeSegment } from "../../export/mapping.js";

/**
 * sources/gmail layout (one subtree per connected mailbox; Gmail ids are mailbox-scoped):
 *
 *   sources/gmail/<mailbox>/
 *     inbox|sent|archive/<yyyy>/<mm>/<date>--<sender>--<subject>--message-<hash>.md   readable projection
 *         (donor gmailMessageSourcePath placement: INBOX/SENT move it, TRASH/SPAM/deletion remove it)
 *     messages/<yyyy-mm>/<messageId>/message.json     exact post-redaction messages.get(format=full)
 *     messages/<yyyy-mm>/<messageId>/message.eml      exact RFC822 bytes (messages.get format=raw)
 *     messages/<yyyy-mm>/<messageId>/state.json       current labels / placement / capture status / tombstone
 *     messages/<yyyy-mm>/<messageId>/attachments/<part>--<filename>   exact attachment bytes
 *     threads/<yyyy>/<mm>/<threadId>.md               thread view (members, order, links)
 *     _history/<yyyy-mm>/<startHistoryId>.json        exact history.list pages (post-redaction)
 *
 * The donor's own mirror (sources/gmail/{inbox,sent,archive}/..., no mailbox segment) cannot collide:
 * a mailbox segment always contains "@".
 */

export const GMAIL_SOURCE_ROOT = "sources/gmail";

/** Labels that keep a message out of the readable projection (donor GMAIL_EXCLUDED_LABELS policy). */
export const GMAIL_PROJECTION_EXCLUDED_LABELS = ["TRASH", "SPAM"] as const;

export function mailboxRoot(mailbox: string): string {
  return `${GMAIL_SOURCE_ROOT}/${encodeSegment(mailbox.trim().toLowerCase())}`;
}

function monthOf(date: Date | null): string {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 7) : "undated";
}

export function messageDir(mailbox: string, messageId: string, internalDate: Date | null): string {
  return `${mailboxRoot(mailbox)}/messages/${monthOf(internalDate)}/${encodeSegment(messageId)}`;
}

export interface MessagePaths {
  dir: string;
  raw: string;
  rfc822: string;
  state: string;
}

export function messagePaths(mailbox: string, messageId: string, internalDate: Date | null): MessagePaths {
  const dir = messageDir(mailbox, messageId, internalDate);
  return { dir, raw: `${dir}/message.json`, rfc822: `${dir}/message.eml`, state: `${dir}/state.json` };
}

export function attachmentPath(mailbox: string, messageId: string, internalDate: Date | null, partRef: string, filename: string | null): string {
  const name = filename && filename.trim() ? filename.trim() : "attachment";
  return `${messageDir(mailbox, messageId, internalDate)}/attachments/${encodeSegment(partRef)}--${encodeSegment(name)}`;
}

/** Projection path, or null when the current labels exclude the message (TRASH/SPAM). */
export function projectionPath(
  mailbox: string,
  messageId: string,
  meta: { internalDate: Date | null; fromEmail: string | null; fromName: string | null; subject: string | null; labelIds: readonly string[] },
): string | null {
  if (meta.labelIds.some((l) => (GMAIL_PROJECTION_EXCLUDED_LABELS as readonly string[]).includes(l))) return null;
  const donor = gmailMessageSourcePath(messageId, {
    timestamp: meta.internalDate,
    fromEmail: meta.fromEmail,
    fromName: meta.fromName,
    subject: meta.subject,
    labelIds: meta.labelIds,
  });
  return `${mailboxRoot(mailbox)}/${donor.slice(`${GMAIL_SOURCE_ROOT}/`.length)}`;
}

export function folderOf(labelIds: readonly string[]): "sent" | "inbox" | "archive" {
  return labelIds.includes("SENT") ? "sent" : labelIds.includes("INBOX") ? "inbox" : "archive";
}

export function threadPath(mailbox: string, threadId: string, firstDate: Date | null): string {
  const bucket = firstDate && !Number.isNaN(firstDate.getTime())
    ? `${firstDate.getUTCFullYear()}/${String(firstDate.getUTCMonth() + 1).padStart(2, "0")}`
    : "undated";
  return `${mailboxRoot(mailbox)}/threads/${bucket}/${encodeSegment(threadId)}.md`;
}

export function historyPagePath(mailbox: string, startHistoryId: string, capturedAt: Date): string {
  return `${mailboxRoot(mailbox)}/_history/${monthOf(capturedAt)}/${startHistoryId}.json`;
}

/** Attachment content type from the part's declared MIME type (falls back to octet-stream). */
export function attachmentContentType(mime: string | null | undefined): string {
  const v = (mime ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v) ? v : "application/octet-stream";
}

/** Relative link from one source file to another (both full sources/ paths). */
export function relativeLink(fromFile: string, toFile: string): string {
  return posix.relative(posix.dirname(fromFile), toFile);
}
