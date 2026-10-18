/**
 * Unipile personal-messaging lane shared by WhatsApp and Instagram (ported from gigabrain 5448774
 * brain/src/integrations/{whatsapp,instagram}-personal/{poller,webhook,account-webhook,connect}.ts).
 *
 * Kept from the donor:
 *  - raw message payload shape (`...message, text, _provider, _source_delivery, _account_id, …`);
 *  - source ids `<provider>:<chatId>:<messageId>`, plus WhatsApp's `:<event>` suffix for non-receive events;
 *  - all-accessible vs selected-conversation sync modes;
 *  - the account readiness gate (source status OK, initial sync done);
 *  - `after=<newest id>` forward paging and cursor paging.
 *
 * Changed, on purpose:
 *  - Tenant binding: each connection has its own webhook URL and secret, and the payload's account_id must
 *    match that connection. The donor used one global secret and took the first token row whose metadata
 *    named the account, so it could pick the wrong tenant.
 *  - Rate limits: Retry-After is persisted on the connection. The donor slept in-process, capped at 60 s.
 *  - Durable per-chat backfill cursors, and immutable `:v:<sha>` raw versions when a message changes.
 *  - Exact attachment bytes from the same validated API host, bounded.
 *  - Read-only, behind an operator opt-in (UNIPILE_PERSONAL_CONNECTORS_ENABLED=1). Unipile automates personal
 *    accounts through unofficial clients (ToS risk; gigabrain policy research 0a92129868), and coverage says so.
 *    No graph/LLM processing, no outbound sends, no credential capture.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db as defaultDb } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { personalScopeOf } from "../../source-lane/core/personal-scope.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import { decrypt, encrypt } from "../../vault/encryption.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { AqueductIntegration, ConnectResult } from "../types.js";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../source-lane/core/types.js";
import {
  DEFAULT_UNIPILE_API_BASE, UnipileApiError, UnipileClient, accountDisplayName, accountInitialSyncStatus, accountUserIdOf, messageTimestamp,
  nextCursor, normalizeUnipileApiBase, pageItems, readinessReason, sourceStatusFromAccount,
  type FetchImpl, type UnipileActor, type UnipileChat, type UnipileMessage,
} from "./api.js";

export type Executor = Pick<typeof defaultDb, "execute">;

export interface UnipileLaneConfig {
  /** Donor source / source_event_id prefix (activity_events.source). */
  provider: "whatsapp_personal" | "instagram_personal";
  /** Module id and directory under sources/. */
  sourceDir: "whatsapp-personal" | "instagram-personal";
  accountType: "WHATSAPP" | "INSTAGRAM";
  label: string;
  /** Truthful history statement for coverage. */
  historyLimit: string;
  senderId(message: UnipileMessage): string | undefined;
  /** Donor event type for a stored message. */
  eventType(message: UnipileMessage, accountUserId: string | null, accountId: string, event: string): string;
  /** Whether non-receive webhook events get the donor `:<event>` id suffix (WhatsApp) or are ignored (Instagram). */
  eventSuffix: boolean;
}

export interface LaneDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const intEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number) => {
  const n = Math.floor(Number(env[name] ?? fallback));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
};
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const CONNECTION_ID = /^up_[0-9a-f]{24}$/;
export const UNIPILE_SYNC_FREQUENCY_SECONDS = 120;

export function personalConnectorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.UNIPILE_PERSONAL_CONNECTORS_ENABLED?.trim() ?? "");
}

function actorId(actor: UnipileActor | null | undefined): string | undefined {
  if (!actor) return undefined;
  return str(actor.attendee_provider_id) ?? str(actor.provider_id) ?? str(actor.id);
}
function actorLabel(actor: UnipileActor | null | undefined): string | undefined {
  if (!actor) return undefined;
  return actor.display_name ?? actor.name ?? actor.username ?? actor.phone_number ?? actor.phone ?? actorId(actor);
}
export function conversationName(chat: UnipileChat): string {
  for (const v of [chat.name, chat.title, chat.subject]) if (v?.trim()) return v.trim();
  const names = (chat.participants ?? chat.attendees ?? []).map(actorLabel).filter(Boolean);
  return names.length ? names.join(", ") : chat.id;
}
export function conversationType(chat: UnipileChat): string {
  return chat.is_group || chat.type === "group" || chat.type === 1 || chat.type === "1" ? "group_dm" : "dm";
}
const messageText = (m: UnipileMessage) => str(m.text) ?? str(m.body) ?? str(m.message) ?? null;

/** Donor WhatsApp sender resolution (richest of the two donors). */
export function whatsappSenderId(m: UnipileMessage): string | undefined {
  return str(m.sender_attendee_provider_id) ?? str(m.attendee_provider_id) ?? str(m.sender_attendee_id) ?? str(m.sender_id) ?? actorId(m.sender);
}
/** Donor Instagram sender resolution. */
export function instagramSenderId(m: UnipileMessage): string | undefined {
  return str(m.sender_id) ?? str(m.sender?.id);
}

// ---------------------------------------------------------------- connections

