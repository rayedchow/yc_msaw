import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { enqueueTask } from "../../queue/queue.js";
import { disableNangoPollSchedule, nangoSyncDedupeKey } from "./tasks.js";
import { activateNangoConnection } from "./sync-enqueue.js";
import { handleJiraForwardWebhook } from "../../source-lane/providers/jira/webhook.js";
import type { NangoExecutor } from "./types.js";

export const nangoWebhookRoute = new Hono();

export type NangoWebhookResult =
  | { status: 204; body?: undefined }
  | { status: 400 | 401 | 503; body: Record<string, unknown> };

export interface NangoSyncRecordsTaskPayload extends Record<string, unknown> {
  tenantId: string;
  provider: string;
  providerConfigKey: string;
  connectionId: string;
  model: string;
  cursor?: string;
}

nangoWebhookRoute.post("/", async (c) => {
  const body = await c.req.text();
  const result = await handleNangoWebhook({
    body,
    signature: readNangoSignatureHeader((name) => c.req.header(name)),
  });

  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body, result.status);
});

export function registerNangoHttpRoutes(app: Hono): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);
  app.route("/webhooks/nango", nangoWebhookRoute);
}

const registeredApps = new WeakSet<Hono>();

/**
 * SOURCE-LANE PATCH (nango-expansion request 2): verified deliveries that belong to another
 * Nango lane (the generic records lane) are handed to it with the raw body and signature; it
 * re-verifies. Keyed by lane id so re-registration replaces instead of stacking.
 */
export interface NangoWebhookDelegate {
  claims(payload: Record<string, unknown>): boolean;
  handle(rawBody: string, signature: string): Promise<{ status: number; body?: unknown }>;
}

const webhookDelegates = new Map<string, NangoWebhookDelegate>();

export function registerNangoWebhookDelegate(id: string, delegate: NangoWebhookDelegate): void {
  webhookDelegates.set(id, delegate);
}

export async function handleNangoWebhook(input: {
  body: string;
  signature?: string | null;
}): Promise<NangoWebhookResult> {
  // SOURCE-LANE PATCH (nango-expansion request 2): the webhook SIGNING key only
  // (Environment Settings > Webhooks > Signing key); the environment API key is a different key.
  const secret = env.NANGO_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return { status: 503, body: { error: "Nango webhook signing key is not configured (NANGO_WEBHOOK_SECRET)" } };
  }
  if (!verifyNangoWebhookSignature(input.body, input.signature, secret)) {
    return { status: 401, body: { error: "Invalid Nango webhook signature" } };
  }

  const payload = parseJsonObject(input.body);
  if (!payload) return { status: 400, body: { error: "Invalid Nango webhook payload" } };

  for (const delegate of webhookDelegates.values()) {
    if (!delegate.claims(payload)) continue;
    const delegated = await delegate.handle(input.body, input.signature ?? "");
    if (delegated.status >= 200 && delegated.status < 300) return { status: 204 };
    return { status: delegated.status === 401 || delegated.status === 503 ? delegated.status : 400, body: { error: "Nango webhook delivery was refused by the records lane" } };
  }

  const type = stringValue(payload.type)?.toLowerCase();
  if (type === "forward") {
    // SOURCE-LANE PATCH (jira request 4): Jira provider webhooks relayed by Nango only queue a
    // refresh BY ID in the Jira deep lane (tenant from the connections table; the body is never
    // stored). The deep lane's relative-JQL delta still covers any webhook that never arrives.
    const jira = await handleJiraForwardWebhook(db, payload);
    if (!jira.handled) console.info("[nango] forward webhook ignored in v1");
    return { status: 204 };
  }

  if (type === "auth" || type === "connection") {
    await reconcileNangoConnectionWebhook(db, payload);
    return { status: 204 };
  }

  const sync = await nangoSyncCompletedPayload(db, payload);
  if (!sync) return { status: 204 };

  await enqueueTask({
    queue: "sync",
    tenantId: sync.tenantId,
    groupKey: `nango:${sync.tenantId}:${sync.provider}:${sync.connectionId}`,
    kind: "nango.sync_records",
    payload: sync,
    dedupeKey: nangoSyncDedupeKey(sync),
  }, db);

  return { status: 204 };
}

