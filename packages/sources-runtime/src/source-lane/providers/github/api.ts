import { createHash } from "node:crypto";
import { env } from "../../../env.js";

/**
 * GitHub REST calls through the authenticated Nango proxy.
 *
 * The runtime never holds GitHub tokens: every call goes to
 * `<nango>/proxy/<endpoint>` with the Nango secret key plus the connection
 * headers, like the donor NangoClient.proxy (src/integrations/nango/client.ts).
 * It differs from the donor proxy where the content lane needs it to:
 *
 *  - it never sleeps on a rate limit. GitHub signals the primary limit with
 *    403/429 + `x-ratelimit-remaining: 0` (+ `x-ratelimit-reset`) and the
 *    secondary limits with 403/429 + `retry-after` or a "secondary rate limit"
 *    message. Both raise GithubRateLimitedError with the deadline, so the sweep
 *    persists the cooldown on the actual quota bucket (installation / grant)
 *    and resumes from its durable checkpoint later;
 *  - every response's `x-ratelimit-*` budget is reported to `onRateLimit`, so a
 *    sweep stops before it exhausts the bucket the donor issue/comment lanes
 *    share with it;
 *  - redirects are never followed (a followed redirect would carry the Nango
 *    bearer to the Location host); a 3xx is an error the caller handles
 *    (renamed repositories are re-resolved by immutable id);
 *  - only Git Database / repository / installation-listing paths are accepted.
 */

export const NANGO_API_BASE = "https://api.nango.dev";
const JSON_TIMEOUT_MS = 60_000;
export const DEFAULT_SECONDARY_BACKOFF_MS = 60_000;

export interface GithubConnectionRef {
  providerConfigKey: string;
  connectionId: string;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/** Primary or secondary GitHub rate limit (or a Nango 429): stop and retry at `retryAt`. */
export class GithubRateLimitedError extends GithubApiError {
  constructor(
    message: string,
    status: number,
    readonly kind: "primary" | "secondary" | "reserve",
    readonly retryAt: Date | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message, status, "rate_limited");
    this.name = "GithubRateLimitedError";
  }
}

/** 401 / unknown Nango connection: the grant is unusable until the user reconnects. */
export class GithubAuthError extends GithubApiError {
  constructor(message: string, status: number, code: string | null = null) {
    super(message, status, code ?? "auth");
    this.name = "GithubAuthError";
  }
}

export interface RateLimitObservation {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  resource: string | null;
}

export interface JsonResult {
  status: number;
  data: unknown;
  rate: RateLimitObservation;
}

export interface GithubClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  /** Called before every upstream request (budgeting); throwing aborts the request. */
  onRequest?: () => void;
  /** Called with the rate-limit headers of every response. */
  onRateLimit?: (rate: RateLimitObservation) => void;
}

