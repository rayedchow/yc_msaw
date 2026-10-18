import { sql } from "drizzle-orm";
import { stagedDocumentMeta } from "../../../mirror/envelope.js";
import { contactNamesByVariant } from "./contacts.js";
import {
  conversationDirectory,
  conversationDirectorySuffix,
  conversationDisplayName,
  IMESSAGE_CONTACTS_PATH,
  IMESSAGE_PROJECTION_ROOT,
  messageGuid,
  normalizeTargetGuid,
  renderContactsJson,
  renderConversationJson,
  renderConversationMonth,
  targetSummary,
  type ProjectionRow,
  type ReactionTarget,
} from "./render.js";
import { isRecord, lockTenant, query, sha256Hex, stringValue, type ImessageDb, type ImessageExecutor } from "./util.js";

/**
 * Writes the iMessage projections into mirror_files (the donor's projection table, journaled
 * by core migration 9000 and exported by the core exporter like every other mirror row).
 * Runs under the tenant's iMessage advisory lock, so a render always reflects the latest
 * committed ingest and two renders of the same month cannot interleave. Dirty rows are
 * deleted only when their mark is not newer than the claim (a concurrent re-mark survives).
 */

const PAIRS_PER_TRANSACTION = 50;

interface DirtyRow {
  conversation_id: string;
  month: string;
  marked_at: string;
}

interface EventRow {
  id: string;
  source_event_id: string;
  event_type: string;
  timestamp: string | Date;
  raw_payload: Record<string, unknown>;
}

function toRow(r: EventRow): ProjectionRow {
  return { id: r.id, sourceEventId: r.source_event_id, eventType: r.event_type, timestamp: new Date(r.timestamp), payload: isRecord(r.raw_payload) ? r.raw_payload : {} };
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)).toISOString(), end: new Date(Date.UTC(y, m, 1)).toISOString() };
}

/** Donor upsertSourceWikiFile semantics (content sha, envelope meta_sha, updated_at only on content change) without the graph hook. */
async function upsertMirror(tx: ImessageExecutor, tenantId: string, path: string, content: string, meta: Record<string, unknown> | null): Promise<void> {
  const body = `${content.trimEnd()}\n`;
  const contentSha = sha256Hex(body);
  const normalizedMeta = meta ? { ...meta, versionRef: meta.versionRef ?? contentSha } : null;
  const metaJson = normalizedMeta ? JSON.stringify(normalizedMeta) : null;
  const metaSha = metaJson ? sha256Hex(metaJson) : null;
  await tx.execute(sql`
    INSERT INTO mirror_files (path, user_id, content, content_sha, meta, meta_sha, updated_at)
    VALUES (${path}, ${tenantId}, ${body}, ${contentSha}, ${metaJson}::jsonb, ${metaSha}, now())
    ON CONFLICT (user_id, path) DO UPDATE
    SET content = EXCLUDED.content, content_sha = EXCLUDED.content_sha,
        meta = COALESCE(EXCLUDED.meta, mirror_files.meta), meta_sha = COALESCE(EXCLUDED.meta_sha, mirror_files.meta_sha),
        updated_at = CASE WHEN mirror_files.content IS DISTINCT FROM EXCLUDED.content THEN now() ELSE mirror_files.updated_at END
    WHERE mirror_files.content_sha IS DISTINCT FROM EXCLUDED.content_sha
       OR mirror_files.content IS DISTINCT FROM EXCLUDED.content
       OR (EXCLUDED.meta_sha IS NOT NULL AND mirror_files.meta_sha IS DISTINCT FROM EXCLUDED.meta_sha)
  `);
}

async function conversationPaths(tx: ImessageExecutor, tenantId: string, conversationId: string): Promise<string[]> {
  const pattern = `${IMESSAGE_PROJECTION_ROOT}/%${conversationDirectorySuffix(conversationId)}/%`;
  return (await query<{ path: string }>(tx, sql`SELECT path FROM mirror_files WHERE user_id = ${tenantId} AND path LIKE ${pattern}`)).map((r) => r.path);
}

