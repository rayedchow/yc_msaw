import { sql } from "drizzle-orm";
import type { CoverageReport } from "../../core/types.js";
import { CONTROL_MODULE_ID, type NangoRecordsSource } from "./config.js";
import { tenantConnections } from "./connections.js";
import { rows, toDate, type NangoRecordsLane } from "./lane.js";
import { quotaBlockedUntil } from "./quota.js";
import { loadCapabilities, modelsToPoll, type ModelCapability } from "./verify.js";

/**
 * Coverage of the generic lane. Never `complete`: Nango's records cache holds only the latest
 * payload of each record (changes between two Nango sync runs are not observable), how far back
 * the first sync reaches is decided by the Nango sync function, payloads untouched for 30 days
 * are pruned, and deletes are only visible when the sync tracks them. The best state is
 * `partial` with those reasons; `pending` until the first full pass is caught up; `blocked`
 * when the account, integration, model or API key cannot be read.
 */

const CACHE_LIMITS = "Nango /records keeps only the latest payload per record (no intermediate versions); history depth is set by the Nango sync function";

function capabilityReason(state: ModelCapability, model: string, key: string): string | null {
  switch (state) {
    case "missing":
      return `Nango integration ${key} does not exist in this environment`;
    case "disabled":
      return `the sync function returning ${model} is deployed but disabled in Nango`;
    case "not_deployed":
      return `no deployed Nango sync function returns ${model}`;
    case "unverified":
      return `deployment of ${model} not yet verified (GET /integrations/${key}/functions)`;
    default:
      return null;
  }
}

interface CheckpointRow {
  connection_id: string;
  model: string;
  cursor: string | null;
  full_pass_completed_at: unknown;
  caught_up_at: unknown;
  backlog: boolean;
  last_success_at: unknown;
  last_error_at: unknown;
  last_error: string | null;
  last_sync_webhook_error: string | null;
  last_sync_webhook_error_at: unknown;
  pages_total: string | number;
  records_total: string | number;
  stored_total: string | number;
  tombstones_total: string | number;
  pruned_skipped_total: string | number;
  cursor_resets: string | number;
}

