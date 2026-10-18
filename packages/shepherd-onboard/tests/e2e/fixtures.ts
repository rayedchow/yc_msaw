/**
 * Synthetic local data for the Mac client end-to-end tests. Nothing here reads a real Messages database, Contacts
 * database or coding history: every file is created under a throwaway HOME.
 *
 * - chat.db: the tables and columns @photon-ai/imessage-kit 3.0.0 (macos26Queries) and the uploader's own
 *   mutation-reconciliation query read, in WAL mode like Messages.app.
 * - AddressBook-v22.abcddb: the ZABCD* tables the uploader's contact loader queries with the system sqlite3.
 * - Codex / Claude Code JSONL transcripts in the shapes the uploader's parsers accept.
 */
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
export const macNs = (iso: string) => (Date.parse(iso) - MAC_EPOCH_MS) * 1e6;

const MESSAGE_FLAG_COLUMNS = [
  "is_from_me", "is_read", "is_sent", "is_delivered", "was_downgraded", "did_notify_recipient", "is_auto_reply", "is_system_message",
  "is_forward", "is_audio_message", "is_played", "is_expirable", "error", "is_spam", "is_kt_verified", "has_unseen_mention",
  "was_delivered_quietly", "is_sos", "is_critical", "sent_or_received_off_grid", "date_delivered", "date_read", "date_played",
  "date_edited", "date_retracted", "date_recovered", "is_empty", "was_detonated", "expire_state", "share_status", "share_direction",
  "schedule_type", "schedule_state", "part_count", "cache_has_attachments", "associated_message_type", "associated_message_range_location",
  "associated_message_range_length", "item_type", "group_action_type", "handle_id", "other_handle",
];
const MESSAGE_TEXT_COLUMNS = [
  "text", "service", "reply_to_guid", "thread_originator_guid", "group_title", "expressive_send_style_id", "balloon_bundle_id",
  "destination_caller_id", "ck_chat_id", "associated_message_guid", "associated_message_emoji",
];

const SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT, country TEXT, uncanonicalized_id TEXT, person_centric_id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
  chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER NOT NULL DEFAULT 0, display_name TEXT,
  group_id TEXT, is_filtered INTEGER NOT NULL DEFAULT 0, last_read_message_timestamp INTEGER NOT NULL DEFAULT 0,
  is_blackholed INTEGER NOT NULL DEFAULT 0, is_deleting_incoming_messages INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE (chat_id, handle_id));
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, attributedBody BLOB, message_summary_info BLOB,
  date INTEGER NOT NULL DEFAULT 0,
  ${MESSAGE_TEXT_COLUMNS.map((c) => `${c} TEXT`).join(", ")},
  ${MESSAGE_FLAG_COLUMNS.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(", ")});
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER NOT NULL DEFAULT 0,
  filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER NOT NULL DEFAULT 0, is_outgoing INTEGER NOT NULL DEFAULT 0, transfer_name TEXT,
  total_bytes INTEGER NOT NULL DEFAULT 0, is_sticker INTEGER NOT NULL DEFAULT 0, hide_attachment INTEGER NOT NULL DEFAULT 0,
  is_commsafety_sensitive INTEGER NOT NULL DEFAULT 0, emoji_image_short_description TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE (message_id, attachment_id));
