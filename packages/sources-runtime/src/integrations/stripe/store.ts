/**
 * Durable state of the Stripe source lane (migration 9900): connections with encrypted credentials,
 * leased cursors, raw events in `activity_events`, and current object snapshots.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db/client.js";
import { decrypt, encrypt } from "../../vault/encryption.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { StripeEvent } from "./api.js";

export type Executor = Pick<typeof defaultDb, "execute">;

export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(r) ? r : [];
}

// ---------------------------------------------------------------- redaction

/**
 * Stripe capability values that must never reach stored files: client secrets (confirm a PaymentIntent /
 * SetupIntent / Checkout session from a browser), webhook endpoint secrets, and URLs that grant access to
 * an invoice or receipt without login. Everything else is kept exactly; global credential-URL rules apply too.
 */
const SECRET_KEYS = new Set(["client_secret", "secret"]);
const CAPABILITY_URL_KEYS = new Set(["hosted_invoice_url", "invoice_pdf", "receipt_url"]);
export const STRIPE_REDACTED = "[redacted: Stripe capability secret]";

export function redactStripePayload<T>(value: T): T {
  const walk = (v: unknown, parentObject: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, parentObject));
    if (!v || typeof v !== "object") return v;
    const obj = v as Record<string, unknown>;
    const objectType = typeof obj.object === "string" ? obj.object : parentObject;
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, x] of Object.entries(obj)) {
      if ((SECRET_KEYS.has(k) || CAPABILITY_URL_KEYS.has(k)) && typeof x === "string") out[k] = STRIPE_REDACTED;
      else if (k === "url" && objectType === "checkout.session" && typeof x === "string") out[k] = STRIPE_REDACTED;
      else out[k] = walk(x, objectType);
    }
    return out;
  };
  return redactProviderPayload("stripe", walk(value, null)) as T;
}

// ---------------------------------------------------------------- connections

export interface StripeConnection {
  id: string;
  tenantId: string;
  accountId: string;
  accountVerified: boolean;
  livemode: boolean;
  label: string | null;
  keyKind: "restricted" | "secret";
  status: "active" | "revoked" | "error";
  statusReason: string | null;
  hasWebhookSecret: boolean;
  lastWebhookAt: string | null;
  createdAt: string;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toConnection(r: Record<string, unknown>): StripeConnection {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    accountId: String(r.account_id),
    accountVerified: r.account_verified === true,
    livemode: r.livemode === true,
    label: (r.label as string | null) ?? null,
    keyKind: r.key_kind as "restricted" | "secret",
    status: r.status as StripeConnection["status"],
    statusReason: (r.status_reason as string | null) ?? null,
    hasWebhookSecret: r.webhook_secret_ciphertext != null,
    lastWebhookAt: iso(r.last_webhook_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  };
}

/** Secrets are bound to their connection and tenant inside the ciphertext, so a swapped column cannot decrypt. */
function seal(connectionId: string, tenantId: string, field: string, value: string): string {
  return encrypt(JSON.stringify({ c: connectionId, t: tenantId, f: field, v: value }));
}

function unseal(connectionId: string, tenantId: string, field: string, ciphertext: string): string {
  const parsed = JSON.parse(decrypt(ciphertext)) as { c?: string; t?: string; f?: string; v?: string };
  if (parsed.c !== connectionId || parsed.t !== tenantId || parsed.f !== field || typeof parsed.v !== "string") {
    throw new Error("Stripe credential does not belong to this connection");
  }
  return parsed.v;
}

export function newConnectionId(): string {
  return `sc_${randomBytes(12).toString("hex")}`;
}

export async function insertConnection(
  input: { id: string; tenantId: string; accountId: string; accountVerified: boolean; livemode: boolean; label: string | null; apiKey: string; keyKind: "restricted" | "secret"; webhookSecret: string | null },
  executor: Executor = defaultDb,
): Promise<StripeConnection> {
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`
    INSERT INTO stripe_connections (id, tenant_id, account_id, account_verified, livemode, label, api_key_ciphertext, key_kind, webhook_secret_ciphertext)
    VALUES (${input.id}, ${input.tenantId}, ${input.accountId}, ${input.accountVerified}, ${input.livemode}, ${input.label},
      ${seal(input.id, input.tenantId, "api_key", input.apiKey)}, ${input.keyKind},
      ${input.webhookSecret ? seal(input.id, input.tenantId, "webhook_secret", input.webhookSecret) : null})
    RETURNING *
  `));
  return toConnection(row!);
}

