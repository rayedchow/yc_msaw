/**
 * OAuth 2.1 refresh-token credential provider for the procmem SDK.
 *
 * The initial login (authorization code + PKCE, DCR/CIMD client registration) happens elsewhere, with any standard
 * OAuth client or CLI. This module only *maintains* an existing grant:
 *
 *  - `getToken()` returns a currently valid access token and refreshes it shortly before it expires (WorkOS AuthKit
 *    issues 300 s access tokens). It is bound, so `credential: provider.getToken` plugs into any
 *    `() => Promise<string>` credential slot. `forceRefresh(rejectedAccessToken)` is the bound hook to call once
 *    after a pre-execution 401.
 *  - Concurrent callers share one refresh (single flight). Every refresh runs under the store's exclusive lock and
 *    re-reads the store first, so a grant rotated by another instance or process is adopted, never replayed.
 *  - The refresh POST is itself a mutating request: once it has been sent, the old refresh token may be consumed.
 *    So the new token set is persisted atomically *before* any caller sees the new access token, and the store lock
 *    is held until that write succeeds (nobody else can load and replay the consumed refresh token meanwhile). If
 *    the outcome of a sent refresh is unknown (timeout, dropped connection, 5xx, unreadable 200), the provider does
 *    not resend the old refresh token: it marks the stored grant as quarantined and fails closed until a new grant
 *    is supplied. Only failures that provably happened before the grant could be consumed (connection refused, DNS,
 *    TLS, 408/429/503) are retried, with bounded exponential backoff.
 *  - `invalid_grant`, `invalid_client` and other definitive rejections fail closed and stay failed until a different
 *    grant appears in the store or `replaceGrant` is called. There is no silent interactive/browser re-login.
 *  - The canonical MCP resource URI (RFC 8707 `resource`) is sent on every refresh. `scope` is sent only when
 *    explicitly configured, and never adds scopes beyond the original grant (RFC 6749 §6).
 *  - The token endpoint must be https (http only on loopback with `allowInsecureLocalhost`, for tests). Redirects
 *    are never followed. Responses are validated strictly; a missing `refresh_token` keeps the previous one.
 *  - Secrets never appear in errors, events, `status()`, `toJSON()` or `util.inspect` output.
 *
 * The cross-instance no-replay guarantee holds for stores whose `acquireLock` is shared by every writer
 * (`FileTokenStore` across processes on one host; `MemoryTokenStore` within one process). A store without
 * `acquireLock` is serialized only per store object in this process and must have a single owner.
 *
 * This is a pre-request credential source only. It never retries or replays MCP requests (tool calls included).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { errorText, scrubSecrets, trustedUrl, UntrustedUrlError } from "./live/security.js";

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

/** Ties stored tokens to the authorization server/client/resource they were issued for. */
export interface OAuthGrantBinding {
  tokenEndpoint: string;
  clientId: string;
  resource?: string;
}

/** One OAuth token set. Times are epoch milliseconds. */
export interface OAuthTokens {
  /** May be "" when only a refresh token is known (forces a refresh on first use). */
  accessToken: string;
  refreshToken?: string;
  /** As issued by the server; must be "Bearer" (case-insensitive). */
  tokenType: string;
  /** Absolute expiry. 0 (or any past time) forces a refresh before the token is used. */
  expiresAt: number;
  /** When the token was obtained; scales the refresh margin for short-lived tokens. */
  obtainedAt?: number;
  scope?: string;
  /** Persisted when the server returns one; never returned by getToken(). */
  idToken?: string;
  binding?: OAuthGrantBinding;
  /**
   * Set when a refresh with this grant was sent but its outcome is unknown: the refresh token may already be
   * consumed, so no provider will use it again. Cleared only by storing a new grant.
   */
  quarantine?: { code: string; at: number };
}

/** Exclusive lock over one token store. */
export interface TokenStoreLock {
  release(): Promise<void>;
}

/**
 * Durable storage for one grant. `save` must be atomic and durable before it resolves. `acquireLock` must be an
 * exclusive lock shared by every writer of the same underlying storage; it must never be taken over automatically
 * from a holder that may still be alive. Without `acquireLock`, providers are serialized only within this process,
 * per store object.
 */
export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
  acquireLock?(options: { timeoutMs: number; signal?: AbortSignal }): Promise<TokenStoreLock>;
}

export type ClientAuthentication =
  | { method: "none" }
  | { method: "client_secret_post"; clientSecret: string }
  | { method: "client_secret_basic"; clientSecret: string };

export interface OAuthRefreshProviderOptions {
  /** Authorization server token endpoint, e.g. https://<tenant>.authkit.app/oauth2/token */
  tokenEndpoint: string;
  clientId: string;
  /** Default `{ method: "none" }` (public client, e.g. DCR with token_endpoint_auth_method=none). */
  clientAuth?: ClientAuthentication;
  /** Canonical resource URI of the protected MCP server (RFC 8707), e.g. https://host/mcp. Sent on every refresh. */
  resource?: string;
  /** Space-separated scopes to request on refresh. Omit to keep the granted scope (recommended). */
  scope?: string;
  store: TokenStore;
  /** Used only when the store is empty; persisted to the store on first use. */
  initialTokens?: OAuthTokens;
  /** Refresh this long before expiry (capped at half the token lifetime). Default 60 s. */
  refreshSkewMs?: number;
  /** Never return a token with less validity than this (capped at a quarter of the lifetime). Default 10 s. */
  minValidityMs?: number;
  /** Token endpoint request timeout. Default 15 s. */
  timeoutMs?: number;
  /** How long to wait for the store lock. Default 30 s. */
  lockTimeoutMs?: number;
  /** Backoff after a retryable failure. Defaults: 1 s initial, 60 s max. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** forceRefresh() without a rejected token is ignored if a refresh succeeded this recently. Default 5 s. */
  forceMinIntervalMs?: number;
  /** Minimum interval between store re-reads while a sticky failure is in effect. Default 1 s. */
  stickyRecheckMs?: number;
  /** Allow http:// token endpoint / resource on loopback hosts. Tests and local development only. */
  allowInsecureLocalhost?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** Credential-free lifecycle events (safe to log). */
  onEvent?: (event: OAuthRefreshEvent) => void;
}

export type OAuthRefreshErrorKind = "transient" | "permanent" | "reauth";

export type OAuthRefreshErrorCode =
  | "invalid_config"
  | "no_tokens"
  | "no_refresh_token"
  | "invalid_grant"
  | "client_rejected"
  | "refresh_rejected"
  | "refresh_outcome_unknown"
  | "scope_not_granted"
  | "grant_removed"
  | "grant_binding_mismatch"
  | "invalid_response"
  | "redirect_blocked"
  | "http_error"
  | "server_unavailable"
  | "rate_limited"
  | "network_error"
  | "lock_timeout"
  | "store_error"
  | "persist_failed"
  | "token_expired"
  | "disposed";

