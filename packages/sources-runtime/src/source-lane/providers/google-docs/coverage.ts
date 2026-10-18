/**
 * Truthful coverage for the Docs/Drive source lane, computed from durable
 * checkpoints (never static claims):
 *
 *  - drive-inventory      from the resumable full Drive listing per mailbox
 *                         (inventory.ts): `complete` only once every roster
 *                         mailbox finished a gap-free listing; until then files
 *                         untouched since connect may be absent (`partial`/`pending`).
 *  - docs-content         documents.get native JSON / tabs / images per tracked Doc.
 *  - docs-history         OT changelog (undocumented, writer+-gated). `blocked`
 *                         with `ot_requires_bearer` for Composio connections;
 *                         `partial` whenever any doc's capture is partial/blocked/error.
 *  - drive-files          Sheets/Slides (files.export + native JSON) and binary
 *                         files (alt=media) with their explicit size limits.
 *
 * Lag is reported as counts of not-yet-exported files and the oldest pending age.
 *
 *  - docs-poll            recency of the last completed gdocs.poll (scheduled every 60 s). When it is older than
 *                         DOCS_POLL_LAG_SECONDS (or never ran while files are tracked), no scope may claim
 *                         `complete`: checkpoints say what was captured, not that edits are still being captured.
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, CoverageState, ExportContext } from "../../core/types.js";
import { docsHistoryCapability, googleAuthModeFromMetadata } from "./auth-mode.js";
import { DRIVE_EXPORT_MAX_BYTES, DRIVE_FILE_MAX_BYTES, DRIVE_NATIVE_JSON_MAX_BYTES, FILES_EXPORT_LIMIT_BYTES, GOOGLE_DOC_MIME } from "./drive-export.js";
import { GOOGLE_DOCS_PROVIDER_ID, rowsOf, type SqlDatabase } from "./store.js";
import { inventoryCoverage, listInventory } from "./inventory.js";

interface Row {
  mime_type: string | null;
  lifecycle_state: string;
  content_state: string;
  content_reason: string | null;
  content_exported_at: Date | string | null;
  history_state: string;
  history_reason: string | null;
  history_complete_at: Date | string | null;
  history_attempted_at: Date | string | null;
  updated_at: Date | string;
}

function iso(v: unknown): string | undefined {
  if (v == null) return undefined;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function maxIso(values: unknown[]): string | undefined {
  let best: number | null = null;
  for (const v of values) {
    const s = iso(v);
    if (!s) continue;
    const t = Date.parse(s);
    if (best == null || t > best) best = t;
  }
  return best == null ? undefined : new Date(best).toISOString();
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Collapse per-file states into one scope state; any gap => not complete. */
export function scopeState(counts: Record<string, number>, total: number): CoverageState {
  if (total === 0) return "pending";
  if ((counts.complete ?? 0) + (counts.not_applicable ?? 0) === total) return "complete";
  if ((counts.blocked ?? 0) === total) return "blocked";
  if ((counts.partial ?? 0) + (counts.error ?? 0) + (counts.blocked ?? 0) + (counts.unsupported ?? 0) > 0) return "partial";
  return "pending";
}

/** gdocs.poll runs every 60 s (queue/dispatch.ts); 15 minutes without a completed poll means capture stopped. */
export const DOCS_POLL_INTERVAL_SECONDS = 60;
export const DOCS_POLL_LAG_SECONDS = 15 * 60;