// SOURCE-LANE PATCH (nango-expansion request 2): Nango's documented signature is
// `X-Nango-Hmac-Sha256` (HMAC-SHA256 of the raw body with the webhook signing key). The legacy
// `X-Nango-Signature` header is plain SHA-256 and must not authorize a delivery
// (https://nango.dev/docs/guides/platform/webhooks-from-nango).
export function readNangoSignatureHeader(
  get: (name: string) => string | null | undefined,
): string | null | undefined {
  return get("x-nango-hmac-sha256");
}

export function verifyNangoWebhookSignature(
  body: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  const actualHex = normalizeSignature(signature);
  if (!actualHex) return false;
  // SOURCE-LANE PATCH (nango-expansion request 2): HMAC only; the legacy sha256(secret + body) never verifies.
  return timingSafeHexEqual(createHmac("sha256", secret).update(body).digest("hex"), actualHex);
}

export async function nangoSyncCompletedPayload(
  executor: NangoExecutor,
  payload: Record<string, unknown>,
): Promise<NangoSyncRecordsTaskPayload | null> {
  if (!isSyncCompletedWebhook(payload)) return null;

  const providerConfigKey =
    stringValue(payload.providerConfigKey)
    ?? stringValue(payload.provider_config_key)
    ?? stringValue(payload.provider_config);
  const connectionId =
    stringValue(payload.connectionId)
    ?? stringValue(payload.connection_id)
    ?? stringValue(objectValue(payload.connection)?.id);
  const model =
    stringValue(payload.model)
    ?? stringValue(payload.syncName)
    ?? stringValue(payload.sync_name)
    ?? stringValue(payload.sync);
  const provider =
    providerFromPayload(payload)
    ?? providerConfigKey;

  if (!providerConfigKey || !connectionId || !model || !provider) return null;
  const tenantId = await resolveTenantForNangoConnection(executor, { providerConfigKey, connectionId });
  if (!tenantId) {
    console.warn(`Nango sync webhook ignored: no tenant mapping for ${providerConfigKey}/${connectionId}`);
    return null;
  }

  const cursor =
    stringValue(payload.cursor)
    ?? stringValue(payload.nextCursor)
    ?? stringValue(payload.next_cursor);

  return {
    tenantId,
    provider,
    providerConfigKey,
    connectionId,
    model,
    ...(cursor ? { cursor } : {}),
  };
}

export async function reconcileNangoConnectionWebhook(
  executor: NangoExecutor,
  payload: Record<string, unknown>,
): Promise<void> {
  const providerConfigKey =
    stringValue(payload.providerConfigKey)
    ?? stringValue(payload.provider_config_key)
    ?? stringValue(payload.provider_config)
    ?? providerFromPayload(payload);
  const connectionId =
    stringValue(payload.connectionId)
    ?? stringValue(payload.connection_id)
    ?? stringValue(objectValue(payload.connection)?.id);
  const tenantId =
    stringValue(objectValue(payload.end_user)?.id)
    ?? stringValue(objectValue(payload.endUser)?.id)
    ?? stringValue(payload.end_user_id)
    ?? stringValue(payload.endUserId)
    ?? (providerConfigKey && connectionId
      ? await resolveTenantForNangoConnection(executor, { providerConfigKey, connectionId })
      : null);
  if (!tenantId || !providerConfigKey) {
    console.warn("[nango] auth webhook ignored: missing tenant or provider mapping");
    return;
  }

  const status = connectionWebhookStatus(payload);
  const metadata = {
    authMode: "nango",
    providerConfigKey,
    ...(connectionId ? { nangoConnectionId: connectionId } : {}),
    nangoStatus: stringValue(payload.status) ?? stringValue(payload.action) ?? null,
    lastAuthWebhookAt: new Date().toISOString(),
    error: status === "error" ? sanitizeWebhookMessage(payload.error ?? payload.reason ?? payload.message) : null,
  };

  const updatedRows = rowsFromExecute<{ id: string; old_status: string }>(await executor.execute(sql`
    WITH candidates AS (
      SELECT id, status AS old_status
      FROM connections
      WHERE tenant_id = ${tenantId}
        AND provider = ${providerConfigKey}
        AND (
          external_account_id IS NULL
          OR external_account_id = ${connectionId ?? ""}
          OR metadata->>'nangoConnectionId' = ${connectionId ?? ""}
        )
    ),
    updated AS (
      UPDATE connections
      SET status = ${status},
          ${status === "active" && connectionId
            ? sql`external_account_id = ${connectionId},`
            : sql``}
          metadata = metadata || ${JSON.stringify(metadata)}::jsonb,
          updated_at = now()
      FROM candidates
      WHERE connections.id = candidates.id
      RETURNING connections.id, candidates.old_status
    )
    SELECT id, old_status
    FROM updated
  `));
  if (updatedRows.length === 0) return;
  const activated = updatedRows.some((row) => row.old_status === "pending" || row.old_status === "error");

  // Keep the polling floor in step with connection lifecycle: newly active
  // connections get (or re-enable) their floor schedule and immediate fan-out;
  // revoked ones lose the floor.
  if (status === "active" && connectionId && activated) {
    await activateNangoConnection(executor, {
      tenantId,
      provider: providerConfigKey,
      providerConfigKey,
      connectionId,
    });
  } else if (status === "revoked") {
    await disableNangoPollSchedule(executor, tenantId, providerConfigKey);
  }
}

