import { createHash } from "node:crypto";
import { NOTION_VERSION } from "../../../integrations/notion/client.js";

/**
 * Notion REST transport for the source-lane collector (Notion-Version 2026-03-11,
 * the version the donor client pins; https://developers.notion.com/reference/versioning).
 *
 * Differences from the donor client (src/integrations/notion/client.ts), which the
 * donor poll/render lane keeps using unchanged:
 *
 *  - one attempt per call and no in-process sleep or global pacer: a 429/529 raises
 *    NotionRateLimitedError with the Retry-After deadline and the budget Notion
 *    named (`additional_data.rate_limit_reason`: per-connection, per-workspace or
 *    per-endpoint, https://developers.notion.com/reference/request-limits), so the
 *    sweep persists the cooldown on that budget's key and resumes from its durable
 *    checkpoint; `public_api_request_blocked` is an auth-like block (no retry);
 *  - 5xx/409 raise a transient NotionApiError (the work item is retried later with
 *    backoff, never in a hot loop);
 *  - a 401 refreshes the stored OAuth token once (same token endpoint and metadata
 *    shape as the donor's refreshStoredNotionToken), then raises NotionAuthError;
 *  - file bytes are downloaded from the short-lived signed URL of a Notion-hosted
 *    file WITHOUT any credential, from allowlisted hosts only, redirects handled
 *    manually (each hop re-checked), streamed with a byte cap; the URL is never
 *    returned to callers for persistence.
 */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_SOURCE_API_VERSION = NOTION_VERSION;
const JSON_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 3;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

/**
 * Hosts Notion serves Notion-hosted file bytes from. Entries starting with "." are
 * suffixes. The shared path-style S3 endpoint is only accepted for Notion's bucket.
 * Override with NOTION_SOURCE_FILE_HOSTS (comma separated) when Notion changes hosts.
 */
export const DEFAULT_FILE_HOSTS: readonly string[] = [
  "prod-files-secure.s3.us-west-2.amazonaws.com",
  "s3.us-west-2.amazonaws.com/secure.notion-static.com/",
  "file.notion.so",
  ".notion-static.com",
];

export type JsonObject = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly transient = false,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export type NotionRateLimitScope = "connection" | "workspace" | "endpoint";

/** 429 / 529: stop and retry after `retryAfterMs` (null = no provider hint; use backoff). */
export class NotionRateLimitedError extends NotionApiError {
  constructor(
    message: string,
    status: number,
    readonly retryAfterMs: number | null,
    readonly reason: string | null,
    readonly scope: NotionRateLimitScope,
    readonly endpoint: string,
  ) {
    super(message, status, status === 529 ? "service_overload" : "rate_limited", true);
    this.name = "NotionRateLimitedError";
  }
}

/** 401 after refresh, missing token, or `public_api_request_blocked`: unusable until the user reconnects / support acts. */
export class NotionAuthError extends NotionApiError {
  constructor(message: string, status: number, code: string | null = null) {
    super(message, status, code ?? "unauthorized");
    this.name = "NotionAuthError";
  }
}

export type NotionFileErrorKind = "host_refused" | "too_large" | "expired" | "http" | "redirect_refused";

export class NotionFileError extends Error {
  constructor(
    readonly kind: NotionFileErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "NotionFileError";
  }
}

export interface NotionCredential {
  token: string;
  refreshToken: string | null;
  metadata: Record<string, unknown> | null;
}

export interface NotionSourceClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Current credential of the tenant's Notion connection (default: donor integration_tokens vault). */
  credential?: (tenantId: string) => Promise<NotionCredential | null>;
  /** Refresh after a 401; returns the new access token (default: donor-compatible OAuth refresh). */
  refresh?: (tenantId: string, credential: NotionCredential) => Promise<string>;
  fileHosts?: readonly string[];
  timeoutMs?: number;
  /** Called before every network request (request budget accounting). */
  onRequest?: (kind: "api" | "file") => void;
}

export interface NotionResponse {
  status: number;
  body: unknown;
}

export interface DownloadedFile {
  size: number;
  sha256: string;
  mediaType: string | null;
}

export class NotionSourceClient {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #credential: (tenantId: string) => Promise<NotionCredential | null>;
  readonly #refresh: (tenantId: string, credential: NotionCredential) => Promise<string>;
  readonly #fileHosts: readonly string[];
  readonly #timeout: number;
  #cached: NotionCredential | null = null;
  #refreshed = false;

