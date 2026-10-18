import { createHash } from "node:crypto";
import { env } from "../../../env.js";

/**
 * Confluence Cloud REST calls through the authenticated Nango proxy.
 *
 * The runtime never holds Atlassian tokens: every call goes to
 * `<nango>/proxy/<endpoint>` with the Nango secret key plus the connection
 * headers, exactly like the donor NangoClient.proxy (src/integrations/nango/client.ts),
 * whose Jira lane uses the same Atlassian routing (`/oauth/token/accessible-resources`,
 * `/ex/<product>/<cloudId>/...`). This client differs from the donor proxy in
 * three ways the deep lane needs:
 *
 *  - it never sleeps on 429/503: it raises ConfluenceRateLimitedError with the
 *    Retry-After / X-RateLimit-Reset deadline so the sweep persists the cooldown
 *    (shared per OAuth app x site) and resumes from its checkpoint later;
 *  - it downloads attachment bytes as a stream (exact bytes, sha256 verified by
 *    the caller's chunk sink), with redirects handled manually: a relative
 *    redirect stays on the authenticated proxy for the same site, an absolute
 *    redirect is followed only to an allowlisted Atlassian media host and
 *    WITHOUT any credential (the signed URL is the capability and is never
 *    persisted); anything else is refused;
 *  - pagination `_links.next` values are accepted only as site-relative wiki
 *    paths (or absolute URLs on the site's own host), so a response can never
 *    redirect the Nango bearer to an arbitrary URL.
 */

export const NANGO_API_BASE = "https://api.nango.dev";
const JSON_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 3;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** Hosts Atlassian serves attachment bytes from after a download redirect. */
const MEDIA_HOST_SUFFIXES = [".atlassian.com", ".atlassian.net", ".atl-paas.net"];

export interface ConfluenceTarget {
  providerConfigKey: string;
  connectionId: string;
  cloudId: string;
  /** https://<site>.atlassian.net, from accessible-resources (used to validate absolute next links). */
  siteUrl?: string | null;
}

export interface ConfluenceConnectionRef {
  providerConfigKey: string;
  connectionId: string;
}

export class ConfluenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ConfluenceApiError";
  }
}

/** 429/503: the caller must stop and retry at `retryAt` (null = no provider hint). */
export class ConfluenceRateLimitedError extends ConfluenceApiError {
  constructor(
    message: string,
    status: number,
    readonly retryAt: Date | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message, status, "rate_limited");
    this.name = "ConfluenceRateLimitedError";
  }
}

/** 401 / unknown Nango connection: the grant is unusable until the user reconnects. */
export class ConfluenceAuthError extends ConfluenceApiError {
  constructor(message: string, status: number, code: string | null = null) {
    super(message, status, code ?? "auth");
    this.name = "ConfluenceAuthError";
  }
}

export interface JsonResult {
  status: number;
  data: unknown;
}

export interface DownloadResult {
  status: number;
  mediaType: string | null;
  size: number;
  sha256: string;
  /** "proxy" when bytes came through the authenticated proxy, "media" after an allowlisted unauthenticated redirect. */
  via: "proxy" | "media";
}

export interface ConfluenceClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  /** Called before every upstream request (budgeting); throwing aborts the request. */
  onRequest?: (kind: "json" | "download") => void;
}