export async function resolveTenantForNangoConnection(
  executor: NangoExecutor,
  input: { providerConfigKey: string; connectionId: string },
): Promise<string | null> {
  const rows = rowsFromExecute<{ tenant_id: string }>(await executor.execute(sql`
    SELECT tenant_id
    FROM connections
    WHERE provider = ${input.providerConfigKey}
      AND (
        external_account_id = ${input.connectionId}
        OR metadata->>'nangoConnectionId' = ${input.connectionId}
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `));
  return rows[0]?.tenant_id ?? null;
}

function isSyncCompletedWebhook(payload: Record<string, unknown>): boolean {
  if (stringValue(payload.type)?.toLowerCase() !== "sync") return false;
  if (payload.success === true || stringValue(payload.status)?.toLowerCase() === "success") return true;
  if (payload.success === false || stringValue(payload.status)?.toLowerCase() === "failed") {
    const providerConfigKey = stringValue(payload.providerConfigKey) ?? stringValue(payload.provider_config_key) ?? "unknown";
    const connectionId = stringValue(payload.connectionId) ?? stringValue(payload.connection_id) ?? "unknown";
    const model = stringValue(payload.model) ?? stringValue(payload.syncName) ?? "unknown";
    console.warn(`Nango sync webhook ignored: failed sync for ${providerConfigKey}/${connectionId}/${model}`);
  }
  return false;
}

function connectionWebhookStatus(payload: Record<string, unknown>): "active" | "error" | "revoked" {
  const status = stringValue(payload.status)?.toLowerCase();
  const action = stringValue(payload.action)?.toLowerCase();
  if (payload.success === false || status === "error" || status === "failed" || action === "error") return "error";
  if (status === "deleted" || status === "revoked" || action === "delete" || action === "deleted" || action === "revoke") return "revoked";
  return "active";
}

function normalizeSignature(signature: string | null | undefined): string | null {
  const trimmed = signature?.trim();
  if (!trimmed) return null;
  const hex = trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
  return /^[a-f0-9]{64}$/iu.test(hex) ? hex.toLowerCase() : null;
}

function timingSafeHexEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  const sameLength = actual.length === expected.length;
  const comparable = sameLength ? actual : Buffer.alloc(expected.length);
  const equal = timingSafeEqual(expected, comparable);
  return sameLength && equal;
}

function providerFromPayload(payload: Record<string, unknown>): string | null {
  const provider = stringValue(payload.provider);
  return provider ? provider.trim().toLowerCase().replace(/_/gu, "-") : null;
}

function sanitizeWebhookMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/(token|secret|authorization)=([^&\s]+)/giu, "$1=[redacted]").slice(0, 500);
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(body));
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