`;

export interface SyntheticChat {
  guid: string;
  identifier: string;
  style: 45 | 43; // 45 = direct message, 43 = group
  displayName?: string | null;
  handles: string[];
}

export interface SyntheticMessage {
  guid: string;
  chat: string; // chat guid
  from?: string | null; // handle id; null/undefined = sent by the device owner
  text: string;
  at: string;
  editedAt?: string;
  reactionTo?: { guid: string; type: number };
  attachment?: { guid: string; name: string; mime: string; bytes: number };
}

export const messagesDbPath = (home: string) => path.join(home, "Library", "Messages", "chat.db");

export function createChatDb(home: string, chats: SyntheticChat[]): string {
  const file = messagesDbPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const handles = new Map<string, number>();
  for (const chat of chats) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, 'iMessage', ?)`)
      .run(chat.guid, chat.style, chat.identifier, chat.displayName ?? null);
    for (const h of chat.handles) {
      if (!handles.has(h)) handles.set(h, Number(db.prepare(`INSERT INTO handle (id, service) VALUES (?, 'iMessage')`).run(h).lastInsertRowid));
      db.prepare(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`).run(lastInsertRowid, handles.get(h));
    }
  }
  db.close();
  return file;
}

/** Appends messages the way Messages.app does: a message row, its chat join and any attachment metadata row. */
export function appendMessages(home: string, messages: SyntheticMessage[]): void {
  const db = new Database(messagesDbPath(home));
  db.pragma("journal_mode = WAL");
  const tx = db.transaction(() => {
    for (const m of messages) {
      const chatRow = db.prepare(`SELECT ROWID FROM chat WHERE guid = ?`).get(m.chat) as { ROWID: number } | undefined;
      if (!chatRow) throw new Error(`unknown synthetic chat ${m.chat}`);
      let handleId = 0;
      if (m.from) {
        const h = db.prepare(`SELECT ROWID FROM handle WHERE id = ?`).get(m.from) as { ROWID: number } | undefined;
        handleId = h?.ROWID ?? Number(db.prepare(`INSERT INTO handle (id, service) VALUES (?, 'iMessage')`).run(m.from).lastInsertRowid);
      }
      const date = macNs(m.at);
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO message (guid, text, service, handle_id, date, is_from_me, is_sent, is_delivered, is_read, date_edited,
          associated_message_type, associated_message_guid, cache_has_attachments)
        VALUES (?, ?, 'iMessage', ?, ?, ?, 1, 1, 1, ?, ?, ?, ?)
      `).run(m.guid, m.text, handleId, date, m.from ? 0 : 1, m.editedAt ? macNs(m.editedAt) : 0,
        m.reactionTo?.type ?? 0, m.reactionTo ? `p:0/${m.reactionTo.guid}` : null, m.attachment ? 1 : 0);
      db.prepare(`INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`).run(chatRow.ROWID, lastInsertRowid, date);
      if (m.attachment) {
        const a = db.prepare(`INSERT INTO attachment (guid, created_date, filename, transfer_name, mime_type, uti, transfer_state, total_bytes)
          VALUES (?, ?, ?, ?, ?, 'public.jpeg', 5, ?)`).run(m.attachment.guid, date, `~/Library/Messages/Attachments/${m.attachment.name}`, m.attachment.name, m.attachment.mime, m.attachment.bytes);
        db.prepare(`INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)`).run(lastInsertRowid, a.lastInsertRowid);
      }
    }
  });
  tx();
  db.close();
}

/** A local Contacts database with the ZABCD* columns the uploader reads (macOS AddressBook-v22 schema subset). */
export function createAddressBook(home: string, contacts: Array<{ first: string; last: string; phone?: string; email?: string }>): string {
  const file = path.join(home, "Library", "Application Support", "AddressBook", "AddressBook-v22.abcddb");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZME INTEGER, Z22_ME INTEGER, ZNAME TEXT, ZFIRSTNAME TEXT, ZMIDDLENAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, Z22_OWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, Z22_OWNER INTEGER, ZADDRESS TEXT, ZADDRESSNORMALIZED TEXT);
  `);
  contacts.forEach((c, i) => {
    const id = i + 1;
    db.prepare(`INSERT INTO ZABCDRECORD (Z_PK, ZME, Z22_ME, ZFIRSTNAME, ZLASTNAME) VALUES (?, 0, 0, ?, ?)`).run(id, c.first, c.last);
    if (c.phone) db.prepare(`INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)`).run(id, c.phone);
    if (c.email) db.prepare(`INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS, ZADDRESSNORMALIZED) VALUES (?, ?, ?)`).run(id, c.email, c.email.toLowerCase());
  });
  db.close();
  return file;
}

/** A Codex rollout transcript (session_meta + response_item messages), with a fixed mtime so cap order is stable. */
export function writeCodexSession(dir: string, id: string, at: string, user: string, answer: string, mtimeSec?: number): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const later = new Date(Date.parse(at) + 60_000).toISOString();
  writeFileSync(file, [
    { type: "session_meta", timestamp: at, payload: { session_id: id, timestamp: at } },
    { type: "response_item", timestamp: at, payload: { id: `${id}-user`, type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
    { type: "response_item", timestamp: later, payload: { id: `${id}-agent`, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

/** A Claude Code project transcript (user / assistant records keyed by sessionId). */
export function writeClaudeSession(projectsDir: string, id: string, at: string, user: string, answer: string): string {
  const dir = path.join(projectsDir, "-synthetic-repo");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const later = new Date(Date.parse(at) + 30_000).toISOString();
  writeFileSync(file, [
    { type: "user", sessionId: id, uuid: `${id}-u1`, timestamp: at, message: { role: "user", content: user } },
    { type: "assistant", sessionId: id, uuid: `${id}-a1`, parentUuid: `${id}-u1`, timestamp: later, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

/** Edits or unsends a message in place, as Messages.app does (new text + date_edited, or date_retracted). */
export function mutateMessage(home: string, guid: string, change: { text?: string | null; editedAt?: string; retractedAt?: string }): void {
  const db = new Database(messagesDbPath(home));
  db.pragma("journal_mode = WAL");
  const r = db.prepare(`UPDATE message SET text = COALESCE(?, CASE WHEN ? THEN NULL ELSE text END), date_edited = ?, date_retracted = ? WHERE guid = ?`)
    .run(change.text ?? null, change.text === null ? 1 : 0, change.editedAt ? macNs(change.editedAt) : 0, change.retractedAt ? macNs(change.retractedAt) : 0, guid);
  db.close();
  if (r.changes !== 1) throw new Error(`no synthetic message ${guid}`);
}
