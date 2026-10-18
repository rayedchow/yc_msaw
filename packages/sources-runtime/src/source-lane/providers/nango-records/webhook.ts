import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { getConnection } from "./connections.js";
import { sourceByKey } from "./config.js";
import { rows, safeError, type NangoRecordsLane, type WebhookDelegateResult } from "./lane.js";
import { consumeSession, SESSION_TAG } from "./sessions.js";
import { enqueueReconcile, enqueueSync } from "./sync.js";
import { loadCapabilities, modelsToPoll, noteUnconfiguredModel } from "./verify.js";

/**
 * Webhooks from Nango (https://nango.dev/docs/guides/platform/webhooks-from-nango).
 *
 * Authentication: `X-Nango-Hmac-Sha256` = hex HMAC-SHA256 of the RAW body keyed with the
 * environment's webhook signing key (current key, or the previous one during the 5-minute
 * rotation window). The legacy `X-Nango-Signature` (plain SHA-256) never authorizes; the
 * environment API key is never used as the HMAC key.
 *
 * Nango signs no timestamp or nonce, so an exact re-delivery is recognized by body digest
 * within a replay window and acknowledged without effect. Beyond that window a replayed body
 * cannot do harm: connect sessions are use-once, auth status webhooks only trigger an
 * authenticated GET /connections check (their payload is not trusted as state), and sync
 * webhooks only enqueue an idempotent incremental read.
 *
 * Deliveries that are not for this lane (integrations it does not capture, auth webhooks
 * without its session tag) are handed to the donor Nango handler after verification.
 */

export const WEBHOOK_PATH = "/webhooks/nango-records";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const REPLAY_WINDOW_MS = 10 * 60_000;

export function verifyNangoHmac(rawBody: string, header: string | null | undefined, keys: readonly string[]): boolean {
  const sig = header?.trim().toLowerCase();
  if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const actual = Buffer.from(sig, "hex");
  let ok = false;
  for (const k of keys) {
    const expected = createHmac("sha256", k).update(rawBody, "utf8").digest();
    // Evaluate every key (no early exit on match) with constant-time comparison.
    if (timingSafeEqual(expected, actual)) ok = true;
  }
  return ok;
}

export type WebhookOutcome =
  | "replayed"
  | "connected"
  | "already_connected"
  | "session_refused"
  | "status_check_enqueued"
  | "sync_enqueued"
  | "sync_collapsed"
  | "sync_failed_recorded"
  | "model_not_enabled"
  | "unknown_connection"
  | "ignored"
  | "delegated";

export interface WebhookResult {
  status: number;
  body?: unknown;
  outcome?: WebhookOutcome;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null;
}

/** Tag keys are normalized to lowercase by Nango. */
function tag(payload: Record<string, unknown>, name: string): string | null {
  const tags = obj(payload.tags);
  if (!tags) return null;
  for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === name) return str(v);
  return null;
}

/**
 * Whether a verified delivery belongs to this lane: its integration is a configured generic
 * source, or it carries this lane's connect-session tag. The donor handler delegates exactly
 * these to the lane and the lane delegates everything else to the donor, so nothing loops.
 */
export function isLaneDelivery(lane: NangoRecordsLane, payload: Record<string, unknown>): boolean {
  const providerConfigKey = str(payload.providerConfigKey);
  return Boolean(providerConfigKey && sourceByKey(lane.catalog, providerConfigKey)) || Boolean(tag(payload, SESSION_TAG));
}

export async function handleLaneWebhook(lane: NangoRecordsLane, input: { rawBody: string; hmacHeader: string | null | undefined }): Promise<WebhookResult> {
  if (!lane.signingKeys.length) return { status: 503, body: { error: "Nango webhook signing key is not configured (NANGO_WEBHOOK_SIGNING_KEY)" } };
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: "payload too large" } };
  if (!verifyNangoHmac(input.rawBody, input.hmacHeader, lane.signingKeys)) return { status: 401, body: { error: "invalid X-Nango-Hmac-Sha256 signature" } };

  let payload: Record<string, unknown> | null = null;
  try {
    payload = obj(JSON.parse(input.rawBody));
  } catch {
    payload = null;
  }
  if (!payload) return { status: 400, body: { error: "invalid JSON payload" } };

  const digest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  const seen = rows(
    await lane.db.execute(sql`
      SELECT 1 FROM nango_records_webhook_deliveries
      WHERE body_sha256 = ${digest} AND received_at > now() - make_interval(secs => ${REPLAY_WINDOW_MS / 1000})
    `),
  );
  if (seen.length) return { status: 204, outcome: "replayed" };

  const type = str(payload.type)?.toLowerCase() ?? "";
  const providerConfigKey = str(payload.providerConfigKey);
  const connectionId = str(payload.connectionId);

  let result: WebhookResult;
  if (!isLaneDelivery(lane, payload)) {
    result = await delegate(lane, input);
  } else if (type === "auth") {
    result = await handleAuth(lane, payload, providerConfigKey, connectionId);
  } else if (type === "sync") {
    result = await handleSync(lane, payload, providerConfigKey, connectionId);
  } else {
    // forward / async action webhooks carry nothing the records lane reads.
    result = { status: 204, outcome: "ignored" };
  }
  if (result.status < 300) {
    await lane.db.execute(sql`
      INSERT INTO nango_records_webhook_deliveries (body_sha256, webhook_type, outcome) VALUES (${digest}, ${type.slice(0, 32)}, ${result.outcome ?? "ok"})
      ON CONFLICT (body_sha256) DO UPDATE SET received_at = now(), outcome = EXCLUDED.outcome
    `);
    await lane.db.execute(sql`DELETE FROM nango_records_webhook_deliveries WHERE received_at < now() - interval '1 day'`);
  }
  return result;
}