export interface LaneConnection {
  id: string;
  tenantId: string;
  accountId: string;
  accountUserId: string | null;
  displayName: string | null;
  apiBase: string;
  syncMode: "all_accessible" | "selected_conversations";
  selectedChatIds: string[];
  sourceStatus: string;
  initialSyncStatus: string | null;
  status: "active" | "revoked" | "error";
  statusReason: string | null;
  lastWebhookAt: string | null;
  lastPollAt: string | null;
  retryAt: string | null;
  attempts: number;
  lastError: string | null;
}

export class UnipileLane {
  readonly t: { connections: string; chats: string; messages: string; attachments: string };
  constructor(readonly cfg: UnipileLaneConfig) {
    const p = cfg.provider;
    this.t = { connections: `${p}_connections`, chats: `${p}_chats`, messages: `${p}_messages`, attachments: `${p}_attachments` };
  }

  #toConn(r: Record<string, unknown>): LaneConnection {
    const sel = typeof r.selected_chat_ids === "string" ? JSON.parse(r.selected_chat_ids) : r.selected_chat_ids;
    return {
      id: String(r.id), tenantId: String(r.tenant_id), accountId: String(r.account_id),
      accountUserId: (r.account_user_id as string | null) ?? null, displayName: (r.display_name as string | null) ?? null,
      apiBase: String(r.api_base), syncMode: r.sync_mode as LaneConnection["syncMode"],
      selectedChatIds: Array.isArray(sel) ? sel.map(String) : [],
      sourceStatus: String(r.source_status), initialSyncStatus: (r.initial_sync_status as string | null) ?? null,
      status: r.status as LaneConnection["status"], statusReason: (r.status_reason as string | null) ?? null,
      lastWebhookAt: iso(r.last_webhook_at), lastPollAt: iso(r.last_poll_at), retryAt: iso(r.retry_at),
      attempts: Number(r.attempts ?? 0), lastError: (r.last_error as string | null) ?? null,
    };
  }

  #seal(id: string, tenantId: string, v: string) {
    return encrypt(JSON.stringify({ c: id, t: tenantId, p: this.cfg.provider, v }));
  }
  #unseal(id: string, tenantId: string, ct: string): string {
    const p = JSON.parse(decrypt(ct)) as { c?: string; t?: string; p?: string; v?: string };
    if (p.c !== id || p.t !== tenantId || p.p !== this.cfg.provider || typeof p.v !== "string") throw new Error("Unipile credential does not belong to this connection");
    return p.v;
  }

  async listConnections(tenantId: string, ex: Executor = defaultDb): Promise<LaneConnection[]> {
    return rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM ${sql.identifier(this.t.connections)} WHERE tenant_id = ${tenantId} ORDER BY created_at, id`)).map((r) => this.#toConn(r));
  }

  async #connById(id: string, ex: Executor): Promise<{ conn: LaneConnection; row: Record<string, unknown> } | null> {
    const [row] = rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM ${sql.identifier(this.t.connections)} WHERE id = ${id}`));
    return row ? { conn: this.#toConn(row), row } : null;
  }

  // -------------------------------------------------------------- connect / disconnect

  async connect(input: { tenantId: string; body: unknown }, deps: LaneDeps = {}): Promise<ConnectResult> {
    const ex = deps.executor ?? defaultDb;
    const env = deps.env ?? process.env;
    const bad = (message: string, code = "invalid_input", status = 400): ConnectResult => ({ status, body: { error: { code, message } } });
    const body = rec(input.body);
    const unknown = Object.keys(body).filter((k) => !["apiKey", "accountId", "apiBase", "selectedChatIds", "connectionId", "list"].includes(k));
    if (unknown.length) return bad(`Unknown field(s): ${unknown.join(", ")}`);
    if (body.list === true) return { status: 200, body: { connections: await this.listConnections(input.tenantId, ex) } };
    const selected = body.selectedChatIds === undefined ? undefined
      : Array.isArray(body.selectedChatIds) && body.selectedChatIds.every((x) => typeof x === "string" && x.trim() && x.length <= 300) && body.selectedChatIds.length <= 5000
        ? [...new Set((body.selectedChatIds as string[]).map((x) => x.trim()))] : null;
    if (selected === null) return bad("selectedChatIds must be a list of chat ids");
    if (typeof body.connectionId === "string") {
      if (!CONNECTION_ID.test(body.connectionId) || selected === undefined || !selected.length) return bad("connectionId + non-empty selectedChatIds required");
      const r = rowsOf(await ex.execute(sql`
        UPDATE ${sql.identifier(this.t.connections)} SET sync_mode = 'selected_conversations', selected_chat_ids = ${JSON.stringify(selected)}::jsonb, updated_at = now()
        WHERE id = ${body.connectionId} AND tenant_id = ${input.tenantId} AND status = 'active' RETURNING id
      `));
      return r.length ? { status: 200, body: { connectionId: body.connectionId, selectedChatIds: selected } } : bad("No active connection with that id", "not_found", 404);
    }
    if (!personalConnectorsEnabled(env)) {
      return bad(`The ${this.cfg.label} personal connector is disabled. It automates a personal account through Unipile's unofficial client (Terms of Service risk); an operator must opt in with UNIPILE_PERSONAL_CONNECTORS_ENABLED=1.`, "experimental_connector_disabled", 403);
    }
    if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8 || body.apiKey.length > 500) return bad("apiKey (Unipile API key) is required");
    if (typeof body.accountId !== "string" || !/^[A-Za-z0-9_-]{4,200}$/.test(body.accountId)) return bad("accountId (the Unipile account id of the linked account) is required");
    let apiBase: string;
    try {
      apiBase = normalizeUnipileApiBase(typeof body.apiBase === "string" ? body.apiBase : DEFAULT_UNIPILE_API_BASE);
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err));
    }
    const client = new UnipileClient(body.apiKey.trim(), apiBase, deps.fetchImpl);
    let profile: Record<string, unknown>;
    try {
      profile = await client.account(body.accountId);
    } catch (err) {
      if (err instanceof UnipileApiError && err.authFailed) return bad("Unipile rejected the API key for this account", "unipile_auth_failed");
      if (err instanceof UnipileApiError && err.status === 404) return bad("Unipile account not found", "account_not_found", 404);
      return bad(`Could not verify the account: ${err instanceof Error ? err.message : String(err)}`, "unipile_unreachable", 502);
    }
    const type = str(profile.type) ?? str(profile.provider);
    if (type && type.toUpperCase() !== this.cfg.accountType) return bad(`Unipile account is ${type}, not ${this.cfg.accountType}`, "account_type_mismatch", 409);
    // SOURCE-LANE PATCH (personal-connection-attribution): one Unipile workspace key can reach every account linked
    // in it, so holding the key does not prove whose account this is. An account another member of this
    // organization already connected (their owner scope) cannot be attached by someone else.
    const scope = await personalScopeOf(ex, input.tenantId);
    if (scope) {
      const taken = rowsOf(await ex.execute(sql`
        SELECT 1 FROM ${sql.identifier(this.t.connections)}
        WHERE account_id = ${body.accountId} AND tenant_id <> ${input.tenantId} AND tenant_id LIKE ${`${scope.parentTenantId}.%`}
        LIMIT 1
      `));
      if (taken.length) return bad("This account is connected by another member of your organization", "account_connected_by_another_member", 409);
    }
    const id = `up_${randomBytes(12).toString("hex")}`;
    const webhookSecret = randomBytes(32).toString("base64url");
    await ex.execute(sql`
      INSERT INTO ${sql.identifier(this.t.connections)} (id, tenant_id, account_id, account_user_id, display_name, api_base, api_key_ciphertext,
        webhook_secret_sha256, sync_mode, selected_chat_ids, source_status, initial_sync_status)
      VALUES (${id}, ${input.tenantId}, ${body.accountId}, ${accountUserIdOf(profile) ?? null}, ${accountDisplayName(profile) ?? null}, ${apiBase},
        ${this.#seal(id, input.tenantId, body.apiKey.trim())}, ${sha256(webhookSecret)},
        ${selected?.length ? "selected_conversations" : "all_accessible"}, ${JSON.stringify(selected ?? [])}::jsonb,
        ${sourceStatusFromAccount(profile)}, ${accountInitialSyncStatus(profile)})
    `);
    await upsertConnection({ tenantId: input.tenantId, provider: this.cfg.provider, externalAccountId: body.accountId, status: "active", metadata: { connectionId: id, ingestionMode: "unipile_personal_read_only", sendsEnabled: false } }, ex);
    const kind = `${this.cfg.provider}.sync`;
    await upsertTaskSchedule({ tenantId: input.tenantId, kind, frequencySeconds: UNIPILE_SYNC_FREQUENCY_SECONDS, queue: "sync", groupKey: `${input.tenantId}:${this.cfg.provider}` }, ex);
    await enqueueTask({ queue: "backfill", tenantId: input.tenantId, kind, groupKey: `${input.tenantId}:${this.cfg.provider}`, dedupeKey: `${input.tenantId}:${kind}:${id}`, payload: {} }, ex);
    const base = (env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL)?.trim().replace(/\/+$/, "");
    return {
      status: 201,
      body: {
        connection: (await this.listConnections(input.tenantId, ex)).find((c) => c.id === id),
        webhook: base ? { url: `${base}/webhooks/${this.cfg.sourceDir}/${id}`, header: "x-unipile-secret", secret: webhookSecret, events: ["message_received", "message_edited", "message_deleted", "message_reaction", "account_status"] } : null,
        note: `Shown once: configure the Unipile webhook with this URL and header. ${this.cfg.historyLimit}`,
      },
    };
  }

  async disconnect(input: { tenantId: string }, deps: LaneDeps = {}): Promise<void> {
    await (deps.executor ?? defaultDb).execute(sql`
      UPDATE ${sql.identifier(this.t.connections)} SET status = 'revoked', status_reason = 'disconnected', api_key_ciphertext = '',
        webhook_secret_sha256 = ${sha256(randomBytes(32))}, revoked_at = now(), updated_at = now()
      WHERE tenant_id = ${input.tenantId} AND status <> 'revoked'
    `);
  }

  // -------------------------------------------------------------- storage

  #shouldSync(c: LaneConnection, chatId: string) {
    return c.syncMode !== "selected_conversations" || c.selectedChatIds.includes(chatId);
  }

  /** Raw (donor identity, then `:v:<sha>` versions on change) + current state. Returns whether anything new was stored. */
  async storeMessage(c: LaneConnection, chat: UnipileChat, message: UnipileMessage, delivery: "poll" | "backfill" | "webhook", event: string, ex: Executor): Promise<boolean> {
    const chatId = str(message.chat_id) ?? chat.id;
    const senderId = this.cfg.senderId(message);
    const ts = messageTimestamp(message) ?? new Date();
    const raw = redactProviderPayload(this.cfg.provider, {
      ...message,
      text: messageText(message),
      _provider: this.cfg.accountType.toLowerCase(),
      _source_delivery: delivery,
      _account_id: c.accountId,
      _account_user_id: c.accountUserId,
      _conversation: chatId,
      _conversation_name: conversationName(chat),
      _conversation_type: conversationType(chat),
      _sender_name: actorLabel(message.sender) ?? null,
      _sender_provider_id: senderId ?? null,
      _is_from_me: Boolean(senderId && c.accountUserId && senderId === c.accountUserId),
      [`_${this.cfg.accountType.toLowerCase()}_event`]: event,
    }) as Record<string, unknown>;
    const isReceive = event === "message_received";
    const baseId = `${this.cfg.provider}:${chatId}:${message.id}`;
    const eventType = this.cfg.eventType(message, c.accountUserId, c.accountId, event);
    const current = redactProviderPayload(this.cfg.provider, message) as Record<string, unknown>;
    const sha = sha256(JSON.stringify(current));
    const insertRaw = async (sourceEventId: string, kind: "activity" | "tombstone") => rowsOf(await ex.execute(sql`
      INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload,
        source_event_id, processing_status, source_namespace, source_object_id, record_kind)
      VALUES (${c.tenantId}, ${this.cfg.provider}, ${eventType}, ${ts.toISOString()}::timestamptz, ${ts.toISOString()}::timestamptz, ${ts.toISOString()}::timestamptz,
        ${JSON.stringify(raw)}::jsonb, ${sourceEventId}, 'received', ${`account:${c.accountId}`}, ${`chat:${chatId}:message:${message.id}`}, ${kind})
      ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
    `)).length > 0;
    if (!isReceive && !this.cfg.eventSuffix) return false;
    if (!isReceive) {
      // Donor WhatsApp: one raw row per (message, event).
      const stored = await insertRaw(`${baseId}:${event}`, event === "message_deleted" ? "tombstone" : "activity");
      if (event === "message_deleted") await this.#tombstone(c, chatId, message.id, "message_deleted", ex);
      else if (event === "message_edited" && (messageText(message) !== null)) await this.#current(c, chatId, message, current, sha, ts, ex);
      return stored;
    }
    const [prior] = rowsOf<{ payload_sha256: string }>(await ex.execute(sql`SELECT payload_sha256 FROM ${sql.identifier(this.t.messages)} WHERE id = ${`${c.id}:${chatId}:${message.id}`}`));
    let stored = await insertRaw(baseId, "activity");
    if (!stored && prior && prior.payload_sha256 !== sha) stored = await insertRaw(`${baseId}:v:${sha.slice(0, 16)}`, "activity");
    if (!prior || prior.payload_sha256 !== sha) {
      await this.#current(c, chatId, message, current, sha, ts, ex);
      stored = true;
      await this.#attachments(c, chatId, message, ex);
    }
    return stored;
  }

  async #current(c: LaneConnection, chatId: string, message: UnipileMessage, payload: Record<string, unknown>, sha: string, ts: Date, ex: Executor) {
    await ex.execute(sql`
      INSERT INTO ${sql.identifier(this.t.messages)} (id, tenant_id, connection_id, account_id, chat_id, message_id, message_ts, payload, payload_sha256, observed_at)
      VALUES (${`${c.id}:${chatId}:${message.id}`}, ${c.tenantId}, ${c.id}, ${c.accountId}, ${chatId}, ${message.id}, ${ts.toISOString()}::timestamptz,
        ${JSON.stringify(payload)}::jsonb, ${sha}, now())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, payload_sha256 = EXCLUDED.payload_sha256, observed_at = now(), deleted = false, deleted_reason = NULL, updated_at = now()
    `);
  }

  async #tombstone(c: LaneConnection, chatId: string, messageId: string, reason: string, ex: Executor) {
    await ex.execute(sql`
      UPDATE ${sql.identifier(this.t.messages)} SET deleted = true, deleted_reason = ${reason}, observed_at = now(), updated_at = now()
      WHERE id = ${`${c.id}:${chatId}:${messageId}`} AND NOT deleted
    `);
  }

  #attachmentsClient: UnipileClient | null = null;
  #env: NodeJS.ProcessEnv = process.env;

  async #attachments(c: LaneConnection, chatId: string, message: UnipileMessage, ex: Executor) {
    const client = this.#attachmentsClient;
    const list = Array.isArray(message.attachments) ? message.attachments : [];
    if (!client || !list.length) return;
    const enabled = !/^(0|false|off|no)$/i.test(this.#env.UNIPILE_ATTACHMENT_BYTES?.trim() ?? "");
    const max = intEnv(this.#env, "UNIPILE_ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024, 1);
    for (const att of list) {
      const attId = str(att.id) ?? str(att.attachment_id);
      if (!attId) continue;
      const id = `${c.id}:${chatId}:${message.id}:${attId}`;
      const existing = rowsOf(await ex.execute(sql`SELECT 1 FROM ${sql.identifier(this.t.attachments)} WHERE id = ${id} AND state = 'stored'`));
      if (existing.length) continue;
      let state: "stored" | "too_large" | "unavailable" | "error" = "unavailable";
      let reason: string | null = enabled ? null : "attachment bytes disabled (UNIPILE_ATTACHMENT_BYTES=0)";
      let got: { bytes: Buffer; contentType: string | null } | null = null;
      if (enabled) {
        try {
          got = await client.attachment(message.id, attId, max);
          if (got) state = "stored";
          else {
            state = "too_large";
            reason = `larger than ${max} bytes`;
          }
        } catch (err) {
          if (err instanceof UnipileApiError && err.rateLimited) throw err;
          state = err instanceof UnipileApiError && (err.status === 404 || err.status === 403) ? "unavailable" : "error";
          reason = err instanceof Error ? err.message : String(err);
        }
      }
      await ex.execute(sql`
        INSERT INTO ${sql.identifier(this.t.attachments)} (id, tenant_id, connection_id, account_id, chat_id, message_id, attachment_id, content_type, size, sha256, bytes, state, reason)
        VALUES (${id}, ${c.tenantId}, ${c.id}, ${c.accountId}, ${chatId}, ${message.id}, ${attId}, ${got?.contentType ?? str(att.mimetype) ?? str(att.type) ?? null},
          ${got ? got.bytes.length : null}, ${got ? sha256(got.bytes) : null}, ${got ? got.bytes : null}, ${state}, ${reason})
        ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, size = EXCLUDED.size, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
          state = EXCLUDED.state, reason = EXCLUDED.reason, observed_at = now()
      `);
    }
  }

  // -------------------------------------------------------------- sync

  async sync(tenantId: string, deps: LaneDeps = {}): Promise<Array<{ connectionId: string; status: string; stored: number; reason?: string }>> {
    const ex = deps.executor ?? defaultDb;
    const env = deps.env ?? process.env;
    this.#env = env;
    const out: Array<{ connectionId: string; status: string; stored: number; reason?: string }> = [];
    for (const listed of await this.listConnections(tenantId, ex)) {
      if (listed.status !== "active") continue;
      if (!personalConnectorsEnabled(env)) {
        out.push({ connectionId: listed.id, status: "disabled", stored: 0, reason: "operator opt-in removed" });
        continue;
      }
      const owner = randomBytes(8).toString("hex");
      const [leased] = rowsOf<Record<string, unknown>>(await ex.execute(sql`
        UPDATE ${sql.identifier(this.t.connections)} SET lease_owner = ${owner}, lease_until = now() + interval '10 minutes'
        WHERE id = ${listed.id} AND status = 'active' AND (lease_until IS NULL OR lease_until < now()) AND (retry_at IS NULL OR retry_at <= now())
        RETURNING *
      `));
      if (!leased) {
        out.push({ connectionId: listed.id, status: "skipped", stored: 0, reason: "leased or retry pending" });
        continue;
      }
      const c = this.#toConn(leased);
      const release = (u: { status?: string; reason?: string | null; retryAt?: Date | null; attempts?: number; lastError?: string | null; polled?: boolean; sourceStatus?: string; initialSync?: string | null }) => ex.execute(sql`
        UPDATE ${sql.identifier(this.t.connections)} SET lease_owner = NULL, lease_until = NULL,
          status = COALESCE(${u.status ?? null}, status), status_reason = ${u.reason ?? null},
          retry_at = ${u.retryAt ? u.retryAt.toISOString() : null}::timestamptz, attempts = ${u.attempts ?? 0}, last_error = ${u.lastError ?? null},
          last_poll_at = CASE WHEN ${u.polled === true} THEN now() ELSE last_poll_at END,
          source_status = COALESCE(${u.sourceStatus ?? null}, source_status),
          initial_sync_status = CASE WHEN ${u.initialSync !== undefined} THEN ${u.initialSync ?? null} ELSE initial_sync_status END,
          updated_at = now()
        WHERE id = ${c.id} AND lease_owner = ${owner}
      `);
      let stored = 0;
      try {
        const client = new UnipileClient(this.#unseal(c.id, c.tenantId, String(leased.api_key_ciphertext)), c.apiBase, deps.fetchImpl);
        this.#attachmentsClient = client;
        const profile = await client.account(c.accountId);
        const sourceStatus = sourceStatusFromAccount(profile);
        const initialSync = accountInitialSyncStatus(profile);
        const waiting = readinessReason(sourceStatus, initialSync);
        if (waiting && waiting !== "initial_sync_failed") {
          // Donor readiness gate: reading while CONNECTING / initial sync stores nothing and webhooks are forward-only.
          await release({ retryAt: new Date(Date.now() + 60_000), sourceStatus, initialSync, lastError: `not ready: ${waiting}`, attempts: c.attempts });
          out.push({ connectionId: c.id, status: "not_ready", stored: 0, reason: waiting });
          continue;
        }
        let pages = 0;
        const budget = intEnv(env, "UNIPILE_PAGES_PER_RUN", 20, 1);
        const maxChats = intEnv(env, "UNIPILE_MAX_CHATS", 250, 1);
        let chatCursor: string | undefined;
        let chatsSeen = 0;
        do {
          const page = await client.chats(c.accountId, this.cfg.accountType, chatCursor);
          pages++;
          for (const chat of pageItems(page)) {
            if (!this.#shouldSync(c, chat.id) || chatsSeen >= maxChats) continue;
            chatsSeen++;
            await ex.execute(sql`
              INSERT INTO ${sql.identifier(this.t.chats)} (connection_id, chat_id, tenant_id, name, conversation_type)
              VALUES (${c.id}, ${chat.id}, ${c.tenantId}, ${conversationName(chat)}, ${conversationType(chat)})
              ON CONFLICT (connection_id, chat_id) DO UPDATE SET name = EXCLUDED.name, conversation_type = EXCLUDED.conversation_type, updated_at = now()
            `);
            const [state] = rowsOf<{ backfill_cursor: string | null; backfill_complete_at: unknown; newest_message_id: string | null; newest_message_at: unknown }>(await ex.execute(sql`
              SELECT backfill_cursor, backfill_complete_at, newest_message_id, newest_message_at FROM ${sql.identifier(this.t.chats)} WHERE connection_id = ${c.id} AND chat_id = ${chat.id}
            `));
            // Forward watermark = the message with the latest timestamp ever stored (donor `lastSeenTs` / `after`).
            let newest = state?.newest_message_id ?? null;
            let newestAt: number | null = state?.newest_message_at ? Date.parse(String(iso(state.newest_message_at))) : null;
            const take = async (msgs: UnipileMessage[], delivery: "poll" | "backfill") => {
              for (const m of [...msgs].sort((a, b) => (messageTimestamp(a)?.getTime() ?? 0) - (messageTimestamp(b)?.getTime() ?? 0))) {
                if (await this.storeMessage(c, chat, m, delivery, "message_received", ex)) stored++;
                const t = messageTimestamp(m)?.getTime() ?? 0;
                if (newestAt === null || t > newestAt || (t === newestAt && newest === null)) {
                  newestAt = t;
                  newest = m.id;
                }
              }
            };
            // Forward from the newest stored message (donor `after`).
            if (state?.newest_message_id) {
              let cursor: string | undefined;
              do {
                const p = await client.messages(chat.id, { after: state.newest_message_id, ...(cursor ? { cursor } : {}) });
                pages++;
                await take(pageItems(p), "poll");
                cursor = nextCursor(p);
              } while (cursor && pages < budget);
            }
            // Backfill: cursor pages from the newest page back, resumable.
            if (!state?.backfill_complete_at) {
              let cursor = state?.backfill_cursor ?? undefined;
              let complete = false;
              let backfillPages = 0;
              // At least one backfill page per run, so forward polling can never starve the history read.
              while (pages < budget || backfillPages === 0) {
                const p = await client.messages(chat.id, cursor ? { cursor } : {});
                pages++;
                backfillPages++;
                await take(pageItems(p), "backfill");
                cursor = nextCursor(p);
                await ex.execute(sql`UPDATE ${sql.identifier(this.t.chats)} SET backfill_cursor = ${cursor ?? null}, updated_at = now() WHERE connection_id = ${c.id} AND chat_id = ${chat.id}`);
                if (!cursor) {
                  complete = true;
                  break;
                }
              }
              if (complete) await ex.execute(sql`UPDATE ${sql.identifier(this.t.chats)} SET backfill_complete_at = now() WHERE connection_id = ${c.id} AND chat_id = ${chat.id}`);
            }
            if (newest) {
              await ex.execute(sql`
                UPDATE ${sql.identifier(this.t.chats)} SET newest_message_id = ${newest},
                  newest_message_at = ${newestAt !== null ? new Date(newestAt).toISOString() : null}::timestamptz, last_error = NULL, updated_at = now()
                WHERE connection_id = ${c.id} AND chat_id = ${chat.id}
              `);
            }
            if (pages >= budget) break;
          }
          chatCursor = nextCursor(page);
        } while (chatCursor && pages < budget && chatsSeen < maxChats);
        await release({ polled: true, sourceStatus, initialSync, attempts: 0 });
        out.push({ connectionId: c.id, status: "ok", stored });
      } catch (err) {
        if (err instanceof UnipileApiError && err.rateLimited) {
          await release({ retryAt: new Date(Date.now() + (err.retryAfterSeconds ?? 30) * 1000), attempts: c.attempts + 1, lastError: `rate_limited: retry after ${err.retryAfterSeconds}s` });
          out.push({ connectionId: c.id, status: "rate_limited", stored, reason: `retry after ${err.retryAfterSeconds}s` });
        } else if (err instanceof UnipileApiError && err.authFailed) {
          await release({ status: "error", reason: "unipile_auth_failed", lastError: err.message, attempts: c.attempts + 1 });
          out.push({ connectionId: c.id, status: "auth_failed", stored, reason: err.message });
        } else {
          const attempts = c.attempts + 1;
          await release({ retryAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000), attempts, lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
          out.push({ connectionId: c.id, status: "error", stored, reason: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        this.#attachmentsClient = null;
      }
    }
    return out;
  }

  // -------------------------------------------------------------- webhook

  webhook(deps: LaneDeps = {}): Hono {
    const app = new Hono();
    app.post("/:connectionId", async (c) => {
      const ex = deps.executor ?? defaultDb;
      const found = CONNECTION_ID.test(c.req.param("connectionId")) ? await this.#connById(c.req.param("connectionId"), ex) : null;
      if (!found) return c.json({ error: "Unknown connection" }, 404);
      const provided = c.req.header("x-unipile-secret") ?? "";
      const a = Buffer.from(sha256(provided), "hex");
      const b = Buffer.from(String(found.row.webhook_secret_sha256), "hex");
      if (!provided || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: "Invalid webhook secret" }, 401);
      if (found.conn.status !== "active") return c.json({ error: "Connection revoked" }, 410);
      const payload = rec(await c.req.json().catch(() => null));
      if (!Object.keys(payload).length) return c.json({ error: "Invalid JSON payload" }, 400);
      const status = rec(payload.AccountStatus ?? payload.accountStatus ?? payload.account_status);
      const accountId = str(payload.account_id) ?? str(payload.accountId) ?? (typeof payload.account === "string" ? str(payload.account) : str(rec(payload.account).id)) ?? str(status.account_id) ?? str(status.accountId);
      // Ownership: the delivery must name this connection's account (never a lookup by account id alone).
      if (accountId !== found.conn.accountId) return c.json({ error: "Webhook account does not match this connection" }, 401);
      const event = str(payload.event) ?? str(payload.type) ?? str(status.message) ?? "message_received";
      if (Object.keys(status).length || event.startsWith("account.")) {
        const msg = (str(status.message) ?? event).toLowerCase();
        const sourceStatus = ["ok", "sync_success", "reconnected"].includes(msg) ? "OK" : ["creation_success", "connecting"].includes(msg) ? "CONNECTING" : msg.toUpperCase();
        await ex.execute(sql`UPDATE ${sql.identifier(this.t.connections)} SET source_status = ${sourceStatus}, last_webhook_at = now(), updated_at = now() WHERE id = ${found.conn.id}`);
        return c.json({ received: true, stored: false, lifecycleUpdated: true });
      }
      const rawMessage = payload.message && typeof payload.message === "object" ? payload.message : {
        id: payload.message_id ?? payload.id, chat_id: payload.chat_id, text: payload.message, sender: payload.sender, sender_id: payload.sender_id,
        sender_attendee_provider_id: rec(payload.sender).attendee_provider_id, timestamp: payload.timestamp, attachments: payload.attachments,
      };
      const message = rawMessage as UnipileMessage;
      const chatId = str(payload.chat_id) ?? str(message.chat_id) ?? str(payload.conversation_id);
      if (!chatId || !str(message.id)) return c.json({ error: "Missing chat_id or message id" }, 400);
      if (!this.#shouldSync(found.conn, chatId)) return c.json({ received: true, stored: false, reason: "chat_not_selected" });
      const chat: UnipileChat = { id: chatId, name: str(payload.chat_name) ?? str(payload.conversation_name) ?? null, type: str(payload.chat_type), is_group: Boolean(payload.is_group) };
      const stored = await this.storeMessage(found.conn, chat, { ...message, chat_id: chatId }, "webhook", event, ex);
      await ex.execute(sql`UPDATE ${sql.identifier(this.t.connections)} SET last_webhook_at = now() WHERE id = ${found.conn.id}`);
      return c.json({ received: true, stored });
    });
    return app;
  }

  // -------------------------------------------------------------- export + coverage

  messagePath(accountId: string, chatId: string, ts: Date, messageId: string): string {
    const seg = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
    return `sources/${this.cfg.sourceDir}/${seg(accountId)}/${seg(chatId)}/${ts.toISOString().slice(0, 7)}/${seg(messageId)}.json`;
  }

  attachmentPath(accountId: string, chatId: string, messageId: string, attachmentId: string): string {
    const seg = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
    return `sources/${this.cfg.sourceDir}/${seg(accountId)}/${seg(chatId)}/attachments/${seg(messageId)}/${seg(attachmentId)}`;
  }

  exports(): ExtraTableExport[] {
    const lane = this;
    const del = (paths: readonly string[], j: JournalInfo, reason: string): SourceFileChange[] => paths.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason, capturedAt: j.enqueuedAt }));
    return [
      {
        table: this.t.messages, tenantColumn: "tenant_id", keyColumn: "id",
        async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
          const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
            SELECT account_id, chat_id, message_id, message_ts, payload::text AS payload_text, observed_at, deleted, deleted_reason
            FROM ${sql.identifier(lane.t.messages)} WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
          `));
          if (!r) return del(prev, j, "message_row_deleted");
          const ts = new Date(String(iso(r.message_ts)));
          const path = lane.messagePath(String(r.account_id), String(r.chat_id), ts, String(r.message_id));
          const capturedAt = iso(r.observed_at)!;
          const provenance = { runtime: `${lane.cfg.sourceDir} source lane (Unipile)`, port: `askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/integrations/${lane.cfg.sourceDir}`, externalId: String(r.message_id), account: String(r.account_id), chat: String(r.chat_id) };
          if (r.deleted) return [{ op: "delete", path, deletedAt: capturedAt, reason: String(r.deleted_reason ?? "deleted"), capturedAt, provenance }];
          return [{ op: "put", path, kind: "raw", contentType: "application/json", content: Buffer.from(String(r.payload_text), "utf8"), sourceUpdatedAt: ts.toISOString(), capturedAt, provenance }];
        },
      },
      {
        table: this.t.attachments, tenantColumn: "tenant_id", keyColumn: "id",
        async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
          const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
            SELECT account_id, chat_id, message_id, attachment_id, content_type, bytes, sha256, state, observed_at
            FROM ${sql.identifier(lane.t.attachments)} WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
          `));
          if (!r || r.state !== "stored" || r.bytes == null) return del(prev, j, r ? `attachment_${String(r.state)}` : "attachment_row_deleted");
          return [{
            op: "put", path: lane.attachmentPath(String(r.account_id), String(r.chat_id), String(r.message_id), String(r.attachment_id)), kind: "binary",
            contentType: String(r.content_type ?? "application/octet-stream"), content: Buffer.from(r.bytes as Uint8Array), sourceUpdatedAt: null, capturedAt: iso(r.observed_at)!,
            provenance: { runtime: `${lane.cfg.sourceDir} source lane (Unipile)`, externalId: String(r.attachment_id), sha256: String(r.sha256) },
          }];
        },
      },
    ];
  }

  async coverage(ctx: ExportContext, now = new Date()): Promise<CoverageReport[]> {
    const p = this.cfg.sourceDir;
    const conns = await this.listConnections(ctx.tenantId, ctx.executor as never);
    if (!conns.length) return [{ provider: p, scope: "connections", state: "pending", reason: `no ${this.cfg.label} connection` }];
    const out: CoverageReport[] = [];
    const policy = "experimental: Unipile automates the personal account through an unofficial client (Terms of Service risk); read-only, operator opt-in";
    for (const c of conns) {
      const scope = `account:${c.accountId}`;
      if (c.status !== "active") {
        out.push({ provider: p, scope, state: "blocked", reason: `connection ${c.status}${c.statusReason ? `: ${c.statusReason}` : ""}` });
        continue;
      }
      if (!personalConnectorsEnabled()) {
        out.push({ provider: p, scope, state: "blocked", reason: "operator opt-in UNIPILE_PERSONAL_CONNECTORS_ENABLED is off; nothing is collected" });
        continue;
      }
      const waiting = readinessReason(c.sourceStatus, c.initialSyncStatus);
      out.push({ provider: p, scope: `${scope}:history`, state: "partial", reason: `${this.cfg.historyLimit}; ${policy}` });
      const fresh = c.lastPollAt != null && now.getTime() - Date.parse(c.lastPollAt) <= 3 * UNIPILE_SYNC_FREQUENCY_SECONDS * 1000;
      out.push({
        provider: p, scope: `${scope}:forward`,
        state: waiting && waiting !== "initial_sync_failed" ? "pending" : fresh && !c.lastError ? "complete" : "partial",
        reason: waiting ? `account ${c.sourceStatus} (${waiting})` : fresh && !c.lastError ? `new messages polled ${c.lastPollAt}${c.lastWebhookAt ? `; last webhook ${c.lastWebhookAt}` : "; no webhook delivery yet (polling only)"}` : c.lastError ?? "poll not current",
        ...(c.lastPollAt ? { lastSuccessAt: c.lastPollAt } : {}),
        ...(c.lastError ? { lastError: c.lastError } : {}),
      });
      const [att] = rowsOf<{ stored: number; other: number }>(await ctx.executor.execute(sql`
        SELECT count(*) FILTER (WHERE state = 'stored')::int AS stored, count(*) FILTER (WHERE state <> 'stored')::int AS other
        FROM ${sql.identifier(this.t.attachments)} WHERE connection_id = ${c.id}
      `));
      out.push({
        provider: p, scope: `${scope}:attachments`, state: (att?.other ?? 0) > 0 ? "partial" : "complete",
        reason: (att?.other ?? 0) > 0 ? `${att!.other} attachment(s) metadata-only (too large, unavailable or failed)` : "every listed attachment stored as exact bytes",
        counts: { stored: att?.stored ?? 0, metadataOnly: att?.other ?? 0 },
      });
    }
    return out;
  }

  integration(): AqueductIntegration {
    return {
      id: this.cfg.provider,
      connect: (input) => this.connect(input),
      disconnect: (input) => this.disconnect(input),
      registerHttp: (app) => {
        app.route(`/webhooks/${this.cfg.sourceDir}`, this.webhook());
      },
      taskKinds: () => [`${this.cfg.provider}.sync`],
      taskHandlers: () => ({
        [`${this.cfg.provider}.sync`]: async (_payload, ctx) => {
          // The tenant is the queued task's own tenant, never a payload field.
          const r = await this.sync(ctx.task.tenantId);
          return { connections: r.map((x) => `${x.connectionId}:${x.status}`) };
        },
      }),
    };
  }

  module(): SourceProviderModule {
    return {
      id: this.cfg.sourceDir,
      eventSources: [this.cfg.provider],
      mirrorRoots: [],
      connectionProviders: [this.cfg.provider],
      extraTables: this.exports(),
      coverage: (ctx) => this.coverage(ctx),
    };
  }
}