export async function sourceCoverage(lane: NangoRecordsLane, source: NangoRecordsSource, tenantId: string): Promise<CoverageReport[]> {
  const out: CoverageReport[] = [];
  const caps = await loadCapabilities(lane, source);
  const conns = await tenantConnections(lane, tenantId, source.source);
  const blockedUntil = lane.api ? await quotaBlockedUntil(lane.db, lane.api.quotaKey) : null;
  if (!lane.api) out.push({ provider: source.source, scope: `nango:${source.providerConfigKey}`, state: "blocked", reason: "NANGO_SECRET_KEY is not configured; nothing is read from Nango" });
  if (!conns.length) {
    const open = Number(rows<{ n: number | string }>(await lane.db.execute(sql`SELECT count(*)::int AS n FROM nango_records_connect_sessions WHERE tenant_id = ${tenantId} AND source = ${source.source} AND outcome = 'pending' AND expires_at > now()`))[0]?.n ?? 0);
    out.push({
      provider: source.source,
      scope: `nango:${source.providerConfigKey}`,
      state: "pending",
      reason: `configured (${[...caps.models.keys()].join(", ") || "models discovered from deployed syncs"}); no account connected for this tenant${open ? ` (${open} connect session(s) open)` : ""}`,
    });
    return out;
  }
  const cps = rows<CheckpointRow>(
    await lane.db.execute(sql`
      SELECT connection_id, model, cursor, full_pass_completed_at, caught_up_at, backlog, last_success_at, last_error_at, last_error,
             last_sync_webhook_error, last_sync_webhook_error_at, pages_total, records_total, stored_total, tombstones_total, pruned_skipped_total, cursor_resets
      FROM nango_records_checkpoints WHERE tenant_id = ${tenantId} AND provider_config_key = ${source.providerConfigKey}
    `),
  );
  const polled = new Set(modelsToPoll(source, caps).map((m) => m.model));
  for (const c of conns) {
    for (const [model, cap] of caps.models) {
      const scope = `nango:${source.providerConfigKey}:${c.connectionId}:${model}`;
      const cp = cps.find((r) => r.connection_id === c.connectionId && r.model === model);
      const counts = cp
        ? { pages: Number(cp.pages_total), records: Number(cp.records_total), versionsStored: Number(cp.stored_total), tombstones: Number(cp.tombstones_total), prunedSkipped: Number(cp.pruned_skipped_total), cursorResets: Number(cp.cursor_resets) }
        : undefined;
      const base = {
        provider: source.source,
        scope,
        ...(cp?.cursor ? { cursor: cp.cursor.slice(0, 200) } : {}),
        ...(toDate(cp?.last_success_at) ? { lastSuccessAt: toDate(cp!.last_success_at)!.toISOString() } : {}),
        ...(toDate(cp?.last_error_at) ? { lastErrorAt: toDate(cp!.last_error_at)!.toISOString(), lastError: cp!.last_error ?? "error" } : {}),
        ...(counts ? { counts } : {}),
      };
      if (c.status === "revoked") {
        out.push({ ...base, state: "blocked", reason: `connection revoked${c.lastError ? `: ${c.lastError}` : ""}; previously captured versions are kept` });
        continue;
      }
      if (c.status === "error") {
        out.push({ ...base, state: "blocked", reason: c.lastError ?? "connection needs re-authorization in Nango" });
        continue;
      }
      const capReason = capabilityReason(cap.state, model, source.providerConfigKey);
      if (!polled.has(model)) {
        out.push({ ...base, state: cap.state === "missing" ? "blocked" : "pending", reason: capReason ?? "model not enabled" });
        continue;
      }
      const reasons: string[] = [CACHE_LIMITS];
      if (capReason) reasons.push(capReason);
      if (cap.trackDeletes === false) reasons.push("the sync does not track deletes; removed records stay as their last version");
      else if (cap.trackDeletes === null) reasons.push("delete tracking unknown");
      if (counts?.prunedSkipped) reasons.push(`${counts.prunedSkipped} record(s) were already pruned by Nango (payload unavailable)`);
      if (cp?.last_sync_webhook_error) reasons.push(`last Nango sync run failed: ${cp.last_sync_webhook_error}`);
      if (blockedUntil) reasons.push(`Nango API rate limited until ${blockedUntil.toISOString()}`);
      if (cp?.backlog) reasons.push("backlog: more record pages pending");
      if (!cp || !toDate(cp.full_pass_completed_at)) {
        out.push({ ...base, state: "pending", reason: `first full read of the Nango records cache not finished; ${reasons.join("; ")}` });
        continue;
      }
      out.push({ ...base, state: "partial", reason: reasons.join("; ") });
    }
  }
  return out;
}

/** Catalog-level status (config errors, refused sources, deployed-but-unenabled models, webhook setup). */
export async function controlCoverage(lane: NangoRecordsLane, tenantId: string): Promise<CoverageReport[]> {
  const out: CoverageReport[] = [];
  for (const e of lane.catalog.errors) out.push({ provider: CONTROL_MODULE_ID, scope: "config", state: "blocked", reason: `NANGO_RECORDS_CONFIG invalid: ${e}` });
  for (const r of lane.catalog.refused) out.push({ provider: CONTROL_MODULE_ID, scope: `source:${r.source}`, state: "blocked", reason: `not registered: ${r.reason}` });
  if (!lane.catalog.sources.length) return out;
  if (!lane.signingKeys.length) out.push({ provider: CONTROL_MODULE_ID, scope: "webhooks", state: "partial", reason: "NANGO_WEBHOOK_SIGNING_KEY not set: webhooks are refused; connections bind and records arrive through polling only" });
  const unconfigured = rows<{ provider_config_key: string; model: string; last_seen_at: unknown }>(
    await lane.db.execute(sql`
      SELECT provider_config_key, model, max(last_seen_at) AS last_seen_at FROM nango_records_unconfigured_models
      WHERE tenant_id IN ('', ${tenantId}) GROUP BY provider_config_key, model ORDER BY provider_config_key, model LIMIT 200
    `),
  );
  for (const u of unconfigured) {
    const s = lane.catalog.sources.find((x) => x.providerConfigKey === u.provider_config_key);
    if (!s || s.discoverModels || s.models.some((m) => m.model === u.model)) continue;
    out.push({ provider: s.source, scope: `nango:${u.provider_config_key}:model:${u.model}`, state: "pending", reason: `Nango produces model ${u.model}, but it is not enabled in NANGO_RECORDS_CONFIG; not captured` });
  }
  return out;
}
