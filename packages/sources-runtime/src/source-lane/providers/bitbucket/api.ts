import { createHash } from "node:crypto";
import { env } from "../../../env.js";

/**
 * Bitbucket Cloud REST (/2.0) calls through the authenticated Nango proxy.
 *
 * The runtime never holds Bitbucket tokens: every call goes to `<nango>/proxy/<endpoint>`
 * with the Nango secret key plus the connection headers, like the donor
 * NangoClient.proxy (src/integrations/nango/client.ts), whose endpoints are relative to
 * `https://api.bitbucket.org/2.0`. It differs from the donor proxy where the content lane
 * needs it to:
 *
 *  - file bodies are read as exact bytes (never decoded as text), with a size cap that
 *    aborts the transfer instead of buffering an oversized file;
 *  - it never sleeps on a rate limit. Bitbucket answers 429 when the per-account hourly
 *    budget is spent (Nango's own limit is a 429 too). The error carries Retry-After
 *    (delta-seconds or HTTP-date) or X-RateLimit-Reset when present, so the sweep
 *    persists the cooldown on the actual quota identity and resumes from its durable
 *    checkpoint later. `X-RateLimit-NearLimit: true` is reported so a sweep stops before
 *    it exhausts the budget the donor issue/PR lanes share with it;
 *  - redirects are never followed (a followed redirect would carry the Nango bearer to
 *    the Location host);
 *  - only `/user`, `/workspaces...` and `/repositories/<ws>/<repo>...` are accepted, and a
 *    pagination `next` URL is followed only when it stays on api.bitbucket.org under the
 *    exact endpoint that produced it.
 */

export const NANGO_API_BASE = "https://api.nango.dev";
const TIMEOUT_MS = 60_000;
export const DEFAULT_RATE_BACKOFF_MS = 60_000;
export const BITBUCKET_API_HOST = "api.bitbucket.org";

export interface BitbucketConnectionRef {
  providerConfigKey: string;
  connectionId: string;
}

export class BitbucketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

/** Bitbucket (or Nango) rate limit: stop and retry at `retryAt` (null = caller's backoff). */
export class BitbucketRateLimitedError extends BitbucketApiError {
  constructor(
    message: string,
    status: number,
    readonly kind: "rate_limit" | "near_limit",
    readonly retryAt: Date | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message, status, "rate_limited");
    this.name = "BitbucketRateLimitedError";
  }
}

/** 401 / unknown Nango connection: the grant is unusable until the user reconnects. */
export class BitbucketAuthError extends BitbucketApiError {
  constructor(message: string, status: number, code: string | null = null) {
    super(message, status, code ?? "auth");
    this.name = "BitbucketAuthError";
  }
}

/** A file body larger than the capture limit (the transfer was aborted). */
export class BitbucketTooLargeError extends BitbucketApiError {
  constructor(
    message: string,
    readonly limit: number,
  ) {
    super(message, 200, "too_large");
    this.name = "BitbucketTooLargeError";
  }
}

export interface RateObservation {
  limit: number | null;
  resource: string | null;
  nearLimit: boolean;
}

export interface JsonResult {
  status: number;
  data: unknown;
  rate: RateObservation;
}

export interface BytesResult {
  status: number;
  bytes: Buffer | null;
  contentType: string | null;
  rate: RateObservation;
}

export interface BitbucketClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

const SEG = "[^/?#]+";
const ALLOWED_ENDPOINT = new RegExp(`^/(user|workspaces(/${SEG})*|repositories/${SEG}/${SEG}(/[^?#]*)?)$`, "u");