/** Error text never contains token, secret or authorization header values. */
export class OAuthRefreshError extends Error {
  readonly code: OAuthRefreshErrorCode;
  readonly kind: OAuthRefreshErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(code: OAuthRefreshErrorCode, kind: OAuthRefreshErrorKind, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "OAuthRefreshError";
    this.code = code;
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
  /** True when a new grant (re-login) is required; the provider will not retry on its own. */
  get reauthRequired(): boolean {
    return this.kind === "reauth";
  }
}

export type OAuthRefreshEvent =
  | { type: "refresh_started"; at: number; forced: boolean }
  | { type: "refresh_succeeded"; at: number; durationMs: number; rotated: boolean; expiresAt: number }
  | { type: "refresh_failed"; at: number; durationMs: number; code: OAuthRefreshErrorCode; kind: OAuthRefreshErrorKind; status?: number; retryAfterMs?: number }
  | { type: "adopted_from_store"; at: number; expiresAt: number }
  | { type: "fallback_to_current"; at: number; expiresAt: number; code: OAuthRefreshErrorCode }
  | { type: "persist_recovered"; at: number }
  | { type: "reauth_required"; at: number; code: OAuthRefreshErrorCode }
  | { type: "grant_replaced"; at: number };

export type OAuthProviderState = "unloaded" | "valid" | "needs_refresh" | "refreshing" | "backoff" | "reauth_required" | "persist_pending" | "disposed";

/** Credential-free snapshot. */
export interface OAuthProviderStatus {
  state: OAuthProviderState;
  expiresAt?: number;
  hasRefreshToken: boolean;
  /** Token requests that returned a new token set. */
  refreshCount: number;
  /** Token sets adopted from the store (rotated by another instance/process). */
  adoptedCount: number;
  consecutiveFailures: number;
  backoffUntil?: number;
  lastRefreshAt?: number;
  lastErrorCode?: OAuthRefreshErrorCode;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------------------------

const CTRL_OR_SPACE = /[\s\x00-\x1f\x7f]/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;

function configError(message: string): OAuthRefreshError {
  return new OAuthRefreshError("invalid_config", "permanent", message);
}

function nonNegative(name: string, v: number | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw configError(`${name} must be a non-negative finite number`);
  return v;
}

function isTokenString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TOKEN_CHARS && !CTRL_OR_SPACE.test(v);
}

/** Validates and copies a token set (throws a credential-free error). */
export function validateTokens(t: unknown, what = "tokens"): OAuthTokens {
  if (!t || typeof t !== "object") throw configError(`${what} must be an object`);
  const o = t as Record<string, unknown>;
  if (typeof o.accessToken !== "string" || (o.accessToken !== "" && !isTokenString(o.accessToken))) throw configError(`${what}.accessToken must be a token string`);
  if (o.refreshToken !== undefined && !isTokenString(o.refreshToken)) throw configError(`${what}.refreshToken must be a token string`);
  if (typeof o.tokenType !== "string" || o.tokenType.toLowerCase() !== "bearer") throw configError(`${what}.tokenType must be Bearer`);
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt) || o.expiresAt < 0) throw configError(`${what}.expiresAt must be epoch milliseconds`);
  if (o.obtainedAt !== undefined && (typeof o.obtainedAt !== "number" || !Number.isFinite(o.obtainedAt))) throw configError(`${what}.obtainedAt must be epoch milliseconds`);
  if (o.scope !== undefined && typeof o.scope !== "string") throw configError(`${what}.scope must be a string`);
  if (o.idToken !== undefined && !isTokenString(o.idToken)) throw configError(`${what}.idToken must be a token string`);
  if (!o.accessToken && !o.refreshToken) throw configError(`${what} needs an access token or a refresh token`);
  const out: OAuthTokens = { accessToken: o.accessToken, tokenType: o.tokenType, expiresAt: o.expiresAt };
  if (o.refreshToken !== undefined) out.refreshToken = o.refreshToken as string;
  if (o.obtainedAt !== undefined) out.obtainedAt = o.obtainedAt as number;
  if (o.scope !== undefined) out.scope = o.scope;
  if (o.idToken !== undefined) out.idToken = o.idToken as string;
  if (o.binding !== undefined) {
    const b = o.binding as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || typeof b.tokenEndpoint !== "string" || typeof b.clientId !== "string" || (b.resource !== undefined && typeof b.resource !== "string")) {
      throw configError(`${what}.binding is malformed`);
    }
    out.binding = { tokenEndpoint: b.tokenEndpoint, clientId: b.clientId, ...(b.resource !== undefined ? { resource: b.resource as string } : {}) };
  }
  if (o.quarantine !== undefined) {
    const q = o.quarantine as Record<string, unknown> | null;
    if (!q || typeof q !== "object" || typeof q.code !== "string" || typeof q.at !== "number") throw configError(`${what}.quarantine is malformed`);
    out.quarantine = { code: q.code, at: q.at };
  }
  return out;
}

interface ParsedTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresInMs: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

/** Returns a credential-free reason string when invalid. */
function parseTokenResponse(o: Record<string, unknown>): ParsedTokenResponse | string {
  if (!isTokenString(o.access_token)) return "has no valid access_token";
  if (typeof o.token_type !== "string" || o.token_type.toLowerCase() !== "bearer") return "token_type is not Bearer";
  if (typeof o.expires_in !== "number" || !Number.isFinite(o.expires_in) || o.expires_in <= 0) return "expires_in is missing or not a positive number";
  if (o.refresh_token !== undefined && o.refresh_token !== null && !isTokenString(o.refresh_token)) return "refresh_token is malformed";
  if (o.scope !== undefined && o.scope !== null && typeof o.scope !== "string") return "scope is malformed";
  if (o.id_token !== undefined && o.id_token !== null && !isTokenString(o.id_token)) return "id_token is malformed";
  return {
    accessToken: o.access_token,
    tokenType: o.token_type,
    expiresInMs: Math.floor(o.expires_in * 1000),
    ...(isTokenString(o.refresh_token) ? { refreshToken: o.refresh_token } : {}),
    ...(typeof o.scope === "string" ? { scope: o.scope } : {}),
    ...(isTokenString(o.id_token) ? { idToken: o.id_token } : {}),
  };
}

/**
 * Converts a standard OAuth token endpoint response (`access_token`, `expires_in`, ...) into `OAuthTokens`,
 * e.g. for seeding `initialTokens` right after an external login.
 */
export function tokensFromTokenResponse(response: Record<string, unknown>, obtainedAt: number = Date.now()): OAuthTokens {
  const parsed = parseTokenResponse(response);
  if (typeof parsed === "string") throw configError(`token response ${parsed}`);
  return {
    accessToken: parsed.accessToken,
    tokenType: parsed.tokenType,
    expiresAt: obtainedAt + parsed.expiresInMs,
    obtainedAt,
    ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
    ...(parsed.idToken ? { idToken: parsed.idToken } : {}),
  };
}

function fingerprint(secret: string | undefined): string | undefined {
  return secret ? createHash("sha256").update(secret).digest("hex") : undefined;
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new OAuthRefreshError("disposed", "permanent", "aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(new OAuthRefreshError("disposed", "permanent", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const d = Date.parse(s);
  return Number.isFinite(d) ? Math.max(0, d - nowMs) : undefined;
}

/** Strips control characters and truncates server-provided text before it is scrubbed into an error. */
function serverText(v: unknown, max = 200): string {
  return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, max) : "";
}

