import { z } from "zod";
import { SLUG_RE } from "./names.js";
import { errorText, originBoundFetch, scrubSecrets, trustedUrl, UntrustedUrlError, type UrlPolicy } from "./security.js";

/**
 * Client for the trusted parent's HTTP integration catalog:
 *   GET  {baseUrl}/v1/integrations              -> {integrations:[...], childAuthConfigured, catalogConfigured}
 *   POST {baseUrl}/v1/integrations/:slug/token  -> 200 {slug, mcpUrl, token, tokenType, expiresAt, audience}
 *        | 404 integration_not_found | 503 child_auth_not_configured (retryable:false) | 502 token_failed (retryable:true)
 * The parent credential is fetched fresh from the provider for every request and is only ever sent to the
 * parent origin (no redirects). Child URLs come only from this authenticated catalog.
 */

/** Returns the parent credential (static key or a fresh OAuth access token). Called per request. */
export type CredentialProvider = () => string | Promise<string>;

/**
 * The parent credential provider failed (e.g. OAuth refresh failed). Nothing was sent. `reauth` means a new grant is
 * required (sticky; fail closed); otherwise it is transient.
 */
export class ParentCredentialError extends Error {
  constructor(message: string, readonly reauth: boolean, readonly code: string | null) {
    super(message);
    this.name = "ParentCredentialError";
  }
}

export interface ParentEndpoint extends UrlPolicy {
  /** Parent base URL, e.g. https://wild-zero-kq08i.run.mcp-use.com */
  baseUrl: string;
  /** Memory MCP URL; default `${baseUrl}/mcp`. Must be on the parent origin. */
  memoryMcpUrl?: string;
  credential: CredentialProvider;
  /**
   * 401 hook for refreshable credentials, e.g. OAuthRefreshProvider.forceRefresh. Called with the rejected credential
   * after a PRE-EXECUTION 401 (catalog, token mint, memory MCP request); the rejected request is then retried once.
   * Throwing (e.g. OAuthRefreshError with reauthRequired) fails closed: no further retry.
   */
  onUnauthorized?: (rejectedCredential: string | undefined) => Promise<unknown>;
  fetch?: typeof fetch;
  /** Per-request timeout for catalog/token calls. Default 15s. */
  timeoutMs?: number;
}

export interface CatalogEntry {
  slug: string;
  title: string;
  description: string;
  mcpUrl: string;
  tools: string[];
  commit: string;
  deploymentId: string;
  deployedAt: string;
  audience: string;
}

export type CatalogResult =
  | {
      kind: "ok";
      /** false when the parent answered `note: "integration catalog not configured"` (a valid, empty catalog). */
      configured: boolean;
      /** false when the parent reports childAuthConfigured:false: tokens cannot be minted, so children are not connected. */
      childAuth: boolean;
      integrations: CatalogEntry[];
      rejected: Array<{ slug: string | null; reason: string }>;
    }
  | { kind: "unauthorized"; status: number; message: string }
  | { kind: "transient"; status: number | null; message: string };

export interface ChildToken {
  slug: string;
  mcpUrl: string;
  token: string;
  /** Server-reported expiry (server clock). */
  expiresAtMs: number;
  /**
   * Remaining lifetime measured on the SERVER clock (expiresAt minus the response Date header, or minus local time if
   * the header is absent). Callers anchor it to their own clock, so client/server clock skew cannot make an expired
   * token look fresh or a fresh token look expired.
   */
  lifetimeMs: number;
  audience: string | null;
}

/** Tokens with less remaining lifetime than this are rejected as already expired. */
export const MIN_CHILD_TOKEN_LIFETIME_MS = 5_000;

/**
 * unauthorized: parent credential rejected (401/403)
 * not_found:    integration not deployed for this tenant (404)
 * unconfigured: the parent cannot mint child tokens at all (503 retryable:false, e.g. child_auth_not_configured)
 * transient:    network, timeout, 408/429/5xx, malformed body: retry later
 * mismatch:     the response does not match the catalog entry (slug/mcpUrl/audience/type) or is already expired
 */
export type ChildTokenFailure = "unauthorized" | "not_found" | "unconfigured" | "transient" | "mismatch";

