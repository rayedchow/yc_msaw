import type { DbExecutor, SourceProviderModule } from "../../core/types.js";
import { nangoApiFromEnv, type NangoRecordsApi } from "./api.js";
import { loadCatalogFromEnv, type NangoRecordsCatalog } from "./config.js";

/**
 * Runtime context shared by every part of the generic Nango records lane. Built once per
 * process from the environment (or explicitly in tests); nothing here is tenant-specific.
 */

export interface WebhookDelegateResult {
  status: number;
  body?: unknown;
}

export interface NangoRecordsLane {
  db: DbExecutor;
  catalog: NangoRecordsCatalog;
  /** Null when NANGO_SECRET_KEY is not configured: nothing is polled and coverage says blocked. */
  api: NangoRecordsApi | null;
  /**
   * Webhook signing keys (Nango Environment Settings > Webhooks > Signing key), current first,
   * then the previous key during a rotation window. Never the environment API key.
   */
  signingKeys: string[];
  /** Operator-set per-connection webhook URL (connect session `webhook_url_override`); never client-supplied. */
  webhookUrlOverride: string | null;
  /** Minimum spacing between Nango API requests across all workers (per-account quota pacing). */
  minRequestIntervalMs: number;
  /** /records pages per sync task run before yielding to a continuation task. */
  maxPagesPerRun: number;
  /** /records page size. */
  pageLimit: number;
  now(): Date;
  log(message: string): void;
  /**
   * Handler for verified webhooks that do not belong to this lane (the donor Nango lane:
   * jira/confluence/github/bitbucket). Default: the donor handleNangoWebhook.
   */
  delegateWebhook?(body: string, hmacSignature: string): Promise<WebhookDelegateResult>;
}

export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 50;
export const DEFAULT_MAX_PAGES_PER_RUN = 50;

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: T[] } | null)?.rows ?? [])) as T[];
}

export { rows };

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toDate(v: unknown): Date | null {
  const s = iso(v);
  return s ? new Date(s) : null;
}

/** Error text safe for status/coverage: bounded, no bearer tokens or key material. */
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/((?:token|secret|key|authorization|signature)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/giu, "$1[redacted]")
    .slice(0, 500);
}

function lazyDb(): DbExecutor {
  let pending: Promise<DbExecutor> | undefined;
  return {
    execute: (async (query: unknown) => {
      pending ??= import("../../../db/client.js").then((m) => m.db as unknown as DbExecutor);
      return (await pending).execute(query as never);
    }) as unknown as DbExecutor["execute"],
  };
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export interface LaneFromEnvOptions {
  db?: DbExecutor;
  api?: NangoRecordsApi | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
  delegateWebhook?: NangoRecordsLane["delegateWebhook"];
}

/**
 * Environment:
 *   NANGO_RECORDS_CONFIG / NANGO_RECORDS_CONFIG_FILE   operator catalog (config.ts)
 *   NANGO_SECRET_KEY, NANGO_API_BASE_URL               Nango API (needs records:read, connections:list,
 *                                                      connect_sessions:write, functions:list scopes)
 *   NANGO_WEBHOOK_SIGNING_KEY (or NANGO_WEBHOOK_SECRET), NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS
 *   NANGO_RECORDS_WEBHOOK_URL                          optional connect-session webhook_url_override
 *   NANGO_RECORDS_MIN_REQUEST_INTERVAL_MS, NANGO_RECORDS_MAX_PAGES_PER_RUN, NANGO_RECORDS_PAGE_LIMIT
 */
export function laneFromEnv(env: NodeJS.ProcessEnv, specialized: readonly SourceProviderModule[], opts: LaneFromEnvOptions = {}): NangoRecordsLane {
  const signing = (env.NANGO_WEBHOOK_SIGNING_KEY ?? env.NANGO_WEBHOOK_SECRET)?.trim();
  const previous = env.NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS?.trim();
  const override = env.NANGO_RECORDS_WEBHOOK_URL?.trim();
  const catalog = loadCatalogFromEnv(env, specialized);
  let webhookUrlOverride: string | null = null;
  if (override) {
    let u: URL | null = null;
    try {
      u = new URL(override);
    } catch {
      u = null;
    }
    // Reported as a configuration error (coverage blocked) instead of crashing every runtime process at import.
    if (!u || u.protocol !== "https:" || u.username || u.password) catalog.errors.push("NANGO_RECORDS_WEBHOOK_URL must be an https URL without credentials");
    else webhookUrlOverride = u.href;
  }
  return {
    db: opts.db ?? lazyDb(),
    catalog,
    api: opts.api !== undefined ? opts.api : nangoApiFromEnv(env, opts.fetchImpl),
    signingKeys: [signing, previous].filter((k): k is string => Boolean(k)),
    webhookUrlOverride,
    minRequestIntervalMs: positiveInt(env.NANGO_RECORDS_MIN_REQUEST_INTERVAL_MS, DEFAULT_MIN_REQUEST_INTERVAL_MS, 60_000),
    maxPagesPerRun: positiveInt(env.NANGO_RECORDS_MAX_PAGES_PER_RUN, DEFAULT_MAX_PAGES_PER_RUN, 2_000),
    pageLimit: positiveInt(env.NANGO_RECORDS_PAGE_LIMIT, 100, 1_000),
    now: opts.now ?? (() => new Date()),
    log: opts.log ?? ((m) => console.log(`[nango-records] ${m}`)),
    ...(opts.delegateWebhook ? { delegateWebhook: opts.delegateWebhook } : {}),
  };
}