export async function listConnections(tenantId: string, executor: Executor = defaultDb): Promise<StripeConnection[]> {
  return rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT * FROM stripe_connections WHERE tenant_id = ${tenantId} ORDER BY created_at, id
  `)).map(toConnection);
}

export async function getConnection(id: string, executor: Executor = defaultDb): Promise<(StripeConnection & { apiKey: () => string; webhookSecrets: () => string[] }) | null> {
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`SELECT * FROM stripe_connections WHERE id = ${id}`));
  if (!row) return null;
  const c = toConnection(row);
  return {
    ...c,
    apiKey: () => unseal(c.id, c.tenantId, "api_key", String(row.api_key_ciphertext)),
    webhookSecrets: () => [row.webhook_secret_ciphertext, row.webhook_secret_previous_ciphertext]
      .filter((x): x is string => typeof x === "string")
      .map((x) => unseal(c.id, c.tenantId, "webhook_secret", x)),
  };
}

/** Set the endpoint signing secret; the previous one keeps verifying until the next rotation (Stripe secret rolling). */
export async function setWebhookSecret(tenantId: string, id: string, secret: string, executor: Executor = defaultDb): Promise<boolean> {
  const r = rows(await executor.execute(sql`
    UPDATE stripe_connections
    SET webhook_secret_previous_ciphertext = webhook_secret_ciphertext,
        webhook_secret_ciphertext = ${seal(id, tenantId, "webhook_secret", secret)},
        updated_at = now()
    WHERE id = ${id} AND tenant_id = ${tenantId} AND status = 'active'
    RETURNING id
  `));
  return r.length > 0;
}

/** Revoke every connection of the tenant: credentials are erased, cursors stop, snapshots stay as history. */
export async function revokeConnections(tenantId: string, executor: Executor = defaultDb): Promise<number> {
  return rows(await executor.execute(sql`
    UPDATE stripe_connections
    SET status = 'revoked', status_reason = 'disconnected', revoked_at = now(), updated_at = now(),
        api_key_ciphertext = '', webhook_secret_ciphertext = NULL, webhook_secret_previous_ciphertext = NULL
    WHERE tenant_id = ${tenantId} AND status <> 'revoked'
    RETURNING id
  `)).length;
}

export async function setConnectionError(id: string, reason: string, executor: Executor = defaultDb): Promise<void> {
  await executor.execute(sql`
    UPDATE stripe_connections SET status = 'error', status_reason = ${reason.slice(0, 500)}, updated_at = now()
    WHERE id = ${id} AND status = 'active'
  `);
}

export async function touchWebhook(id: string, executor: Executor = defaultDb): Promise<void> {
  await executor.execute(sql`UPDATE stripe_connections SET last_webhook_at = now() WHERE id = ${id}`);
}

// ---------------------------------------------------------------- cursors

export type CursorStatus = "pending" | "running" | "complete" | "error" | "blocked";

export interface StripeCursor {
  connectionId: string;
  lane: string;
  tenantId: string;
  status: CursorStatus;
  state: Record<string, unknown>;
  lastSuccessAt: string | null;
  completedAt: string | null;
  retryAt: string | null;
  attempts: number;
  lastError: string | null;
}

function toCursor(r: Record<string, unknown>): StripeCursor {
  return {
    connectionId: String(r.connection_id),
    lane: String(r.lane),
    tenantId: String(r.tenant_id),
    status: r.status as CursorStatus,
    state: (typeof r.state === "string" ? JSON.parse(r.state) : r.state ?? {}) as Record<string, unknown>,
    lastSuccessAt: iso(r.last_success_at),
    completedAt: iso(r.completed_at),
    retryAt: iso(r.retry_at),
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error as string | null) ?? null,
  };
}

export async function listCursors(tenantId: string, executor: Executor = defaultDb): Promise<StripeCursor[]> {
  return rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT * FROM stripe_cursors WHERE tenant_id = ${tenantId} ORDER BY connection_id, lane
  `)).map(toCursor);
}

