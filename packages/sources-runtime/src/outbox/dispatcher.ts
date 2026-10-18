import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { decrypt } from "../vault/encryption.js";

/**
 * Webhook dispatcher skeleton (Stripe/GitHub-grade delivery is the product
 * feature - see docs/aws-architecture.md).
 *
 * Loop: claim a batch of due `outbox_events` with SKIP LOCKED (skipping any
 * event whose ordering key has an earlier unfinalized event, so per-key
 * delivery stays ordered), fan each out to the tenant's enabled
 * `webhook_endpoints`, HMAC-SHA256 sign the body, POST with a timeout, then:
 *  - success        -> record the endpoint in `delivered_endpoint_ids` (so a
 *                      retry after a partial failure never re-sends to an
 *                      endpoint that already accepted), reset its breaker;
 *                      mark the event delivered once every target accepted
 *  - failure        -> exponential backoff w/ jitter on the event, bump the
 *                      endpoint's consecutive-failure count; too many
 *                      failures opens the endpoint's circuit for a cool-off
 *  - out of retries -> mark the event dead (redelivery console comes later)
 *
 * PR 1 intentionally ships this as a single-process poller; the SQS buffer
 * and delivery-log surface from the architecture doc layer on later.
 */

const MAX_DELIVERY_ATTEMPTS = 8;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;
const CIRCUIT_OPEN_AFTER_FAILURES = 5;
const CIRCUIT_OPEN_SECONDS = 300;
const DELIVERY_TIMEOUT_MS = 10_000;
/**
 * Visibility timeout: claiming pushes next_attempt_at into the future so no
 * other dispatcher re-claims the event while its POSTs are in flight. If the
 * worker dies mid-delivery, the event (still `delivering`) becomes claimable
 * again once the lease expires. Must exceed targets × DELIVERY_TIMEOUT_MS.
 */
const DELIVERY_LEASE_SECONDS = 300;

type DbExecutor = Pick<typeof db, "execute">;

export interface EndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  event_types: string[];
  consecutive_failures: number;
  circuit_open_until: string | null;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  ordering_key: string | null;
  delivered_endpoint_ids: string[];
  attempts: number;
  created_at: string;
}

/** Signature header value: `t=<unix>,v1=<hex hmac of "<t>.<body>">`. */
export function signWebhookPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function deliveryBackoffSeconds(attempts: number): number {
  const base = Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS);
  // Full jitter keeps a briefly-down endpoint from being hammered in lockstep.
  return Math.max(5, Math.floor(base * (0.5 + Math.random() * 0.5)));
}

function endpointMatchesEvent(endpoint: EndpointRow, eventType: string): boolean {
  const subscriptions = Array.isArray(endpoint.event_types) ? endpoint.event_types : [];
  if (subscriptions.length === 0) return true;
  return subscriptions.some((prefix) => typeof prefix === "string" && eventType.startsWith(prefix));
}