/** Connection-level failures that prove the request never reached the server. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function provablyNotSent(e: unknown): boolean {
  const codes: string[] = [];
  const visit = (x: unknown, depth: number) => {
    if (!x || typeof x !== "object" || depth > 4) return;
    const c = errCode(x);
    if (c) codes.push(c);
    const errors = (x as { errors?: unknown }).errors;
    if (Array.isArray(errors)) for (const sub of errors) visit(sub, depth + 1);
    visit((x as { cause?: unknown }).cause, depth + 1);
  };
  visit((e as { cause?: unknown } | null)?.cause, 0);
  return codes.length > 0 && codes.every((c) => NOT_SENT_CODES.has(c));
}

// ---------------------------------------------------------------------------------------------------------------
// In-process exclusive lock with bounded waits
// ---------------------------------------------------------------------------------------------------------------

class LocalLock {
  #held = false;
  #waiters: Array<() => void> = [];

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new OAuthRefreshError("disposed", "permanent", "lock wait aborted"));
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((res, rej) => {
      const grant = () => {
        cleanup();
        res(this.#releaser());
      };
      const fail = (err: OAuthRefreshError) => {
        cleanup();
        const i = this.#waiters.indexOf(grant);
        if (i >= 0) this.#waiters.splice(i, 1);
        rej(err);
      };
      const timer = setTimeout(() => fail(new OAuthRefreshError("lock_timeout", "transient", "timed out waiting for the token store lock")), timeoutMs);
      const onAbort = () => fail(new OAuthRefreshError("disposed", "permanent", "lock wait aborted"));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(grant);
    });
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#held = false;
    };
  }
}

const storeLocks = new WeakMap<object, LocalLock>();
const pathLocks = new Map<string, LocalLock>();

function localLockFor(key: object): LocalLock {
  let l = storeLocks.get(key);
  if (!l) storeLocks.set(key, (l = new LocalLock()));
  return l;
}

function localLockForPath(path: string): LocalLock {
  let l = pathLocks.get(path);
  if (!l) pathLocks.set(path, (l = new LocalLock()));
  return l;
}

// ---------------------------------------------------------------------------------------------------------------
// Secure files (POSIX permissions enforced; skipped on Windows)
// ---------------------------------------------------------------------------------------------------------------

const POSIX = process.platform !== "win32";
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function storeError(message: string): OAuthRefreshError {
  return new OAuthRefreshError("store_error", "permanent", message);
}

/** Ensures `dir` is a real directory owned by this user and not group/world writable; creates it 0700 if missing. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw storeError(`cannot inspect token store directory ${dir} (${errCode(e) ?? "error"})`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    st = await lstat(dir);
  }
  if (st.isSymbolicLink()) throw storeError(`token store directory ${dir} is a symlink`);
  if (!st.isDirectory()) throw storeError(`token store directory ${dir} is not a directory`);
  if (POSIX) {
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw storeError(`token store directory ${dir} is not owned by the current user`);
    if (st.mode & 0o022) throw storeError(`token store directory ${dir} is group/world writable`);
  }
}

/**
 * Reads a secret file without following symlinks. Rejects non-regular files, files not owned by the current user
 * and files accessible by group or others (mode must be 0600 or stricter). Returns null when missing.
 */