export class BitbucketClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;

  constructor(options: BitbucketClientOptions = {}) {
    const apiKey = options.apiKey ?? env.NANGO_SECRET_KEY;
    if (!apiKey) throw new Error("NANGO_SECRET_KEY is required for the Bitbucket content lane");
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = (options.baseUrl ?? NANGO_API_BASE).replace(/\/+$/u, "");
    this.#now = options.now ?? Date.now;
  }

  /** GET a JSON endpoint. Statuses in `tolerate` are returned (data parsed when JSON) instead of thrown. */
  async getJson(conn: BitbucketConnectionRef, endpoint: string, params?: Record<string, string | number | undefined>, tolerate: readonly number[] = []): Promise<JsonResult> {
    const response = await this.#send(conn, endpoint, params, "application/json");
    const rate = rateOf(response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.#raise(response, text, tolerate);
      return { status: response.status, data: safeJson(text), rate };
    }
    const text = await response.text();
    if (!text.trim()) return { status: response.status, data: null, rate };
    try {
      return { status: response.status, data: JSON.parse(text) as unknown, rate };
    } catch {
      throw new BitbucketApiError(`Bitbucket returned non-JSON for ${endpoint}`, response.status, "bad_json");
    }
  }

  /**
   * GET a file body as exact bytes (`/src/<commit>/<path>`). Aborts with
   * BitbucketTooLargeError as soon as more than `maxBytes` arrive.
   */
  async getBytes(conn: BitbucketConnectionRef, endpoint: string, maxBytes: number, tolerate: readonly number[] = []): Promise<BytesResult> {
    const response = await this.#send(conn, endpoint, undefined, "*/*");
    const rate = rateOf(response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.#raise(response, text, tolerate);
      return { status: response.status, bytes: null, contentType: response.headers.get("content-type"), rate };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new BitbucketTooLargeError(`file body is ${declared} bytes, over the ${maxBytes} byte capture limit`, maxBytes);
    }
    const parts: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new BitbucketTooLargeError(`file body exceeded the ${maxBytes} byte capture limit`, maxBytes);
        }
        parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    return { status: response.status, bytes: Buffer.concat(parts, total), contentType: response.headers.get("content-type"), rate };
  }

  /** Throws for every non-tolerated failure; returns for tolerated statuses. */
  #raise(response: Response, body: string, tolerate: readonly number[]): void {
    const status = response.status;
    const limited = rateLimitedOf(status, response.headers, this.#now());
    if (limited) throw limited;
    const code = nangoErrorCode(body);
    // Nango answers an unknown/broken connection with its own error code (often HTTP 404/400),
    // which must never be mistaken for a Bitbucket "not found".
    if (status === 401 || code === "unknown_connection" || code === "invalid_credentials" || code === "connection_not_found" || code === "refresh_token_external_error") {
      throw new BitbucketAuthError(`Bitbucket connection is not authorized (HTTP ${status}${code ? ` ${code}` : ""})`, status, code);
    }
    if (status >= 300 && status < 400) {
      if (tolerate.includes(status)) return;
      throw new BitbucketApiError(`unexpected redirect (HTTP ${status})`, status, "unexpected_redirect");
    }
    if (tolerate.includes(status)) return;
    throw new BitbucketApiError(`Bitbucket request failed with HTTP ${status}${body ? `: ${bitbucketMessage(body).slice(0, 300)}` : ""}`, status, code);
  }

  async #send(conn: BitbucketConnectionRef, endpoint: string, params: Record<string, string | number | undefined> | undefined, accept: string): Promise<Response> {
    assertEndpoint(endpoint);
    const url = new URL(`${this.#base}/proxy${endpoint}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && String(v).length > 0) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: accept,
          "Provider-Config-Key": conn.providerConfigKey,
          "Connection-Id": conn.connectionId,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      throw new BitbucketApiError(`Bitbucket request failed: ${error instanceof Error ? error.message : String(error)}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertEndpoint(endpoint: string): void {
  if (!ALLOWED_ENDPOINT.test(endpoint) || endpoint.split("/").some((s) => s === "." || s === ".." || /^%2e%2e?$/iu.test(s))) {
    throw new BitbucketApiError(`refusing Bitbucket path ${JSON.stringify(endpoint.slice(0, 120))}`, 0, "bad_path");
  }
}

// ------------------------------------------------------------------ endpoints

const SLUG_RE = /^[A-Za-z0-9_.-]{1,128}$/u;
const UUID_RE = /^\{[0-9a-fA-F-]{36}\}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;

export function isCommitSha(v: unknown): v is string {
  return typeof v === "string" && COMMIT_RE.test(v);
}

export function isBitbucketUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** `workspace/slug` as typed by Bitbucket (both segments [A-Za-z0-9_.-]). */
export function parseFullName(fullName: string): { workspace: string; slug: string } | null {
  const [workspace, slug, ...rest] = fullName.split("/");
  if (!workspace || !slug || rest.length || !SLUG_RE.test(workspace) || !SLUG_RE.test(slug) || workspace.startsWith(".") || slug.startsWith(".")) return null;
  return { workspace, slug };
}

/** `/repositories/<workspace>/<slug><rest>` with validated segments. */
export function repoEndpoint(fullName: string, rest = ""): string {
  const p = parseFullName(fullName);
  if (!p) throw new BitbucketApiError(`invalid repository name ${JSON.stringify(fullName.slice(0, 120))}`, 0, "bad_repo");
  return `/repositories/${p.workspace}/${p.slug}${rest}`;
}

/** Rename-safe repository endpoint by UUIDs (`/repositories/{workspace-uuid}/{repo-uuid}`). */
export function repoUuidEndpoint(workspaceUuid: string, repoUuid: string): string {
  if (!isBitbucketUuid(workspaceUuid) || !isBitbucketUuid(repoUuid)) throw new BitbucketApiError("invalid repository UUID", 0, "bad_repo");
  return `/repositories/${encodeURIComponent(workspaceUuid)}/${encodeURIComponent(repoUuid)}`;
}

/** Percent-encode each path segment, keep `/` separators (branch names and file paths). */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function branchEndpoint(fullName: string, branch: string): string {
  return repoEndpoint(fullName, `/refs/branches/${encodePath(branch)}`);
}

/** Directory listing (trailing slash) or file body at an exact commit. */
export function srcEndpoint(fullName: string, commit: string, path: string, directory: boolean): string {
  if (!isCommitSha(commit)) throw new BitbucketApiError(`refusing non-commit ref ${JSON.stringify(commit.slice(0, 60))}`, 0, "bad_commit");
  const rel = path.replace(/\/+$/u, "");
  return repoEndpoint(fullName, `/src/${commit}/${rel ? encodePath(rel) : ""}${directory && rel ? "/" : ""}`);
}

/**
 * Bitbucket diffstat of `newer` against `older` in two-dot form (`topic=false`): the
 * Bitbucket range spec is `<source>..<destination>` (pull-request order), i.e. what the
 * newer commit changed relative to the older one. The orientation is verified by the
 * caller (content.ts), never assumed blindly.
 */
export function diffstatEndpoint(fullName: string, newer: string, older: string): string {
  if (!isCommitSha(newer) || !isCommitSha(older)) throw new BitbucketApiError("diffstat needs two commit SHAs", 0, "bad_commit");
  return repoEndpoint(fullName, `/diffstat/${newer}..${older}`);
}

/**
 * Validate a pagination `next` URL and turn it into a proxy endpoint + params. It must be
 * https on api.bitbucket.org under /2.0 and its endpoint must equal `expectedEndpoint`
 * (same repository, same resource): a hostile or confused `next` can never point the
 * authenticated proxy elsewhere.
 */
export function nextPage(next: unknown, expectedEndpoint: string): { endpoint: string; params: Record<string, string> } | null {
  if (typeof next !== "string" || !next) return null;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new BitbucketApiError("pagination next is not a URL", 0, "bad_next");
  }
  if (url.protocol !== "https:" || url.hostname !== BITBUCKET_API_HOST || url.username || url.password || url.port) {
    throw new BitbucketApiError(`refusing pagination next on ${url.host}`, 0, "bad_next");
  }
  if (!url.pathname.startsWith("/2.0/")) throw new BitbucketApiError("pagination next is outside /2.0", 0, "bad_next");
  const endpoint = url.pathname.slice(4);
  if (normalizeEndpoint(endpoint) !== normalizeEndpoint(expectedEndpoint)) {
    throw new BitbucketApiError(`pagination next left ${expectedEndpoint.slice(0, 120)}`, 0, "bad_next");
  }
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) params[k] = v;
  return { endpoint: expectedEndpoint, params };
}