/** One dispatcher pass. Returns how many events were finalized (delivered or dead). */
export async function dispatchPendingOutboxEvents(executor: DbExecutor = db): Promise<number> {
  const events = (await executor.execute(sql`
    UPDATE outbox_events
    SET state = 'delivering',
        next_attempt_at = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS})
    WHERE id IN (
      SELECT id FROM outbox_events candidate
      WHERE candidate.state IN ('pending', 'delivering')
        AND candidate.next_attempt_at <= now()
        -- Per-key ordering: never start an event while an earlier event with
        -- the same ordering key is still unfinalized.
        AND (
          candidate.ordering_key IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM outbox_events prior
            WHERE prior.ordering_key = candidate.ordering_key
              AND prior.state IN ('pending', 'delivering')
              AND prior.created_at < candidate.created_at
          )
        )
      ORDER BY created_at ASC
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, event_type, payload, ordering_key, delivered_endpoint_ids, attempts, created_at
  `)) as unknown as OutboxRow[];

  let finalized = 0;
  for (const event of events) {
    const endpoints = (await executor.execute(sql`
      SELECT id, tenant_id, url, secret, event_types, consecutive_failures,
             circuit_open_until
      FROM webhook_endpoints
      WHERE tenant_id = ${event.tenant_id} AND enabled = true
    `)) as unknown as EndpointRow[];

    const targets = endpoints.filter((endpoint) => endpointMatchesEvent(endpoint, event.event_type));
    if (targets.length === 0) {
      await executor.execute(sql`
        UPDATE outbox_events SET state = 'delivered', delivered_at = now()
        WHERE id = ${event.id}::uuid
      `);
      finalized += 1;
      continue;
    }

    const alreadyDelivered = new Set(
      Array.isArray(event.delivered_endpoint_ids) ? event.delivered_endpoint_ids : [],
    );
    let allDelivered = true;
    let lastError: string | null = null;

    for (const endpoint of targets) {
      // Partial-failure retries must not re-send to endpoints that already
      // accepted this event.
      if (alreadyDelivered.has(endpoint.id)) continue;
      if (endpoint.circuit_open_until && new Date(endpoint.circuit_open_until).getTime() > Date.now()) {
        allDelivered = false;
        lastError = `endpoint ${endpoint.id} circuit open`;
        continue;
      }
      const result = await deliverToEndpoint(endpoint, event);
      if (result.ok) {
        await executor.execute(sql`
          UPDATE outbox_events
          SET delivered_endpoint_ids = delivered_endpoint_ids || to_jsonb(${endpoint.id}::text)
          WHERE id = ${event.id}::uuid
            AND NOT delivered_endpoint_ids @> to_jsonb(${endpoint.id}::text)
        `);
        await executor.execute(sql`
          UPDATE webhook_endpoints
          SET consecutive_failures = 0, circuit_open_until = NULL,
              last_delivery_at = now(), updated_at = now()
          WHERE id = ${endpoint.id}::uuid
        `);
      } else {
        allDelivered = false;
        lastError = result.error;
        await executor.execute(sql`
          UPDATE webhook_endpoints
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_at = now(),
              circuit_open_until = CASE
                WHEN consecutive_failures + 1 >= ${CIRCUIT_OPEN_AFTER_FAILURES}
                THEN now() + make_interval(secs => ${CIRCUIT_OPEN_SECONDS})
                ELSE circuit_open_until
              END,
              updated_at = now()
          WHERE id = ${endpoint.id}::uuid
        `);
      }
    }

    if (allDelivered) {
      await executor.execute(sql`
        UPDATE outbox_events SET state = 'delivered', delivered_at = now()
        WHERE id = ${event.id}::uuid
      `);
      finalized += 1;
    } else if (event.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
      await executor.execute(sql`
        UPDATE outbox_events
        SET state = 'dead', attempts = attempts + 1, last_error = ${lastError}
        WHERE id = ${event.id}::uuid
      `);
      finalized += 1;
    } else {
      await executor.execute(sql`
        UPDATE outbox_events
        SET state = 'pending',
            attempts = attempts + 1,
            last_error = ${lastError},
            next_attempt_at = now() + make_interval(secs => ${deliveryBackoffSeconds(event.attempts + 1)})
        WHERE id = ${event.id}::uuid
      `);
    }
  }

  return finalized;
}

async function deliverToEndpoint(
  endpoint: EndpointRow,
  event: OutboxRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = JSON.stringify({
    id: event.id,
    type: event.event_type,
    created_at: event.created_at,
    data: event.payload ?? {},
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decrypt(endpoint.secret);

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Aqueduct-Signature": signWebhookPayload(secret, body, timestamp),
        "Aqueduct-Event": event.event_type,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `endpoint ${endpoint.id} responded ${res.status}` };
  } catch (err) {
    return { ok: false, error: `endpoint ${endpoint.id}: ${err instanceof Error ? err.message : "request failed"}` };
  }
}

/** Long-running dispatcher loop for the worker entrypoint. */
export async function runOutboxDispatcher(signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    let processed = 0;
    try {
      processed = await dispatchPendingOutboxEvents();
    } catch (err) {
      console.error("outbox dispatch pass failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, processed > 0 ? 250 : 5_000));
  }
}
