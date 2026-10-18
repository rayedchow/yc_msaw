import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { query } from "./util.js";

/**
 * Truthful iMessage coverage per tenant.
 *
 * Messages are pushed by the user's Mac, so the server can only claim what the device
 * proved. `device:<binding>:messages` is `complete` only when the device's latest
 * all-history `messages_source_sync` run completed with a receipt that passed the donor
 * validation (exhausted, no pending/failed items, coverageFrom null = all history) AND the
 * device's latest local status is not behind (no queued messages, not failed/paused);
 * a bounded receipt or uploads without a receipt are `partial`, never complete.
 * Attachment bytes are never uploaded by the bundled uploader: always `partial` (metadata only).
 * Rejected uploads and pending projections are reported, not hidden.
 */

interface DeviceRow {
  binding_id: string;
  label: string | null;
  status: string;
  revoked_at: string | Date | null;
  last_seen_at: string | Date | null;
  local_status: Record<string, unknown> | null;
  messages: number;
  last_message_at: string | Date | null;
}

interface RunRow {
  binding_id: string;
  status: string;
  coverage_from: string | Date | null;
  coverage_to: string | Date;
  completed_at: string | Date | null;
  failed_at: string | Date | null;
  error_message: string | null;
}

function iso(v: string | Date | null | undefined): string | undefined {
  return v ? (v instanceof Date ? v : new Date(v)).toISOString() : undefined;
}

export async function imessageCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const devices = await query<DeviceRow>(
    ctx.executor,
    sql`SELECT d.binding_id, d.label, d.status, d.revoked_at, d.last_seen_at, d.local_status,
               (SELECT count(*)::int FROM activity_events e WHERE e.user_id = d.tenant_id AND e.source = 'imessage' AND e.raw_payload -> '_observed_binding_ids' ? d.binding_id) AS messages,
               (SELECT max(e.timestamp) FROM activity_events e WHERE e.user_id = d.tenant_id AND e.source = 'imessage' AND e.raw_payload -> '_observed_binding_ids' ? d.binding_id) AS last_message_at
        FROM imessage_devices d WHERE d.tenant_id = ${ctx.tenantId} ORDER BY d.created_at`,
  );
  if (!devices.length) return [];
  const runs = await query<RunRow>(
    ctx.executor,
    sql`SELECT DISTINCT ON (c.binding_id, (r.coverage_from IS NULL)) c.binding_id, r.status, r.coverage_from, r.coverage_to, r.completed_at, r.failed_at, r.error_message
        FROM imessage_device_commands c JOIN source_sync_runs r ON r.id = c.source_sync_run_id
        WHERE c.tenant_id = ${ctx.tenantId}
        ORDER BY c.binding_id, (r.coverage_from IS NULL), r.created_at DESC`,
  );
  const reports: CoverageReport[] = [];
  for (const d of devices) {
    const scope = `device:${d.binding_id}`;
    if (d.status !== "active") {
      reports.push({ provider: "imessage", scope: `${scope}:messages`, state: "blocked", reason: `device revoked${d.revoked_at ? ` at ${iso(d.revoked_at)}` : ""}; it can no longer upload. Messages it uploaded before revocation remain.`, counts: { messages: Number(d.messages) } });
      continue;
    }
    const counts = { messages: Number(d.messages) };
    if (!d.last_seen_at) {
      reports.push({ provider: "imessage", scope: `${scope}:messages`, state: "pending", reason: "device enrolled; the Mac uploader has not connected yet", counts });
      continue;
    }
    const local = d.local_status ?? {};
    const queued = Number(local.queuedMessages ?? 0);
    const localState = typeof local.status === "string" ? local.status : null;
    const fullRun = runs.find((r) => r.binding_id === d.binding_id && r.coverage_from === null);
    const boundedRun = runs.find((r) => r.binding_id === d.binding_id && r.coverage_from !== null);
    const behind = queued > 0 || localState === "failed" || localState === "paused" || localState === "running";
    if (fullRun?.status === "completed" && !behind) {
      reports.push({
        provider: "imessage",
        scope: `${scope}:messages`,
        state: "complete",
        reason: `all-history source sync receipt through ${iso(fullRun.coverage_to)} validated for the device's selected chat scope; later messages are pushed live by the uploader`,
        lastSuccessAt: iso(fullRun.completed_at),
        cursor: iso(fullRun.coverage_to),
        counts,
      });
    } else {
      const why: string[] = [];
      if (fullRun?.status === "failed") why.push(`latest all-history source sync failed: ${fullRun.error_message ?? "unknown"}`);
      else if (fullRun) why.push(`all-history source sync ${fullRun.status}`);
      else if (boundedRun?.status === "completed") why.push(`only a bounded source sync receipt (${iso(boundedRun.coverage_from)} – ${iso(boundedRun.coverage_to)}) exists`);
      else why.push("no validated all-history source sync receipt; coverage is what the uploader has sent since it started");
      if (behind) why.push(`device reports ${localState ?? "unknown"} with ${queued} queued message(s)`);
      reports.push({ provider: "imessage", scope: `${scope}:messages`, state: "partial", reason: why.join("; "), ...(iso(d.last_seen_at) ? { lastSuccessAt: iso(d.last_seen_at) } : {}), counts });
    }
  }
  const attachments = (
    await query<{ n: number }>(
      ctx.executor,
      sql`SELECT COALESCE(sum(jsonb_array_length(raw_payload -> 'attachments')), 0)::int AS n FROM activity_events
          WHERE user_id = ${ctx.tenantId} AND source = 'imessage' AND jsonb_typeof(raw_payload -> 'attachments') = 'array'`,
    )
  )[0]?.n;
  reports.push({
    provider: "imessage",
    scope: "attachments",
    state: "partial",
    reason: "attachment metadata only (name, type, size, transfer status): the bundled Mac uploader protocol does not send attachment bytes",
    counts: { attachmentsWithMetadataOnly: Number(attachments ?? 0) },
  });
  const rejected = await query<{ n: number; last: string | Date | null; reason: string | null }>(
    ctx.executor,
    sql`SELECT count(*)::int AS n, max(received_at) AS last, (array_agg(reason ORDER BY received_at DESC))[1] AS reason FROM imessage_ingest_rejections WHERE tenant_id = ${ctx.tenantId}`,
  );
  if (rejected[0] && Number(rejected[0].n) > 0) {
    reports.push({
      provider: "imessage",
      scope: "rejected-uploads",
      state: "partial",
      reason: `${rejected[0].n} uploaded entr(ies) could not be stored (latest: ${rejected[0].reason}); kept verbatim under sources/imessage/_rejected/`,
      ...(iso(rejected[0].last) ? { lastErrorAt: iso(rejected[0].last) } : {}),
      counts: { rejected: Number(rejected[0].n) },
    });
  }
  const pending = (await query<{ n: number }>(ctx.executor, sql`SELECT count(*)::int AS n FROM imessage_projection_dirty WHERE tenant_id = ${ctx.tenantId}`))[0]?.n ?? 0;
  if (Number(pending) > 0) {
    reports.push({ provider: "imessage", scope: "projections", state: "pending", reason: `${pending} conversation month(s) waiting to be re-rendered; raw records are already stored`, counts: { pending: Number(pending) } });
  }
  return reports;
}
