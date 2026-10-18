import { createHash } from "node:crypto";

/**
 * Nango HTTP API calls used by the generic records lane, checked against the current
 * official reference (nango.dev/docs, Oct 2026):
 *
 *   GET    /records             model, cursor, limit, modified_after; Connection-Id + Provider-Config-Key headers.
 *                               Records ordered by modification ascending; follow next_cursor until null.
 *   POST   /connect/sessions    {tags, allowed_integrations, webhook_url_override?} -> 201 {data:{token, connect_link, expires_at}}
 *   GET    /connections         ?connectionId= / tags[<k>]=<v> / limit / page
 *                               -> {connections:[{connection_id, provider_config_key, provider, created, tags, errors}]}
 *   DELETE /connections/{id}    ?provider_config_key=  (404 = already gone)
 *   GET    /integrations/{key}/functions?type=sync  -> {data:[{name, returns, enabled, track_deletes, runs,
 *                               id, last_deployed, source}], pagination:{total, page, limit}}; 404 = no such integration.
 *                               `source: "tools-catalog"` entries are catalog offerings, not deployed functions.
 *
 * Unlike the donor NangoClient, this client never sleeps inside a request: 429/503 raise
 * NangoRateLimitedError with the Retry-After / X-RateLimit-Reset deadline so the task can
 * persist the cooldown and resume after it (a task lease is never held across a long wait).
 * The X-RateLimit-* headers Nango returns on every response are surfaced to the limiter.
 */

export const NANGO_API_BASE = "https://api.nango.dev";
const TIMEOUT_MS = 45_000;
export const DEFAULT_RECORDS_PAGE_LIMIT = 100;
const LIST_PAGE_LIMIT = 100;
/** Hard stop for list pagination (10k connections / functions per call). */
const MAX_LIST_PAGES = 100;

export interface RateHeaders {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds when the window resets. */
  resetAt: Date | null;
}

export class NangoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "NangoApiError";
  }
}

export class NangoRateLimitedError extends NangoApiError {
  constructor(
    message: string,
    status: number,
    /** When the caller may try again (from Retry-After, else X-RateLimit-Reset, else a default backoff). */
    readonly retryAt: Date,
    readonly rate: RateHeaders,
  ) {
    super(message, status, "rate_limited", true);
    this.name = "NangoRateLimitedError";
  }
}

export interface ListRecordsInput {
  providerConfigKey: string;
  connectionId: string;
  model: string;
  cursor?: string | null;
  modifiedAfter?: Date | null;
  limit?: number;
}

export interface ListRecordsPage {
  records: Record<string, unknown>[];
  nextCursor: string | null;
  rate: RateHeaders;
}

export interface NangoRemoteConnection {
  connectionId: string;
  providerConfigKey: string;
  provider: string | null;
  /** When Nango created the connection (used to prove it was created while its connect session was valid). */
  created: Date | null;
  tags: Record<string, string>;
  errors: Array<{ type: string | null; log_id?: string | null }>;
}

export interface ConnectSessionInput {
  allowedIntegration: string;
  tags: Record<string, string>;
  webhookUrlOverride?: string;
}

export interface ConnectSessionResult {
  token: string;
  connectLink: string | null;
  expiresAt: Date | null;
}

export interface DeployedSync {
  name: string;
  enabled: boolean;
  trackDeletes: boolean | null;
  runs: string | null;
  models: string[];
  lastDeployed: string | null;
}

export interface IntegrationSyncFunctions {
  /** false when Nango has no integration with this unique key (HTTP 404). */
  found: boolean;
  /** Deployed sync functions only (catalog offerings that are not deployed are excluded). */
  syncs: DeployedSync[];
}

export interface NangoRecordsApi {
  /** Stable identity of the quota bucket this API key draws from (Nango limits per account). */
  readonly quotaKey: string;
  listRecords(input: ListRecordsInput): Promise<ListRecordsPage>;
  createConnectSession(input: ConnectSessionInput): Promise<ConnectSessionResult>;
  listConnections(filter: { connectionId?: string; tags?: Record<string, string> }): Promise<NangoRemoteConnection[]>;
  deleteConnection(input: { providerConfigKey: string; connectionId: string }): Promise<{ deleted: boolean }>;
  listSyncFunctions(providerConfigKey: string): Promise<IntegrationSyncFunctions>;
}

export interface NangoHttpApiOptions {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Nango API base: https, or http only on loopback (self-hosted dev); no credentials/query/fragment. */
export function assertNangoBaseUrl(raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash) throw new Error("NANGO_API_BASE_URL must not embed credentials, query or fragment");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) throw new Error("NANGO_API_BASE_URL must use https (http only for loopback)");
  return u.href.replace(/\/+$/u, "");
}