  constructor(
    readonly tenantId: string,
    private readonly opts: NotionSourceClientOptions = {},
  ) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#base = (opts.baseUrl ?? NOTION_API_BASE).replace(/\/+$/u, "");
    this.#credential = opts.credential ?? defaultCredential;
    this.#refresh = opts.refresh ?? refreshNotionToken;
    this.#fileHosts = opts.fileHosts ?? fileHostsFromEnv();
    this.#timeout = opts.timeoutMs ?? JSON_TIMEOUT_MS;
  }

  async credential(): Promise<NotionCredential> {
    if (this.#cached) return this.#cached;
    const c = await this.#credential(this.tenantId);
    if (!c?.token) throw new NotionAuthError("no Notion token is stored for this tenant (connect Notion first)", 401, "token_missing");
    this.#cached = c;
    return c;
  }

  async get(path: string, tolerate: readonly number[] = []): Promise<NotionResponse> {
    return this.request("GET", path, undefined, tolerate);
  }

  async post(path: string, body: JsonObject, tolerate: readonly number[] = []): Promise<NotionResponse> {
    return this.request("POST", path, body, tolerate);
  }

  /**
   * One Notion API call. 2xx and statuses in `tolerate` return; everything else throws a
   * typed error. `path` is relative to /v1 and must not be an absolute URL.
   */
  async request(method: "GET" | "POST", path: string, body?: JsonObject, tolerate: readonly number[] = []): Promise<NotionResponse> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Notion path must be API-relative: ${path}`);
    const cred = await this.credential();
    let res = await this.#send(method, path, body, cred.token);
    if (res.status === 401 && !this.#refreshed && cred.refreshToken) {
      this.#refreshed = true;
      try {
        const token = await this.#refresh(this.tenantId, cred);
        this.#cached = { ...cred, token };
        res = await this.#send(method, path, body, token);
      } catch (error) {
        throw new NotionAuthError(`Notion token refresh failed: ${error instanceof Error ? error.message : String(error)}`, 401, "refresh_failed");
      }
    }
    const text = await res.text();
    const parsed = parseJson(text);
    if (res.ok || tolerate.includes(res.status)) return { status: res.status, body: parsed };
    throw notionError(res, parsed, text, endpointFamily(method, path));
  }

  async #send(method: string, path: string, body: JsonObject | undefined, token: string): Promise<Response> {
    this.opts.onRequest?.("api");
    return this.#fetch(`${this.#base}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeout),
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_SOURCE_API_VERSION,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** True when `url` is an https URL on an allowlisted Notion file host. */
  allowsFileUrl(url: string): boolean {
    return fileUrlAllowed(url, this.#fileHosts);
  }

  /**
   * Stream the bytes of a Notion-hosted file from its signed URL into `sink`, without any
   * credential. Each redirect hop must again be an allowlisted https host. Throws
   * NotionFileError("expired") for the S3 403 of an expired link (caller re-fetches the
   * owner object for a fresh URL), ("too_large") past `maxBytes`.
   */
  async downloadFile(url: string, maxBytes: number, sink: (piece: Buffer) => Promise<void>): Promise<DownloadedFile> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.allowsFileUrl(current)) {
        throw new NotionFileError(hop === 0 ? "host_refused" : "redirect_refused", `file host ${safeHost(current)} is not an allowlisted Notion file host`);
      }
      this.opts.onRequest?.("file");
      const res = await this.#fetch(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new NotionFileError("http", `file redirect ${res.status} without location`, res.status);
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 403 && /expired|AccessDenied|Request has expired/iu.test(text)) {
          throw new NotionFileError("expired", "signed Notion file URL expired", 403);
        }
        throw new NotionFileError("http", `file download failed with HTTP ${res.status}`, res.status);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new NotionFileError("too_large", `file is ${declared} bytes (limit ${maxBytes})`);
      }
      const hash = createHash("sha256");
      let size = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new NotionFileError("too_large", `file exceeds ${maxBytes} bytes`);
          }
          const piece = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          hash.update(piece);
          await sink(piece);
        }
      }
      return { size, sha256: hash.digest("hex"), mediaType: mediaTypeOf(res.headers.get("content-type")) };
    }
    throw new NotionFileError("redirect_refused", `more than ${MAX_REDIRECTS} file redirects`);
  }
}

