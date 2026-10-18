import { sql } from "drizzle-orm";
import { NangoRateLimitedError } from "./api.js";
import { MODEL_RE, type NangoRecordsModel, type NangoRecordsSource } from "./config.js";
import { rows, safeError, toDate, type NangoRecordsLane } from "./lane.js";
import { pace, recordRateLimited } from "./quota.js";

/**
 * Capability verification: which sync models the Nango environment actually deploys for each
 * configured integration (GET /integrations/{key}/functions?type=sync). A model is
 *
 *   available    a deployed, enabled sync function returns it
 *   disabled     only disabled sync functions return it
 *   not_deployed no deployed sync function returns it (the integration exists)
 *   missing      the integration itself does not exist in the environment
 *   unverified   never checked successfully (no API key, missing functions:list scope, errors)
 *
 * Declared models are polled unless verification proved them disabled/not_deployed/missing;
 * coverage reports the state either way, so nothing is claimed available from the OAuth
 * catalog or the operator config alone.
 */

export const VERIFY_INTERVAL_MS = 15 * 60_000;
const CLAIM_SECONDS = 120;

export type ModelCapability = "available" | "disabled" | "not_deployed" | "missing" | "unverified";

export interface IntegrationCapabilities {
  providerConfigKey: string;
  checkedAt: string | null;
  integrationFound: boolean | null;
  error: string | null;
  models: Map<string, { state: ModelCapability; syncs: string[]; trackDeletes: boolean | null; runs: string | null }>;
}

/** Re-verify one integration if its last check is older than VERIFY_INTERVAL_MS (one worker at a time). */
export async function refreshVerification(lane: NangoRecordsLane, source: NangoRecordsSource, opts: { force?: boolean } = {}): Promise<"checked" | "fresh" | "skipped" | "error"> {
  if (!lane.api) return "skipped";
  const key = source.providerConfigKey;
  await lane.db.execute(sql`INSERT INTO nango_records_verification (provider_config_key) VALUES (${key}) ON CONFLICT DO NOTHING`);
  const claimed = rows(
    await lane.db.execute(sql`
      UPDATE nango_records_verification SET claimed_until = now() + make_interval(secs => ${CLAIM_SECONDS})
      WHERE provider_config_key = ${key}
        AND (claimed_until IS NULL OR claimed_until < now())
        AND (${opts.force === true} OR checked_at IS NULL OR checked_at < now() - make_interval(secs => ${VERIFY_INTERVAL_MS / 1000}))
      RETURNING provider_config_key
    `),
  );
  if (!claimed.length) return "fresh";
  try {
    const gate = await pace(lane.db, lane.api.quotaKey, lane.minRequestIntervalMs);
    if (!gate.ok) {
      await lane.db.execute(sql`UPDATE nango_records_verification SET claimed_until = NULL WHERE provider_config_key = ${key}`);
      return "skipped";
    }
    const result = await lane.api.listSyncFunctions(key);
    await lane.db.execute(sql`DELETE FROM nango_records_capabilities WHERE provider_config_key = ${key}`);
    for (const sync of result.syncs) {
      for (const model of sync.models) {
        await lane.db.execute(sql`
          INSERT INTO nango_records_capabilities (provider_config_key, model, sync_name, enabled, track_deletes, runs, last_deployed, verified_at)
          VALUES (${key}, ${model}, ${sync.name}, ${sync.enabled}, ${sync.trackDeletes}, ${sync.runs}, ${sync.lastDeployed}::timestamptz, now())
          ON CONFLICT (provider_config_key, model, sync_name) DO UPDATE SET enabled = EXCLUDED.enabled, track_deletes = EXCLUDED.track_deletes,
            runs = EXCLUDED.runs, last_deployed = EXCLUDED.last_deployed, verified_at = now()
        `);
        // Deployed models the operator did not enable are surfaced, never silently captured or dropped.
        if (!source.discoverModels && !source.models.some((m) => m.model === model)) await noteUnconfiguredModel(lane, key, model, "");
      }
    }
    await lane.db.execute(sql`
      UPDATE nango_records_verification SET checked_at = now(), claimed_until = NULL, integration_found = ${result.found}, error = NULL, error_at = NULL
      WHERE provider_config_key = ${key}
    `);
    return "checked";
  } catch (error) {
    if (error instanceof NangoRateLimitedError) await recordRateLimited(lane.db, lane.api.quotaKey, { retryAt: error.retryAt, status: error.status, rate: error.rate });
    await lane.db.execute(sql`
      UPDATE nango_records_verification SET claimed_until = NULL, error = ${safeError(error)}, error_at = now() WHERE provider_config_key = ${key}
    `);
    return "error";
  }
}

