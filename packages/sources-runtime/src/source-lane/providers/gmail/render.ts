import { normalizeGmailBody } from "../../../integrations/gmail/body.js";
import { extractBodyText, extractHtmlBody, getHeader, parseEmailAddress, type GmailMessage } from "../../../integrations/gmail/poller.js";
import { attachmentPath, folderOf, relativeLink } from "./paths.js";

/**
 * Readable Gmail projections, rendered from the stored post-redaction raw payload with the donor
 * parsers (poller.ts header/body extraction, body.ts normalisation). Unlike the donor mirror the body
 * is never truncated (the donor capped it at 60,000 characters). Following the donor label policy,
 * volatile labels are not rendered (they live in state.json); only INBOX/SENT/TRASH/SPAM affect placement.
 */

export interface ParsedGmailMessage {
  messageId: string;
  threadId: string | null;
  subject: string | null;
  from: string | null;
  fromEmail: string | null;
  fromName: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  date: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  snippet: string | null;
  bodyText: string;
  bodyMarkdown: string;
  bodySource: string;
}

export function parseStoredMessage(rawJson: string): ParsedGmailMessage {
  const msg = JSON.parse(rawJson) as GmailMessage;
  const from = getHeader(msg, "From") ?? null;
  const parsedFrom = from ? parseEmailAddress(from) : null;
  const normalized = normalizeGmailBody(
    {
      bodyText: msg.payload ? extractBodyText(msg.payload) : "",
      bodyHtml: msg.payload ? extractHtmlBody(msg.payload) : "",
      snippet: msg.snippet,
    },
    { includeMarkdown: true },
  );
  return {
    messageId: msg.id,
    threadId: msg.threadId ?? null,
    subject: getHeader(msg, "Subject") ?? null,
    from,
    fromEmail: parsedFrom?.email || null,
    fromName: parsedFrom?.name || null,
    to: getHeader(msg, "To") ?? null,
    cc: getHeader(msg, "Cc") ?? null,
    bcc: getHeader(msg, "Bcc") ?? null,
    replyTo: getHeader(msg, "Reply-To") ?? null,
    date: getHeader(msg, "Date") ?? null,
    rfcMessageId: getHeader(msg, "Message-ID") ?? null,
    inReplyTo: getHeader(msg, "In-Reply-To") ?? null,
    references: getHeader(msg, "References") ?? null,
    snippet: msg.snippet ?? null,
    bodyText: normalized.bodyText,
    bodyMarkdown: normalized.bodyMarkdown,
    bodySource: normalized.bodySource,
  };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function metadataList(rows: Array<[string, string | null | undefined]>): string {
  return rows
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${oneLine(String(v))}`)
    .join("\n");
}

function linkText(value: string): string {
  return oneLine(value).replace(/([\\[\]])/g, "\\$1");
}

function linkTarget(value: string): string {
  return value.split("/").map((s) => encodeURIComponent(decodeURIComponentSafe(s))).join("/");
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface AttachmentView {
  partRef: string;
  filename: string | null;
  mimeType: string | null;
  declaredSize: number | null;
  status: string;
  size: number | null;
}

export interface MessageView {
  mailbox: string;
  internalDate: Date | null;
  labelIds: readonly string[];
  rfc822Status: string;
  paths: { projection: string; raw: string; rfc822: string; state: string };
}

export function renderMessageMarkdown(parsed: ParsedGmailMessage, view: MessageView, attachments: readonly AttachmentView[]): string {
  const from = view.paths.projection;
  const attachmentLines = attachments.map((a) => {
    const name = a.filename ?? "unnamed attachment";
    const bytes = a.size ?? a.declaredSize;
    const details = [a.mimeType, bytes !== null ? `${bytes} bytes` : null].filter(Boolean).join(", ");
    const target = attachmentPath(view.mailbox, parsed.messageId, view.internalDate, a.partRef, a.filename);
    const label = a.status === "stored" ? `[${linkText(name)}](${linkTarget(relativeLink(from, target))})` : linkText(name);
    const status = a.status === "stored" ? "" : ` - bytes ${a.status.replace(/_/g, " ")}`;
    return `- ${label}${details ? ` (${details})` : ""}${status}`;
  });
  const body = parsed.bodyMarkdown || parsed.bodyText || parsed.snippet || "";
  return [
    `# ${oneLine(parsed.subject ?? "(no subject)") || "(no subject)"}`,
    "",
    metadataList([
      ["Source", "Gmail"],
      ["Mailbox", view.mailbox],
      ["Folder", folderOf(view.labelIds)],
      ["From", parsed.from],
      ["To", parsed.to],
      ["Cc", parsed.cc],
      ["Bcc", parsed.bcc],
      ["Reply-To", parsed.replyTo],
      ["Date", parsed.date ?? view.internalDate?.toISOString() ?? null],
      ["Subject", parsed.subject],
      ["Gmail ID", parsed.messageId],
      ["Thread ID", parsed.threadId],
      ["Message-ID", parsed.rfcMessageId],
      ["In reply to", parsed.inReplyTo],
      ["References", parsed.references],
      ["Body source", parsed.bodySource],
      ["Raw message", `[message.json](${linkTarget(relativeLink(from, view.paths.raw))})`],
      ["RFC822", view.rfc822Status === "captured" ? `[message.eml](${linkTarget(relativeLink(from, view.paths.rfc822))})` : view.rfc822Status.replace(/_/g, " ")],
      ["State", `[state.json](${linkTarget(relativeLink(from, view.paths.state))})`],
    ]),
    "",
    "## Attachments",
    "",
    attachmentLines.length ? attachmentLines.join("\n") : "- No attachments.",
    "",
    "## Body",
    "",
    body.trim() ? body : "_No message body was available._",
    "",
  ].join("\n");
}

export interface ThreadMember {
  parsed: ParsedGmailMessage;
  internalDate: Date | null;
  projection: string | null;
  state: string;
  labelIds: readonly string[];
}

export function renderThreadMarkdown(mailbox: string, threadId: string, threadFile: string, members: readonly ThreadMember[]): string {
  const subject = members.find((m) => m.parsed.subject)?.parsed.subject ?? "(no subject)";
  const participants = [...new Set(members.flatMap((m) => [m.parsed.fromEmail, ...[m.parsed.to, m.parsed.cc].flatMap((v) => (v ?? "").split(",").map((x) => parseEmailAddress(x.trim()).email))]).filter((x): x is string => Boolean(x)))].sort();
  const lines = members.map((m, i) => {
    const when = m.internalDate ? m.internalDate.toISOString() : m.parsed.date ?? "undated";
    const who = m.parsed.from ?? "unknown sender";
    const target = m.projection ?? m.state;
    const note = m.projection ? "" : m.labelIds.includes("SPAM") ? " (in Spam)" : " (in Trash)";
    return [
      `${i + 1}. [${linkText(`${when} - ${who}`)}](${linkTarget(relativeLink(threadFile, target))})${note}`,
      ...(m.parsed.snippet ? [`   > ${oneLine(m.parsed.snippet)}`] : []),
    ].join("\n");
  });
  return [
    `# ${oneLine(subject) || "(no subject)"}`,
    "",
    metadataList([
      ["Source", "Gmail thread"],
      ["Mailbox", mailbox],
      ["Thread ID", threadId],
      ["Messages", String(members.length)],
      ["Participants", participants.join(", ")],
    ]),
    "",
    "## Messages",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
}
