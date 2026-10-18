import { sql } from "drizzle-orm";
import { imessageHandleVariants, normalizeImessageHandle } from "../../../lib/imessage-handles.js";
import type { DeviceContext } from "./devices.js";
import { touchImessageDevice } from "./devices.js";
import { IngestInputError } from "./ingest.js";
import { localMessagesSyncStatus } from "./receipts.js";
import { isRecord, lockTenant, query, type ImessageDb, type ImessageExecutor } from "./util.js";

/**
 * POST /api/imessage/ingest/sync-contacts and /local-status.
 *
 * Donor syncImessageContactsForUser (gigabrain contact-sync.ts) renamed graph entities,
 * rewrote `_resolved_name` inside every matching raw payload and invalidated memory
 * artifacts. The source lane has no graph, and raw payloads stay as the device uploaded
 * them; instead the mapping is persisted per tenant (imessage_contacts, matched with the
 * donor's handle variants), exported as sources/imessage/contacts.json, and applied by
 * the projection renderer. Affected conversations are re-projected.
 */

export const MAX_CONTACTS_PER_SYNC = 50_000;

export interface ContactSyncResult {
  updated: number;
  contactsProcessed: number;
  stored: number;
  unchanged: number;
  invalid: number;
  affectedConversations: number;
  // Donor response keys (graph/memory work does not exist in the source lane).
  renamedEntities: 0;
  attachedIdentifiers: 0;
  hydratedEvents: 0;
  invalidatedMemoryArtifacts: 0;
  releasedWikiEventClaims: 0;
  skippedCollisions: 0;
  affectedDailyPeriods: [];
  affectedWeeklyPeriods: [];
  refresh: Record<string, unknown>;
}

export async function syncImessageContacts(database: ImessageDb, device: DeviceContext, body: unknown): Promise<ContactSyncResult> {
  if (!isRecord(body) || !Array.isArray(body.contacts)) throw new IngestInputError("contacts array is required");
  if (body.contacts.length > MAX_CONTACTS_PER_SYNC) throw new IngestInputError(`Maximum ${MAX_CONTACTS_PER_SYNC} contacts per sync`);
  const contacts = body.contacts as unknown[];
  // Last mapping for a handle wins, as when the donor processed them in order.
  const byHandle = new Map<string, { name: string; variants: string[] }>();
  let invalid = 0;
  for (const c of contacts) {
    if (!isRecord(c) || typeof c.handle !== "string" || typeof c.name !== "string") {
      invalid++;
      continue;
    }
    const normalized = normalizeImessageHandle(c.handle);
    // Variants of the normalized handle, so the stored set does not depend on how the address book formatted it.
    const variants = normalized ? imessageHandleVariants(normalized) : [];
    const name = c.name.trim().slice(0, 500);
    if (!normalized || variants.length === 0 || !name) {
      invalid++;
      continue;
    }
    const prev = byHandle.get(normalized);
    byHandle.set(normalized, { name, variants: [...new Set([...(prev?.variants ?? []), ...variants, normalized])].sort() });
  }

  const { stored, affected } = await database.transaction(async (tx) => {
    await lockTenant(tx, device.tenantId);
    const changedHandles: Array<{ handle: string; variants: string[] }> = [];
    for (const [handle, c] of byHandle) {
      const r = await query<{ handle: string }>(
        tx,
        sql`INSERT INTO imessage_contacts (tenant_id, handle, name, variants, binding_id)
            VALUES (${device.tenantId}, ${handle}, ${c.name}, ${JSON.stringify(c.variants)}::jsonb, ${device.bindingId})
            ON CONFLICT (tenant_id, handle) DO UPDATE
            SET name = excluded.name, variants = excluded.variants, binding_id = excluded.binding_id, updated_at = now()
            WHERE imessage_contacts.name IS DISTINCT FROM excluded.name OR imessage_contacts.variants IS DISTINCT FROM excluded.variants
            RETURNING handle`,
      );
      if (r.length) changedHandles.push({ handle, variants: c.variants });
    }
    let affected = 0;
    if (changedHandles.length) {
      // Every conversation in which a changed handle speaks or is the DM counterpart: re-render all its months.
      const variants = [...new Set(changedHandles.flatMap((c) => c.variants))];
      for (let i = 0; i < variants.length; i += 1_000) {
        const chunk = variants.slice(i, i + 1_000);
        const inList = sql.join(chunk.map((v) => sql`${v}`), sql`, `);
        const marked = await query<{ conversation_id: string }>(
          tx,
          sql`INSERT INTO imessage_projection_dirty (tenant_id, conversation_id, month)
              SELECT DISTINCT ${device.tenantId}, raw_payload ->> '_normalized_conversation_id', '*'
              FROM activity_events
              WHERE user_id = ${device.tenantId} AND source = 'imessage'
                AND raw_payload ->> '_normalized_conversation_id' IS NOT NULL
                AND (raw_payload ->> '_sender_handle' IN (${inList}) OR raw_payload ->> 'participant' IN (${inList})
                     OR raw_payload ->> '_counterpart_handle' IN (${inList}) OR raw_payload ->> 'affectedParticipant' IN (${inList}))
              ON CONFLICT (tenant_id, conversation_id, month) DO UPDATE SET marked_at = clock_timestamp()
              RETURNING conversation_id`,
        );
        affected += marked.length;
      }
    }
    // The contacts file itself.
    await tx.execute(sql`INSERT INTO imessage_projection_dirty (tenant_id, conversation_id, month) VALUES (${device.tenantId}, '_contacts', '*')
                         ON CONFLICT (tenant_id, conversation_id, month) DO UPDATE SET marked_at = clock_timestamp()`);
    await touchImessageDevice(tx, device, {});
    return { stored: changedHandles.length, affected };
  });

  return {
    updated: stored,
    contactsProcessed: contacts.length,
    stored,
    unchanged: byHandle.size - stored,
    invalid,
    affectedConversations: affected,
    renamedEntities: 0,
    attachedIdentifiers: 0,
    hydratedEvents: 0,
    invalidatedMemoryArtifacts: 0,
    releasedWikiEventClaims: 0,
    skippedCollisions: 0,
    affectedDailyPeriods: [],
    affectedWeeklyPeriods: [],
    refresh: {},
  };
}