function mediaTypeOf(header: string | null): string | null {
  const t = header?.split(";")[0]?.trim().toLowerCase();
  return t ? t : null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

export function fileHostsFromEnv(): readonly string[] {
  const raw = process.env.NOTION_SOURCE_FILE_HOSTS?.trim();
  if (!raw) return DEFAULT_FILE_HOSTS;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** https only, no credentials in the URL, host (and for path-scoped entries, path prefix) allowlisted. */
export function fileUrlAllowed(url: string, hosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  for (const entry of hosts) {
    const e = entry.toLowerCase();
    const slash = e.indexOf("/");
    if (slash > 0) {
      if (host === e.slice(0, slash) && u.pathname.toLowerCase().startsWith(e.slice(slash))) return true;
      continue;
    }
    if (e.startsWith(".") ? host.endsWith(e) && host.length > e.length : host === e) return true;
  }
  return false;
}

/** Endpoint family for per-endpoint rate limits (ids removed). */
export function endpointFamily(method: string, path: string): string {
  const p = path.split("?")[0]!.replace(/\/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/giu, "/{id}");
  return `${method} ${p}`;
}

/** Retry-After header (integer seconds) or additional_data.retry_after; null when absent. */
export function retryAfterMs(headers: Headers, body: unknown): number | null {
  const header = headers.get("retry-after");
  const fromBody = isRecord(body) && isRecord(body.additional_data) ? body.additional_data.retry_after : undefined;
  for (const v of [header, typeof fromBody === "string" || typeof fromBody === "number" ? String(fromBody) : null]) {
    if (v === null || v === undefined || v === "") continue;
    const seconds = Number(v);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(v);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

function notionError(res: Response, body: unknown, text: string, endpoint: string): NotionApiError {
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
  const message = isRecord(body) && typeof body.message === "string" ? body.message : text.slice(0, 300) || res.statusText;
  const reason = isRecord(body) && isRecord(body.additional_data) && typeof body.additional_data.rate_limit_reason === "string"
    ? body.additional_data.rate_limit_reason
    : null;
  if (res.status === 429 || res.status === 529) {
    if (reason === "public_api_request_blocked") {
      return new NotionAuthError(`Notion blocked this connection's API access (${reason})`, res.status, reason);
    }
    const scope: NotionRateLimitScope = reason === "public_api_space_request_rate_limit"
      ? "workspace"
      : reason === "public_api_endpoint_rate_limit"
        ? "endpoint"
        : "connection";
    return new NotionRateLimitedError(`Notion ${res.status} ${code ?? ""} on ${endpoint}${reason ? ` (${reason})` : ""}: ${message}`, res.status, retryAfterMs(res.headers, body), reason, scope, endpoint);
  }
  if (res.status === 401) return new NotionAuthError(`Notion 401 ${code ?? ""}: ${message}`, 401, code);
  const transient = res.status >= 500 || res.status === 409;
  return new NotionApiError(`Notion ${res.status} ${code ?? ""} on ${endpoint}: ${message}`, res.status, code, transient);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function defaultCredential(tenantId: string): Promise<NotionCredential | null> {
  const { getTokenFull } = await import("../../../vault/tokens.js");
  return getTokenFull(tenantId, "notion");
}

/**
 * OAuth refresh, same request and stored metadata shape as the donor's
 * refreshStoredNotionToken (src/integrations/notion/client.ts, not exported there).
 */
export async function refreshNotionToken(tenantId: string, stored: NotionCredential): Promise<string> {
  const [{ env }, { storeToken }] = await Promise.all([import("../../../env.js"), import("../../../vault/tokens.js")]);
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET || !stored.refreshToken) {
    throw new Error("Notion token expired and refresh is not configured; reconnect Notion");
  }
  const res = await fetch(`${NOTION_API_BASE}/oauth/token`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
  });
  const body = parseJson(await res.text());
  if (!res.ok || !isRecord(body) || typeof body.access_token !== "string") {
    throw new Error(`Notion token refresh failed (${res.status})`);
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : stored.refreshToken;
  await storeToken(tenantId, "notion", body.access_token, {
    ...(stored.metadata ?? {}),
    auth_mode: "oauth",
    token_type: typeof body.token_type === "string" ? body.token_type : "bearer",
    expires_at: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : null,
    refreshed_at: new Date().toISOString(),
  }, refreshToken);
  return body.access_token;
}