export async function googleDocsCoverage(ctx: ExportContext, now: Date = new Date()): Promise<CoverageReport[]> {
  const rows = rowsOf<Row>(await ctx.executor.execute(sql`
    SELECT mime_type, lifecycle_state, content_state, content_reason, content_exported_at,
           history_state, history_reason, history_complete_at, history_attempted_at, updated_at
    FROM gdocs_file_checkpoints WHERE tenant_id = ${ctx.tenantId}
  `));
  const [token] = rowsOf<{ metadata: Record<string, unknown> | string | null }>(await ctx.executor.execute(sql`
    SELECT metadata FROM integration_tokens WHERE user_id = ${ctx.tenantId} AND provider = 'google' LIMIT 1
  `).catch(() => []));
  const metadata = typeof token?.metadata === "string" ? JSON.parse(token.metadata) as Record<string, unknown> : token?.metadata ?? null;
  const mode = googleAuthModeFromMetadata(metadata);
  const capability = docsHistoryCapability(mode);

  const live = rows.filter((r) => r.lifecycle_state === "active");
  const docs = live.filter((r) => r.mime_type === GOOGLE_DOC_MIME);
  const drive = live.filter((r) => r.mime_type !== GOOGLE_DOC_MIME);
  const oldestPendingSeconds = (list: Row[], field: "content_state" | "history_state") => {
    const pending = list.filter((r) => r[field] === "pending").map((r) => Date.parse(iso(r.updated_at) ?? ""));
    return pending.length ? Math.max(0, Math.round((now.getTime() - Math.min(...pending)) / 1000)) : 0;
  };
  const reasons = (list: Row[], field: "content_reason" | "history_reason") =>
    [...new Set(list.map((r) => r[field]).filter((r): r is string => Boolean(r)))].slice(0, 10).join("; ") || undefined;

  const reports: CoverageReport[] = [];
  const inventoryRows = await listInventory(ctx.tenantId, { db: ctx.executor as unknown as SqlDatabase }).catch(() => []);
  let roster: string[] | null = null;
  try {
    const { listGoogleMailboxes } = await import("../../../integrations/google/mailboxes.js");
    roster = await listGoogleMailboxes(ctx.tenantId, ctx.executor as never);
  } catch {
    roster = null;
  }
  const inventory = inventoryCoverage(inventoryRows, roster);
  reports.push({
    provider: GOOGLE_DOCS_PROVIDER_ID,
    scope: "drive-inventory",
    state: inventory.state,
    reason: inventory.reason,
    ...(inventory.lastSuccessAt ? { lastSuccessAt: inventory.lastSuccessAt } : {}),
    counts: {
      ...inventory.counts,
      trackedFiles: rows.length,
      active: live.length,
      trashed: rows.filter((r) => r.lifecycle_state === "trashed").length,
      removed: rows.filter((r) => r.lifecycle_state === "removed").length,
    },
  });

  const docContent = tally(docs.map((r) => r.content_state));
  reports.push({
    provider: GOOGLE_DOCS_PROVIDER_ID,
    scope: "docs-content",
    // Composio never hands out a bearer, and the Docs content path needs one.
    state: capability.content ? scopeState(docContent, docs.length) : "blocked",
    reason: !capability.content
      ? `${capability.contentReason}: auth mode ${mode} has no Google bearer; documents.get content, images and snapshot diffs are not captured`
      : reasons(docs, "content_reason") ?? "documents.get native JSON, per-tab JSON, image bytes (contentUri never stored)",
    lastSuccessAt: maxIso(docs.map((r) => r.content_exported_at)),
    counts: { ...docContent, docs: docs.length, oldestPendingSeconds: oldestPendingSeconds(docs, "content_state") },
  });

  const historyCounts = tally(docs.map((r) => r.history_state));
  let historyState = scopeState(historyCounts, docs.length);
  // Even a fully complete set is history of an undocumented endpoint; keep
  // that visible, and never let Composio claim it.
  if (!capability.changelog) historyState = "blocked";
  reports.push({
    provider: GOOGLE_DOCS_PROVIDER_ID,
    scope: "docs-history",
    state: historyState,
    reason: !capability.changelog
      ? `${capability.reason}: auth mode ${mode} cannot call the private /revisions/load changelog${capability.content ? "; snapshot diffs only" : "; Docs content and snapshot diffs are unavailable too (bearer-only lane)"}`
      : `undocumented /revisions/load (writer+ role, no SLA); auth mode ${mode}${reasons(docs, "history_reason") ? `; ${reasons(docs, "history_reason")}` : ""}`,
    lastSuccessAt: maxIso(docs.map((r) => r.history_complete_at)),
    counts: { ...historyCounts, docs: docs.length, oldestPendingSeconds: oldestPendingSeconds(docs, "history_state") },
  });

  const driveCounts = tally(drive.map((r) => r.content_state));
  reports.push({
    provider: GOOGLE_DOCS_PROVIDER_ID,
    scope: "drive-files",
    state: scopeState(driveCounts, drive.length),
    reason: [
      `limits: files.export documented ${FILES_EXPORT_LIMIT_BYTES} bytes (exportLinks fallback), export cap ${DRIVE_EXPORT_MAX_BYTES}, media cap ${DRIVE_FILE_MAX_BYTES}, native JSON cap ${DRIVE_NATIVE_JSON_MAX_BYTES}`,
      "PDFs are exported by the drive-pdf binary lane, not here",
      reasons(drive, "content_reason"),
    ].filter(Boolean).join("; "),
    lastSuccessAt: maxIso(drive.map((r) => r.content_exported_at)),
    counts: { ...driveCounts, files: drive.length, oldestPendingSeconds: oldestPendingSeconds(drive, "content_state") },
  });

  // Per-account current views of view-only Docs (account-capture.ts): one scope per mailbox, so the owner of that
  // mailbox sees what of its readable view was captured and what is withheld from it (yc_msaw shows `account:<mb>`
  // only to that owner). Non-Doc files a mailbox may only view have no account capture: counted as withheld.
  const accountRows = rowsOf<{ mailbox: string; state: string; n: number | string; last: unknown }>(await ctx.executor.execute(sql`
    SELECT mailbox, state, count(*)::int AS n, max(captured_at) AS last
    FROM gdocs_account_captures WHERE tenant_id = ${ctx.tenantId} GROUP BY mailbox, state
  `).catch(() => []));
  const viewOnlyOther = rowsOf<{ mailbox: string; n: number | string }>(await ctx.executor.execute(sql`
    SELECT v.mailbox, count(*)::int AS n FROM gdocs_file_visibility v
    LEFT JOIN gdocs_file_checkpoints c ON c.tenant_id = v.tenant_id AND c.file_id = v.file_id
    WHERE v.tenant_id = ${ctx.tenantId} AND v.visible AND v.can_read_revisions = false
      AND c.mime_type IS DISTINCT FROM ${GOOGLE_DOC_MIME}
    GROUP BY v.mailbox
  `).catch(() => []));
  for (const mailbox of [...new Set([...accountRows.map((r) => r.mailbox), ...viewOnlyOther.map((r) => r.mailbox)])].sort()) {
    const counts: Record<string, number> = {};
    for (const r of accountRows.filter((x) => x.mailbox === mailbox)) counts[r.state] = Number(r.n);
    const withheld = Number(viewOnlyOther.find((r) => r.mailbox === mailbox)?.n ?? 0);
    const active = Object.entries(counts).filter(([s]) => s !== "superseded" && s !== "retired").reduce((n, [, c]) => n + c, 0);
    let state = scopeState(counts, active);
    // Withheld non-Doc files are a standing gap for this account: never `complete`/`pending` while they exist.
    if (withheld > 0 && (state === "complete" || state === "pending")) state = "partial";
    reports.push({
      provider: GOOGLE_DOCS_PROVIDER_ID,
      scope: `account:${mailbox}`,
      state,
      reason: [
        "current view of Docs this account may only read or comment on, captured under its own credential (documents.get as that account; suggestions only if Google shows them to it); writer-only revision history, OT changelog, sessions, comments, suggestion cards and other accounts' copies are not part of it",
        withheld > 0 ? `${withheld} view-only Sheets/Slides/Drive files/PDFs withheld: viewer_current_content_not_captured` : null,
      ].filter(Boolean).join("; "),
      lastSuccessAt: maxIso(accountRows.filter((x) => x.mailbox === mailbox).map((x) => x.last)),
      counts: { ...counts, docs: active, viewOnlyOtherFilesWithheld: withheld },
    });
  }

  const [poll] = rowsOf<{ last_completed: Date | string | null; last_failed: Date | string | null }>(await ctx.executor.execute(sql`
    SELECT max(completed_at) FILTER (WHERE status = 'completed') AS last_completed,
           max(failed_at) FILTER (WHERE status = 'failed') AS last_failed
    FROM source_sync_runs
    WHERE user_id = ${ctx.tenantId} AND provider = 'google' AND metadata->>'taskKind' = 'gdocs.poll'
  `));
  const lastPoll = iso(poll?.last_completed);
  const pollAge = lastPoll ? Math.max(0, Math.round((now.getTime() - Date.parse(lastPoll)) / 1000)) : null;
  const pollFresh = pollAge !== null && pollAge <= DOCS_POLL_LAG_SECONDS;
  const lastFailed = iso(poll?.last_failed);
  reports.push({
    provider: GOOGLE_DOCS_PROVIDER_ID,
    scope: "docs-poll",
    state: pollFresh ? "complete" : rows.length === 0 && pollAge === null ? "pending" : "partial",
    reason: pollFresh
      ? `edits polled ${pollAge} s ago`
      : pollAge === null
        ? "no completed gdocs.poll yet: edits since the last capture are not being collected"
        : `last completed gdocs.poll was ${pollAge} s ago (bound ${DOCS_POLL_LAG_SECONDS} s): edits since then are not captured`,
    ...(lastPoll ? { lastSuccessAt: lastPoll } : {}),
    ...(lastFailed ? { lastErrorAt: lastFailed } : {}),
    expectedIntervalSeconds: DOCS_POLL_INTERVAL_SECONDS * 5,
  });
  if (!pollFresh) {
    for (const r of reports) {
      if (r.scope !== "docs-poll" && r.state === "complete") {
        r.state = "partial";
        r.reason = `${r.reason ? `${r.reason}; ` : ""}not current: no completed gdocs.poll within ${DOCS_POLL_LAG_SECONDS} s`;
      }
    }
  }
  return reports;
}