export function parseRateHeaders(headers: Headers): RateHeaders {
  const num = (name: string): number | null => {
    const v = headers.get(name);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reset = num("x-ratelimit-reset");
  return { limit: num("x-ratelimit-limit"), remaining: num("x-ratelimit-remaining"), resetAt: reset === null ? null : new Date(reset * 1000) };
}

/** Retry-After as delta-seconds or HTTP-date. */
export function retryAfterDate(headers: Headers, now: Date): Date | null {
  const h = headers.get("retry-after");
  if (!h) return null;
  const seconds = Number(h);
  if (Number.isFinite(seconds)) return new Date(now.getTime() + Math.max(0, seconds) * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? new Date(Math.max(at, now.getTime())) : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function stringTags(v: unknown): Record<string, string> {
  const r = asRecord(v);
  const out: Record<string, string> = {};
  if (!r) return out;
  for (const [k, val] of Object.entries(r)) if (typeof val === "string") out[k.toLowerCase()] = val;
  return out;
}

export class NangoHttpApi implements NangoRecordsApi {
  readonly quotaKey: string;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #now: () => Date;

  constructor(opts: NangoHttpApiOptions) {
    if (!opts.secretKey) throw new Error("NANGO_SECRET_KEY is required");
    this.#key = opts.secretKey;
    this.#base = assertNangoBaseUrl(opts.baseUrl ?? NANGO_API_BASE);
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeout = opts.timeoutMs ?? TIMEOUT_MS;
    this.#now = opts.now ?? (() => new Date());
    // One Nango account/environment = one quota bucket, shared by every tenant and connection.
    this.quotaKey = `nango-api:${createHash("sha256").update(`${this.#base}\n${this.#key}`).digest("hex").slice(0, 16)}`;
  }

  async #request(method: string, path: string, opts: { query?: URLSearchParams; headers?: Record<string, string>; body?: unknown; tolerate?: number[] } = {}): Promise<{ status: number; data: unknown; rate: RateHeaders }> {
    const url = new URL(`${this.#base}${path}`);
    if (opts.query) url.search = opts.query.toString();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      throw new NangoApiError(`Nango ${method} ${path} failed: ${(error as Error).message}`, 0, "network", true);
    }
    const rate = parseRateHeaders(res.headers);
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.ok || opts.tolerate?.includes(res.status)) return { status: res.status, data, rate };
    const err = asRecord(asRecord(data)?.error);
    const code = str(err?.code);
    // Error text from Nango may echo request details; keep it bounded and never include our key.
    const message = (str(err?.message) ?? text.slice(0, 300)).replaceAll(this.#key, "[redacted]");
    if (res.status === 429 || res.status === 503) {
      const now = this.#now();
      const retryAt = retryAfterDate(res.headers, now) ?? (rate.resetAt && rate.resetAt > now ? rate.resetAt : new Date(now.getTime() + 30_000));
      throw new NangoRateLimitedError(`Nango ${method} ${path} -> ${res.status}${message ? `: ${message}` : ""}`, res.status, retryAt, rate);
    }
    throw new NangoApiError(`Nango ${method} ${path} -> ${res.status}${message ? `: ${message}` : ""}`, res.status, code, res.status === 408 || res.status >= 500);
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsPage> {
    const q = new URLSearchParams({ model: input.model, limit: String(input.limit ?? DEFAULT_RECORDS_PAGE_LIMIT) });
    if (input.cursor) q.set("cursor", input.cursor);
    else if (input.modifiedAfter) q.set("modified_after", input.modifiedAfter.toISOString());
    // Connection identity goes in headers (query params are rejected by /records).
    const { data, rate } = await this.#request("GET", "/records", {
      query: q,
      headers: { "Connection-Id": input.connectionId, "Provider-Config-Key": input.providerConfigKey },
    });
    const r = asRecord(data);
    const list = Array.isArray(r?.records) ? r!.records : Array.isArray(data) ? (data as unknown[]) : null;
    if (!list) throw new NangoApiError("Nango /records response has no records array", 502, "invalid_response", true);
    return {
      records: list.filter((x): x is Record<string, unknown> => asRecord(x) !== null),
      nextCursor: str(r?.next_cursor),
      rate,
    };
  }

  async createConnectSession(input: ConnectSessionInput): Promise<ConnectSessionResult> {
    const { data } = await this.#request("POST", "/connect/sessions", {
      body: {
        tags: input.tags,
        allowed_integrations: [input.allowedIntegration],
        ...(input.webhookUrlOverride ? { webhook_url_override: input.webhookUrlOverride } : {}),
      },
    });
    const d = asRecord(asRecord(data)?.data);
    const token = str(d?.token);
    if (!token) throw new NangoApiError("Nango connect session response has no token", 502, "invalid_response");
    const expires = str(d?.expires_at);
    const at = expires ? new Date(expires) : null;
    return { token, connectLink: str(d?.connect_link), expiresAt: at && !Number.isNaN(at.getTime()) ? at : null };
  }

  async listConnections(filter: { connectionId?: string; tags?: Record<string, string> }): Promise<NangoRemoteConnection[]> {
    const out: NangoRemoteConnection[] = [];
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const q = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT), page: String(page) });
      if (filter.connectionId) q.set("connectionId", filter.connectionId);
      for (const [k, v] of Object.entries(filter.tags ?? {})) q.set(`tags[${k}]`, v);
      const { data } = await this.#request("GET", "/connections", { query: q });
      const list = asRecord(data)?.connections;
      if (!Array.isArray(list)) throw new NangoApiError("Nango /connections response has no connections array", 502, "invalid_response", true);
      for (const item of list) {
        const c = asRecord(item);
        const connectionId = str(c?.connection_id);
        const providerConfigKey = str(c?.provider_config_key);
        if (!c || !connectionId || !providerConfigKey) continue;
        const created = str(c.created) ? new Date(str(c.created)!) : null;
        out.push({
          connectionId,
          providerConfigKey,
          provider: str(c.provider),
          created: created && !Number.isNaN(created.getTime()) ? created : null,
          tags: stringTags(c.tags),
          errors: Array.isArray(c.errors) ? c.errors.map((e) => ({ type: str(asRecord(e)?.type), log_id: str(asRecord(e)?.log_id) })) : [],
        });
      }
      if (list.length < LIST_PAGE_LIMIT) break;
    }
    return out;
  }

  async deleteConnection(input: { providerConfigKey: string; connectionId: string }): Promise<{ deleted: boolean }> {
    const { status } = await this.#request("DELETE", `/connections/${encodeURIComponent(input.connectionId)}`, {
      query: new URLSearchParams({ provider_config_key: input.providerConfigKey }),
      tolerate: [404],
    });
    return { deleted: status !== 404 };
  }

  async listSyncFunctions(providerConfigKey: string): Promise<IntegrationSyncFunctions> {
    const syncs: DeployedSync[] = [];
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const { status, data } = await this.#request("GET", `/integrations/${encodeURIComponent(providerConfigKey)}/functions`, {
        query: new URLSearchParams({ type: "sync", limit: String(LIST_PAGE_LIMIT), page: String(page) }),
        tolerate: [404],
      });
      if (status === 404) return { found: false, syncs: [] };
      const r = asRecord(data);
      if (!r || !Array.isArray(r.data)) throw new NangoApiError("Nango functions response has no data array", 502, "invalid_response", true);
      syncs.push(...parseSyncFunctions(r.data));
      const total = typeof asRecord(r.pagination)?.total === "number" ? (asRecord(r.pagination)!.total as number) : null;
      if (r.data.length < LIST_PAGE_LIMIT || (total !== null && (page + 1) * LIST_PAGE_LIMIT >= total)) break;
    }
    return { found: true, syncs };
  }
}