export class ConfluenceClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;
  readonly #onRequest: ConfluenceClientOptions["onRequest"];

  constructor(options: ConfluenceClientOptions = {}) {
    const apiKey = options.apiKey ?? env.NANGO_SECRET_KEY;
    if (!apiKey) throw new Error("NANGO_SECRET_KEY is required for the Confluence source lane");
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = (options.baseUrl ?? NANGO_API_BASE).replace(/\/+$/u, "");
    this.#now = options.now ?? Date.now;
    this.#onRequest = options.onRequest;
  }

  /** Atlassian sites (cloudIds + granted scopes) reachable through the connection. */
  async accessibleResources(conn: ConfluenceConnectionRef): Promise<Array<Record<string, unknown>>> {
    const r = await this.#json(conn, "/oauth/token/accessible-resources", undefined, []);
    return Array.isArray(r.data) ? r.data.filter(isRecord) : [];
  }

  /**
   * GET a site wiki path (`/wiki/api/v2/...` or `/wiki/rest/api/...`).
   * Statuses in `tolerate` are returned instead of thrown (403/404 for access and deletion checks).
   */
  async get(target: ConfluenceTarget, wikiPath: string, params?: Record<string, string | number | readonly string[] | undefined>, tolerate: readonly number[] = []): Promise<JsonResult> {
    return this.#json(target, sitePath(target.cloudId, assertWikiPath(wikiPath)), params, tolerate);
  }

  /** Follow a `_links.next` value after validating it stays on this site's wiki API. */
  async next(target: ConfluenceTarget, next: string, tolerate: readonly number[] = []): Promise<JsonResult> {
    const { path, params } = parseNextLink(next, target.siteUrl ?? null);
    return this.#json(target, sitePath(target.cloudId, path), params, tolerate);
  }

  /**
   * Stream an attachment's bytes into `sink` (called with each received piece in order).
   * Returns the final status; non-2xx statuses in `tolerate` return without bytes.
   */
  async download(
    target: ConfluenceTarget,
    wikiPath: string,
    params: Record<string, string | number | undefined>,
    sink: (piece: Buffer) => Promise<void>,
    maxBytes: number,
    tolerate: readonly number[] = [],
  ): Promise<DownloadResult> {
    let url = proxyUrl(this.#base, sitePath(target.cloudId, assertWikiPath(wikiPath)), params);
    let authenticated = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.#onRequest?.("download");
      const response = await this.#send(url, authenticated ? this.#proxyHeaders(target, "*/*") : { Accept: "*/*" }, DOWNLOAD_TIMEOUT_MS);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new ConfluenceApiError(`attachment download redirect without Location (HTTP ${response.status})`, response.status, "bad_redirect");
        const nextHop = resolveDownloadRedirect(location, target.cloudId, this.#base, url);
        url = nextHop.url;
        authenticated = nextHop.authenticated;
        continue;
      }
      if (!response.ok) {
        await this.#raise(response, tolerate);
        await response.body?.cancel().catch(() => {});
        return { status: response.status, mediaType: null, size: 0, sha256: "", via: authenticated ? "proxy" : "media" };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new AttachmentTooLargeError(declared, maxBytes);
      }
      const hash = createHash("sha256");
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new AttachmentTooLargeError(size, maxBytes);
          }
          const piece = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          hash.update(piece);
          await sink(piece);
        }
      }
      return {
        status: response.status,
        mediaType: response.headers.get("content-type"),
        size,
        sha256: hash.digest("hex"),
        via: authenticated ? "proxy" : "media",
      };
    }
    throw new ConfluenceApiError(`attachment download exceeded ${MAX_REDIRECTS} redirects`, 310, "too_many_redirects");
  }

  async #json(conn: ConfluenceConnectionRef, endpoint: string, params: Record<string, string | number | readonly string[] | undefined> | undefined, tolerate: readonly number[]): Promise<JsonResult> {
    this.#onRequest?.("json");
    const response = await this.#send(proxyUrl(this.#base, endpoint, params), this.#proxyHeaders(conn, "application/json"), JSON_TIMEOUT_MS);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ConfluenceApiError(`unexpected redirect (HTTP ${response.status}) for ${redactEndpoint(endpoint)}`, response.status, "unexpected_redirect");
    }
    if (!response.ok) {
      await this.#raise(response, tolerate);
      const text = await response.text().catch(() => "");
      return { status: response.status, data: safeJson(text) };
    }
    const text = await response.text();
    if (!text.trim()) return { status: response.status, data: null };
    try {
      return { status: response.status, data: JSON.parse(text) as unknown };
    } catch {
      throw new ConfluenceApiError(`Confluence returned non-JSON for ${redactEndpoint(endpoint)}`, response.status, "bad_json");
    }
  }

  /** Throws for every non-tolerated failure; returns for tolerated statuses. */
  async #raise(response: Response, tolerate: readonly number[]): Promise<void> {
    const status = response.status;
    if (status === 429 || status === 503) {
      const retryAfterMs = retryAfterMsOf(response.headers, this.#now());
      const retryAt = retryAfterMs !== null ? new Date(this.#now() + retryAfterMs) : null;
      await response.body?.cancel().catch(() => {});
      throw new ConfluenceRateLimitedError(`Confluence rate limited (HTTP ${status})`, status, retryAt, retryAfterMs);
    }
    if (tolerate.includes(status)) return;
    const body = await response.text().catch(() => "");
    const code = nangoErrorCode(body);
    if (status === 401 || code === "unknown_connection" || code === "invalid_credentials" || code === "connection_not_found") {
      throw new ConfluenceAuthError(`Confluence connection is not authorized (HTTP ${status}${code ? ` ${code}` : ""})`, status, code);
    }
    throw new ConfluenceApiError(`Confluence request failed with HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ""}`, status, code);
  }

  #proxyHeaders(conn: ConfluenceConnectionRef, accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: accept,
      "Provider-Config-Key": conn.providerConfigKey,
      "Connection-Id": conn.connectionId,
    };
  }

  /** Redirects are never followed automatically: a followed redirect would carry the Nango bearer to the Location host. */
  async #send(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    } catch (error) {
      if (error instanceof ConfluenceApiError) throw error;
      throw new ConfluenceApiError(`Confluence request failed: ${error instanceof Error ? error.message : String(error)}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`attachment is ${size} bytes, over the ${maxBytes} byte capture limit`);
    this.name = "AttachmentTooLargeError";
  }
}

function sitePath(cloudId: string, wikiPath: string): string {
  return `/ex/confluence/${encodeURIComponent(cloudId)}${wikiPath}`;
}

function assertWikiPath(path: string): string {
  if (!/^\/wiki\/(api\/v2|rest\/api)\//u.test(path) || path.includes("..") || /[?#]/u.test(path)) {
    throw new ConfluenceApiError(`refusing non-wiki Confluence path ${JSON.stringify(path.slice(0, 120))}`, 0, "bad_path");
  }
  return path;
}

function proxyUrl(base: string, endpoint: string, params?: Record<string, string | number | readonly string[] | undefined>): URL {
  const url = new URL(`${base}/proxy${endpoint}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else if (String(value).length > 0) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Validate a pagination link. Accepted: `/wiki/api/v2/...`, `/wiki/rest/api/...`, the
 * base-relative v1 form `/rest/api/...` (v1 `_links.next` is relative to `_links.base`,
 * which ends in /wiki), or an absolute URL on the site's own host.
 */
export function parseNextLink(next: string, siteUrl: string | null): { path: string; params: Record<string, string[]> } {
  let raw = next.trim();
  if (/^https?:\/\//iu.test(raw)) {
    const u = new URL(raw);
    const site = siteUrl ? safeUrl(siteUrl) : null;
    if (!site || u.protocol !== "https:" || u.host.toLowerCase() !== site.host.toLowerCase()) {
      throw new ConfluenceApiError("refusing pagination link to another host", 0, "untrusted_next_link");
    }
    raw = `${u.pathname}${u.search}`;
  }
  if (raw.startsWith("/rest/api/") || raw.startsWith("/api/v2/")) raw = `/wiki${raw}`;
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  assertWikiPath(path);
  const params: Record<string, string[]> = {};
  for (const [k, v] of new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "")) (params[k] ??= []).push(v);
  return { path, params };
}