async function renderConversation(
  tx: ImessageExecutor,
  tenantId: string,
  conversationId: string,
  requestedMonths: Set<string>,
  contacts: Map<string, string>,
): Promise<{ rendered: number; deleted: number }> {
  const latest = (
    await query<EventRow>(
      tx,
      sql`SELECT id::text AS id, source_event_id, event_type, timestamp, raw_payload FROM activity_events
          WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' = ${conversationId}
          ORDER BY timestamp DESC, source_event_id DESC LIMIT 1`,
    )
  )[0];
  const latestName = (
    await query<{ name: string | null }>(
      tx,
      sql`SELECT raw_payload ->> 'newGroupName' AS name FROM activity_events
          WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' = ${conversationId}
            AND raw_payload ->> 'kind' = 'nameChanged'
          ORDER BY timestamp DESC LIMIT 1`,
    )
  )[0];
  const name = conversationDisplayName(conversationId, latest?.raw_payload ?? null, latestName ? (stringValue(latestName.name) ?? null) : null, contacts);
  const dir = conversationDirectory(conversationId, latest ? name : null);
  const monthsWithRows = await query<{ month: string; n: number; first: string | Date; last: string | Date }>(
    tx,
    sql`SELECT to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*)::int AS n, min(timestamp) AS first, max(timestamp) AS last
        FROM activity_events
        WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' = ${conversationId}
        GROUP BY 1 ORDER BY 1`,
  );
  const existing = await conversationPaths(tx, tenantId, conversationId);
  const months = new Set(requestedMonths.has("*") ? monthsWithRows.map((m) => m.month) : requestedMonths);
  months.delete("*");
  // A rename moves the directory: every month is re-rendered at the new place.
  if (existing.some((p) => !p.startsWith(`${dir}/`))) for (const m of monthsWithRows) months.add(m.month);
  // Files of months that no longer hold any message (moved/archived) are removed.
  for (const p of existing) {
    const m = /\/(\d{4}-\d{2})\.md$/u.exec(p)?.[1];
    if (m && !monthsWithRows.some((x) => x.month === m)) months.add(m);
  }

  let rendered = 0;
  let deleted = 0;
  for (const month of [...months].sort()) {
    const { start, end } = monthBounds(month);
    const rows = (
      await query<EventRow>(
        tx,
        sql`SELECT id::text AS id, source_event_id, event_type, timestamp, raw_payload FROM activity_events
            WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' = ${conversationId}
              AND timestamp >= ${start}::timestamptz AND timestamp < ${end}::timestamptz
            ORDER BY timestamp, source_event_id`,
      )
    ).map(toRow);
    const target = `${dir}/${month}.md`;
    const stale = existing.filter((p) => p.endsWith(`/${month}.md`) && p !== target);
    if (rows.length === 0) {
      const gone = existing.filter((p) => p.endsWith(`/${month}.md`));
      for (const p of gone) await tx.execute(sql`DELETE FROM mirror_files WHERE user_id = ${tenantId} AND path = ${p}`);
      deleted += gone.length;
      continue;
    }
    const guids = [...new Set(rows.map((r) => messageGuid(r.payload)).filter((g): g is string => Boolean(g)))];
    const reactionsOnMonth = guids.length
      ? (
          await query<EventRow>(
            tx,
            sql`SELECT id::text AS id, source_event_id, event_type, timestamp, raw_payload FROM activity_events
                WHERE user_id = ${tenantId} AND source = 'imessage' AND jsonb_typeof(raw_payload -> 'reaction') = 'object'
                  AND regexp_replace(raw_payload -> 'reaction' ->> 'targetMessageId', '^(p:[0-9]+/|bp:)', '') IN (${sql.join(guids.map((g) => sql`${g}`), sql`, `)})`,
          )
        ).map(toRow)
      : [];
    const localGuids = new Set(guids);
    const wanted = [
      ...new Set(
        rows
          .flatMap((r) => [isRecord(r.payload.reaction) ? normalizeTargetGuid(r.payload.reaction.targetMessageId) : null, normalizeTargetGuid(r.payload.replyToMessageId)])
          .filter((g): g is string => Boolean(g) && !localGuids.has(g!)),
      ),
    ];
    const externalTargets = new Map<string, ReactionTarget>();
    if (wanted.length) {
      for (const r of await query<EventRow & { guid: string }>(
        tx,
        sql`SELECT id::text AS id, source_event_id, event_type, timestamp, raw_payload, COALESCE(raw_payload ->> 'providerMessageGuid', raw_payload ->> 'messageId') AS guid
            FROM activity_events
            WHERE user_id = ${tenantId} AND source = 'imessage'
              AND (raw_payload ->> 'providerMessageGuid' IN (${sql.join(wanted.map((g) => sql`${g}`), sql`, `)})
                   OR raw_payload ->> 'messageId' IN (${sql.join(wanted.map((g) => sql`${g}`), sql`, `)}))`,
      )) {
        if (!externalTargets.has(r.guid)) externalTargets.set(r.guid, targetSummary(isRecord(r.raw_payload) ? r.raw_payload : {}, contacts));
      }
    }
    const content = renderConversationMonth({
      conversationId,
      conversationName: name,
      conversationType: conversationId.startsWith("imessage:dm:") ? "direct" : conversationId.startsWith("imessage:group:") ? "group" : "unknown",
      month,
      rows,
      contacts,
      externalTargets,
      reactionsOnMonth,
    })!;
    const lastChange = rows.reduce((t, r) => {
      const candidates = [r.timestamp.getTime(), new Date(String(r.payload.editedAt ?? 0)).getTime(), new Date(String(r.payload.retractedAt ?? 0)).getTime()].filter(Number.isFinite);
      return Math.max(t, ...candidates);
    }, 0);
    const meta = stagedDocumentMeta({
      provider: "imessage",
      externalId: `${conversationId}:${month}`,
      kind: "conversation_window",
      title: `${name} - ${month}`,
      sourceUpdatedAt: lastChange ? new Date(lastChange) : null,
      sourceAcl: { conversationId },
    }) as unknown as Record<string, unknown>;
    await upsertMirror(tx, tenantId, target, content, meta);
    // Lifecycle collected -> mirrored (not journaled: processing_status is bookkeeping).
    await tx.execute(sql`UPDATE activity_events SET processing_status = 'mirrored'
                         WHERE user_id = ${tenantId} AND id::text IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) AND processing_status <> 'mirrored'`);
    for (const p of stale) await tx.execute(sql`DELETE FROM mirror_files WHERE user_id = ${tenantId} AND path = ${p}`);
    rendered++;
    deleted += stale.length;
  }

  // conversation.json at the current directory; old directories' copies are removed.
  const summaryPath = `${dir}/conversation.json`;
  const oldSummaries = existing.filter((p) => p.endsWith("/conversation.json") && p !== summaryPath);
  for (const p of oldSummaries) await tx.execute(sql`DELETE FROM mirror_files WHERE user_id = ${tenantId} AND path = ${p}`);
  deleted += oldSummaries.length;
  if (monthsWithRows.length === 0) {
    if (existing.includes(summaryPath)) {
      await tx.execute(sql`DELETE FROM mirror_files WHERE user_id = ${tenantId} AND path = ${summaryPath}`);
      deleted++;
    }
    return { rendered, deleted };
  }
  const rawChats = await query<{ chat: string }>(
    tx,
    sql`SELECT DISTINCT jsonb_array_elements_text(COALESCE(raw_payload -> '_observed_raw_chat_ids', '[]'::jsonb)) AS chat FROM activity_events
        WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' = ${conversationId} ORDER BY 1`,
  );
  await upsertMirror(
    tx,
    tenantId,
    summaryPath,
    renderConversationJson({
      conversationId,
      conversationType: conversationId.startsWith("imessage:dm:") ? "direct" : conversationId.startsWith("imessage:group:") ? "group" : "unknown",
      name,
      counterpartHandle: conversationId.startsWith("imessage:dm:") ? conversationId.slice("imessage:dm:".length) : null,
      rawChatIds: rawChats.map((r) => r.chat),
      months: monthsWithRows.map((m) => ({ month: m.month, path: `${dir}/${m.month}.md`, rows: Number(m.n) })),
      firstMessageAt: new Date(monthsWithRows[0]!.first).toISOString(),
      lastMessageAt: new Date(monthsWithRows.at(-1)!.last).toISOString(),
    }),
    null,
  );
  return { rendered: rendered + 1, deleted };
}

