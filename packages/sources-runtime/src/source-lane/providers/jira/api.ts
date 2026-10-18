import { createHash } from "node:crypto";
import { env } from "../../../env.js";

/**
 * Jira Cloud REST (v3) calls through the authenticated Nango proxy.
 *
 * The runtime never holds Atlassian tokens: every call goes to
 * `<nango>/proxy/ex/jira/<cloudId>/rest/api/3/...` with the Nango secret key
 * plus the tenant's connection headers, the same routing the donor Jira lane
 * uses (src/integrations/nango/proxy-details.ts). Differences from the donor
 * NangoClient.proxy that the deep lane needs:
 *
 *  - 429/503 never sleep: JiraRateLimitedError carries the Retry-After /
 *    X-RateLimit-Reset deadline so the sweep persists the cooldown on the
 *    Atlassian bucket (OAuth app x site) and resumes from its checkpoint;
 *  - attachment bytes stream into a sink (exact bytes, sha256 computed here);
 *    redirects are followed manually: a relative `/rest/api/3/` redirect stays
 *    on the authenticated proxy for the same site, an absolute one only to an
 *    allowlisted Atlassian media host and WITHOUT any credential (the signed
 *    URL is the capability and is never persisted); anything else is refused;
 *  - only `/rest/api/3/` paths are accepted, so a value read from a response can
 *    never steer the Nango bearer to another endpoint or host.
 */

export const NANGO_API_BASE = "https://api.nango.dev";
const JSON_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 3;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** Hosts Atlassian serves attachment bytes from after a content redirect. */
const MEDIA_HOST_SUFFIXES = [".atlassian.com", ".atlassian.net", ".atl-paas.net"];

export interface JiraConnectionRef {
  providerConfigKey: string;
  connectionId: string;
}

export interface JiraTarget extends JiraConnectionRef {
  cloudId: string;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

/** 429/503: stop and retry at `retryAt` (null = no provider hint; the caller backs off). */
export class JiraRateLimitedError extends JiraApiError {
  constructor(
    message: string,
    status: number,
    readonly retryAt: Date | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message, status, "rate_limited");
    this.name = "JiraRateLimitedError";
  }
}

/** 401 / unknown Nango connection: the grant is unusable until the user reconnects. */
export class JiraAuthError extends JiraApiError {
  constructor(message: string, status: number, code: string | null = null) {
    super(message, status, code ?? "auth");
    this.name = "JiraAuthError";
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

export type Params = Record<string, string | number | readonly string[] | undefined>;

export interface JiraClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

export class JiraClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;

  constructor(options: JiraClientOptions = {}) {
    const apiKey = options.apiKey ?? env.NANGO_SECRET_KEY;
    if (!apiKey) throw new Error("NANGO_SECRET_KEY is required for the Jira source lane");
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = (options.baseUrl ?? NANGO_API_BASE).replace(/\/+$/u, "");
    this.#now = options.now ?? Date.now;
  }

  /** Atlassian sites (cloudIds + granted scopes) reachable through the connection. */
  async accessibleResources(conn: JiraConnectionRef): Promise<Array<Record<string, unknown>>> {
    const r = await this.#json(conn, "/oauth/token/accessible-resources", undefined, []);
    return Array.isArray(r.data) ? r.data.filter(isRecord) : [];
  }

  /** GET a site REST path (`/rest/api/3/...`); statuses in `tolerate` are returned instead of thrown. */
  async get(target: JiraTarget, apiPath: string, params?: Params, tolerate: readonly number[] = []): Promise<JsonResult> {
    return this.#json(target, sitePath(target.cloudId, assertApiPath(apiPath)), params, tolerate);
  }

  /**
   * Stream an attachment's exact bytes into `sink`
   * (`/rest/api/3/attachment/content/{id}?redirect=false`, so bytes normally come
   * straight through the proxy). Non-2xx statuses in `tolerate` return without bytes.
   */
  async download(target: JiraTarget, attachmentId: string, sink: (piece: Buffer) => Promise<void>, maxBytes: number, tolerate: readonly number[] = []): Promise<DownloadResult> {
    let url = proxyUrl(this.#base, sitePath(target.cloudId, `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`), { redirect: "false" });
    let authenticated = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.#send(url, authenticated ? this.#proxyHeaders(target, "*/*") : { Accept: "*/*" }, DOWNLOAD_TIMEOUT_MS);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new JiraApiError(`attachment download redirect without Location (HTTP ${response.status})`, response.status, "bad_redirect");
        const next = resolveDownloadRedirect(location, target.cloudId, this.#base, url);
        url = next.url;
        authenticated = next.authenticated;
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
      return { status: response.status, mediaType: response.headers.get("content-type"), size, sha256: hash.digest("hex"), via: authenticated ? "proxy" : "media" };
    }
    throw new JiraApiError(`attachment download exceeded ${MAX_REDIRECTS} redirects`, 310, "too_many_redirects");
  }

  async #json(conn: JiraConnectionRef, endpoint: string, params: Params | undefined, tolerate: readonly number[]): Promise<JsonResult> {
    const response = await this.#send(proxyUrl(this.#base, endpoint, params), this.#proxyHeaders(conn, "application/json"), JSON_TIMEOUT_MS);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new JiraApiError(`unexpected redirect (HTTP ${response.status}) for ${endpoint}`, response.status, "unexpected_redirect");
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
      throw new JiraApiError(`Jira returned non-JSON for ${endpoint}`, response.status, "bad_json");
    }
  }