async function delegate(lane: NangoRecordsLane, input: { rawBody: string; hmacHeader: string | null | undefined }): Promise<WebhookResult> {
  if (!lane.delegateWebhook) return { status: 204, outcome: "ignored" };
  const r: WebhookDelegateResult = await lane.delegateWebhook(input.rawBody, input.hmacHeader ?? "");
  return { status: r.status, ...(r.body !== undefined ? { body: r.body } : {}), outcome: "delegated" };
}

async function handleAuth(lane: NangoRecordsLane, payload: Record<string, unknown>, providerConfigKey: string | null, connectionId: string | null): Promise<WebhookResult> {
  if (!providerConfigKey || !connectionId) return { status: 204, outcome: "ignored" };
  const operation = str(payload.operation)?.toLowerCase();
  const sessionTag = tag(payload, SESSION_TAG);
  if ((operation === "creation" || operation === "override") && payload.success === true && sessionTag) {
    const existing = await getConnection(lane, providerConfigKey, connectionId);
    if (existing && operation === "override") {
      // Re-authorization of a bound connection: confirm through the API, do not re-bind.
      await enqueueReconcile(lane, existing);
      return { status: 204, outcome: "status_check_enqueued" };
    }
    const r = await consumeSession(lane, {
      tag: sessionTag,
      providerConfigKey,
      connectionId,
      via: "webhook",
      nangoProvider: str(payload.provider),
      authMode: str(payload.authMode),
    });
    if (r.outcome === "refused") lane.log(`auth webhook for ${providerConfigKey}/${connectionId} refused: ${r.reason}`);
    return { status: 204, outcome: r.outcome === "refused" ? "session_refused" : r.outcome };
  }
  // refresh failure/recovery, deletion, failed creation: verify state through the API.
  const conn = await getConnection(lane, providerConfigKey, connectionId);
  if (!conn) return { status: 204, outcome: "unknown_connection" };
  await enqueueReconcile(lane, conn);
  return { status: 204, outcome: "status_check_enqueued" };
}

async function handleSync(lane: NangoRecordsLane, payload: Record<string, unknown>, providerConfigKey: string | null, connectionId: string | null): Promise<WebhookResult> {
  const model = str(payload.model);
  if (!providerConfigKey || !connectionId || !model) return { status: 204, outcome: "ignored" };
  const conn = await getConnection(lane, providerConfigKey, connectionId);
  // Tenant comes from the server-side binding only; unknown connections are not captured.
  if (!conn || conn.status !== "active") return { status: 204, outcome: "unknown_connection" };
  const source = sourceByKey(lane.catalog, providerConfigKey);
  if (!source || source.source !== conn.source) return { status: 204, outcome: "ignored" };
  if (!modelsToPoll(source, await loadCapabilities(lane, source)).some((m) => m.model === model)) {
    await noteUnconfiguredModel(lane, providerConfigKey, model, conn.tenantId);
    return { status: 204, outcome: "model_not_enabled" };
  }
  if (payload.success === false) {
    const err = obj(payload.error);
    const msg = safeError(`${str(err?.type) ?? "error"}: ${str(err?.description) ?? "sync failed"}`);
    await lane.db.execute(sql`
      INSERT INTO nango_records_checkpoints (tenant_id, provider_config_key, connection_id, model, last_sync_webhook_error, last_sync_webhook_error_at)
      VALUES (${conn.tenantId}, ${providerConfigKey}, ${connectionId}, ${model}, ${msg}, now())
      ON CONFLICT (tenant_id, provider_config_key, connection_id, model) DO UPDATE SET
        last_sync_webhook_error = EXCLUDED.last_sync_webhook_error, last_sync_webhook_error_at = now(), updated_at = now()
    `);
    return { status: 204, outcome: "sync_failed_recorded" };
  }
  await lane.db.execute(sql`
    UPDATE nango_records_checkpoints SET last_sync_webhook_error = NULL, last_sync_webhook_error_at = NULL
    WHERE tenant_id = ${conn.tenantId} AND provider_config_key = ${providerConfigKey} AND connection_id = ${connectionId} AND model = ${model}
  `);
  const id = await enqueueSync(lane, { tenantId: conn.tenantId, providerConfigKey, connectionId, model });
  return { status: 204, outcome: id ? "sync_enqueued" : "sync_collapsed" };
}

export function registerLaneWebhookRoute(app: Hono, lane: () => NangoRecordsLane): void {
  app.post(WEBHOOK_PATH, async (c) => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_WEBHOOK_BYTES) return c.json({ error: "payload too large" }, 413);
    const raw = await c.req.text();
    try {
      const r = await handleLaneWebhook(lane(), { rawBody: raw, hmacHeader: c.req.header("x-nango-hmac-sha256") });
      if (r.status === 204) return c.body(null, 204);
      return c.json((r.body ?? {}) as Record<string, unknown>, r.status as 400);
    } catch (error) {
      // Non-2xx makes Nango retry the delivery (2 retries); the polling floor reconciles regardless.
      lane().log(`webhook processing failed: ${safeError(error)}`);
      return c.json({ error: "webhook processing failed" }, 500);
    }
  });
}
