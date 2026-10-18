import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * Transactional outbox writer.
 *
 * Connectors call this in the same transaction (or at least the same
 * logical step) as the state change itself, so "data changed" and "customer
 * was told data changed" cannot diverge. The dispatcher owns delivery.
 */

type DbExecutor = Pick<typeof db, "execute">;

export interface OutboxEventInput {
  tenantId: string;
  /** e.g. "mirror.file.changed", "event.collected", "connection.updated". */
  eventType: string;
  payload?: Record<string, unknown>;
  /** Deliveries with the same ordering key are serialized per endpoint. */
  orderingKey?: string;
}

/** Append an event to the outbox. Returns the outbox row id. */
export async function emitOutboxEvent(input: OutboxEventInput, executor: DbExecutor = db): Promise<string | null> {
  const rows = (await executor.execute(sql`
    INSERT INTO outbox_events (tenant_id, event_type, payload, ordering_key)
    VALUES (
      ${input.tenantId},
      ${input.eventType},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.orderingKey ?? null}
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
