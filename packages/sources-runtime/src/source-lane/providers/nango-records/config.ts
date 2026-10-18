import { readFileSync } from "node:fs";
import { z } from "zod";
import { NANGO_CONNECTION_PROVIDERS } from "../../../integrations/nango/reconcile.js";
import type { SourceProviderModule } from "../../core/types.js";

/**
 * Operator-declared catalog of Nango integrations captured by the generic records lane.
 *
 * Nothing here is discovered from an OAuth catalog or guessed: every source names the
 * exact Nango integration ID (providerConfigKey) the operator created in their Nango
 * environment, and the sync models to read from it. Whether those models are actually
 * deployed and enabled is verified separately against GET /scripts/config (see
 * verify.ts) and reported in coverage; a declared but unverified model is `pending`.
 *
 * Read from NANGO_RECORDS_CONFIG (JSON) or NANGO_RECORDS_CONFIG_FILE (path to JSON):
 *
 *   {"version":1,"sources":[{"source":"outlook","providerConfigKey":"<your integration id>",
 *     "models":["<SyncModel>", {"model":"<SyncModel2>","eventType":"outlook_event"}],
 *     "discoverModels":false,"pollSeconds":300,"maxConcurrentSyncs":2,"audience":"personal"}]}
 *
 * `audience` (default "personal"): whose account a connection is. A personal source is connected by any member
 * into their own owner scope and published under sources/<source>/<owner segment>/, readable by that member only
 * (core/personal-scope.ts). An "organization" source (one shared workspace account) is connected by an admin for
 * the tenant; yc_msaw serves it to members only when the operator lists it in SOURCES_SHARED_PROVIDERS.
 *
 * A source that collides with a specialized provider (same directory, activity_events
 * source, or a Nango integration the donor lane already captures) is refused: it is not
 * registered and is reported as `blocked`, so specialized integrations stay authoritative.
 */

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Nango integration IDs: letters, digits, '-', '_', '.'; bounded. */
export const PROVIDER_CONFIG_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Sync model names as declared in Nango functions. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_.]{0,127}$/;

export const CONTROL_MODULE_ID = "nango-records";
/** Directory names the generic lane may never take (core/system paths). */
const RESERVED_IDS = new Set([CONTROL_MODULE_ID, "nango", "unknown-source", "_raw", "_meta", "index", "sources"]);

export const DEFAULT_POLL_SECONDS = 300;
export const MIN_POLL_SECONDS = 60;
export const MAX_CONCURRENT_SYNCS = 10;

const ModelSchema = z.union([
  z.string().regex(MODEL_RE),
  z
    .object({
      model: z.string().regex(MODEL_RE),
      eventType: z.string().regex(EVENT_TYPE_RE).optional(),
    })
    .strict(),
]);

const SourceSchema = z
  .object({
    source: z.string().regex(SOURCE_ID_RE),
    providerConfigKey: z.string().regex(PROVIDER_CONFIG_KEY_RE),
    label: z.string().max(200).optional(),
    models: z.array(ModelSchema).max(100).default([]),
    discoverModels: z.boolean().default(false),
    pollSeconds: z.number().int().min(MIN_POLL_SECONDS).max(86_400).default(DEFAULT_POLL_SECONDS),
    maxConcurrentSyncs: z.number().int().min(1).max(MAX_CONCURRENT_SYNCS).default(2),
    /** Extra payload keys holding credentials/ephemeral URLs for this provider (exact key match). */
    redactKeys: z.array(z.string().min(1).max(128)).max(50).default([]),
    audience: z.enum(["personal", "organization"]).default("personal"),
  })
  .strict();

const ConfigSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(SourceSchema).max(200),
  })
  .strict();

export interface NangoRecordsModel {
  model: string;
  eventType: string;
}

export interface NangoRecordsSource {
  source: string;
  providerConfigKey: string;
  label: string;
  models: NangoRecordsModel[];
  discoverModels: boolean;
  pollSeconds: number;
  maxConcurrentSyncs: number;
  redactKeys: string[];
  audience: "personal" | "organization";
}

export interface RefusedSource {
  source: string;
  providerConfigKey: string | null;
  reason: string;
}

export interface NangoRecordsCatalog {
  sources: NangoRecordsSource[];
  refused: RefusedSource[];
  /** Configuration errors (unparseable JSON, schema violations); the lane captures nothing from an invalid config. */
  errors: string[];
}

export function emptyCatalog(): NangoRecordsCatalog {
  return { sources: [], refused: [], errors: [] };
}

/** Event type for a model: explicit, else the donor's generic normalization (lowercase, spaces → '_'). */
function defaultEventType(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/gu, "_");
}

export interface ReservedNames {
  ids: Set<string>;
  eventSources: Set<string>;
  providerConfigKeys: Set<string>;
}