export async function readSecretFile(path: string, maxBytes = MAX_RESPONSE_BYTES): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    const c = errCode(e);
    if (c === "ENOENT") return null;
    if (c === "ELOOP" || c === "EMLINK") throw storeError(`secret file ${path} is a symlink`);
    throw storeError(`cannot open secret file ${path} (${c ?? "error"})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw storeError(`secret file ${path} is not a regular file`);
    if (POSIX) {
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw storeError(`secret file ${path} is not owned by the current user`);
      if (st.mode & 0o077) throw storeError(`secret file ${path} must have mode 0600 (chmod 600)`);
    }
    if (st.size > maxBytes) throw storeError(`secret file ${path} is too large`);
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Atomically replaces `path` with `data`: writes a 0600 temp file in the same directory (O_EXCL|O_NOFOLLOW),
 * fsyncs it, renames it over the target and fsyncs the directory. Refuses symlinked targets and insecure directories.
 */
export async function writeSecretFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await ensurePrivateDir(dir);
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw storeError(`secret file ${path} is a symlink`);
    if (!st.isFile()) throw storeError(`secret file ${path} is not a regular file`);
  } catch (e) {
    if (e instanceof OAuthRefreshError) throw e;
    if (errCode(e) !== "ENOENT") throw storeError(`cannot inspect secret file ${path} (${errCode(e) ?? "error"})`);
  }
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    const fh = await open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW, 0o600);
    created = true;
    try {
      await fh.writeFile(data, "utf8");
      if (POSIX) await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    created = false;
  } catch (e) {
    if (created) await unlink(tmp).catch(() => undefined);
    if (e instanceof OAuthRefreshError) throw e;
    throw storeError(`atomic write of ${path} failed (${errCode(e) ?? "error"})`);
  }
  if (POSIX) {
    try {
      const dh = await open(dir, fsConstants.O_RDONLY);
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Directory fsync is best effort on filesystems that do not support it.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cross-process exclusive lock file. No automatic takeover: an existing lock file is never broken by age or by a
// pid check (both are unsafe without kernel-level ownership proof). A lock left behind by a crashed process blocks
// refreshes (fail closed) until an operator who has stopped every writer removes it (`FileTokenStore.removeLock`).
// ---------------------------------------------------------------------------------------------------------------

interface LockInfo {
  pid: number;
  host: string;
  nonce: string;
  createdAt: number;
}

async function readLockInfo(path: string): Promise<LockInfo | null> {
  try {
    const raw = await readFile(path, { encoding: "utf8", flag: fsConstants.O_RDONLY | O_NOFOLLOW });
    const j = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof j.pid === "number" && typeof j.host === "string" && typeof j.nonce === "string" && typeof j.createdAt === "number") return j as LockInfo;
  } catch {
    // Missing, symlinked, partially written or foreign: unknown holder.
  }
  return null;
}

/** Acquires an exclusive O_CREAT|O_EXCL lock file (0600), waiting at most `timeoutMs`. */
export async function acquireFileLock(lockPath: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TokenStoreLock> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const nonce = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  await ensurePrivateDir(dirname(lockPath));
  for (;;) {
    if (options.signal?.aborted) throw new OAuthRefreshError("disposed", "permanent", "lock wait aborted");
    try {
      const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW, 0o600);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce, createdAt: Date.now() } satisfies LockInfo));
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw storeError(`cannot create lock ${lockPath} (${errCode(e) ?? "error"})`);
    }
    if (Date.now() >= deadline) {
      const info = await readLockInfo(lockPath);
      const holder = info ? `held by pid ${info.pid} on ${info.host} for ${Math.round((Date.now() - info.createdAt) / 1000)} s` : "holder unknown";
      throw new OAuthRefreshError(
        "lock_timeout",
        "transient",
        `timed out waiting for token store lock ${lockPath} (${holder}); if no process holds it, stop every writer of this store and remove the lock file`,
      );
    }
    await sleep(delay + Math.random() * delay, options.signal);
    delay = Math.min(delay * 2, 200);
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const info = await readLockInfo(lockPath);
      if (info?.nonce === nonce) await unlink(lockPath).catch(() => undefined);
    },
  };
}

/** Runs `fn` while holding `acquireFileLock(lockPath)`. */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const lock = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Token stores
// ---------------------------------------------------------------------------------------------------------------

const FILE_FORMAT = "procmem-oauth-token-store";

export interface FileTokenStoreOptions {
  /** Token file path. Its directory is created 0700 if missing; the file is written 0600. */
  path: string;
  /** Lock file path; default `${path}.lock`. */
  lockPath?: string;
}

/**
 * Node file store in the SDK's own JSON format. Writes are atomic (temp + fsync + rename), the file is 0600, the
 * directory is private, symlinks are refused, and `acquireLock` is an exclusive cross-process lock file, so several
 * providers/processes on one host can share one grant without replaying or losing a rotated refresh token.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(options: FileTokenStoreOptions | string) {
    const o = typeof options === "string" ? { path: options } : options;
    if (!o.path) throw configError("FileTokenStore needs a path");
    this.path = resolve(o.path);
    this.lockPath = resolve(o.lockPath ?? `${this.path}.lock`);
  }

  async load(): Promise<OAuthTokens | null> {
    const raw = await readSecretFile(this.path);
    if (raw === null) return null;
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      throw storeError(`token store ${this.path} is not valid JSON`);
    }
    const o = j as { format?: unknown; version?: unknown; tokens?: unknown };
    if (!o || o.format !== FILE_FORMAT || o.version !== 1) throw storeError(`token store ${this.path} has an unknown format`);
    try {
      return validateTokens(o.tokens, "stored tokens");
    } catch (e) {
      throw storeError(`token store ${this.path} is invalid: ${(e as Error).message}`);
    }
  }

  async save(tokens: OAuthTokens): Promise<void> {
    const t = validateTokens(tokens);
    await writeSecretFileAtomic(this.path, `${JSON.stringify({ format: FILE_FORMAT, version: 1, updatedAt: new Date().toISOString(), tokens: t }, null, 2)}\n`);
  }

  async acquireLock(options: { timeoutMs: number; signal?: AbortSignal }): Promise<TokenStoreLock> {
    const started = Date.now();
    const releaseLocal = await localLockForPath(this.lockPath).acquire(options.timeoutMs, options.signal);
    try {
      const file = await acquireFileLock(this.lockPath, { timeoutMs: Math.max(0, options.timeoutMs - (Date.now() - started)), ...(options.signal ? { signal: options.signal } : {}) });
      return {
        release: async () => {
          try {
            await file.release();
          } finally {
            releaseLocal();
          }
        },
      };
    } catch (e) {
      releaseLocal();
      throw e;
    }
  }

  /** Removes the stored grant (logout). Providers using it then fail closed with `grant_removed`. */
  async clear(): Promise<void> {
    await unlink(this.path).catch((e) => {
      if (errCode(e) !== "ENOENT") throw storeError(`cannot remove ${this.path} (${errCode(e) ?? "error"})`);
    });
  }

  /**
   * Operator recovery only: removes the lock file left by a crashed process. Call only after stopping every process
   * that might use this store; removing a live holder's lock can lead to a replayed (and revoked) refresh token.
   */
  async removeLock(): Promise<void> {
    await unlink(this.lockPath).catch((e) => {
      if (errCode(e) !== "ENOENT") throw storeError(`cannot remove ${this.lockPath} (${errCode(e) ?? "error"})`);
    });
  }
}

/** In-memory store (tests, or hosts that persist through their own hooks). Single process only. */
export class MemoryTokenStore implements TokenStore {
  #tokens: OAuthTokens | null;
  readonly #lock = new LocalLock();
  constructor(initial?: OAuthTokens) {
    this.#tokens = initial ? validateTokens(initial) : null;
  }
  async load(): Promise<OAuthTokens | null> {
    return this.#tokens ? validateTokens(this.#tokens) : null;
  }
  async save(tokens: OAuthTokens): Promise<void> {
    this.#tokens = validateTokens(tokens);
  }
  async acquireLock(options: { timeoutMs: number; signal?: AbortSignal }): Promise<TokenStoreLock> {
    const release = await this.#lock.acquire(options.timeoutMs, options.signal);
    return { release: async () => release() };
  }
  clear(): void {
    this.#tokens = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------

const MAX_KNOWN_SECRETS = 32;
const PERSIST_ATTEMPTS = 3;

interface Sticky {
  error: OAuthRefreshError;
  /** Fingerprint of the refresh token that failed; a different grant in the store clears the failure. */
  refreshFp: string | undefined;
  checkedAt: number;
}

/**
 * A token set that must reach the store before anything else happens. The store lock taken for the refresh is
 * kept (`lock`) until the write succeeds, so no other writer can load and replay the refresh token we consumed.
 */
interface PendingWrite {
  tokens: OAuthTokens;
  lock: TokenStoreLock;
  /** Fingerprint of the refresh token the store held when we sent the refresh. */
  consumedFp: string | undefined;
  /** Becomes sticky once written (quarantine after an unknown outcome). */
  failure?: OAuthRefreshError;
}

interface RefreshRequest {
  forced: boolean;
  /** forceRefresh: the access token the server rejected. */
  rejected?: string;
}

export class OAuthRefreshProvider {
  readonly #endpoint: URL;
  readonly #clientId: string;
  readonly #auth: ClientAuthentication;
  readonly #resource: string | undefined;
  readonly #scope: string | undefined;
  readonly #store: TokenStore;
  readonly #initial: OAuthTokens | undefined;
  readonly #skewMs: number;
  readonly #minValidityMs: number;
  readonly #timeoutMs: number;
  readonly #lockTimeoutMs: number;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #forceMinIntervalMs: number;
  readonly #stickyRecheckMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onEvent: ((e: OAuthRefreshEvent) => void) | undefined;
  readonly #abort = new AbortController();
  readonly #secrets = new Set<string>();
  readonly #pinnedSecrets: number;

  #tokens: OAuthTokens | undefined;
  #loaded = false;
  #loading: Promise<void> | undefined;
  #inflight: Promise<OAuthTokens> | undefined;
  #pending: PendingWrite | undefined;
  /** Serializes everything that resolves #pending (flush, replaceGrant, dispose); one flush is shared by callers. */
  #pendingTx: Promise<void> = Promise.resolve();
  #sharedFlush: Promise<void> | undefined;
  #sticky: Sticky | undefined;
  #backoffUntil = 0;
  #failures = 0;
  #lastError: OAuthRefreshError | undefined;
  #refreshCount = 0;
  #adoptedCount = 0;
  #lastRefreshAt: number | undefined;
  #disposed = false;

  constructor(options: OAuthRefreshProviderOptions) {
    if (!options || typeof options !== "object") throw configError("options are required");
    const policy = { allowInsecureLocalhost: options.allowInsecureLocalhost === true };
    try {
      this.#endpoint = trustedUrl(options.tokenEndpoint, policy, "tokenEndpoint");
      if (options.resource !== undefined) trustedUrl(options.resource, policy, "resource");
    } catch (e) {
      throw configError(e instanceof UntrustedUrlError ? e.message : "invalid URL");
    }
    if (typeof options.clientId !== "string" || !options.clientId || CTRL_OR_SPACE.test(options.clientId)) throw configError("clientId must be a non-empty string without whitespace");
    this.#clientId = options.clientId;

    const auth = options.clientAuth ?? { method: "none" };
    if (auth.method === "none") {
      if ((auth as { clientSecret?: unknown }).clientSecret !== undefined) throw configError("clientAuth none must not carry a clientSecret");
      this.#pinnedSecrets = 0;
    } else if (auth.method === "client_secret_post" || auth.method === "client_secret_basic") {
      if (typeof auth.clientSecret !== "string" || !auth.clientSecret || /[\x00-\x1f\x7f]/.test(auth.clientSecret)) throw configError(`${auth.method} requires a non-empty clientSecret`);
      this.#secrets.add(auth.clientSecret);
      if (auth.method === "client_secret_basic") this.#secrets.add(this.#basicCredential(auth.clientSecret));
      this.#pinnedSecrets = this.#secrets.size;
    } else {
      throw configError("clientAuth.method must be none, client_secret_post or client_secret_basic");
    }
    this.#auth = auth;

    this.#resource = options.resource;
    if (options.scope !== undefined) {
      const parts = typeof options.scope === "string" ? options.scope.split(" ").filter(Boolean) : [];
      if (!parts.length || parts.some((p) => !SCOPE_TOKEN.test(p))) throw configError("scope must be space-separated OAuth scope tokens");
      this.#scope = parts.join(" ");
    }
    if (!options.store || typeof options.store.load !== "function" || typeof options.store.save !== "function") throw configError("store must implement load() and save()");
    this.#store = options.store;
    if (options.initialTokens !== undefined) {
      this.#initial = validateTokens(options.initialTokens, "initialTokens");
      this.#rememberTokens(this.#initial);
    }
    this.#skewMs = nonNegative("refreshSkewMs", options.refreshSkewMs, 60_000);
    this.#minValidityMs = nonNegative("minValidityMs", options.minValidityMs, 10_000);
    this.#timeoutMs = nonNegative("timeoutMs", options.timeoutMs, 15_000) || 15_000;
    this.#lockTimeoutMs = nonNegative("lockTimeoutMs", options.lockTimeoutMs, 30_000);
    this.#backoffInitialMs = nonNegative("backoff.initialMs", options.backoff?.initialMs, 1_000);
    this.#backoffMaxMs = Math.max(this.#backoffInitialMs, nonNegative("backoff.maxMs", options.backoff?.maxMs, 60_000));
    this.#forceMinIntervalMs = nonNegative("forceMinIntervalMs", options.forceMinIntervalMs, 5_000);
    this.#stickyRecheckMs = nonNegative("stickyRecheckMs", options.stickyRecheckMs, 1_000);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.onEvent;
  }

  /** Bound credential function: `credential: provider.getToken`. Resolves to a currently valid access token. */
  readonly getToken = (): Promise<string> => this.#getToken();

  /**
   * Bound 401 hook. Call once after the server rejected `rejectedAccessToken` before executing the request. If a
   * newer token already exists (another caller, instance or process refreshed), it is returned without a token
   * request; otherwise one refresh is forced even though the token has not expired. Concurrent calls share one
   * refresh. Never use this to justify replaying a request that may have executed.
   */
  readonly forceRefresh = (rejectedAccessToken?: string): Promise<string> => this.#forceRefresh(rejectedAccessToken);

  /** Alias of getToken. */
  get credential(): () => Promise<string> {
    return this.getToken;
  }

  /** Credential-free snapshot of the provider state. */
  status(): OAuthProviderStatus {
    const t = this.#tokens;
    const now = this.#now();
    let state: OAuthProviderState;
    if (this.#disposed) state = "disposed";
    else if (this.#pending) state = "persist_pending";
    else if (this.#sticky) state = "reauth_required";
    else if (this.#inflight) state = "refreshing";
    else if (!this.#loaded) state = "unloaded";
    else if (now < this.#backoffUntil) state = "backoff";
    else if (t && this.#fresh(t, now)) state = "valid";
    else state = "needs_refresh";
    return {
      state,
      ...(t ? { expiresAt: t.expiresAt } : {}),
      hasRefreshToken: !!t?.refreshToken,
      refreshCount: this.#refreshCount,
      adoptedCount: this.#adoptedCount,
      consecutiveFailures: this.#failures,
      ...(now < this.#backoffUntil ? { backoffUntil: this.#backoffUntil } : {}),
      ...(this.#lastRefreshAt !== undefined ? { lastRefreshAt: this.#lastRefreshAt } : {}),
      ...(this.#lastError ? { lastErrorCode: this.#lastError.code } : {}),
    };
  }

  /** Replaces every known secret value (tokens, client secret, basic credential) and bearer/JWT patterns in `text`. */
  scrub(text: string): string {
    return scrubSecrets(text, this.#secrets);
  }

  /**
   * Supplies a new grant (e.g. after the user logged in again): persists it under the store lock and clears any
   * sticky failure, quarantine and backoff.
   */
  async replaceGrant(tokens: OAuthTokens): Promise<void> {
    this.#assertOpen();
    const t = this.#bind(validateTokens(tokens));
    delete t.quarantine;
    this.#rememberTokens(t);
    await this.#inflight?.catch(() => undefined);
    await this.#inPendingTx(async () => {
      const lock = this.#pending?.lock ?? (await this.#acquire());
      try {
        await this.#saveWithRetry(t);
      } catch (e) {
        if (!this.#pending) await lock.release();
        throw this.#normalize(e);
      }
      this.#pending = undefined;
      await lock.release();
    });
    this.#tokens = t;
    this.#loaded = true;
    this.#sticky = undefined;
    this.#clearFailures();
    this.#emit({ type: "grant_replaced", at: this.#now() });
  }

  /** Re-reads the store; a grant different from the one that failed clears a sticky failure. */
  async reload(): Promise<OAuthProviderStatus> {
    this.#assertOpen();
    if (!this.#pending) {
      const latest = await this.#loadStore();
      if (latest) this.#adopt(latest);
      this.#loaded = true;
    }
    return this.status();
  }

  /**
   * Aborts an in-flight refresh and rejects all further calls. If rotated tokens are still unpersisted, one final
   * write is attempted; if it fails the store lock is deliberately NOT released (fail closed: other writers cannot
   * replay the consumed refresh token; operator recovery is required).
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    await this.#inflight?.catch(() => undefined);
    await this.#inPendingTx(async () => {
      const pending = this.#pending;
      if (!pending) return;
      try {
        await this.#store.save(pending.tokens);
        this.#pending = undefined;
        await pending.lock.release();
      } catch {
        // Keep the lock held.
      }
    });
    this.#tokens = undefined;
  }

  toJSON(): OAuthProviderStatus {
    return this.status();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `OAuthRefreshProvider ${JSON.stringify(this.status())}`;
  }

  // -- getToken / forceRefresh ----------------------------------------------------------------------------------

  async #prepare(): Promise<void> {
    this.#assertOpen();
    await this.#ensureLoaded();
    if (this.#pending) await this.#flushPendingShared();
    if (this.#sticky) {
      await this.#recheckSticky();
      if (this.#sticky) throw (this.#sticky as Sticky).error;
    }
  }

  async #getToken(): Promise<string> {
    await this.#prepare();
    const current = this.#tokens;
    if (!current) throw this.#error("no_tokens", "reauth", "no OAuth tokens are available; complete an OAuth login first");
    const now = this.#now();
    if (this.#fresh(current, now)) return current.accessToken;
    if (now < this.#backoffUntil) {
      if (this.#usable(current, now)) return current.accessToken;
      throw this.#backoffError(now);
    }
    return this.#refreshAndReturn({ forced: false });
  }

  async #forceRefresh(rejected?: string): Promise<string> {
    await this.#prepare();
    const current = this.#tokens;
    if (!current) throw this.#error("no_tokens", "reauth", "no OAuth tokens are available; complete an OAuth login first");
    const now = this.#now();
    // Already rotated past the rejected token: no request.
    if (rejected !== undefined && current.accessToken !== rejected && this.#usable(current, now)) return current.accessToken;
    if (rejected === undefined && this.#lastRefreshAt !== undefined && now - this.#lastRefreshAt < this.#forceMinIntervalMs && this.#usable(current, now)) {
      return current.accessToken;
    }
    if (now < this.#backoffUntil) throw this.#backoffError(now);
    return this.#refreshAndReturn({ forced: true, rejected: rejected ?? current.accessToken });
  }

  async #refreshAndReturn(req: RefreshRequest): Promise<string> {
    try {
      const next = await (this.#inflight ??= this.#runRefresh(req).finally(() => {
        this.#inflight = undefined;
      }));
      this.#assertOpen();
      if (!this.#usable(next, this.#now())) throw this.#error("token_expired", "transient", "the refreshed access token is already too close to expiry");
      if (req.forced && next.accessToken === req.rejected) throw this.#error("refresh_rejected", "permanent", "no newer access token is available");
      return next.accessToken;
    } catch (e) {
      const err = this.#normalize(e);
      const now = this.#now();
      const fallback = this.#tokens;
      if (!req.forced && err.kind === "transient" && !this.#sticky && !this.#pending && !this.#disposed && fallback && this.#usable(fallback, now)) {
        this.#emit({ type: "fallback_to_current", at: now, expiresAt: fallback.expiresAt, code: err.code });
        return fallback.accessToken;
      }
      throw err;
    }
  }

  #backoffError(now: number): OAuthRefreshError {
    const last = this.#lastError;
    return this.#error(last?.code ?? "network_error", "transient", `token refresh is backing off after a failure${last ? ` (${last.code})` : ""}`, {
      retryAfterMs: this.#backoffUntil - now,
    });
  }

  #assertOpen(): void {
    if (this.#disposed) throw new OAuthRefreshError("disposed", "permanent", "OAuth refresh provider was disposed");
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loading ??= (async () => {
      let t = await this.#loadStore();
      if (!t && this.#initial) {
        const lock = await this.#acquire();
        try {
          t = await this.#loadStore();
          if (!t) {
            t = this.#bind(this.#initial);
            await this.#store.save(t);
          }
        } finally {
          await lock.release();
        }
      }
      this.#loaded = true;
      if (t) this.#adopt(t);
    })().finally(() => {
      this.#loading = undefined;
    });
    await this.#loading;
  }

  async #loadStore(): Promise<OAuthTokens | null> {
    let t: OAuthTokens | null;
    try {
      t = await this.#store.load();
    } catch (e) {
      throw this.#normalize(e, "store_error");
    }
    if (!t) return null;
    let v: OAuthTokens;
    try {
      v = validateTokens(t, "stored tokens");
    } catch (e) {
      throw this.#error("store_error", "permanent", (e as Error).message);
    }
    this.#rememberTokens(v);
    return v;
  }

  async #acquire(): Promise<TokenStoreLock> {
    const opts = { timeoutMs: this.#lockTimeoutMs, signal: this.#abort.signal };
    try {
      if (this.#store.acquireLock) return await this.#store.acquireLock(opts);
      const release = await localLockFor(this.#store).acquire(opts.timeoutMs, opts.signal);
      return { release: async () => release() };
    } catch (e) {
      throw this.#normalize(e, "store_error");
    }
  }

  // -- refresh --------------------------------------------------------------------------------------------------

  async #runRefresh(req: RefreshRequest): Promise<OAuthTokens> {
    const started = this.#now();
    this.#emit({ type: "refresh_started", at: started, forced: req.forced });
    let failedFp = fingerprint(this.#tokens?.refreshToken);
    let lock: TokenStoreLock | undefined;
    try {
      lock = await this.#acquire();
      this.#assertOpen();
      // The store is the source of truth: another instance or process may have rotated the grant while we waited.
      const latest = await this.#loadStore();
      if (!latest) {
        failedFp = undefined; // any grant that reappears clears this
        throw this.#error("grant_removed", "reauth", "the stored OAuth grant was removed; complete an OAuth login again");
      }
      failedFp = fingerprint(latest.refreshToken);
      this.#checkBinding(latest);
      if (latest.quarantine) throw this.#quarantineError(latest.quarantine.code);
      const now = this.#now();
      if (this.#differs(latest, this.#tokens)) {
        this.#tokens = latest;
        const adoptable = req.forced ? latest.accessToken !== req.rejected && this.#usable(latest, now) : this.#fresh(latest, now);
        if (adoptable) {
          this.#adoptedCount++;
          this.#clearFailures();
          this.#emit({ type: "adopted_from_store", at: now, expiresAt: latest.expiresAt });
          return latest;
        }
      }
      const base = latest;
      if (!base.refreshToken) throw this.#error("no_refresh_token", "reauth", "the OAuth grant has no refresh token (request offline_access at login)");
      const outcome = await this.#requestRefresh(base);
      if (outcome.kind === "unknown") {
        // The old refresh token may be consumed: quarantine it in the store so no instance replays it.
        const quarantined: OAuthTokens = { ...base, quarantine: { code: "refresh_outcome_unknown", at: this.#now() } };
        await this.#mustPersist(quarantined, lock, failedFp, outcome.error);
        lock = undefined;
        throw outcome.error;
      }
      if (outcome.kind === "salvage") {
        // 200 with an unusable body but a well-formed new refresh token: keep the grant alive, hand out nothing.
        await this.#mustPersist(outcome.tokens, lock, failedFp);
        lock = undefined;
        this.#tokens = outcome.tokens;
        throw outcome.error;
      }
      const next = outcome.tokens;
      await this.#mustPersist(next, lock, failedFp);
      lock = undefined;
      this.#tokens = next;
      this.#refreshCount++;
      this.#lastRefreshAt = this.#now();
      this.#clearFailures();
      this.#emit({ type: "refresh_succeeded", at: this.#lastRefreshAt, durationMs: this.#lastRefreshAt - started, rotated: next.refreshToken !== base.refreshToken, expiresAt: next.expiresAt });
      return next;
    } catch (e) {
      const err = this.#normalize(e);
      this.#onFailure(err, failedFp, started);
      throw err;
    } finally {
      // A lock handed to #pending stays held until the write succeeds (or operator recovery).
      if (lock && this.#pending?.lock !== lock) await lock.release().catch(() => undefined);
    }
  }

  /**
   * Persists `tokens` while still holding `lock`, then releases it. If the write keeps failing, the lock is retained
   * in `#pending` (other writers stay blocked) and a persist_failed error is thrown.
   */
  async #mustPersist(tokens: OAuthTokens, lock: TokenStoreLock, consumedFp: string | undefined, failure?: OAuthRefreshError): Promise<void> {
    try {
      await this.#saveWithRetry(tokens);
    } catch (e) {
      this.#pending = { tokens, lock, consumedFp, ...(failure ? { failure } : {}) };
      throw this.#error(
        "persist_failed",
        "permanent",
        `refreshed OAuth tokens could not be persisted; the store stays locked and the write is retried before any token is returned (${this.#normalize(e).message})`,
      );
    }
    await lock.release().catch(() => undefined);
  }

  /** Runs `fn` after every earlier pending transaction has settled. */
  #inPendingTx<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#pendingTx.then(fn, fn);
    this.#pendingTx = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Concurrent callers share one flush; it runs inside the pending transaction chain. */
  #flushPendingShared(): Promise<void> {
    this.#sharedFlush ??= this.#inPendingTx(() => (this.#pending ? this.#flushPending() : Promise.resolve())).finally(() => {
      this.#sharedFlush = undefined;
    });
    return this.#sharedFlush;
  }

  async #flushPending(): Promise<void> {
    const p = this.#pending!;
    let current: OAuthTokens | null | undefined;
    try {
      current = await this.#store.load();
    } catch {
      current = undefined; // unreadable: we hold the lock, so writing our tokens is still correct
    }
    const currentFp = current ? fingerprint(current.refreshToken) : undefined;
    const ourFp = fingerprint(p.tokens.refreshToken);
    if (current && currentFp !== p.consumedFp && currentFp !== ourFp) {
      // A different grant was written by someone outside the lock protocol (e.g. a fresh login): never overwrite it.
      this.#pending = undefined;
      await p.lock.release().catch(() => undefined);
      this.#tokens = undefined;
      this.#adopt(validateTokens(current, "stored tokens"));
      return;
    }
    if (this.#pending !== p) return; // resolved elsewhere while loading: never write after its lock was released
    if (!(current && currentFp === ourFp && !!current.quarantine === !!p.tokens.quarantine)) {
      try {
        await this.#saveWithRetry(p.tokens);
      } catch (e) {
        throw this.#error("persist_failed", "permanent", `refreshed OAuth tokens are still not persisted (${this.#normalize(e).message})`);
      }
    }
    this.#pending = undefined;
    await p.lock.release().catch(() => undefined);
    this.#tokens = p.tokens;
    this.#emit({ type: "persist_recovered", at: this.#now() });
    if (p.failure) this.#setSticky(p.failure, fingerprint(p.tokens.refreshToken));
  }

  async #saveWithRetry(t: OAuthTokens): Promise<void> {
    let last: unknown;
    for (let i = 0; i < PERSIST_ATTEMPTS; i++) {
      try {
        await this.#store.save(t);
        return;
      } catch (e) {
        last = e;
        if (i < PERSIST_ATTEMPTS - 1) await sleep(25 * 2 ** i).catch(() => undefined);
      }
    }
    throw this.#normalize(last, "store_error");
  }

  async #requestRefresh(
    base: OAuthTokens,
  ): Promise<{ kind: "ok"; tokens: OAuthTokens } | { kind: "unknown"; error: OAuthRefreshError } | { kind: "salvage"; tokens: OAuthTokens; error: OAuthRefreshError }> {
    if (this.#scope && base.scope !== undefined) {
      const granted = new Set(base.scope.split(" ").filter(Boolean));
      const extra = this.#scope.split(" ").filter((s) => !granted.has(s));
      if (extra.length) throw this.#error("scope_not_granted", "permanent", `refresh scope must not exceed the granted scope (not granted: ${extra.join(" ")})`);
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: base.refreshToken! });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    if (this.#auth.method === "client_secret_basic") {
      headers.set("authorization", `Basic ${this.#basicCredential(this.#auth.clientSecret)}`);
    } else {
      body.set("client_id", this.#clientId);
      if (this.#auth.method === "client_secret_post") body.set("client_secret", this.#auth.clientSecret);
    }
    if (this.#resource) body.set("resource", this.#resource);
    if (this.#scope) body.set("scope", this.#scope);

    const unknown = (why: string) => ({
      kind: "unknown" as const,
      error: this.#error("refresh_outcome_unknown", "reauth", `token refresh was sent but its outcome is unknown (${why}); the refresh token may be consumed, so it will not be reused; complete an OAuth login again`),
    });

    const requestedAt = this.#now();
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([this.#abort.signal, timeout]);
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint.toString(), { method: "POST", headers, body: body.toString(), redirect: "manual", signal });
    } catch (e) {
      if (provablyNotSent(e)) throw this.#error("network_error", "transient", `token endpoint unreachable: ${errorText(e)}`);
      if (this.#abort.signal.aborted) return unknown("provider disposed during the request");
      if (timeout.aborted) return unknown(`no response within ${this.#timeoutMs} ms`);
      return unknown(`connection failed: ${errorText(e)}`);
    }

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw this.#error("redirect_blocked", "permanent", `token endpoint answered with a redirect (${res.status || "opaque"}); redirects are never followed`, res.status ? { status: res.status } : {});
    }

    let text: string;
    try {
      text = await readLimited(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      if (!res.ok) text = "";
      else return unknown(`response body unreadable: ${errorText(e)}`);
    }
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // handled below
    }

    if (!res.ok) {
      const status = res.status;
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
      const oauthError = serverText(json?.error, 64);
      const desc = serverText(json?.error_description);
      const detail = `${oauthError || "no OAuth error code"}${desc ? `: ${desc}` : ""}`;
      const extra = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      // Refused before processing: safe to retry later with the same refresh token.
      if (status === 429) throw this.#error("rate_limited", "transient", `token endpoint rate limited the refresh (429, ${detail})`, extra);
      if (status === 408 || status === 503) throw this.#error("server_unavailable", "transient", `token endpoint unavailable (${status}, ${detail})`, extra);
      if (status >= 500) return unknown(`HTTP ${status}`);
      if (oauthError === "invalid_grant") throw this.#error("invalid_grant", "reauth", `refresh token was rejected (invalid_grant${desc ? `: ${desc}` : ""}); the grant is revoked or expired, complete an OAuth login again`, extra);
      if (oauthError === "invalid_client" || oauthError === "unauthorized_client") throw this.#error("client_rejected", "reauth", `OAuth client was rejected (${detail})`, extra);
      if (status === 400 || status === 401 || status === 403) throw this.#error("refresh_rejected", "reauth", `token endpoint rejected the refresh (${status}, ${detail})`, extra);
      throw this.#error("http_error", "reauth", `token endpoint returned HTTP ${status} (${detail})`, extra);
    }

    if (!json) return unknown("2xx response without a JSON object body");
    const parsed = parseTokenResponse(json);
    if (typeof parsed === "string") {
      const error = this.#error("invalid_response", "permanent", `token endpoint response is invalid: ${parsed}`);
      if (isTokenString(json.refresh_token) && json.refresh_token !== base.refreshToken) {
        this.#remember(json.refresh_token);
        return { kind: "salvage", tokens: { ...base, refreshToken: json.refresh_token }, error };
      }
      if (isTokenString(json.access_token)) this.#remember(json.access_token);
      // Without a new refresh token RFC 6749 §6 says the old one stays valid; but an invalid 200 may be a rotation
      // we cannot read, so treat it as unknown.
      return unknown(`2xx response invalid: ${parsed}`);
    }
    const next: OAuthTokens = this.#bind({
      accessToken: parsed.accessToken,
      tokenType: parsed.tokenType,
      // Measured from before the request was sent, so network latency only shortens the assumed lifetime.
      expiresAt: requestedAt + parsed.expiresInMs,
      obtainedAt: requestedAt,
      refreshToken: parsed.refreshToken ?? base.refreshToken!,
      ...((parsed.scope ?? this.#scope ?? base.scope) !== undefined ? { scope: parsed.scope ?? this.#scope ?? base.scope } : {}),
      ...((parsed.idToken ?? base.idToken) ? { idToken: parsed.idToken ?? base.idToken } : {}),
    });
    this.#rememberTokens(next);
    return { kind: "ok", tokens: next };
  }

  // -- state helpers --------------------------------------------------------------------------------------------

  async #recheckSticky(): Promise<void> {
    const s = this.#sticky!;
    const now = this.#now();
    if (now - s.checkedAt < this.#stickyRecheckMs) return;
    s.checkedAt = now;
    try {
      const latest = await this.#loadStore();
      if (latest) this.#adopt(latest);
    } catch {
      // Stay failed.
    }
  }

  /** Adopts stored tokens. A different refresh token (a new grant) clears a sticky failure. */
  #adopt(latest: OAuthTokens): void {
    const fp = fingerprint(latest.refreshToken);
    if (this.#sticky && fp === this.#sticky.refreshFp) return;
    try {
      this.#checkBinding(latest);
      if (latest.quarantine) throw this.#quarantineError(latest.quarantine.code);
    } catch (e) {
      this.#setSticky(this.#normalize(e), fp);
      return;
    }
    if (this.#sticky) {
      this.#sticky = undefined;
      this.#clearFailures();
    }
    if (this.#differs(latest, this.#tokens)) {
      if (this.#tokens) {
        this.#adoptedCount++;
        this.#emit({ type: "adopted_from_store", at: this.#now(), expiresAt: latest.expiresAt });
      }
      this.#tokens = latest;
    }
  }

  #quarantineError(code: string): OAuthRefreshError {
    return this.#error("refresh_outcome_unknown", "reauth", `the stored grant is quarantined (${serverText(code, 64)}): a refresh was sent but its outcome is unknown; complete an OAuth login again`);
  }

  #onFailure(err: OAuthRefreshError, refreshFp: string | undefined, started: number): void {
    const now = this.#now();
    this.#lastError = err;
    this.#emit({
      type: "refresh_failed",
      at: now,
      durationMs: now - started,
      code: err.code,
      kind: err.kind,
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    });
    // Local conditions with no token request behind them: no backoff (the lock wait itself throttles callers).
    if (err.code === "disposed" || err.code === "persist_failed" || err.code === "lock_timeout") return;
    if (err.kind === "reauth") {
      this.#setSticky(err, refreshFp);
      return;
    }
    this.#failures++;
    const exp = Math.min(this.#backoffMaxMs, this.#backoffInitialMs * 2 ** Math.min(this.#failures - 1, 20));
    const delay = Math.min(this.#backoffMaxMs, Math.max(exp * (0.8 + Math.random() * 0.4), err.retryAfterMs ?? 0));
    this.#backoffUntil = now + delay;
  }

  #setSticky(error: OAuthRefreshError, refreshFp: string | undefined): void {
    this.#sticky = { error, refreshFp, checkedAt: this.#now() };
    this.#lastError = error;
    this.#emit({ type: "reauth_required", at: this.#now(), code: error.code });
  }

  #clearFailures(): void {
    this.#failures = 0;
    this.#backoffUntil = 0;
    this.#lastError = undefined;
  }

  #checkBinding(t: OAuthTokens): void {
    const b = t.binding;
    if (!b) return;
    let sameEndpoint = false;
    try {
      sameEndpoint = new URL(b.tokenEndpoint).toString() === this.#endpoint.toString();
    } catch {
      // malformed binding: mismatch
    }
    if (!sameEndpoint || b.clientId !== this.#clientId || (b.resource !== undefined && this.#resource !== undefined && b.resource !== this.#resource)) {
      throw this.#error("grant_binding_mismatch", "reauth", "stored tokens were issued for a different token endpoint, client or resource");
    }
  }

  #bind(t: OAuthTokens): OAuthTokens {
    return { ...t, binding: { tokenEndpoint: this.#endpoint.toString(), clientId: this.#clientId, ...(this.#resource ? { resource: this.#resource } : {}) } };
  }

  #differs(a: OAuthTokens, b: OAuthTokens | undefined): boolean {
    return !b || a.refreshToken !== b.refreshToken || a.accessToken !== b.accessToken || a.expiresAt !== b.expiresAt;
  }

  #lifetime(t: OAuthTokens): number | undefined {
    return t.obtainedAt !== undefined && t.expiresAt > t.obtainedAt ? t.expiresAt - t.obtainedAt : undefined;
  }

  /** Valid and not yet inside the proactive refresh window. */
  #fresh(t: OAuthTokens, now: number): boolean {
    const life = this.#lifetime(t);
    const skew = life !== undefined ? Math.min(this.#skewMs, life / 2) : this.#skewMs;
    return this.#usable(t, now) && now < t.expiresAt - skew;
  }

  /** Still valid for a safe margin (never expired). */
  #usable(t: OAuthTokens, now: number): boolean {
    if (!t.accessToken) return false;
    const life = this.#lifetime(t);
    const margin = life !== undefined ? Math.min(this.#minValidityMs, life / 4) : this.#minValidityMs;
    return t.expiresAt - now >= margin;
  }

  #basicCredential(secret: string): string {
    return Buffer.from(`${encodeURIComponent(this.#clientId)}:${encodeURIComponent(secret)}`).toString("base64");
  }

  #remember(secret: string | undefined): void {
    if (!secret || secret.length < 8 || this.#secrets.has(secret)) return;
    this.#secrets.add(secret);
    while (this.#secrets.size > MAX_KNOWN_SECRETS + this.#pinnedSecrets) {
      const victim = [...this.#secrets][this.#pinnedSecrets];
      if (victim === undefined) break;
      this.#secrets.delete(victim);
    }
  }

  #rememberTokens(t: OAuthTokens): void {
    this.#remember(t.accessToken);
    this.#remember(t.refreshToken);
    this.#remember(t.idToken);
  }

  #error(code: OAuthRefreshErrorCode, kind: OAuthRefreshErrorKind, message: string, extra: { status?: number | undefined; retryAfterMs?: number | undefined } = {}): OAuthRefreshError {
    const clean: { status?: number; retryAfterMs?: number } = {};
    if (extra.status !== undefined) clean.status = extra.status;
    if (extra.retryAfterMs !== undefined) clean.retryAfterMs = extra.retryAfterMs;
    return new OAuthRefreshError(code, kind, this.scrub(message), clean);
  }

  /** Wraps foreign errors and re-scrubs every message (store implementations may echo values). */
  #normalize(e: unknown, fallback: OAuthRefreshErrorCode = "store_error"): OAuthRefreshError {
    if (e instanceof OAuthRefreshError) {
      const scrubbed = this.scrub(e.message);
      return scrubbed === e.message ? e : this.#error(e.code, e.kind, scrubbed, { status: e.status, retryAfterMs: e.retryAfterMs });
    }
    return this.#error(fallback, "permanent", errorText(e));
  }

  #emit(event: OAuthRefreshEvent): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch {
      // Event sinks never affect the credential flow.
    }
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Creates a provider. Equivalent to `new OAuthRefreshProvider(options)`. */
export function createOAuthRefreshProvider(options: OAuthRefreshProviderOptions): OAuthRefreshProvider {
  return new OAuthRefreshProvider(options);
}

/**
 * A callable credential (`() => Promise<string>`) backed by a provider, with the provider attached for
 * forceRefresh/status/dispose: `credential: createOAuthCredential({...})`.
 */
export function createOAuthCredential(options: OAuthRefreshProviderOptions): (() => Promise<string>) & { provider: OAuthRefreshProvider } {
  const provider = new OAuthRefreshProvider(options);
  return Object.assign(() => provider.getToken(), { provider });
}