  /** Throws for every non-tolerated failure; returns for tolerated statuses. Rate limits are never tolerated. */
  async #raise(response: Response, tolerate: readonly number[]): Promise<void> {
    const status = response.status;
    if (status === 429 || status === 503) {
      const retryAfterMs = retryAfterMsOf(response.headers, this.#now());
      const retryAt = retryAfterMs !== null ? new Date(this.#now() + retryAfterMs) : null;
      await response.body?.cancel().catch(() => {});
      throw new JiraRateLimitedError(`Jira rate limited (HTTP ${status})`, status, retryAt, retryAfterMs);
    }
    if (tolerate.includes(status)) return;
    const body = await response.text().catch(() => "");
    const code = nangoErrorCode(body);
    if (status === 401 || code === "unknown_connection" || code === "invalid_credentials" || code === "connection_not_found") {
      throw new JiraAuthError(`Jira connection is not authorized (HTTP ${status}${code ? ` ${code}` : ""})`, status, code);
    }
    throw new JiraApiError(`Jira request failed with HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ""}`, status, code);
  }

  #proxyHeaders(conn: JiraConnectionRef, accept: string): Record<string, string> {
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
      if (error instanceof JiraApiError) throw error;
      throw new JiraApiError(`Jira request failed: ${error instanceof Error ? error.message : String(error)}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

function sitePath(cloudId: string, apiPath: string): string {
  return `/ex/jira/${encodeURIComponent(cloudId)}${apiPath}`;
}

export function assertApiPath(path: string): string {
  if (!/^\/rest\/api\/3\//u.test(path) || path.includes("..") || /[?#]/u.test(path)) {
    throw new JiraApiError(`refusing non-REST Jira path ${JSON.stringify(path.slice(0, 120))}`, 0, "bad_path");
  }
  return path;
}

function proxyUrl(base: string, endpoint: string, params?: Params): URL {
  const url = new URL(`${base}/proxy${endpoint}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else if (String(value).length > 0) url.searchParams.set(key, String(value));
  }
  return url;
}

/** Where a download redirect may go: same-site REST path (authenticated proxy) or an allowlisted media host (no credential). */
export function resolveDownloadRedirect(location: string, cloudId: string, nangoBase: string, current: URL): { url: URL; authenticated: boolean } {
  const trimmed = location.trim();
  if (trimmed.startsWith("/")) {
    if (current.origin === new URL(nangoBase).origin) {
      const q = trimmed.indexOf("?");
      const path = q >= 0 ? trimmed.slice(0, q) : trimmed;
      if (!/^\/rest\/api\/3\/attachment\//u.test(path) || path.includes("..")) throw new JiraApiError("refusing redirect outside the site attachment API", 0, "untrusted_redirect");
      return { url: new URL(`${nangoBase}/proxy${sitePath(cloudId, path)}${q >= 0 ? trimmed.slice(q) : ""}`), authenticated: true };
    }
    return { url: new URL(trimmed, current), authenticated: false };
  }
  const u = safeUrl(trimmed);
  if (!u || u.protocol !== "https:" || u.username || u.password) throw new JiraApiError("refusing non-https download redirect", 0, "untrusted_redirect");
  const host = u.hostname.toLowerCase();
  if (!MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new JiraApiError(`refusing download redirect to ${host}`, 0, "untrusted_redirect");
  return { url: u, authenticated: false };
}

/** Retry-After (delta-seconds or HTTP-date), else Atlassian's X-RateLimit-Reset (ISO timestamp or epoch seconds/ms). */
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