/** Names already owned by specialized modules and the donor Nango lane. */
export function reservedNames(specialized: readonly SourceProviderModule[]): ReservedNames {
  const ids = new Set<string>(RESERVED_IDS);
  const eventSources = new Set<string>();
  const providerConfigKeys = new Set<string>(NANGO_CONNECTION_PROVIDERS.map((p) => p.toLowerCase()));
  for (const m of specialized) {
    ids.add(m.id);
    for (const s of m.eventSources) eventSources.add(s);
    for (const p of m.connectionProviders ?? [m.id]) providerConfigKeys.add(p.toLowerCase());
  }
  return { ids, eventSources, providerConfigKeys };
}

/**
 * Validate a raw config object against the specialized registry. Never throws: a broken
 * config yields `errors` (nothing captured), a colliding source yields `refused`.
 */
export function buildCatalog(raw: unknown, specialized: readonly SourceProviderModule[]): NangoRecordsCatalog {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { sources: [], refused: [], errors: parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).slice(0, 20) };
  }
  const reserved = reservedNames(specialized);
  const sources: NangoRecordsSource[] = [];
  const refused: RefusedSource[] = [];
  const seenIds = new Map<string, string>();
  const seenKeys = new Map<string, string>();
  for (const s of parsed.data.sources) {
    const key = s.providerConfigKey;
    const why =
      reserved.ids.has(s.source) ? `source directory "${s.source}" is owned by a specialized provider module`
      : reserved.eventSources.has(s.source) ? `activity_events source "${s.source}" is claimed by a specialized provider module`
      : reserved.providerConfigKeys.has(key.toLowerCase()) ? `Nango integration "${key}" is captured by a specialized integration (it stays authoritative)`
      : seenIds.has(s.source) ? `source "${s.source}" is declared twice`
      : seenKeys.has(key.toLowerCase()) ? `Nango integration "${key}" is already mapped to source "${seenKeys.get(key.toLowerCase())}"`
      : null;
    if (why) {
      refused.push({ source: s.source, providerConfigKey: key, reason: why });
      continue;
    }
    const models: NangoRecordsModel[] = [];
    const seenModels = new Set<string>();
    for (const m of s.models) {
      const model = typeof m === "string" ? m : m.model;
      if (seenModels.has(model)) continue;
      seenModels.add(model);
      models.push({ model, eventType: typeof m === "string" || !m.eventType ? defaultEventType(model) : m.eventType });
    }
    if (models.length === 0 && !s.discoverModels) {
      refused.push({ source: s.source, providerConfigKey: key, reason: "no models declared and discoverModels is false" });
      continue;
    }
    seenIds.set(s.source, key);
    seenKeys.set(key.toLowerCase(), s.source);
    sources.push({
      source: s.source,
      providerConfigKey: key,
      label: s.label ?? s.source,
      models,
      discoverModels: s.discoverModels,
      pollSeconds: s.pollSeconds,
      maxConcurrentSyncs: s.maxConcurrentSyncs,
      redactKeys: s.redactKeys,
      audience: s.audience,
    });
  }
  return { sources, refused, errors: [] };
}

/** Load the operator config from the environment (JSON or file). Absent config = empty catalog. */
export function loadCatalogFromEnv(env: NodeJS.ProcessEnv, specialized: readonly SourceProviderModule[]): NangoRecordsCatalog {
  const inline = env.NANGO_RECORDS_CONFIG?.trim();
  const file = env.NANGO_RECORDS_CONFIG_FILE?.trim();
  if (!inline && !file) return emptyCatalog();
  let text: string;
  try {
    text = inline ? inline : readFileSync(file!, "utf8");
  } catch (error) {
    return { ...emptyCatalog(), errors: [`NANGO_RECORDS_CONFIG_FILE could not be read: ${(error as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ...emptyCatalog(), errors: [`NANGO_RECORDS_CONFIG is not valid JSON: ${(error as Error).message}`] };
  }
  return buildCatalog(raw, specialized);
}

export function sourceByKey(catalog: NangoRecordsCatalog, providerConfigKey: string): NangoRecordsSource | undefined {
  return catalog.sources.find((s) => s.providerConfigKey === providerConfigKey);
}

export function sourceById(catalog: NangoRecordsCatalog, source: string): NangoRecordsSource | undefined {
  return catalog.sources.find((s) => s.source === source);
}

/** The event type for a model of a source; undefined when the model is neither declared nor discoverable. */
export function modelFor(source: NangoRecordsSource, model: string): NangoRecordsModel | undefined {
  const declared = source.models.find((m) => m.model === model);
  if (declared) return declared;
  if (source.discoverModels && MODEL_RE.test(model)) return { model, eventType: defaultEventType(model) };
  return undefined;
}