async function renderContacts(tx: ImessageExecutor, tenantId: string): Promise<void> {
  const contacts = await query<{ handle: string; name: string; variants: string[]; updated_at: string | Date }>(
    tx,
    sql`SELECT handle, name, variants, updated_at FROM imessage_contacts WHERE tenant_id = ${tenantId} ORDER BY handle`,
  );
  if (!contacts.length) {
    await tx.execute(sql`DELETE FROM mirror_files WHERE user_id = ${tenantId} AND path = ${IMESSAGE_CONTACTS_PATH}`);
    return;
  }
  await upsertMirror(
    tx,
    tenantId,
    IMESSAGE_CONTACTS_PATH,
    renderContactsJson(contacts.map((c) => ({ handle: c.handle, name: c.name, variants: c.variants, updatedAt: new Date(c.updated_at).toISOString() }))),
    null,
  );
}

export interface ProjectionPassResult {
  rendered: number;
  deleted: number;
  pending: number;
}

/**
 * Drain the tenant's dirty projections (oldest first) until none remain or the time budget
 * is spent. Each transaction claims up to 50 (conversation, month) marks.
 */
export async function drainImessageProjections(database: ImessageDb, tenantId: string, opts: { budgetMs?: number } = {}): Promise<ProjectionPassResult> {
  const deadline = Date.now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
  const out: ProjectionPassResult = { rendered: 0, deleted: 0, pending: 0 };
  for (;;) {
    const more = await database.transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const dirty = await query<DirtyRow>(
        tx,
        sql`SELECT conversation_id, month, marked_at::text AS marked_at FROM imessage_projection_dirty
            WHERE tenant_id = ${tenantId} ORDER BY marked_at, conversation_id, month LIMIT ${PAIRS_PER_TRANSACTION}`,
      );
      if (!dirty.length) return false;
      const contacts = await contactNamesByVariant(tx, tenantId);
      const byConversation = new Map<string, Set<string>>();
      for (const d of dirty) {
        const set = byConversation.get(d.conversation_id) ?? new Set<string>();
        set.add(d.month);
        byConversation.set(d.conversation_id, set);
      }
      for (const [conversationId, months] of byConversation) {
        if (conversationId === "_contacts") {
          await renderContacts(tx, tenantId);
          out.rendered++;
          continue;
        }
        const r = await renderConversation(tx, tenantId, conversationId, months, contacts);
        out.rendered += r.rendered;
        out.deleted += r.deleted;
      }
      for (const d of dirty) {
        await tx.execute(sql`DELETE FROM imessage_projection_dirty
                             WHERE tenant_id = ${tenantId} AND conversation_id = ${d.conversation_id} AND month = ${d.month} AND marked_at <= ${d.marked_at}::timestamptz`);
      }
      return true;
    });
    if (!more || Date.now() >= deadline) break;
  }
  out.pending = Number(
    (await query<{ n: number }>(database, sql`SELECT count(*)::int AS n FROM imessage_projection_dirty WHERE tenant_id = ${tenantId}`))[0]?.n ?? 0,
  );
  return out;
}

/** Re-render every conversation of a tenant (operator repair; also used after enabling the provider). */
export async function markAllImessageProjectionsDirty(executor: ImessageExecutor, tenantId: string): Promise<number> {
  const marked = await query<{ conversation_id: string }>(
    executor,
    sql`INSERT INTO imessage_projection_dirty (tenant_id, conversation_id, month)
        SELECT DISTINCT ${tenantId}, raw_payload ->> '_normalized_conversation_id', '*' FROM activity_events
        WHERE user_id = ${tenantId} AND source = 'imessage' AND raw_payload ->> '_normalized_conversation_id' IS NOT NULL
        UNION SELECT ${tenantId}, '_contacts', '*'
        ON CONFLICT (tenant_id, conversation_id, month) DO UPDATE SET marked_at = clock_timestamp()
        RETURNING conversation_id`,
  );
  return marked.length;
}