/** Deployed sync functions from GET /integrations/{key}/functions entries; catalog-only offerings are dropped. */
export function parseSyncFunctions(list: unknown[]): DeployedSync[] {
  const out: DeployedSync[] = [];
  for (const item of list) {
    const f = asRecord(item);
    const name = str(f?.name);
    if (!f || !name || f.type !== "sync") continue;
    // Deployed functions carry a sync-config id and a deployment time; "tools-catalog" means not deployed.
    if (f.source === "tools-catalog" || f.id === null || f.id === undefined || !str(f.last_deployed)) continue;
    const models = Array.isArray(f.returns) ? [...new Set(f.returns.filter((m): m is string => typeof m === "string" && m.length > 0))] : [];
    out.push({
      name,
      enabled: f.enabled === true,
      trackDeletes: typeof f.track_deletes === "boolean" ? f.track_deletes : null,
      runs: str(f.runs),
      models,
      lastDeployed: str(f.last_deployed),
    });
  }
  return out;
}

export function nangoApiFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): NangoRecordsApi | null {
  const key = env.NANGO_SECRET_KEY?.trim();
  if (!key) return null;
  return new NangoHttpApi({ secretKey: key, ...(env.NANGO_API_BASE_URL?.trim() ? { baseUrl: env.NANGO_API_BASE_URL.trim() } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
}