export async function noteUnconfiguredModel(lane: NangoRecordsLane, providerConfigKey: string, model: string, tenantId: string): Promise<void> {
  if (!MODEL_RE.test(model)) return;
  await lane.db.execute(sql`
    INSERT INTO nango_records_unconfigured_models (provider_config_key, model, tenant_id) VALUES (${providerConfigKey}, ${model}, ${tenantId})
    ON CONFLICT (provider_config_key, model, tenant_id) DO UPDATE SET last_seen_at = now(), seen_count = nango_records_unconfigured_models.seen_count + 1
  `);
}

export async function loadCapabilities(lane: NangoRecordsLane, source: NangoRecordsSource): Promise<IntegrationCapabilities> {
  const key = source.providerConfigKey;
  const v = rows<{ checked_at: unknown; integration_found: boolean | null; error: string | null }>(
    await lane.db.execute(sql`SELECT checked_at, integration_found, error FROM nango_records_verification WHERE provider_config_key = ${key}`),
  )[0];
  const caps = rows<{ model: string; sync_name: string; enabled: boolean; track_deletes: boolean | null; runs: string | null }>(
    await lane.db.execute(sql`SELECT model, sync_name, enabled, track_deletes, runs FROM nango_records_capabilities WHERE provider_config_key = ${key} ORDER BY model, sync_name`),
  );
  const checkedAt = toDate(v?.checked_at)?.toISOString() ?? null;
  const found = checkedAt ? (v?.integration_found ?? null) : null;
  const models: IntegrationCapabilities["models"] = new Map();
  const names = new Set<string>([...source.models.map((m) => m.model), ...(source.discoverModels ? caps.map((c) => c.model) : [])]);
  for (const name of names) {
    const forModel = caps.filter((c) => c.model === name);
    const enabled = forModel.filter((c) => c.enabled);
    const state: ModelCapability =
      !checkedAt ? "unverified"
      : found === false ? "missing"
      : enabled.length ? "available"
      : forModel.length ? "disabled"
      : "not_deployed";
    const pick = enabled[0] ?? forModel[0];
    models.set(name, {
      state,
      syncs: forModel.map((c) => c.sync_name),
      trackDeletes: deletesTracked(enabled.length ? enabled : forModel),
      runs: pick?.runs ?? null,
    });
  }
  return { providerConfigKey: key, checkedAt, integrationFound: found, error: v?.error ?? null, models };
}

/** Deletes are tracked if any (enabled) sync returning the model tracks them; unknown when none reports it. */
function deletesTracked(syncs: ReadonlyArray<{ track_deletes: boolean | null }>): boolean | null {
  if (syncs.some((c) => c.track_deletes === true)) return true;
  return syncs.some((c) => c.track_deletes === false) ? false : null;
}

/** Models of a source the lane reads from Nango now (declared, or discovered as deployed when discoverModels). */
export function modelsToPoll(source: NangoRecordsSource, caps: IntegrationCapabilities): NangoRecordsModel[] {
  const out: NangoRecordsModel[] = [];
  for (const [name, cap] of caps.models) {
    if (cap.state === "missing" || cap.state === "disabled" || cap.state === "not_deployed") continue;
    const declared = source.models.find((m) => m.model === name);
    if (declared) out.push(declared);
    else if (source.discoverModels && cap.state === "available") out.push({ model: name, eventType: name.trim().toLowerCase().replace(/\s+/gu, "_") });
  }
  return out;
}