/**
 * Lease a cursor for one run (creating it on first use). Null when another run holds it or its retry time
 * has not come. The lease expires on its own, so a crashed worker never wedges the lane.
 */
export async function leaseCursor(
  tenantId: string,
  connectionId: string,
  lane: string,
  owner: string,
  opts: { leaseSeconds?: number; ignoreRetryAt?: boolean } = {},
  executor: Executor = defaultDb,
): Promise<StripeCursor | null> {
  await executor.execute(sql`
    INSERT INTO stripe_cursors (connection_id, lane, tenant_id) VALUES (${connectionId}, ${lane}, ${tenantId})
    ON CONFLICT (connection_id, lane) DO NOTHING
  `);
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`
    UPDATE stripe_cursors
    SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${opts.leaseSeconds ?? 300}), updated_at = now()
    WHERE connection_id = ${connectionId} AND lane = ${lane} AND tenant_id = ${tenantId}
      AND (lease_until IS NULL OR lease_until < now())
      ${opts.ignoreRetryAt ? sql`` : sql`AND (retry_at IS NULL OR retry_at <= now())`}
    RETURNING *
  `));
  return row ? toCursor(row) : null;
}

/** Persist progress; only the current lease holder can write. */
export async function saveCursor(
  c: { connectionId: string; lane: string },
  owner: string,
  update: { status: CursorStatus; state: Record<string, unknown>; success?: boolean; completed?: boolean; retryAt?: Date | null; attempts?: number; lastError?: string | null; release?: boolean },
  executor: Executor = defaultDb,
): Promise<boolean> {
  const r = rows(await executor.execute(sql`
    UPDATE stripe_cursors
    SET status = ${update.status}, state = ${JSON.stringify(update.state)}::jsonb,
        last_success_at = CASE WHEN ${update.success === true} THEN now() ELSE last_success_at END,
        completed_at = CASE WHEN ${update.completed === true} THEN now() ELSE completed_at END,
        retry_at = ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz,
        attempts = ${update.attempts ?? 0},
        last_error = ${update.lastError ?? null},
        lease_owner = CASE WHEN ${update.release === true} THEN NULL ELSE lease_owner END,
        lease_until = CASE WHEN ${update.release === true} THEN NULL ELSE lease_until END,
        updated_at = now()
    WHERE connection_id = ${c.connectionId} AND lane = ${c.lane} AND lease_owner = ${owner}
    RETURNING connection_id
  `));
  return r.length > 0;
}

// ---------------------------------------------------------------- raw events

/** Insert one event (post-redaction) keyed by the donor's `sourceEventId = event.id`. Returns false for a duplicate. */
export async function storeEvent(tenantId: string, accountId: string, event: StripeEvent, executor: Executor = defaultDb): Promise<boolean> {
  const at = new Date(event.created * 1000).toISOString();
  const obj = event.data?.object ?? {};
  const objectKey = typeof obj.object === "string" && typeof obj.id === "string" ? `${obj.object}:${obj.id}` : `event:${event.id}`;
  const payload = redactStripePayload(event);
  const r = rows(await executor.execute(sql`
    INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload,
      source_event_id, processing_status, source_namespace, source_object_id, record_kind)
    VALUES (${tenantId}, 'stripe', ${event.type}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz,
      ${JSON.stringify(payload)}::jsonb, ${event.id}, 'received', ${`account:${accountId}`}, ${objectKey}, 'activity')
    ON CONFLICT (user_id, source_event_id) DO NOTHING
    RETURNING id
  `));
  return r.length > 0;
}

// ---------------------------------------------------------------- object snapshots

export function snapshotId(connectionId: string, resource: string, objectId: string): string {
  return `${connectionId}:${resource}:${objectId}`;
}