/** Where a download redirect may go: same-site wiki path (authenticated proxy) or allowlisted media host (no credential). */
export function resolveDownloadRedirect(location: string, cloudId: string, nangoBase: string, current: URL): { url: URL; authenticated: boolean } {
  const trimmed = location.trim();
  if (trimmed.startsWith("/")) {
    // Relative to the provider site through the proxy, e.g. /wiki/download/attachments/...
    if (current.origin === new URL(nangoBase).origin) {
      const q = trimmed.indexOf("?");
      const path = q >= 0 ? trimmed.slice(0, q) : trimmed;
      if (!/^\/wiki\//u.test(path) || path.includes("..")) throw new ConfluenceApiError("refusing redirect outside the site wiki", 0, "untrusted_redirect");
      return { url: new URL(`${nangoBase}/proxy${sitePath(cloudId, path)}${q >= 0 ? trimmed.slice(q) : ""}`), authenticated: true };
    }
    return { url: new URL(trimmed, current), authenticated: false };
  }
  const u = safeUrl(trimmed);
  if (!u || u.protocol !== "https:" || u.username || u.password) throw new ConfluenceApiError("refusing non-https download redirect", 0, "untrusted_redirect");
  const host = u.hostname.toLowerCase();
  if (!MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new ConfluenceApiError(`refusing download redirect to ${host}`, 0, "untrusted_redirect");
  return { url: u, authenticated: false };
}

/** Retry-After (delta-seconds or HTTP-date), else Atlassian's X-RateLimit-Reset (ISO timestamp or epoch seconds). */
export function retryAfterMsOf(headers: Headers, now: number): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const seconds = Number(ra);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) return Math.max(0, n > 1e12 ? n - now : n * 1000 - now);
    const at = Date.parse(reset);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return null;
}

function nangoErrorCode(body: string): string | null {
  const parsed = safeJson(body);
  const err = isRecord(parsed) ? parsed.error : null;
  if (isRecord(err) && typeof err.code === "string") return err.code;
  if (typeof err === "string" && /^[a-z_]+$/u.test(err)) return err;
  return null;
}

function redactEndpoint(endpoint: string): string {
  return endpoint.replace(/\?.*$/u, "");
}

function safeUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
