import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { DONOR, RUNTIME_VERSION } from "../core/donor.js";
import type { ActivityEventRow, CoverageReport, DbExecutor, ExportContext, JournalInfo, MirrorFileRow, SourceFileChange } from "../core/types.js";
import { defaultRegistry, type SourceProviderRegistry } from "../registry.js";
import { boundTenants, getTenantBinding } from "./bindings.js";
import { defaultEventChanges, defaultMirrorChanges, rawEventDir } from "./mapping.js";
import { PublishError, sha256, SourcePublishClient, type PublishReceipt, type WireChange } from "./publish-client.js";
/** activity_events.id is a uuid primary key: lookups must compare as uuid so the index is used. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SQL_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";


/**
 * Source exporter: drains `source_lane_journal` into yc_msaw's sources/ store.
 *
 * Claim (lease) -> coalesce per row -> read current row state -> map through the
 * provider registry -> upload chunks -> publish one batch per tenant binding ->
 * delete exactly the journal rows whose every change was accepted. A crash at
 * any point leaves the rows leased; the lease expires and the rows are published
 * again, which the store resolves as unchanged/replayed. Changes the store
 * rejects (shape conflicts, limits) and rows that fail to map are dead-lettered
 * with their error (retried hourly) and reported as partial coverage, never
 * acknowledged.
 */

export interface ExporterOptions {
  db: DbExecutor;
  registry?: SourceProviderRegistry;
  owner?: string;
  fetchImpl?: typeof fetch;
  leaseSeconds?: number;
  claimLimit?: number;
  reportIntervalSeconds?: number;
  log?: (msg: string) => void;
}

export interface ExportPassResult {
  claimed: number;
  acked: number;
  deadLettered: number;
  released: number;
  tenants: number;
}

interface JournalRow {
  id: string;
  tenant_id: string;
  table_name: string;
  row_key: string;
  op: JournalInfo["op"];
  enqueued_at: string | Date;
  attempts: number;
}

interface KeyGroup {
  table: string;
  rowKey: string;
  ids: string[];
  journal: JournalInfo;
  attempts: number;
}

interface MappedItem {
  group: KeyGroup;
  changes: SourceFileChange[];
}

interface Fence {
  tenantId: string;
  fence: number;
}

const MAX_BATCH_CHANGES = 1_000;
const MAX_BATCH_JSON_BYTES = 3 * 1024 * 1024;
const DEAD_LETTER_RETRY_SECONDS = 3_600;
const DEAD_LETTER_MAX_ATTEMPTS = 50;
/** Modules fed by the donor's single Google (DWD) connection when they do not declare connectionProviders. */
const GOOGLE_CONNECTION_MODULES = new Set(["gmail", "calendar", "google-docs"]);

function feedsFrom(m: { id: string; connectionProviders?: readonly string[] }): readonly string[] {
  return m.connectionProviders ?? (GOOGLE_CONNECTION_MODULES.has(m.id) ? ["google", m.id] : [m.id]);
}

/** Postgres bigint[] literal for journal ids (always numeric strings read back from the table). */
function idArray(ids: readonly string[]): string {
  if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("journal ids must be numeric");
  return `{${ids.join(",")}}`;
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

function iso(v: string | Date): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
}