export function payloadSha(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Upsert the current state of one object. A state ordered before the stored one (an older event delivered
 * late, or a listing that started before a newer webhook) never overwrites it; an identical payload only
 * marks the listing run.
 */
export async function upsertSnapshot(
  input: { tenantId: string; connectionId: string; accountId: string; livemode: boolean; resource: string; object: Record<string, unknown> & { id: string }; sourceOrder: number; runId?: string | null; deleted?: { reason: string } | null },
  executor: Executor = defaultDb,
): Promise<"created" | "updated" | "unchanged" | "stale"> {
  const payload = redactStripePayload(input.object);
  const sha = payloadSha(payload);
  const id = snapshotId(input.connectionId, input.resource, input.object.id);
  const deleted = Boolean(input.deleted);
  const [row] = rows<{ inserted: boolean; changed: boolean; stale: boolean }>(await executor.execute(sql`
    WITH prior AS (
      SELECT payload_sha256, source_order, deleted FROM stripe_object_snapshots WHERE id = ${id}
    ), up AS (
      INSERT INTO stripe_object_snapshots (id, tenant_id, connection_id, account_id, livemode, resource, object_id, payload, payload_sha256,
        source_order, observed_at, deleted, deleted_reason, last_seen_run)
      VALUES (${id}, ${input.tenantId}, ${input.connectionId}, ${input.accountId}, ${input.livemode}, ${input.resource}, ${input.object.id},
        ${JSON.stringify(payload)}::jsonb, ${sha}, ${input.sourceOrder}, now(), ${deleted}, ${input.deleted?.reason ?? null}, ${input.runId ?? null})
      ON CONFLICT (id) DO UPDATE SET
        payload = CASE WHEN EXCLUDED.source_order >= stripe_object_snapshots.source_order THEN EXCLUDED.payload ELSE stripe_object_snapshots.payload END,
        payload_sha256 = CASE WHEN EXCLUDED.source_order >= stripe_object_snapshots.source_order THEN EXCLUDED.payload_sha256 ELSE stripe_object_snapshots.payload_sha256 END,
        deleted = CASE WHEN EXCLUDED.source_order >= stripe_object_snapshots.source_order THEN EXCLUDED.deleted ELSE stripe_object_snapshots.deleted END,
        deleted_reason = CASE WHEN EXCLUDED.source_order >= stripe_object_snapshots.source_order THEN EXCLUDED.deleted_reason ELSE stripe_object_snapshots.deleted_reason END,
        observed_at = CASE WHEN EXCLUDED.source_order >= stripe_object_snapshots.source_order
                            AND (EXCLUDED.payload_sha256 <> stripe_object_snapshots.payload_sha256 OR EXCLUDED.deleted <> stripe_object_snapshots.deleted)
                           THEN now() ELSE stripe_object_snapshots.observed_at END,
        source_order = GREATEST(stripe_object_snapshots.source_order, EXCLUDED.source_order),
        last_seen_run = COALESCE(EXCLUDED.last_seen_run, stripe_object_snapshots.last_seen_run),
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    )
    SELECT up.inserted,
           (SELECT p.payload_sha256 IS DISTINCT FROM ${sha} OR p.deleted IS DISTINCT FROM ${deleted} FROM prior p) AS changed,
           (SELECT p.source_order > ${input.sourceOrder} FROM prior p) AS stale
    FROM up
  `));
  if (!row || row.inserted) return "created";
  if (row.stale) return "stale";
  return row.changed ? "updated" : "unchanged";
}

/** After a complete listing: objects of this resource the listing did not return are tombstoned. */
export async function tombstoneUnlisted(connectionId: string, resource: string, runId: string, listedAtSeconds: number, executor: Executor = defaultDb): Promise<number> {
  return rows(await executor.execute(sql`
    UPDATE stripe_object_snapshots
    SET deleted = true, deleted_reason = 'not_in_full_listing', observed_at = now(), updated_at = now(),
        source_order = GREATEST(source_order, ${listedAtSeconds})
    WHERE connection_id = ${connectionId} AND resource = ${resource} AND deleted = false
      AND last_seen_run IS DISTINCT FROM ${runId} AND source_order <= ${listedAtSeconds}
    RETURNING id
  `)).length;
}