const ALLOWED_ENDPOINT = /^\/(repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^?#]*)?|repositories\/\d+(\/[^?#]*)?|installation\/repositories|user\/repos)$/u;

export class GithubClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;
  onRequest: GithubClientOptions["onRequest"];
  onRateLimit: GithubClientOptions["onRateLimit"];

  constructor(options: GithubClientOptions = {}) {
    const apiKey = options.apiKey ?? env.NANGO_SECRET_KEY;
    if (!apiKey) throw new Error("NANGO_SECRET_KEY is required for the GitHub content lane");
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = (options.baseUrl ?? NANGO_API_BASE).replace(/\/+$/u, "");
    this.#now = options.now ?? Date.now;
    this.onRequest = options.onRequest;
    this.onRateLimit = options.onRateLimit;
  }

  /**
   * GET a GitHub REST path. Statuses in `tolerate` are returned instead of thrown
   * (404/409/403 for deletion, empty-repository and access checks).
   */
  async get(conn: GithubConnectionRef, endpoint: string, params?: Record<string, string | number | undefined>, tolerate: readonly number[] = []): Promise<JsonResult> {
    assertEndpoint(endpoint);
    this.onRequest?.();
    const url = new URL(`${this.#base}/proxy${endpoint}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && String(v).length > 0) url.searchParams.set(k, String(v));
    const response = await this.#send(url, conn);
    const rate = rateLimitOf(response.headers);
    this.onRateLimit?.(rate);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      if (tolerate.includes(response.status)) return { status: response.status, data: null, rate };
      throw new GithubApiError(`unexpected redirect (HTTP ${response.status}) for ${endpoint}`, response.status, "unexpected_redirect");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.#raise(response, text, tolerate, rate);
      return { status: response.status, data: safeJson(text), rate };
    }
    const text = await response.text();
    if (!text.trim()) return { status: response.status, data: null, rate };
    try {
      return { status: response.status, data: JSON.parse(text) as unknown, rate };
    } catch {
      throw new GithubApiError(`GitHub returned non-JSON for ${endpoint}`, response.status, "bad_json");
    }
  }

  /**
   * Adapter for donor helpers that take `Pick<NangoClient, "proxy">`
   * (listGithubInstallationRepos) - same contract, but rate limits throw instead of sleeping.
   */
  proxy = async (input: { providerConfigKey: string; connectionId: string; endpoint: string; params?: Record<string, string | number | undefined>; tolerateStatuses?: number[] }): Promise<{ status: number; data: unknown }> => {
    const r = await this.get({ providerConfigKey: input.providerConfigKey, connectionId: input.connectionId }, input.endpoint, input.params, input.tolerateStatuses ?? []);
    return { status: r.status, data: r.data };
  };

  /** Throws for every non-tolerated failure; returns for tolerated statuses. */
  #raise(response: Response, body: string, tolerate: readonly number[], rate: RateLimitObservation): void {
    const status = response.status;
    const limited = rateLimitedOf(status, response.headers, body, rate, this.#now());
    if (limited) throw limited;
    if (tolerate.includes(status)) return;
    const code = nangoErrorCode(body);
    if (status === 401 || code === "unknown_connection" || code === "invalid_credentials" || code === "connection_not_found") {
      throw new GithubAuthError(`GitHub connection is not authorized (HTTP ${status}${code ? ` ${code}` : ""})`, status, code);
    }
    throw new GithubApiError(`GitHub request failed with HTTP ${status}${body ? `: ${githubMessage(body).slice(0, 300)}` : ""}`, status, code);
  }

  async #send(url: URL, conn: GithubConnectionRef): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_TIMEOUT_MS);
    try {
      return await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
          "Provider-Config-Key": conn.providerConfigKey,
          "Connection-Id": conn.connectionId,
          // Forwarded to GitHub by the Nango proxy (Nango-Proxy-* prefix).
          "Nango-Proxy-Accept": "application/vnd.github+json",
          "Nango-Proxy-X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw new GithubApiError(`GitHub request failed: ${error instanceof Error ? error.message : String(error)}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertEndpoint(endpoint: string): void {
  if (!ALLOWED_ENDPOINT.test(endpoint) || endpoint.split("/").some((s) => s === "." || s === "..")) {
    throw new GithubApiError(`refusing GitHub path ${JSON.stringify(endpoint.slice(0, 120))}`, 0, "bad_path");
  }
}

/** `/repos/<owner>/<repo>` with each segment validated (GitHub names are [A-Za-z0-9_.-]). */
export function repoEndpoint(fullName: string, rest = ""): string {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!owner || !repo || extra.length || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new GithubApiError(`invalid repository name ${JSON.stringify(fullName.slice(0, 120))}`, 0, "bad_repo");
  }
  return `/repos/${owner}/${repo}${rest}`;
}

/** Path-encode a branch name for `/git/ref/heads/<ref>` (slashes stay separators, as GitHub expects). */
export function refPath(ref: string): string {
  return ref.split("/").map((s) => encodeURIComponent(s)).join("/");
}

export function rateLimitOf(headers: Headers): RateLimitObservation {
  const n = (h: string): number | null => {
    const v = headers.get(h);
    if (v === null || v.trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const reset = n("x-ratelimit-reset");
  return { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetAt: reset !== null ? new Date(reset * 1000) : null, resource: headers.get("x-ratelimit-resource") };
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

/**
 * GitHub's documented rate-limit signals (REST "Rate limits for the REST API"):
 * primary = 403/429 with x-ratelimit-remaining 0 (wait until x-ratelimit-reset);
 * secondary = 403/429 with retry-after, or the "secondary rate limit" message
 * without headers (wait at least one minute, exponentially longer when repeated).
 * A 403 without any of these is a permission failure, not a rate limit.
 */
export function rateLimitedOf(status: number, headers: Headers, body: string, rate: RateLimitObservation, now: number): GithubRateLimitedError | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfterMs = retryAfterMsOf(headers, now);
  if (retryAfterMs !== null) return new GithubRateLimitedError(`GitHub secondary rate limit (HTTP ${status}, retry-after)`, status, "secondary", new Date(now + retryAfterMs), retryAfterMs);
  if (rate.remaining === 0) {
    const ms = rate.resetAt ? Math.max(1000, rate.resetAt.getTime() - now) : null;
    return new GithubRateLimitedError(`GitHub primary rate limit exhausted (HTTP ${status})`, status, "primary", ms !== null ? new Date(now + ms) : null, ms);
  }
  if (status === 429 || /secondary rate limit|abuse detection|rate limit exceeded/iu.test(body)) {
    return new GithubRateLimitedError(`GitHub secondary rate limit (HTTP ${status})`, status, "secondary", null, null);
  }
  return null;
}

// ------------------------------------------------------------------ blob decoding

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Exact bytes of a Git Database blob response (`encoding: base64`, content with
 * line breaks). Strict: only `\n`/`\r` are stripped, the alphabet and padding are
 * validated, and the decoded length must equal the declared size. No text
 * coercion ever happens; utf-8 encoded blobs (`encoding: utf-8`) are re-encoded
 * from the exact string GitHub returned and then verified by the git SHA-1.
 */
export function decodeBlobContent(data: unknown): Buffer {
  if (!isRecord(data)) throw new GithubApiError("blob response is not an object", 0, "bad_blob");
  const content = data.content;
  if (typeof content !== "string") throw new GithubApiError("blob response has no content", 0, "bad_blob");
  let bytes: Buffer;
  if (data.encoding === "base64") {
    const compact = content.replace(/[\r\n]/gu, "");
    if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) throw new GithubApiError("blob content is not canonical base64", 0, "bad_base64");
    bytes = Buffer.from(compact, "base64");
  } else if (data.encoding === "utf-8" || data.encoding === "utf8") {
    bytes = Buffer.from(content, "utf8");
  } else {
    throw new GithubApiError(`unsupported blob encoding ${JSON.stringify(data.encoding)}`, 0, "bad_blob");
  }
  if (typeof data.size === "number" && data.size !== bytes.length) {
    throw new GithubApiError(`blob decoded to ${bytes.length} bytes, GitHub declared ${data.size}`, 0, "blob_size_mismatch");
  }
  return bytes;
}

/** Git object id of a blob: sha1("blob <size>\0" + bytes). */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

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

function githubMessage(body: string): string {
  const parsed = safeJson(body);
  return isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : body;
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