function normalizeEndpoint(endpoint: string): string {
  let decoded: string;
  try {
    decoded = endpoint.split("/").map((s) => decodeURIComponent(s)).join("/");
  } catch {
    decoded = endpoint;
  }
  return decoded.replace(/\/+$/u, "");
}

// ------------------------------------------------------------------ rate limits

export function rateOf(headers: Headers): RateObservation {
  const limit = Number(headers.get("x-ratelimit-limit"));
  return {
    limit: headers.get("x-ratelimit-limit") !== null && Number.isFinite(limit) ? limit : null,
    resource: headers.get("x-ratelimit-resource"),
    nearLimit: (headers.get("x-ratelimit-nearlimit") ?? "").trim().toLowerCase() === "true",
  };
}

/** Retry-After as delta-seconds or HTTP-date. */
export function retryAfterMsOf(headers: Headers, now: number): number | null {
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const seconds = Number(ra);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** X-RateLimit-Reset as epoch seconds (or delta-seconds when small). */
export function resetMsOf(headers: Headers, now: number): number | null {
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1_000_000_000) return Math.max(1000, Math.round(n * 1000 - now));
  return Math.max(1000, Math.round(n * 1000));
}

/** 429 (Bitbucket or Nango): Retry-After wins, then X-RateLimit-Reset, else the caller's escalating backoff. */
export function rateLimitedOf(status: number, headers: Headers, now: number): BitbucketRateLimitedError | null {
  if (status !== 429) return null;
  const ms = retryAfterMsOf(headers, now) ?? resetMsOf(headers, now);
  return new BitbucketRateLimitedError(`Bitbucket rate limit (HTTP 429${ms !== null ? `, retry in ${Math.ceil(ms / 1000)}s` : ""})`, status, "rate_limit", ms !== null ? new Date(now + ms) : null, ms);
}

// ------------------------------------------------------------------ bytes

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Text = valid UTF-8 with no NUL byte (git's own binary heuristic looks for NUL). */
export function isTextContent(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function nangoErrorCode(body: string): string | null {
  const parsed = safeJson(body);
  const err = isRecord(parsed) ? parsed.error : null;
  if (isRecord(err) && typeof err.code === "string") return err.code;
  if (typeof err === "string" && /^[a-z_]+$/u.test(err)) return err;
  return null;
}

function bitbucketMessage(body: string): string {
  const parsed = safeJson(body);
  const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  return err && typeof err.message === "string" ? err.message : body;
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