/** Contact names by every handle variant, for the projection renderer. */
export async function contactNamesByVariant(executor: ImessageExecutor, tenantId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await query<{ name: string; variants: string[] }>(executor, sql`SELECT name, variants FROM imessage_contacts WHERE tenant_id = ${tenantId} ORDER BY handle`)) {
    for (const v of Array.isArray(r.variants) ? r.variants : []) if (!out.has(v)) out.set(v, r.name);
  }
  return out;
}

/** POST /local-status: donor localMessagesSyncStatus stored on the device row. */
export async function recordImessageLocalStatus(executor: ImessageExecutor, device: DeviceContext, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
  const status = localMessagesSyncStatus(isRecord(body) ? body.status : null, now);
  // The uploader posts its statuses without awaiting them, so a "running" can arrive after the run's final
  // "complete". A status older (by the uploader's own updatedAt) than the stored one is not applied.
  const updatedAt = typeof status.updatedAt === "string" ? status.updatedAt : null;
  const stale = sql`(${updatedAt}::timestamptz IS NOT NULL AND local_status->>'updatedAt' IS NOT NULL AND (local_status->>'updatedAt')::timestamptz > ${updatedAt}::timestamptz)`;
  await executor.execute(sql`
    UPDATE imessage_devices
    SET local_status = CASE WHEN ${stale} THEN local_status ELSE ${JSON.stringify(status)}::jsonb END,
        local_status_at = CASE WHEN ${stale} THEN local_status_at ELSE ${now.toISOString()}::timestamptz END, last_seen_at = now(),
        last_device_id = COALESCE(${typeof status.deviceId === "string" && status.deviceId ? status.deviceId : null}, last_device_id),
        last_agent_version = COALESCE(${typeof status.agentVersion === "string" ? status.agentVersion : null}, last_agent_version),
        last_agent_channel = COALESCE(${typeof status.agentChannel === "string" ? status.agentChannel : null}, last_agent_channel)
    WHERE tenant_id = ${device.tenantId} AND binding_id = ${device.bindingId}
  `);
  return status;
}