function backoffSeconds(attempts: number): number {
  return Math.min(3_600, 15 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
}

export class SourceExporter {
  readonly db: DbExecutor;
  readonly registry: SourceProviderRegistry;
  readonly owner: string;
  readonly #fetch: typeof fetch;
  readonly #lease: number;
  readonly #limit: number;
  readonly reportIntervalSeconds: number;
  readonly #log: (msg: string) => void;
  readonly #lastExportAt = new Map<string, string>();

  constructor(opts: ExporterOptions) {
    this.db = opts.db;
    this.registry = opts.registry ?? defaultRegistry();
    this.owner = opts.owner ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#lease = opts.leaseSeconds ?? 300;
    this.#limit = opts.claimLimit ?? 500;
    this.reportIntervalSeconds = opts.reportIntervalSeconds ?? 300;
    this.#log = opts.log ?? ((m) => console.log(`[source-export] ${m}`));
  }

  // ---------------------------------------------------------------- tenant lease (fencing)

  /** Take (or renew) the tenant's export lease; returns the fence, or null when another exporter holds it. */
  async #lockTenant(tenantId: string): Promise<number | null> {
    const r = rows<{ fence: string | number }>(
      await this.db.execute(sql`
        INSERT INTO source_lane_tenant_locks (tenant_id, owner, fence, lease_until)
        VALUES (${tenantId}, ${this.owner}, 1, now() + make_interval(secs => ${this.#lease}))
        ON CONFLICT (tenant_id) DO UPDATE
          SET owner = EXCLUDED.owner,
              fence = source_lane_tenant_locks.fence + 1,
              lease_until = EXCLUDED.lease_until,
              acquired_at = now()
          WHERE source_lane_tenant_locks.lease_until < now()
        RETURNING fence
      `),
    )[0];
    return r ? Number(r.fence) : null;
  }

  /** Extend the lease before each externally visible step; false when the fence was lost. */
  async #renew(tenantId: string, fence: number): Promise<boolean> {
    return rows(
      await this.db.execute(sql`
        UPDATE source_lane_tenant_locks SET lease_until = now() + make_interval(secs => ${this.#lease})
        WHERE tenant_id = ${tenantId} AND owner = ${this.owner} AND fence = ${fence} AND lease_until > now()
        RETURNING fence
      `),
    ).length > 0;
  }

  async #unlockTenant(tenantId: string, fence: number): Promise<void> {
    await this.db.execute(sql`DELETE FROM source_lane_tenant_locks WHERE tenant_id = ${tenantId} AND owner = ${this.owner} AND fence = ${fence}`);
  }

  #held(f: Fence) {
    return sql`EXISTS (SELECT 1 FROM source_lane_tenant_locks l WHERE l.tenant_id = ${f.tenantId} AND l.owner = ${this.owner} AND l.fence = ${f.fence} AND l.lease_until > now())`;
  }

  // ---------------------------------------------------------------- journal ops

  async #claim(): Promise<JournalRow[]> {
    return rows<JournalRow>(
      await this.db.execute(sql`
        UPDATE source_lane_journal j
        SET lease_owner = ${this.owner},
            lease_until = now() + make_interval(secs => ${this.#lease}),
            attempts = j.attempts + 1
        WHERE j.id IN (
          SELECT id FROM source_lane_journal
          WHERE dead_lettered_at IS NULL
            AND next_attempt_at <= now()
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY id
          LIMIT ${this.#limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING j.id::text AS id, j.tenant_id, j.table_name, j.row_key, j.op, j.enqueued_at, j.attempts
      `),
    );
  }

  /** Rows are acknowledged only by their current claimant while it still holds the tenant fence (when given). */
  async #ack(ids: string[], f?: Fence): Promise<number> {
    if (!ids.length) return 0;
    return rows(
      await this.db.execute(sql`
        DELETE FROM source_lane_journal
        WHERE id = ANY(${idArray(ids)}::bigint[]) AND lease_owner = ${this.owner} ${f ? sql`AND ${this.#held(f)}` : sql``}
        RETURNING id
      `),
    ).length;
  }

  async #release(ids: string[], delaySeconds: number, error: string): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(sql`
      UPDATE source_lane_journal
      SET lease_owner = NULL, lease_until = NULL, last_error = ${error},
          next_attempt_at = now() + make_interval(secs => ${delaySeconds})
      WHERE id = ANY(${idArray(ids)}::bigint[]) AND lease_owner = ${this.owner}
    `);
  }

  async #deadLetter(ids: string[], error: string, f?: Fence): Promise<number> {
    if (!ids.length) return 0;
    return rows(
      await this.db.execute(sql`
        UPDATE source_lane_journal
        SET lease_owner = NULL, lease_until = NULL, last_error = ${error}, dead_lettered_at = now()
        WHERE id = ANY(${idArray(ids)}::bigint[]) AND lease_owner = ${this.owner} ${f ? sql`AND ${this.#held(f)}` : sql``}
        RETURNING id
      `),
    ).length;
  }

  /** Re-arm dead letters older than an hour (bounded attempts) so fixed causes drain on their own. */
  async retryDeadLetters(olderThanSeconds = DEAD_LETTER_RETRY_SECONDS): Promise<number> {
    return rows<{ id: string }>(
      await this.db.execute(sql`
        UPDATE source_lane_journal
        SET dead_lettered_at = NULL, next_attempt_at = now()
        WHERE dead_lettered_at IS NOT NULL
          AND dead_lettered_at < now() - make_interval(secs => ${olderThanSeconds})
          AND attempts < ${DEAD_LETTER_MAX_ATTEMPTS}
        RETURNING id::text AS id
      `),
    ).length;
  }

  /** Journal every existing row of a tenant (first binding, or a re-sync): publication is idempotent. */
  async enqueueTenantBackfill(tenantId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    counts.mirror_files = rows(
      await this.db.execute(sql`
        INSERT INTO source_lane_journal (tenant_id, table_name, row_key, op)
        SELECT user_id, 'mirror_files', path, 'INSERT' FROM mirror_files WHERE user_id = ${tenantId}
        RETURNING id
      `),
    ).length;
    counts.activity_events = rows(
      await this.db.execute(sql`
        INSERT INTO source_lane_journal (tenant_id, table_name, row_key, op)
        SELECT user_id, 'activity_events', id::text, 'INSERT' FROM activity_events WHERE user_id = ${tenantId}
        RETURNING id
      `),
    ).length;
    for (const m of this.registry.modules) {
      for (const t of m.extraTables ?? []) {
        if (!t.tenantColumn || !t.keyColumn) continue;
        counts[t.table] = rows(
          await this.db.execute(sql`
            INSERT INTO source_lane_journal (tenant_id, table_name, row_key, op)
            SELECT ${sql.identifier(t.tenantColumn)}::text, ${t.table}, ${sql.identifier(t.keyColumn)}::text, 'INSERT'
            FROM ${sql.identifier(t.table)} WHERE ${sql.identifier(t.tenantColumn)}::text = ${tenantId}
            RETURNING id
          `),
        ).length;
      }
    }
    return counts;
  }

  // ---------------------------------------------------------------- mapping

  async #previousPaths(tenantId: string, table: string, rowKey: string): Promise<string[]> {
    return rows<{ path: string }>(
      await this.db.execute(sql`SELECT path FROM source_lane_exported WHERE tenant_id = ${tenantId} AND table_name = ${table} AND row_key = ${rowKey} ORDER BY path`),
    ).map((r) => r.path);
  }

  /**
   * Current changes for a row plus deletes for paths this row exported before but no longer
   * produces (its provider path moved), unless another row now owns that path.
   */
  async #mapWithMoves(ctx: ExportContext, g: KeyGroup): Promise<SourceFileChange[]> {
    const changes = await this.#map(ctx, g);
    if (g.table === "mirror_files") return changes; // key == path: a move is a delete of the old row
    const produced = new Set(changes.map((c) => c.path));
    if (!changes.some((c) => c.op === "put")) return changes;
    const previous = await this.#previousPaths(ctx.tenantId, g.table, g.rowKey);
    const extra: SourceFileChange[] = [];
    for (const path of previous) {
      if (produced.has(path)) continue;
      const others = rows(
        await this.db.execute(sql`
          SELECT 1 FROM source_lane_exported
          WHERE tenant_id = ${ctx.tenantId} AND path = ${path} AND NOT (table_name = ${g.table} AND row_key = ${g.rowKey})
          LIMIT 1
        `),
      );
      if (others.length) continue;
      extra.push({ op: "delete", path, deletedAt: g.journal.enqueuedAt, reason: "source_path_changed", capturedAt: g.journal.enqueuedAt, provenance: { donor: `${DONOR.repo}@${DONOR.commit}`, table: g.table, rowKey: g.rowKey } });
    }
    return [...changes, ...extra];
  }

  async #map(ctx: ExportContext, g: KeyGroup): Promise<SourceFileChange[]> {
    if (g.table === "mirror_files") {
      const row = rows<MirrorFileRow>(
        await this.db.execute(sql`SELECT path, user_id, content, content_sha, meta, meta_sha, updated_at FROM mirror_files WHERE user_id = ${ctx.tenantId} AND path = ${g.rowKey}`),
      )[0] ?? null;
      const norm = row ? { ...row, updated_at: iso(row.updated_at) } : null;
      const module = this.registry.forMirrorPath(g.rowKey);
      const custom = module?.mapMirror ? await module.mapMirror(g.rowKey, norm, ctx, g.journal) : null;
      return custom ?? defaultMirrorChanges(g.rowKey, norm, g.journal.enqueuedAt);
    }
    if (g.table === "activity_events") {
      const row = rows<ActivityEventRow>(
        await this.db.execute(sql`
          SELECT id::text AS id, user_id, source, source_namespace, source_object_id, record_kind, event_type,
                 timestamp, source_updated_at, raw_payload, raw_payload::text AS raw_payload_text,
                 extracted_entities, extracted_entities::text AS extracted_entities_text, source_event_id, created_at
          FROM activity_events WHERE user_id = ${ctx.tenantId} AND id = ${UUID_RE.test(g.rowKey) ? g.rowKey : null}::uuid
        `),
      )[0];
      if (!row) {
        // Raw ledger rows are append-only in the donor; if one is removed, remove exactly what it produced.
        return (await this.#previousPaths(ctx.tenantId, g.table, g.rowKey)).map((path) => ({
          op: "delete" as const,
          path,
          deletedAt: g.journal.enqueuedAt,
          reason: "raw_row_deleted",
          capturedAt: g.journal.enqueuedAt,
          provenance: { donor: `${DONOR.repo}@${DONOR.commit}`, table: "activity_events", activityEventId: g.rowKey },
        }));
      }
      const norm = { ...row, timestamp: iso(row.timestamp), created_at: iso(row.created_at), source_updated_at: row.source_updated_at ? iso(row.source_updated_at) : null };
      const module = this.registry.forEventSource(row.source);
      const custom = module?.mapEvent ? await module.mapEvent(norm, ctx, g.journal) : null;
      return custom ?? defaultEventChanges(this.registry, norm, g.journal);
    }
    const extra = this.registry.extraTable(g.table);
    if (!extra) throw new Error(`no source-lane exporter is registered for table ${g.table}`);
    return extra.table.map(ctx, g.rowKey, g.journal, await this.#previousPaths(ctx.tenantId, g.table, g.rowKey));
  }

  async #toWire(client: SourcePublishClient, c: SourceFileChange): Promise<WireChange> {
    const capturedAt = iso(c.capturedAt);
    if (c.op === "delete") {
      return { op: "delete", path: c.path, deletedAt: iso(c.deletedAt), reason: c.reason, capturedAt, ...(c.provenance ? { provenance: c.provenance } : {}) };
    }
    const head = {
      op: "put" as const,
      path: c.path,
      kind: c.kind,
      contentType: c.contentType,
      sourceUpdatedAt: c.sourceUpdatedAt === null ? null : iso(c.sourceUpdatedAt),
      capturedAt,
      ...(c.sourceVersion ? { sourceVersion: c.sourceVersion } : {}),
      ...(c.provenance ? { provenance: c.provenance } : {}),
    };
    return c.chunked ? client.preparePutChunked(head, c.chunked) : client.preparePut(head, c.content);
  }

  /** Path ownership of this row only; a delete never erases another row's ownership of the same path. */
  async #recordExported(f: Fence, item: MappedItem): Promise<void> {
    for (const c of item.changes) {
      if (c.op === "put") {
        await this.db.execute(sql`
          INSERT INTO source_lane_exported (tenant_id, table_name, row_key, path)
          SELECT ${f.tenantId}, ${item.group.table}, ${item.group.rowKey}, ${c.path} WHERE ${this.#held(f)}
          ON CONFLICT (tenant_id, table_name, row_key, path) DO UPDATE SET exported_at = now()
        `);
      } else {
        await this.db.execute(sql`
          DELETE FROM source_lane_exported
          WHERE tenant_id = ${f.tenantId} AND table_name = ${item.group.table} AND row_key = ${item.group.rowKey} AND path = ${c.path} AND ${this.#held(f)}
        `);
      }
    }
  }

  // ---------------------------------------------------------------- passes

  async runOnce(): Promise<ExportPassResult> {
    const claimed = await this.#claim();
    const result: ExportPassResult = { claimed: claimed.length, acked: 0, deadLettered: 0, released: 0, tenants: 0 };
    const byTenant = new Map<string, JournalRow[]>();
    for (const r of claimed) {
      const list = byTenant.get(r.tenant_id) ?? [];
      list.push(r);
      byTenant.set(r.tenant_id, list);
    }
    for (const [tenantId, list] of byTenant) {
      result.tenants += 1;
      try {
        const r = await this.#exportTenant(tenantId, list);
        result.acked += r.acked;
        result.deadLettered += r.deadLettered;
        result.released += r.released;
      } catch (error) {
        // Unexpected failure: give every row of this tenant back with backoff.
        const ids = list.map((x) => x.id);
        await this.#release(ids, backoffSeconds(Math.max(...list.map((x) => x.attempts))), `export failed: ${errText(error)}`);
        result.released += ids.length;
        this.#log(`tenant ${tenantId}: export pass failed: ${errText(error)}`);
      }
    }
    return result;
  }

  async #exportTenant(tenantId: string, list: JournalRow[]): Promise<{ acked: number; deadLettered: number; released: number }> {
    const fence = await this.#lockTenant(tenantId);
    if (fence === null) {
      // Another exporter is publishing this tenant; give the rows back without penalty.
      await this.#release(list.map((r) => r.id), 2, "tenant export in progress on another exporter");
      return { acked: 0, deadLettered: 0, released: list.length };
    }
    try {
      return await this.#exportTenantLocked({ tenantId, fence }, list);
    } finally {
      await this.#unlockTenant(tenantId, fence);
    }
  }

  async #exportTenantLocked(f: Fence, list: JournalRow[]): Promise<{ acked: number; deadLettered: number; released: number }> {
    const tenantId = f.tenantId;
    const out = { acked: 0, deadLettered: 0, released: 0 };
    const binding = await getTenantBinding(this.db, tenantId);
    if (!binding) {
      await this.#release(list.map((r) => r.id), 300, "no source binding for this tenant (provision it from yc_msaw POST /v1/sources/bindings)");
      out.released += list.length;
      return out;
    }
    const client = new SourcePublishClient(binding.publishUrl, binding.token, this.#fetch);
    const ctx: ExportContext = { tenantId, executor: this.db };

    const groups = new Map<string, KeyGroup>();
    for (const r of list) {
      const k = `${r.table_name}\u0000${r.row_key}`;
      const at = iso(r.enqueued_at);
      const g = groups.get(k);
      if (!g) groups.set(k, { table: r.table_name, rowKey: r.row_key, ids: [r.id], journal: { op: r.op, enqueuedAt: at }, attempts: r.attempts });
      else {
        g.ids.push(r.id);
        g.attempts = Math.max(g.attempts, r.attempts);
        if (at >= g.journal.enqueuedAt) g.journal = { op: r.op, enqueuedAt: at };
      }
    }

    const items: MappedItem[] = [];
    for (const g of groups.values()) {
      try {
        items.push({ group: g, changes: await this.#mapWithMoves(ctx, g) });
      } catch (error) {
        out.deadLettered += await this.#deadLetter(g.ids, `map failed: ${errText(error)}`, f);
      }
    }

    // Items with nothing to publish (e.g. generated navigation) are done.
    const empty = items.filter((i) => i.changes.length === 0);
    out.acked += await this.#ack(empty.flatMap((i) => i.group.ids), f);

    let batch: MappedItem[] = [];
    let paths = new Set<string>();
    let size = 0;
    let count = 0;
    const flush = async () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      paths = new Set();
      size = 0;
      count = 0;
      const r = await this.#publish(client, f, current);
      out.acked += r.acked;
      out.deadLettered += r.deadLettered;
      out.released += r.released;
    };
    for (const item of items) {
      if (!item.changes.length) continue;
      const itemPaths = item.changes.map((c) => c.path);
      const itemBytes = item.changes.reduce((s, c) => s + (c.op === "put" ? Math.min(c.chunked ? c.chunked.size : c.content.length, 200 * 1024) * 1.4 + 1024 : 512), 0);
      if (count + item.changes.length > MAX_BATCH_CHANGES || size + itemBytes > MAX_BATCH_JSON_BYTES || itemPaths.some((p) => paths.has(p))) await flush();
      batch.push(item);
      for (const p of itemPaths) paths.add(p);
      size += itemBytes;
      count += item.changes.length;
    }
    await flush();
    this.#lastExportAt.set(tenantId, new Date().toISOString());
    return out;
  }

  async #publish(client: SourcePublishClient, f: Fence, items: MappedItem[]): Promise<{ acked: number; deadLettered: number; released: number }> {
    const out = { acked: 0, deadLettered: 0, released: 0 };
    const allIds = items.flatMap((i) => i.group.ids);
    if (!(await this.#renew(f.tenantId, f.fence))) {
      // Lost the tenant lease (e.g. paused past it): another exporter owns this tenant now.
      await this.#release(allIds, 2, "tenant export lease lost before publish");
      out.released += allIds.length;
      return out;
    }
    let receipt: PublishReceipt;
    let wire: WireChange[];
    try {
      wire = [];
      for (const item of items) for (const c of item.changes) wire.push(await this.#toWire(client, c));
      const minId = items.reduce((m, i) => Math.min(m, ...i.group.ids.map(Number)), Number.MAX_SAFE_INTEGER);
      // The digest makes a retry that re-read newer row state a different batch, never a batch_conflict.
      const batchId = `exp-${minId}-${sha256(JSON.stringify(wire)).slice(0, 24)}`;
      receipt = await client.publish(batchId, wire);
    } catch (error) {
      if (error instanceof PublishError && !error.retryable && error.status !== 401 && error.status !== 403 && items.length > 1) {
        // A permanent refusal of the batch: isolate the offending rows by publishing one item at a time.
        for (const item of items) {
          const r = await this.#publish(client, f, [item]);
          out.acked += r.acked;
          out.deadLettered += r.deadLettered;
          out.released += r.released;
        }
        return out;
      }
      if (error instanceof PublishError && !error.retryable && error.status !== 401 && error.status !== 403) {
        out.deadLettered += await this.#deadLetter(allIds, `publish refused (${error.code}): ${error.message}`, f);
        return out;
      }
      const attempts = Math.max(...items.map((i) => i.group.attempts));
      const delay = error instanceof PublishError && error.retryAfterSeconds !== null ? Math.max(error.retryAfterSeconds, 1) : error instanceof PublishError && (error.status === 401 || error.status === 403) ? 600 : backoffSeconds(attempts);
      await this.#release(allIds, delay, `publish failed: ${errText(error)}`);
      out.released += allIds.length;
      return out;
    }
    let index = 0;
    for (const item of items) {
      const results = receipt.results.slice(index, index + item.changes.length);
      index += item.changes.length;
      const rejected = results.filter((r) => r.outcome === "rejected");
      if (rejected.length || results.length !== item.changes.length) {
        const why = rejected.map((r) => `${r.path}: ${r.error?.code ?? "rejected"} ${r.error?.message ?? ""}`.trim()).join("; ") || "receipt did not cover every change";
        out.deadLettered += await this.#deadLetter(item.group.ids, `rejected by sources store: ${why}`, f);
        continue;
      }
      await this.#recordExported(f, item);
      out.acked += await this.#ack(item.group.ids, f);
    }
    return out;
  }

  // ---------------------------------------------------------------- coverage

  /** Export-lane and provider coverage for one tenant (module reports + journal backlog + connections). */
  async coverage(tenantId: string): Promise<CoverageReport[]> {
    const ctx: ExportContext = { tenantId, executor: this.db };
    const reports: CoverageReport[] = [];
    const reported = new Set<string>();
    for (const m of this.registry.modules) {
      if (!m.coverage) continue;
      try {
        const r = await m.coverage(ctx);
        reports.push(...r);
        for (const x of r) reported.add(x.provider);
      } catch (error) {
        reports.push({ provider: m.id, scope: "coverage", state: "blocked", reason: "provider coverage check failed", lastError: errText(error), lastErrorAt: new Date().toISOString() });
        reported.add(m.id);
      }
    }
    // Journal backlog and dead letters per provider directory, aggregated in SQL. activity_events rows are joined
    // through the uuid primary key (a text cast of the key would scan the table once per journal row).
    const backlog = rows<{ table_name: string; mirror_dir: string | null; source: string | null; dead: boolean; n: number; last_error: string | null }>(
      await this.db.execute(sql`
        SELECT j.table_name,
               CASE WHEN j.table_name = 'mirror_files' THEN substring(j.row_key FROM '^sources/([^/]+)/') END AS mirror_dir,
               a.source, (j.dead_lettered_at IS NOT NULL) AS dead, count(*)::int AS n, max(j.last_error) AS last_error
        FROM source_lane_journal j
        LEFT JOIN activity_events a
          ON j.table_name = 'activity_events' AND a.user_id = j.tenant_id
         AND a.id = (CASE WHEN j.row_key ~ ${UUID_SQL_RE} THEN j.row_key::uuid END)
        WHERE j.tenant_id = ${tenantId}
        GROUP BY 1, 2, 3, 4
      `),
    );
    const perProvider = new Map<string, { backlog: number; dead: number; error: string | null }>();
    for (const b of backlog) {
      const provider =
        b.table_name === "mirror_files" ? (b.mirror_dir ?? "unknown-source")
        : b.table_name === "activity_events" ? (b.source ? rawEventDir(this.registry, { source: b.source }) : "unknown-source")
        : (this.registry.extraTable(b.table_name)?.provider.id ?? "unknown-source");
      const p = perProvider.get(provider) ?? { backlog: 0, dead: 0, error: null };
      const n = Number(b.n);
      if (b.dead) {
        p.dead += n;
        p.error ??= b.last_error;
      } else p.backlog += n;
      perProvider.set(provider, p);
    }
    for (const [provider, p] of perProvider) {
      reports.push({
        provider,
        scope: "export",
        state: p.dead > 0 ? "partial" : "pending",
        reason: p.dead > 0 ? `${p.dead} change(s) could not be exported and are dead-lettered: ${p.error ?? "unknown error"}` : `${p.backlog} change(s) waiting to be exported`,
        counts: { backlog: p.backlog, deadLettered: p.dead },
      });
    }
    // Connections whose provider module does not report coverage are presented as unknown, never complete.
    const conns = rows<{ provider: string; status: string; updated_at: string | Date }>(
      await this.db.execute(sql`SELECT provider, status, updated_at FROM connections WHERE tenant_id = ${tenantId}`),
    );
    for (const c of conns) {
      const targets = this.registry.modules.filter((m) => feedsFrom(m).includes(c.provider));
      const ids = targets.length ? [...new Set(targets.map((m) => m.id))] : [c.provider.replace(/[^a-z0-9-]+/g, "-")];
      for (const id of ids) {
        if (reported.has(id)) continue;
        reports.push({
          provider: id,
          scope: `connection:${c.provider}`,
          state: c.status === "active" ? "pending" : "blocked",
          reason:
            c.status === "active"
              ? "connected; data captured since connect is exported, but this provider's module does not report completeness yet"
              : `connection is ${c.status}`,
        });
      }
    }
    const last = this.#lastExportAt.get(tenantId);
    for (const r of reports) if (r.scope === "export" && last) r.lastSuccessAt ??= last;
    return reports;
  }

  async reportStatus(tenantId: string): Promise<boolean> {
    const binding = await getTenantBinding(this.db, tenantId);
    if (!binding) return false;
    const client = new SourcePublishClient(binding.publishUrl, binding.token, this.#fetch);
    await client.reportStatus(await this.coverage(tenantId), {
      version: RUNTIME_VERSION,
      donorCommit: DONOR.commit,
      reportIntervalSeconds: this.reportIntervalSeconds,
      host: hostname().slice(0, 200),
    });
    return true;
  }

  /** Long-running loop: drain the journal, heartbeat coverage per bound tenant, re-arm old dead letters. */
  async run(signal?: AbortSignal): Promise<void> {
    let nextReport = 0;
    let nextRetry = 0;
    while (!signal?.aborted) {
      let pass: ExportPassResult = { claimed: 0, acked: 0, deadLettered: 0, released: 0, tenants: 0 };
      try {
        pass = await this.runOnce();
        if (pass.claimed) this.#log(`claimed=${pass.claimed} acked=${pass.acked} dead=${pass.deadLettered} released=${pass.released}`);
        const now = Date.now();
        if (now >= nextRetry) {
          await this.retryDeadLetters();
          nextRetry = now + DEAD_LETTER_RETRY_SECONDS * 1000;
        }
        if (now >= nextReport) {
          for (const t of await boundTenants(this.db)) {
            try {
              await this.reportStatus(t);
            } catch (error) {
              this.#log(`status report for ${t} failed: ${errText(error)}`);
            }
          }
          nextReport = now + this.reportIntervalSeconds * 1000;
        }
      } catch (error) {
        this.#log(`export loop error: ${errText(error)}`);
      }
      await new Promise((r) => setTimeout(r, pass.claimed > 0 ? 100 : 2_000));
    }
  }
}