export class ChildTokenError extends Error {
  constructor(readonly kind: ChildTokenFailure, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ChildTokenError";
  }
}

const EntrySchema = z.object({
  slug: z.string(),
  title: z.string().optional().default(""),
  description: z.string().optional().default(""),
  mcpUrl: z.string(),
  tools: z.array(z.string()).optional().default([]),
  commit: z.string().optional().default(""),
  deploymentId: z.string().optional().default(""),
  deployedAt: z.string().optional().default(""),
  audience: z.string().optional().default(""),
});
const CatalogSchema = z.object({ integrations: z.array(z.unknown()), childAuthConfigured: z.boolean().optional(), catalogConfigured: z.boolean().optional(), note: z.string().optional() });
const RECENT_CREDENTIALS = 16;
const TokenSchema = z.object({ slug: z.string(), mcpUrl: z.string(), token: z.string().min(16), tokenType: z.string().optional(), expiresAt: z.union([z.string(), z.number()]), audience: z.string().optional() });

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class ParentClient {
  readonly origin: string;
  readonly baseUrl: string;
  readonly memoryMcpUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /** Recent credential values, kept only so they can be scrubbed from text and results (bounded). */
  readonly #recent: string[] = [];

  constructor(private readonly opts: ParentEndpoint) {
    const base = trustedUrl(opts.baseUrl, opts, "Parent baseUrl");
    this.origin = base.origin;
    this.baseUrl = base.toString().replace(/\/+$/, "");
    const mem = trustedUrl(opts.memoryMcpUrl ?? `${this.baseUrl}/mcp`, opts, "Memory MCP URL");
    if (mem.origin !== this.origin) throw new UntrustedUrlError("Memory MCP URL must be on the parent origin");
    this.memoryMcpUrl = mem.toString();
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get policy(): UrlPolicy {
    return { allowInsecureLocalhost: this.opts.allowInsecureLocalhost === true };
  }

  /** Fresh parent credential (never cached here). Provider failures surface as ParentCredentialError. */
  async credential(): Promise<string> {
    let v: string;
    try {
      v = await this.opts.credential();
    } catch (error) {
      const e = error as { reauthRequired?: unknown; kind?: unknown; code?: unknown };
      const reauth = e?.reauthRequired === true || e?.kind === "reauth";
      throw new ParentCredentialError(this.scrub(`parent credential unavailable: ${errorText(error)}`), reauth, typeof e?.code === "string" ? e.code : null);
    }
    if (typeof v !== "string" || !v) throw new ParentCredentialError("Parent credential provider returned no credential", false, "no_credential");
    if (this.#recent[this.#recent.length - 1] !== v) {
      const i = this.#recent.indexOf(v);
      if (i >= 0) this.#recent.splice(i, 1);
      this.#recent.push(v);
      if (this.#recent.length > RECENT_CREDENTIALS) this.#recent.shift();
    }
    return v;
  }

  /**
   * After a pre-execution 401 with the parent credential: ask the hook (if any) for a fresh credential.
   * Returns true when one retry is worthwhile; false when the hook says re-authentication is required.
   * Throws ParentCredentialError for a transient refresh failure.
   */
  async recoverFromUnauthorized(rejected: string | undefined): Promise<boolean> {
    if (!this.opts.onUnauthorized) return true; // the next credential() call is fresh anyway (rotation by the caller)
    try {
      // Pass the EXACT credential the failed request carried: a late 401 for an old token then adopts the newer token
      // instead of forcing another rotation. (undefined only if it could not be determined; the hook rate-limits that.)
      await this.opts.onUnauthorized(rejected);
      return true;
    } catch (error) {
      const e = error as { reauthRequired?: unknown; kind?: unknown; code?: unknown };
      if (e?.reauthRequired === true || e?.kind === "reauth") return false;
      throw new ParentCredentialError(this.scrub(`parent credential refresh failed: ${errorText(error)}`), false, typeof e?.code === "string" ? e.code : null);
    }
  }

  /** Parent credential values seen recently (for exact-value scrubbing; never logged). */
  recentCredentials(): readonly string[] {
    return this.#recent;
  }

  scrub(text: string, extra: Iterable<string> = []): string {
    return scrubSecrets(text, [...this.#recent, ...extra]);
  }

  /** One parent request with a freshly obtained credential; returns the response and the credential it carried. */
  async #send(url: string, init: RequestInit): Promise<{ res: Response; sent: string }> {
    const sent = await this.credential(); // ParentCredentialError propagates (nothing sent)
    const res = await originBoundFetch(this.origin, async () => sent, this.#fetch)(url, init);
    return { res, sent };
  }

  async listIntegrations(): Promise<CatalogResult> {
    let res: Response;
    let sent: string;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ res, sent } = await this.#send(`${this.baseUrl}/v1/integrations`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.#timeoutMs) }));
      } catch (error) {
        if (error instanceof UntrustedUrlError) throw error;
        if (error instanceof ParentCredentialError) return error.reauth ? { kind: "unauthorized", status: 401, message: error.message } : { kind: "transient", status: null, message: error.message };
        return { kind: "transient", status: null, message: this.scrub(`catalog request failed: ${errorText(error)}`) };
      }
      if (res.status !== 401 || attempt > 0) break;
      await res.body?.cancel().catch(() => undefined);
      try {
        if (!(await this.recoverFromUnauthorized(sent))) return { kind: "unauthorized", status: 401, message: "parent credential rejected and re-authentication is required" };
      } catch (error) {
        return { kind: "transient", status: null, message: errorText(error) };
      }
    }
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized", status: res.status, message: (await this.#errorInfo(res)).message };
    if (!res.ok) return { kind: "transient", status: res.status, message: (await this.#errorInfo(res)).message };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "transient", status: res.status, message: "catalog response was not JSON" };
    }
    const parsed = CatalogSchema.safeParse(body);
    if (!parsed.success) return { kind: "transient", status: res.status, message: "catalog response did not match {integrations:[...]}" };
    const configured = parsed.data.catalogConfigured !== false && parsed.data.note === undefined;
    const childAuth = parsed.data.childAuthConfigured !== false;
    const rejected: Array<{ slug: string | null; reason: string }> = [];
    const bySlug = new Map<string, CatalogEntry[]>();
    for (const raw of parsed.data.integrations) {
      const e = EntrySchema.safeParse(raw);
      if (!e.success) {
        rejected.push({ slug: typeof (raw as { slug?: unknown })?.slug === "string" ? (raw as { slug: string }).slug : null, reason: "malformed catalog entry" });
        continue;
      }
      if (!SLUG_RE.test(e.data.slug)) {
        rejected.push({ slug: null, reason: "invalid slug" });
        continue;
      }
      try {
        e.data.mcpUrl = trustedUrl(e.data.mcpUrl, this.policy, `mcpUrl for ${e.data.slug}`).toString();
      } catch (error) {
        rejected.push({ slug: e.data.slug, reason: errorText(error) });
        continue;
      }
      bySlug.set(e.data.slug, [...(bySlug.get(e.data.slug) ?? []), e.data]);
    }
    const integrations: CatalogEntry[] = [];
    for (const [slug, list] of bySlug) {
      if (list.length > 1) rejected.push({ slug, reason: "duplicate slug in catalog" });
      else integrations.push(list[0]!);
    }
    integrations.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return { kind: "ok", configured, childAuth, integrations, rejected };
  }

  /** Mint a short-lived child bearer. The response must match the catalog entry it was requested for. */
  async childToken(entry: Pick<CatalogEntry, "slug" | "mcpUrl" | "audience">): Promise<ChildToken> {
    let res: Response;
    let sent: string;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ res, sent } = await this.#send(`${this.baseUrl}/v1/integrations/${encodeURIComponent(entry.slug)}/token`, { method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.#timeoutMs) }));
      } catch (error) {
        if (error instanceof UntrustedUrlError) throw error;
        if (error instanceof ParentCredentialError) throw new ChildTokenError(error.reauth ? "unauthorized" : "transient", error.message);
        throw new ChildTokenError("transient", this.scrub(`token request for ${entry.slug} failed: ${errorText(error)}`));
      }
      // Minting has no side effect beyond issuing a token, and a 401 is rejected before issuing: one retry is safe.
      if (res.status !== 401 || attempt > 0) break;
      await res.body?.cancel().catch(() => undefined);
      let retry: boolean;
      try {
        retry = await this.recoverFromUnauthorized(sent);
      } catch (error) {
        throw new ChildTokenError("transient", errorText(error));
      }
      if (!retry) throw new ChildTokenError("unauthorized", `token request for ${entry.slug} rejected: re-authentication is required`, 401);
    }
    if (!res.ok) {
      const info = await this.#errorInfo(res);
      const what = `token request for ${entry.slug} failed: ${info.message}`;
      if (res.status === 401 || res.status === 403) throw new ChildTokenError("unauthorized", what, res.status);
      if (res.status === 404) throw new ChildTokenError("not_found", `integration ${entry.slug} is not deployed for this tenant: ${info.message}`, res.status);
      if (info.retryable === false || info.code === "child_auth_not_configured" || info.code === "not_configured") throw new ChildTokenError("unconfigured", what, res.status);
      if (isRetryable(res.status)) throw new ChildTokenError("transient", what, res.status);
      throw new ChildTokenError("mismatch", what, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ChildTokenError("transient", `token response for ${entry.slug} was not JSON`, res.status);
    }
    const t = TokenSchema.safeParse(body);
    if (!t.success) throw new ChildTokenError("mismatch", `token response for ${entry.slug} is malformed`, res.status);
    const known = [t.data.token];
    if (t.data.slug !== entry.slug) throw new ChildTokenError("mismatch", this.scrub(`token response slug does not match ${entry.slug}`, known));
    let mcpUrl: string;
    try {
      mcpUrl = trustedUrl(t.data.mcpUrl, this.policy, `token mcpUrl for ${entry.slug}`).toString();
    } catch (error) {
      throw new ChildTokenError("mismatch", this.scrub(errorText(error), known));
    }
    if (mcpUrl !== entry.mcpUrl) throw new ChildTokenError("mismatch", `token mcpUrl for ${entry.slug} differs from the catalog entry`);
    if (t.data.tokenType && t.data.tokenType.toLowerCase() !== "bearer") throw new ChildTokenError("mismatch", `unsupported token type for ${entry.slug}`);
    if (entry.audience && t.data.audience && t.data.audience !== entry.audience) throw new ChildTokenError("mismatch", `token audience for ${entry.slug} differs from the catalog entry`);
    const expiresAtMs = typeof t.data.expiresAt === "number" ? (t.data.expiresAt < 1e12 ? t.data.expiresAt * 1000 : t.data.expiresAt) : Date.parse(t.data.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new ChildTokenError("mismatch", `token expiry for ${entry.slug} is invalid`);
    const serverNow = Date.parse(res.headers.get("date") ?? "");
    const lifetimeMs = expiresAtMs - (Number.isFinite(serverNow) ? serverNow : Date.now());
    if (lifetimeMs < MIN_CHILD_TOKEN_LIFETIME_MS) throw new ChildTokenError("mismatch", `token for ${entry.slug} is already expired or has a near-zero lifetime`);
    return { slug: entry.slug, mcpUrl, token: t.data.token, expiresAtMs, lifetimeMs, audience: t.data.audience ?? null };
  }

  async #errorInfo(res: Response): Promise<{ message: string; code?: string; retryable?: boolean }> {
    let msg = `${res.status} ${res.statusText}`.trim();
    let code: string | undefined;
    let retryable: boolean | undefined;
    try {
      const text = (await res.text()).slice(0, 2048);
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean } | string; message?: string; retryable?: boolean };
        const detail = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
        code = typeof j.error === "object" ? j.error?.code : undefined;
        const r = typeof j.error === "object" && typeof j.error?.retryable === "boolean" ? j.error.retryable : j.retryable;
        if (typeof r === "boolean") retryable = r;
        if (detail) msg = `${res.status} ${code ? `${code}: ` : ""}${detail}`;
      } catch {
        if (text.trim()) msg = `${res.status} ${text.trim().slice(0, 200)}`;
      }
    } catch {
      // body unreadable
    }
    return { message: this.scrub(msg), ...(code ? { code } : {}), ...(retryable !== undefined ? { retryable } : {}) };
  }
}
