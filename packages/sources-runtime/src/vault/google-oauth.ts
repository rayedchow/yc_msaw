import { sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { googleRateLimitErrorFromResponse } from "./google-rate-limit.js";
import {
  decryptBound,
  encryptBound,
  googleGrantAad,
  googleStateAad,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "./google-grant-crypto.js";

/**
 * Per-user Google OAuth ("oauth_direct") for the source lane.
 *
 * Restores the gigabrain c9c55105a^ direct 3-legged flow (offline access,
 * prompt=consent, include_granted_scopes, rotated refresh tokens) with the
 * fixes the cross-repo audit called for:
 *   * state is 32 random bytes, stored only as sha256 in google_oauth_states,
 *     bound server-side to {tenant, yc_msaw principal, mode, expected account},
 *     expiry-bound and consumed with a single conditional UPDATE (no process
 *     memory, safe with many workers, replay-proof);
 *   * PKCE S256 (RFC 7636) and an OIDC nonce derived from the state;
 *   * a one-time launch step sets an HttpOnly browser-binding cookie, so a raw
 *     Google consent URL forwarded to someone else cannot complete;
 *   * the consenting Google account must be the expected account (the
 *     initiating principal's verified email by default);
 *   * refresh happens under SELECT ... FOR UPDATE with a re-read (the Jira
 *     client pattern), persists rotated refresh tokens, and marks the grant
 *     reauth_required on invalid_grant/401/403 instead of retrying forever;
 *   * tokens are encrypted with row-bound AAD (google-grant-crypto.ts).
 * The tenant always comes from the server (runtime internal API URL filled by
 * yc_msaw from the verified principal, or the stored state row), never from the
 * Google callback query.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_OAUTH_LAUNCH_PATH = "/auth/google/oauth/launch";
export const GOOGLE_OAUTH_CALLBACK_PATH = "/auth/google/oauth/callback";
export const GOOGLE_OAUTH_BINDING_COOKIE = "__Host-procmem_google_oauth";
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const TOKEN_SAFETY_MS = 5 * 60 * 1000;
const TOKEN_HTTP_TIMEOUT_MS = 15_000;
const ID_TOKEN_CLOCK_SKEW_S = 300;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Capabilities and scopes -------------------------------------------------

// Literal scope strings (kept identical to the *_DELEGATION_SCOPES job constants in
// vault/google-auth.ts, which import this module; importing them back would cycle).
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const DOCUMENTS = "https://www.googleapis.com/auth/documents";
const DRIVE_ACTIVITY_READONLY = "https://www.googleapis.com/auth/drive.activity.readonly";
const CONTACTS_READONLY = "https://www.googleapis.com/auth/contacts.readonly";
const CONTACTS_OTHER_READONLY = "https://www.googleapis.com/auth/contacts.other.readonly";
const DIRECTORY_READONLY = "https://www.googleapis.com/auth/directory.readonly";
const ADMIN_DIRECTORY_USER_READONLY = "https://www.googleapis.com/auth/admin.directory.user.readonly";

/** What a caller may ask for. The server maps capabilities to scopes; raw scopes are never accepted from a body. */
export const GOOGLE_OAUTH_CAPABILITY_SCOPES = {
  gmail: [GMAIL_READONLY],
  calendar: [CALENDAR_READONLY],
  docs: [DRIVE_READONLY, DOCUMENTS, DRIVE_ACTIVITY_READONLY],
  contacts: [CONTACTS_READONLY, CONTACTS_OTHER_READONLY, DIRECTORY_READONLY],
  // Admin Directory works over OAuth only when a Workspace admin consents.
  directory_admin: [ADMIN_DIRECTORY_USER_READONLY],
} as const satisfies Record<string, readonly string[]>;

export type GoogleOAuthCapability = keyof typeof GOOGLE_OAUTH_CAPABILITY_SCOPES;
export const GOOGLE_OAUTH_DEFAULT_CAPABILITIES: readonly GoogleOAuthCapability[] = ["gmail", "calendar", "docs", "contacts"];

/** Scopes Google documents as service-account (DWD) only; never satisfiable by a user grant. */
export const GOOGLE_DWD_ONLY_SCOPES = ["https://www.googleapis.com/auth/gmail.settings.sharing"] as const;

/** Broader scopes that imply narrower ones (a grant of the key satisfies a request for any value). */
const SCOPE_IMPLICATIONS: Record<string, readonly string[]> = {
  "https://mail.google.com/": [
    GMAIL_READONLY,
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.metadata",
    "https://www.googleapis.com/auth/gmail.labels",
  ],
  "https://www.googleapis.com/auth/gmail.modify": [GMAIL_READONLY, "https://www.googleapis.com/auth/gmail.metadata", "https://www.googleapis.com/auth/gmail.labels"],
  [GMAIL_READONLY]: ["https://www.googleapis.com/auth/gmail.metadata"],
  "https://www.googleapis.com/auth/drive": [DRIVE_READONLY, "https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/drive.metadata"],
  [DRIVE_READONLY]: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
  [DOCUMENTS]: ["https://www.googleapis.com/auth/documents.readonly"],
  "https://www.googleapis.com/auth/calendar": [CALENDAR_READONLY, "https://www.googleapis.com/auth/calendar.events.readonly"],
  [CALENDAR_READONLY]: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  "https://www.googleapis.com/auth/contacts": [CONTACTS_READONLY],
};

export function normalizeGoogleOAuthCapabilities(value: unknown): GoogleOAuthCapability[] {
  if (value === undefined || value === null) return [...GOOGLE_OAUTH_DEFAULT_CAPABILITIES];
  if (!Array.isArray(value) || value.length === 0) {
    throw new GoogleOAuthError("capabilities must be a non-empty array", { code: "invalid_request", status: 400 });
  }
  const out = new Set<GoogleOAuthCapability>();
  for (const item of value) {
    if (typeof item !== "string" || !Object.hasOwn(GOOGLE_OAUTH_CAPABILITY_SCOPES, item)) {
      throw new GoogleOAuthError(`Unknown Google capability ${JSON.stringify(item)}`, { code: "invalid_request", status: 400 });
    }
    out.add(item as GoogleOAuthCapability);
  }
  return [...out].sort();
}

export function googleOAuthScopesForCapabilities(capabilities: readonly GoogleOAuthCapability[]): string[] {
  return [...new Set(capabilities.flatMap((cap) => GOOGLE_OAUTH_CAPABILITY_SCOPES[cap]))].sort();
}

export function missingGoogleScopes(granted: readonly string[], requested: readonly string[]): string[] {
  const satisfied = new Set<string>();
  for (const scope of granted) {
    satisfied.add(scope);
    for (const implied of SCOPE_IMPLICATIONS[scope] ?? []) satisfied.add(implied);
  }
  return [...new Set(requested)].filter((scope) => !satisfied.has(scope)).sort();
}

export function googleCapabilitiesSatisfied(granted: readonly string[]): GoogleOAuthCapability[] {
  return (Object.keys(GOOGLE_OAUTH_CAPABILITY_SCOPES) as GoogleOAuthCapability[])
    .filter((cap) => missingGoogleScopes(granted, GOOGLE_OAUTH_CAPABILITY_SCOPES[cap]).length === 0);
}

// --- Errors -----------------------------------------------------------------

export type GoogleOAuthErrorCode =
  | "not_configured"
  | "invalid_request"
  | "account_binding_required"
  | "invalid_state"
  | "browser_mismatch"
  | "access_denied"
  | "token_exchange_failed"
  | "id_token_invalid"
  | "account_mismatch"
  | "mode_conflict"
  | "account_not_connected"
  | "insufficient_scope"
  | "reauth_required"
  | "bearer_unavailable"
  | "token_refresh_failed";

export class GoogleOAuthError extends Error {
  readonly code: GoogleOAuthErrorCode;
  readonly status: number;
  constructor(message: string, options: { code: GoogleOAuthErrorCode; status?: number }) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = options.code;
    this.status = options.status ?? 400;
  }
}

export class GoogleOAuthScopeError extends GoogleOAuthError {
  constructor(readonly accountEmail: string, readonly missingScopes: string[]) {
    super(`Google account ${accountEmail} has not granted the scopes this job needs: ${missingScopes.join(" ")}. Reconnect with the matching capability (incremental consent).`, {
      code: "insufficient_scope",
      status: 409,
    });
    this.name = "GoogleOAuthScopeError";
  }
}

export class GoogleOAuthReauthRequiredError extends GoogleOAuthError {
  constructor(readonly accountEmail: string, readonly reason: string) {
    // The message deliberately avoids provider error codes such as invalid_grant: the
    // donor classifyCredentialFailure would escalate those to a tenant-wide Google
    // outage, while only this account is affected (it already left the roster).
    super(`Google OAuth grant for ${accountEmail} needs to be reconnected (${describeReauthReason(reason)}).`, { code: "reauth_required", status: 409 });
    this.name = "GoogleOAuthReauthRequiredError";
  }
}

function describeReauthReason(reason: string): string {
  switch (reason) {
    case "invalid_grant": return "refresh token revoked or expired";
    case "unauthorized_client":
    case "invalid_client": return "OAuth client no longer authorized";
    case "no_refresh_token": return "no refresh token on file";
    case "revoked":
    case "revoked_by_admin": return "disconnected";
    default: return reason.replace(/[^a-z0-9_ -]/gi, "").slice(0, 60) || "reauthorization required";
  }
}

// --- Config -----------------------------------------------------------------

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  redirectUri: string;
}

export function googleOAuthClientConfig(source: Record<string, string | undefined> = process.env): GoogleOAuthClientConfig | null {
  const clientId = (source.GOOGLE_OAUTH_CLIENT_ID ?? source.GOOGLE_CLIENT_ID)?.trim();
  const clientSecret = (source.GOOGLE_OAUTH_CLIENT_SECRET ?? source.GOOGLE_CLIENT_SECRET)?.trim();
  const publicBaseUrl = googleAuthPublicBaseUrl(source);
  if (!clientId || !clientSecret || !publicBaseUrl) return null;
  const redirectUri = source.GOOGLE_OAUTH_REDIRECT_URI?.trim() || `${publicBaseUrl}${GOOGLE_OAUTH_CALLBACK_PATH}`;
  return { clientId, clientSecret, publicBaseUrl, redirectUri };
}

export function isGoogleOAuthConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return googleOAuthClientConfig(source) !== null;
}

/** Public origin of the runtime (browser-facing launch/callback routes). https unless loopback. */
export function googleAuthPublicBaseUrl(source: Record<string, string | undefined> = process.env): string | null {
  const raw = (source.SOURCES_RUNTIME_PUBLIC_URL ?? source.WEBHOOK_BASE_URL)?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// --- DB plumbing --------------------------------------------------------------

export interface GoogleAuthSqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface GoogleAuthDb extends GoogleAuthSqlExecutor {
  transaction<T>(fn: (tx: GoogleAuthSqlExecutor) => Promise<T>): Promise<T>;
}

export interface GoogleAuthDeps {
  db?: GoogleAuthDb;
  fetch?: typeof fetch;
  now?: () => number;
  config?: GoogleOAuthClientConfig | null;
}

function depsDb(deps: GoogleAuthDeps): GoogleAuthDb {
  return deps.db ?? (defaultDb as unknown as GoogleAuthDb);
}

function depsNow(deps: GoogleAuthDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function depsFetch(deps: GoogleAuthDeps): typeof fetch {
  return deps.fetch ?? fetch;
}

function requireConfig(deps: GoogleAuthDeps): GoogleOAuthClientConfig {
  const config = deps.config === undefined ? googleOAuthClientConfig() : deps.config;
  if (!config) {
    throw new GoogleOAuthError(
      "Google OAuth is not configured on the source runtime (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, SOURCES_RUNTIME_PUBLIC_URL).",
      { code: "not_configured", status: 503 },
    );
  }
  return config;
}

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && "rows" in result ? (result as { rows: T[] }).rows : [];
}

function jsonText(values: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))::text[]`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.startsWith("{")) {
    return value.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).filter(Boolean);
  }
  return [];
}

// --- Principal / expected account ------------------------------------------------

/** yc_msaw principal forwarded by the authenticated internal API (never read from a provider callback). */
export interface GoogleAuthPrincipal {
  subject: string;
  issuer: string;
  email?: string | null;
}

export type GoogleExpectedAccount = { kind: "self" } | { kind: "email"; email: string };

export function normalizeGoogleExpectedAccount(value: unknown): GoogleExpectedAccount {
  if (value === undefined || value === null || value === "self") return { kind: "self" };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const email = (value as Record<string, unknown>).email;
    if (typeof email === "string" && EMAIL_PATTERN.test(email.trim())) return { kind: "email", email: email.trim().toLowerCase() };
  }
  throw new GoogleOAuthError('account must be "self" or {"email": "<google account>"}', { code: "invalid_request", status: 400 });
}

export function assertGoogleAuthTenant(tenantId: string): string {
  if (!TENANT_PATTERN.test(tenantId)) {
    throw new GoogleOAuthError("Invalid tenant id", { code: "invalid_request", status: 400 });
  }
  return tenantId;
}

function resolveExpectedEmail(principal: GoogleAuthPrincipal, account: GoogleExpectedAccount): {
  email: string;
  source: "principal" | "admin_specified";
} {
  if (account.kind === "email") return { email: account.email, source: "admin_specified" };
  const email = principal.email?.trim().toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new GoogleOAuthError(
      "The signed-in principal has no verified email; pass account: {email} naming the Google account to connect.",
      { code: "account_binding_required", status: 400 },
    );
  }
  return { email, source: "principal" };
}

function assertPrincipal(principal: GoogleAuthPrincipal): void {
  if (!principal || typeof principal.subject !== "string" || !principal.subject || typeof principal.issuer !== "string" || !principal.issuer) {
    throw new GoogleOAuthError("A verified principal is required", { code: "invalid_request", status: 401 });
  }
}

// --- Authorization start ----------------------------------------------------

export interface GoogleAuthorizationStart {
  mode: "oauth_direct" | "composio_proxy";
  launchUrl: string;
  expiresAt: string;
  expectedEmail: string;
  capabilities: GoogleOAuthCapability[];
  scopes: string[];
}

export interface CreateGoogleStateInput {
  tenantId: string;
  principal: GoogleAuthPrincipal;
  mode: "oauth_direct" | "composio_proxy";
  capabilities: GoogleOAuthCapability[];
  account: GoogleExpectedAccount;
  redirectUri: string;
  publicBaseUrl: string;
  composio?: { connectedAccountId: string; userId: string; toolkit: string; redirectUrl: string };
  /** Pre-generated state (Composio must embed the callback URL before the link exists). */
  state?: string;
}

/** Inserts a single-use state row. Shared by oauth_direct and composio_proxy. */
export async function createGoogleAuthorizationState(
  input: CreateGoogleStateInput,
  deps: GoogleAuthDeps = {},
): Promise<{ state: string; start: GoogleAuthorizationStart }> {
  assertGoogleAuthTenant(input.tenantId);
  assertPrincipal(input.principal);
  const expected = resolveExpectedEmail(input.principal, input.account);
  const scopes = googleOAuthScopesForCapabilities(input.capabilities);
  const state = input.state ?? randomToken(32);
  const stateSha = sha256Hex(state);
  const now = depsNow(deps);
  const expiresAt = now + GOOGLE_OAUTH_STATE_TTL_MS;
  const verifier = input.mode === "oauth_direct" ? randomToken(48) : null;
  const nonce = input.mode === "oauth_direct" ? oidcNonceFor(state) : null;

  // Bounded housekeeping: consumed/expired states are kept a day for audit, then dropped.
  await depsDb(deps).execute(sql`
    DELETE FROM google_oauth_states
    WHERE tenant_id = ${input.tenantId} AND expires_at < ${iso(now - 24 * 60 * 60 * 1000)}::timestamptz
  `);
  await depsDb(deps).execute(sql`
    INSERT INTO google_oauth_states (
      state_sha256, tenant_id, principal_subject, principal_issuer, principal_email, mode,
      capabilities, requested_scopes, expected_email, expected_account_source,
      pkce_verifier_ciphertext, oidc_nonce_sha256, redirect_uri,
      composio_connected_account_id, composio_user_id, composio_toolkit, composio_redirect_url,
      created_at, expires_at
    ) VALUES (
      ${stateSha}, ${input.tenantId}, ${input.principal.subject}, ${input.principal.issuer},
      ${input.principal.email?.trim().toLowerCase() || null}, ${input.mode},
      ${jsonText(input.capabilities)}, ${jsonText(scopes)}, ${expected.email}, ${expected.source},
      ${verifier ? encryptBound(verifier, googleStateAad(stateSha, "pkce_verifier")) : null},
      ${nonce ? sha256Hex(nonce) : null}, ${input.redirectUri},
      ${input.composio?.connectedAccountId ?? null}, ${input.composio?.userId ?? null},
      ${input.composio?.toolkit ?? null}, ${input.composio?.redirectUrl ?? null},
      ${iso(now)}::timestamptz, ${iso(expiresAt)}::timestamptz
    )
  `);

  return {
    state,
    start: {
      mode: input.mode,
      launchUrl: `${input.publicBaseUrl}${GOOGLE_OAUTH_LAUNCH_PATH}?state=${encodeURIComponent(state)}`,
      expiresAt: iso(expiresAt),
      expectedEmail: expected.email,
      capabilities: input.capabilities,
      scopes,
    },
  };
}

export async function startGoogleOAuthAuthorization(
  input: { tenantId: string; principal: GoogleAuthPrincipal; capabilities?: unknown; account?: unknown },
  deps: GoogleAuthDeps = {},
): Promise<GoogleAuthorizationStart> {
  const config = requireConfig(deps);
  const capabilities = normalizeGoogleOAuthCapabilities(input.capabilities);
  const account = normalizeGoogleExpectedAccount(input.account);
  const { start } = await createGoogleAuthorizationState({
    tenantId: input.tenantId,
    principal: input.principal,
    mode: "oauth_direct",
    capabilities,
    account,
    redirectUri: config.redirectUri,
    publicBaseUrl: config.publicBaseUrl,
  }, deps);
  return start;
}

/**
 * Identity-only Google sign-in that proves the principal controls a Google address (owner-only sources),
 * without a data grant: scopes `openid email`, online access, no incremental scopes. The callback stores
 * only a google_account_owner_proofs row, so a domain-wide-delegation mailbox stays collected by DWD.
 * A state is an ownership proof exactly when it requests no data scopes (every data capability has some).
 */
export async function startGoogleOwnershipProof(
  input: { tenantId: string; principal: GoogleAuthPrincipal; account?: unknown },
  deps: GoogleAuthDeps = {},
): Promise<GoogleAuthorizationStart> {
  const config = requireConfig(deps);
  const { start } = await createGoogleAuthorizationState({
    tenantId: input.tenantId,
    principal: input.principal,
    mode: "oauth_direct",
    capabilities: [],
    account: normalizeGoogleExpectedAccount(input.account),
    redirectUri: config.redirectUri,
    publicBaseUrl: config.publicBaseUrl,
  }, deps);
  return start;
}

function oidcNonceFor(state: string): string {
  return sha256Base64Url(`procmem.google.oidc-nonce.v1|${state}`);
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  nonce: string;
  loginHint?: string | null;
}): string {
  // No data scopes = ownership proof: identity only, no refresh token, no previously granted scopes folded in.
  const identityOnly = input.scopes.length === 0;
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: (identityOnly ? ["openid", "email"] : ["openid", "email", "profile", ...input.scopes]).join(" "),
    access_type: identityOnly ? "online" : "offline",
    prompt: identityOnly ? "select_account" : "consent",
    ...(identityOnly ? {} : { include_granted_scopes: "true" }),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    nonce: input.nonce,
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

interface StateRow {
  state_sha256: string;
  tenant_id: string;
  principal_subject: string;
  principal_issuer: string;
  principal_email: string | null;
  mode: "oauth_direct" | "composio_proxy";
  capabilities: unknown;
  requested_scopes: unknown;
  expected_email: string | null;
  expected_account_source: string;
  pkce_verifier_ciphertext: string | null;
  oidc_nonce_sha256: string | null;
  redirect_uri: string;
  browser_binding_sha256: string | null;
  composio_connected_account_id: string | null;
  composio_user_id: string | null;
  composio_toolkit: string | null;
  composio_redirect_url: string | null;
}

/**
 * One-time launch: marks the state launched, records a browser-binding secret
 * (returned as a cookie) and returns the provider redirect. A second launch of
 * the same state fails, so whoever launched first is the only browser that can
 * complete the callback.
 */
export async function launchGoogleAuthorization(
  state: string | undefined,
  deps: GoogleAuthDeps = {},
): Promise<{ redirectUrl: string; bindingCookie: string; mode: "oauth_direct" | "composio_proxy"; maxAgeSeconds: number }> {
  if (!state || state.length > 256) throw new GoogleOAuthError("Missing or invalid state", { code: "invalid_state" });
  const stateSha = sha256Hex(state);
  const binding = randomToken(32);
  const now = depsNow(deps);
  // RETURNING yields post-update values, so the Composio link (cleared here) is read via a locked CTE.
  const rows = rowsOf<StateRow & { expires_at: unknown; launch_redirect_url: string | null }>(await depsDb(deps).execute(sql`
    WITH prev AS (
      SELECT state_sha256, composio_redirect_url
      FROM google_oauth_states
      WHERE state_sha256 = ${stateSha}
        AND launched_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > ${iso(now)}::timestamptz
      FOR UPDATE
    )
    UPDATE google_oauth_states s
    SET launched_at = ${iso(now)}::timestamptz,
        browser_binding_sha256 = ${sha256Hex(binding)},
        composio_redirect_url = NULL
    FROM prev
    WHERE s.state_sha256 = prev.state_sha256
      AND s.launched_at IS NULL
      AND s.consumed_at IS NULL
    RETURNING s.state_sha256, s.tenant_id, s.mode, s.requested_scopes, s.expected_email, s.pkce_verifier_ciphertext,
              s.redirect_uri, s.expires_at, prev.composio_redirect_url AS launch_redirect_url
  `));
  const row = rows[0];
  if (!row) throw new GoogleOAuthError("This connection link has expired or was already used. Start the connection again.", { code: "invalid_state" });
  const expiresAt = toMillis(row.expires_at) ?? now;
  const maxAgeSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));

  if (row.mode === "composio_proxy") {
    if (!row.launch_redirect_url) throw new GoogleOAuthError("Composio link is missing for this state", { code: "invalid_state" });
    return { redirectUrl: row.launch_redirect_url, bindingCookie: binding, mode: row.mode, maxAgeSeconds };
  }

  const config = requireConfig(deps);
  if (!row.pkce_verifier_ciphertext) throw new GoogleOAuthError("State is missing its PKCE verifier", { code: "invalid_state" });
  const verifier = decryptBound(row.pkce_verifier_ciphertext, googleStateAad(stateSha, "pkce_verifier"));
  return {
    redirectUrl: buildGoogleAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: row.redirect_uri,
      scopes: textArray(row.requested_scopes),
      state,
      codeChallenge: sha256Base64Url(verifier),
      nonce: oidcNonceFor(state),
      loginHint: row.expected_email,
    }),
    bindingCookie: binding,
    mode: row.mode,
    maxAgeSeconds,
  };
}

/** Atomically consumes a launched, unexpired state of the given mode. Returns null on replay/tamper/expiry. */
export async function consumeGoogleAuthorizationState(
  state: string | undefined,
  mode: "oauth_direct" | "composio_proxy",
  deps: GoogleAuthDeps = {},
): Promise<StateRow | null> {
  if (!state || state.length > 256) return null;
  const now = depsNow(deps);
  const rows = rowsOf<StateRow>(await depsDb(deps).execute(sql`
    UPDATE google_oauth_states
    SET consumed_at = ${iso(now)}::timestamptz, outcome = 'consumed'
    WHERE state_sha256 = ${sha256Hex(state)}
      AND mode = ${mode}
      AND launched_at IS NOT NULL
      AND consumed_at IS NULL
      AND expires_at > ${iso(now)}::timestamptz
    RETURNING *
  `));
  return rows[0] ?? null;
}

export async function recordGoogleAuthorizationOutcome(state: string, outcome: string, deps: GoogleAuthDeps = {}): Promise<void> {
  await depsDb(deps).execute(sql`
    UPDATE google_oauth_states SET outcome = ${outcome.slice(0, 120)} WHERE state_sha256 = ${sha256Hex(state)}
  `);
}

export function assertBrowserBinding(row: { browser_binding_sha256: string | null }, cookie: string | undefined): void {
  if (!row.browser_binding_sha256 || !cookie || sha256Hex(cookie) !== row.browser_binding_sha256) {
    throw new GoogleOAuthError(
      "This Google consent was completed in a different browser than the one that started it. Start the connection again from the same browser.",
      { code: "browser_mismatch" },
    );
  }
}

// --- Callback ----------------------------------------------------------------

export interface GoogleOAuthCallbackInput {
  state?: string;
  code?: string;
  error?: string;
  bindingCookie?: string;
}

export interface GoogleConnectedAccount {
  tenantId: string;
  mode: "oauth_direct" | "composio_proxy";
  email: string;
  googleSub: string | null;
  hostedDomain: string | null;
  grantedScopes: string[];
  requestedScopes: string[];
  missingScopes: string[];
  capabilities: GoogleOAuthCapability[];
  connectedBy: { subject: string; issuer: string };
  /** Identity-only sign-in (startGoogleOwnershipProof): ownership recorded, no grant, no connection to activate. */
  ownershipProof?: true;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
}

/**
 * Completes the direct OAuth callback. The tenant, principal and expected account
 * come from the consumed state row; nothing in the query selects them.
 */
export async function completeGoogleOAuthCallback(
  input: GoogleOAuthCallbackInput,
  deps: GoogleAuthDeps = {},
): Promise<GoogleConnectedAccount> {
  const row = await consumeGoogleAuthorizationState(input.state, "oauth_direct", deps);
  if (!row) {
    throw new GoogleOAuthError("This Google connection request is invalid, expired or was already used. Start again.", { code: "invalid_state" });
  }
  const state = input.state!;
  try {
    assertBrowserBinding(row, input.bindingCookie);
    if (input.error) {
      throw new GoogleOAuthError("Google authorization was denied or failed.", { code: "access_denied" });
    }
    if (!input.code || input.code.length > 2048) {
      throw new GoogleOAuthError("Google callback did not include an authorization code.", { code: "invalid_request" });
    }
    const config = requireConfig(deps);
    if (!row.pkce_verifier_ciphertext) throw new GoogleOAuthError("State is missing its PKCE verifier", { code: "invalid_state" });
    const verifier = decryptBound(row.pkce_verifier_ciphertext, googleStateAad(row.state_sha256, "pkce_verifier"));
    const tokens = await exchangeGoogleCode(input.code, { verifier, redirectUri: row.redirect_uri }, deps);
    const claims = validateGoogleIdToken(tokens.id_token, {
      clientId: config.clientId,
      nonce: oidcNonceFor(state),
      nonceSha256: row.oidc_nonce_sha256,
      nowMs: depsNow(deps),
    });
    const email = claims.email;
    const ownershipProof = textArray(row.requested_scopes).length === 0;
    if (!row.expected_email || email !== row.expected_email) {
      // An identity-only token carries no data scope and expires on its own; revoking it would revoke that Google
      // user's whole grant to this OAuth client (including a data grant they hold elsewhere).
      if (!ownershipProof) await revokeGoogleToken(tokens.refresh_token ?? tokens.access_token, deps).catch(() => undefined);
      throw new GoogleOAuthError(
        "The Google account that consented is not the account this connection was started for.",
        { code: "account_mismatch", status: 403 },
      );
    }
    const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean).sort();
    const requestedScopes = textArray(row.requested_scopes).sort();
    const account: GoogleConnectedAccount = {
      tenantId: row.tenant_id,
      mode: "oauth_direct",
      email,
      googleSub: claims.sub,
      hostedDomain: claims.hd,
      grantedScopes,
      requestedScopes,
      missingScopes: missingGoogleScopes(grantedScopes, requestedScopes),
      capabilities: textArray(row.capabilities) as GoogleOAuthCapability[],
      connectedBy: { subject: row.principal_subject, issuer: row.principal_issuer },
    };
    if (ownershipProof) {
      await storeGoogleOwnershipProof(account, deps);
      await recordGoogleAuthorizationOutcome(state, "ownership_proven", deps);
      return { ...account, missingScopes: [], ownershipProof: true };
    }
    await storeGoogleOAuthGrant(account, tokens, deps);
    await recordGoogleAuthorizationOutcome(state, account.missingScopes.length ? "connected_partial_scopes" : "connected", deps);
    return account;
  } catch (err) {
    const code = err instanceof GoogleOAuthError ? err.code : "error";
    await recordGoogleAuthorizationOutcome(state, `failed:${code}`, deps).catch(() => undefined);
    throw err;
  }
}

export async function exchangeGoogleCode(
  code: string,
  input: { verifier: string; redirectUri: string },
  deps: GoogleAuthDeps = {},
): Promise<TokenResponse & { access_token: string }> {
  const config = requireConfig(deps);
  const res = await depsFetch(deps)(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({})) as TokenResponse;
  if (!res.ok || !data.access_token) {
    // Never echo the body: it can contain token material on partial failures.
    throw new GoogleOAuthError(`Google token exchange failed (${res.status}${safeErrorCode(data.error)})`, {
      code: "token_exchange_failed",
      status: 502,
    });
  }
  return data as TokenResponse & { access_token: string };
}

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  hd: string | null;
}

/**
 * Validates the ID token received directly from Google's token endpoint over TLS
 * with our client secret (OIDC Core 3.1.3.7 step 6 permits TLS server validation
 * in place of signature checking for this case). Claims are still checked.
 */
export function validateGoogleIdToken(
  idToken: string | undefined,
  expected: { clientId: string; nonce: string; nonceSha256?: string | null; nowMs: number },
): GoogleIdTokenClaims {
  if (!idToken) throw new GoogleOAuthError("Google did not return an ID token (openid scope missing)", { code: "id_token_invalid", status: 502 });
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleOAuthError("Malformed Google ID token", { code: "id_token_invalid", status: 502 });
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new GoogleOAuthError("Malformed Google ID token", { code: "id_token_invalid", status: 502 });
  }
  const nowS = Math.floor(expected.nowMs / 1000);
  const aud = claims.aud;
  const audOk = aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId) && claims.azp === expected.clientId);
  const fail = (why: string): never => {
    throw new GoogleOAuthError(`Google ID token rejected: ${why}`, { code: "id_token_invalid", status: 502 });
  };
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) fail("issuer");
  if (!audOk) fail("audience");
  if (typeof claims.exp !== "number" || claims.exp + ID_TOKEN_CLOCK_SKEW_S < nowS) fail("expired");
  if (typeof claims.iat === "number" && claims.iat - ID_TOKEN_CLOCK_SKEW_S > nowS) fail("issued in the future");
  if (claims.nonce !== expected.nonce) fail("nonce");
  if (expected.nonceSha256 && sha256Hex(String(claims.nonce)) !== expected.nonceSha256) fail("nonce");
  if (typeof claims.sub !== "string" || !claims.sub) fail("subject");
  if (typeof claims.email !== "string" || !EMAIL_PATTERN.test(claims.email)) fail("email");
  if (!(claims.email_verified === true || claims.email_verified === "true")) fail("email not verified");
  return {
    sub: claims.sub as string,
    email: (claims.email as string).trim().toLowerCase(),
    hd: typeof claims.hd === "string" && claims.hd ? claims.hd.toLowerCase() : null,
  };
}

// --- Grant storage ------------------------------------------------------------

export interface GoogleOAuthGrantRow {
  tenant_id: string;
  account_email: string;
  google_sub: string | null;
  hosted_domain: string | null;
  mode: "oauth_direct" | "composio_proxy";
  access_token_ciphertext: string | null;
  access_token_expires_at: unknown;
  refresh_token_ciphertext: string | null;
  refresh_token_expires_at: unknown;
  granted_scopes: unknown;
  composio_connected_account_id: string | null;
  composio_user_id: string | null;
  composio_toolkit: string | null;
  status: "active" | "reauth_required" | "revoked";
  reauth_reason: string | null;
  reauth_at: unknown;
  token_version: string | number;
  connected_by_subject: string;
  connected_by_issuer: string;
  created_at: unknown;
  updated_at: unknown;
  last_refresh_at: unknown;
}

async function storeGoogleOAuthGrant(account: GoogleConnectedAccount, tokens: TokenResponse & { access_token: string }, deps: GoogleAuthDeps): Promise<void> {
  const now = depsNow(deps);
  const accessCipher = encryptBound(tokens.access_token, googleGrantAad(account.tenantId, account.email, "access_token"));
  const refreshCipher = tokens.refresh_token
    ? encryptBound(tokens.refresh_token, googleGrantAad(account.tenantId, account.email, "refresh_token"))
    : null;
  const accessExpiresAt = now + Math.max(60, Number(tokens.expires_in ?? 3600)) * 1000;
  const refreshExpiresAt = tokens.refresh_token_expires_in ? now + tokens.refresh_token_expires_in * 1000 : null;
  await depsDb(deps).transaction(async (tx) => {
    // The same Google identity reconnecting under a changed email replaces its old row.
    await tx.execute(sql`
      DELETE FROM google_oauth_grants
      WHERE tenant_id = ${account.tenantId} AND google_sub = ${account.googleSub} AND account_email <> ${account.email}
    `);
    await tx.execute(sql`
      INSERT INTO google_oauth_grants (
        tenant_id, account_email, google_sub, hosted_domain, mode,
        access_token_ciphertext, access_token_expires_at, refresh_token_ciphertext, refresh_token_expires_at,
        granted_scopes, status, connected_by_subject, connected_by_issuer, last_refresh_at, created_at, updated_at
      ) VALUES (
        ${account.tenantId}, ${account.email}, ${account.googleSub}, ${account.hostedDomain}, 'oauth_direct',
        ${accessCipher}, ${iso(accessExpiresAt)}::timestamptz, ${refreshCipher},
        ${refreshExpiresAt ? iso(refreshExpiresAt) : null}::timestamptz,
        ${jsonText(account.grantedScopes)}, 'active', ${account.connectedBy.subject}, ${account.connectedBy.issuer},
        ${iso(now)}::timestamptz, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz
      )
      ON CONFLICT (tenant_id, account_email) DO UPDATE SET
        google_sub = EXCLUDED.google_sub,
        hosted_domain = EXCLUDED.hosted_domain,
        mode = 'oauth_direct',
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        -- Google omits refresh_token on some re-consents; keep the old one only for the same Google identity.
        refresh_token_ciphertext = CASE
          WHEN EXCLUDED.refresh_token_ciphertext IS NOT NULL THEN EXCLUDED.refresh_token_ciphertext
          WHEN google_oauth_grants.google_sub = EXCLUDED.google_sub THEN google_oauth_grants.refresh_token_ciphertext
          ELSE NULL END,
        refresh_token_expires_at = CASE
          WHEN EXCLUDED.refresh_token_ciphertext IS NOT NULL THEN EXCLUDED.refresh_token_expires_at
          WHEN google_oauth_grants.google_sub = EXCLUDED.google_sub THEN google_oauth_grants.refresh_token_expires_at
          ELSE NULL END,
        granted_scopes = EXCLUDED.granted_scopes,
        composio_connected_account_id = NULL,
        composio_user_id = NULL,
        composio_toolkit = NULL,
        status = 'active',
        reauth_reason = NULL,
        reauth_at = NULL,
        connected_by_subject = EXCLUDED.connected_by_subject,
        connected_by_issuer = EXCLUDED.connected_by_issuer,
        token_version = google_oauth_grants.token_version + 1,
        last_refresh_at = EXCLUDED.last_refresh_at,
        updated_at = EXCLUDED.updated_at
    `);
  });
}

/** Record (or refresh) that `account.connectedBy` proved control of `account.email`; no token is kept. */
async function storeGoogleOwnershipProof(account: GoogleConnectedAccount, deps: GoogleAuthDeps): Promise<void> {
  if (!account.googleSub) throw new GoogleOAuthError("Google did not return a subject", { code: "id_token_invalid", status: 502 });
  await depsDb(deps).execute(sql`
    INSERT INTO google_account_owner_proofs (tenant_id, account_email, google_sub, hosted_domain, proven_by_subject, proven_by_issuer, verified_at)
    VALUES (${account.tenantId}, ${account.email}, ${account.googleSub}, ${account.hostedDomain},
            ${account.connectedBy.subject}, ${account.connectedBy.issuer}, ${iso(depsNow(deps))}::timestamptz)
    ON CONFLICT (tenant_id, account_email) DO UPDATE SET
      google_sub = EXCLUDED.google_sub,
      hosted_domain = EXCLUDED.hosted_domain,
      proven_by_subject = EXCLUDED.proven_by_subject,
      proven_by_issuer = EXCLUDED.proven_by_issuer,
      verified_at = EXCLUDED.verified_at
  `);
}

export async function findGoogleOAuthGrant(
  tenantId: string,
  email: string,
  deps: GoogleAuthDeps = {},
  executor: GoogleAuthSqlExecutor = depsDb(deps),
  lock = false,
): Promise<GoogleOAuthGrantRow | null> {
  const rows = rowsOf<GoogleOAuthGrantRow>(await executor.execute(sql`
    SELECT * FROM google_oauth_grants
    WHERE tenant_id = ${tenantId} AND account_email = ${email.trim().toLowerCase()}
    ${lock ? sql`FOR UPDATE` : sql``}
  `));
  return rows[0] ?? null;
}

/** Deterministic primary OAuth account (oldest active grant) for calls that pass no mailbox. */
export async function primaryGoogleOAuthGrant(tenantId: string, deps: GoogleAuthDeps = {}): Promise<GoogleOAuthGrantRow | null> {
  const rows = rowsOf<GoogleOAuthGrantRow>(await depsDb(deps).execute(sql`
    SELECT * FROM google_oauth_grants
    WHERE tenant_id = ${tenantId} AND status <> 'revoked'
    ORDER BY created_at ASC, account_email ASC
    LIMIT 1
  `));
  return rows[0] ?? null;
}

export async function listGoogleOAuthGrants(tenantId: string, deps: GoogleAuthDeps = {}): Promise<GoogleOAuthGrantRow[]> {
  return rowsOf<GoogleOAuthGrantRow>(await depsDb(deps).execute(sql`
    SELECT * FROM google_oauth_grants WHERE tenant_id = ${tenantId} ORDER BY account_email
  `));
}

// --- Access token / refresh ------------------------------------------------------

const refreshInFlight = new Map<string, Promise<string>>();

export interface GoogleOAuthTokenOptions {
  forceRefresh?: boolean;
}

/**
 * Bearer token for one OAuth-connected account of one tenant. Scope-checked
 * against what the user actually granted; refreshed under a row lock.
 */
export async function getGoogleOAuthAccessToken(
  tenantId: string,
  email: string,
  scopes: readonly string[],
  options: GoogleOAuthTokenOptions = {},
  deps: GoogleAuthDeps = {},
): Promise<string> {
  const account = email.trim().toLowerCase();
  const grant = await findGoogleOAuthGrant(tenantId, account, deps);
  if (!grant) throw new GoogleOAuthError(`Google account ${account} is not connected via OAuth for this tenant.`, { code: "account_not_connected", status: 404 });
  assertGrantUsable(grant, scopes);
  if (grant.mode !== "oauth_direct") {
    throw new GoogleOAuthError(
      "This Google account is connected through Composio, which never exposes a bearer token. Use fetchGoogleApi with getGoogleApiCredential.",
      { code: "bearer_unavailable", status: 409 },
    );
  }

  const now = depsNow(deps);
  const expiresAt = toMillis(grant.access_token_expires_at) ?? 0;
  if (!options.forceRefresh && grant.access_token_ciphertext && expiresAt > now + TOKEN_SAFETY_MS) {
    return decryptBound(grant.access_token_ciphertext, googleGrantAad(tenantId, account, "access_token"));
  }

  const key = `${tenantId}\u0000${account}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const promise = refreshGoogleOAuthGrant(tenantId, account, Number(grant.token_version), options, deps);
  refreshInFlight.set(key, promise);
  promise.then(() => refreshInFlight.delete(key), () => refreshInFlight.delete(key));
  return promise;
}

function assertGrantUsable(grant: GoogleOAuthGrantRow, scopes: readonly string[]): void {
  if (grant.status !== "active") {
    throw new GoogleOAuthReauthRequiredError(grant.account_email, grant.status === "revoked" ? "revoked" : grant.reauth_reason ?? "reauth_required");
  }
  const dwdOnly = scopes.filter((s) => (GOOGLE_DWD_ONLY_SCOPES as readonly string[]).includes(s));
  if (dwdOnly.length) {
    throw new GoogleOAuthScopeError(grant.account_email, dwdOnly);
  }
  if (grant.mode === "oauth_direct") {
    const missing = missingGoogleScopes(textArray(grant.granted_scopes), scopes);
    if (missing.length) throw new GoogleOAuthScopeError(grant.account_email, missing);
  }
}

async function refreshGoogleOAuthGrant(
  tenantId: string,
  account: string,
  observedVersion: number,
  options: GoogleOAuthTokenOptions,
  deps: GoogleAuthDeps,
): Promise<string> {
  const config = requireConfig(deps);
  let reauth: { reason: string } | null = null;
  const token = await depsDb(deps).transaction(async (tx) => {
    const row = await findGoogleOAuthGrant(tenantId, account, deps, tx, true);
    if (!row) throw new GoogleOAuthError(`Google account ${account} is not connected via OAuth for this tenant.`, { code: "account_not_connected", status: 404 });
    if (row.status !== "active") throw new GoogleOAuthReauthRequiredError(account, row.reauth_reason ?? row.status);
    const now = depsNow(deps);
    const expiresAt = toMillis(row.access_token_expires_at) ?? 0;
    // Another worker refreshed while we waited for the lock: use its token.
    if (Number(row.token_version) !== observedVersion && row.access_token_ciphertext && expiresAt > now + TOKEN_SAFETY_MS) {
      return decryptBound(row.access_token_ciphertext, googleGrantAad(tenantId, account, "access_token"));
    }
    if (!options.forceRefresh && row.access_token_ciphertext && expiresAt > now + TOKEN_SAFETY_MS) {
      return decryptBound(row.access_token_ciphertext, googleGrantAad(tenantId, account, "access_token"));
    }
    if (!row.refresh_token_ciphertext) {
      reauth = { reason: "no_refresh_token" };
      await markReauth(tx, tenantId, account, "no_refresh_token", now);
      return null;
    }
    const refreshToken = decryptBound(row.refresh_token_ciphertext, googleGrantAad(tenantId, account, "refresh_token"));
    const res = await depsFetch(deps)(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as TokenResponse;
    if (!res.ok || !data.access_token) {
      const rateLimited = googleRateLimitErrorFromResponse(`google-oauth-token:${tenantId}:${account}`, res, data);
      if (rateLimited) throw rateLimited;
      if (isPermanentRefreshFailure(res.status, data.error)) {
        const reason = data.error ? safeErrorCode(data.error).replace(/^: /, "") : `http_${res.status}`;
        reauth = { reason };
        await markReauth(tx, tenantId, account, reason, now);
        return null;
      }
      // Upstream status kept so classifyCredentialFailure sees 5xx as transient.
      throw new GoogleOAuthError(`Google token refresh failed (${res.status}${safeErrorCode(data.error)})`, {
        code: "token_refresh_failed",
        status: res.status,
      });
    }
    const accessExpiresAt = now + Math.max(60, Number(data.expires_in ?? 3600)) * 1000;
    const rotated = data.refresh_token
      ? encryptBound(data.refresh_token, googleGrantAad(tenantId, account, "refresh_token"))
      : null;
    const grantedScopes = data.scope ? data.scope.split(/\s+/).filter(Boolean).sort() : null;
    await tx.execute(sql`
      UPDATE google_oauth_grants SET
        access_token_ciphertext = ${encryptBound(data.access_token, googleGrantAad(tenantId, account, "access_token"))},
        access_token_expires_at = ${iso(accessExpiresAt)}::timestamptz,
        refresh_token_ciphertext = COALESCE(${rotated}, refresh_token_ciphertext),
        refresh_token_expires_at = ${data.refresh_token_expires_in ? sql`${iso(now + data.refresh_token_expires_in * 1000)}::timestamptz` : sql`refresh_token_expires_at`},
        granted_scopes = ${grantedScopes ? jsonText(grantedScopes) : sql`granted_scopes`},
        status = 'active', reauth_reason = NULL, reauth_at = NULL,
        token_version = token_version + 1,
        last_refresh_at = ${iso(now)}::timestamptz,
        updated_at = ${iso(now)}::timestamptz
      WHERE tenant_id = ${tenantId} AND account_email = ${account}
    `);
    return data.access_token;
  });
  if (token === null) {
    const reason = (reauth as { reason: string } | null)?.reason ?? "reauth_required";
    await markGoogleConnectionError(tenantId, account, deps).catch(() => undefined);
    throw new GoogleOAuthReauthRequiredError(account, reason);
  }
  return token;
}

function isPermanentRefreshFailure(status: number, error: string | undefined): boolean {
  if (error === "invalid_grant" || error === "unauthorized_client" || error === "invalid_client") return true;
  return status === 400 || status === 401 || status === 403;
}

async function markReauth(tx: GoogleAuthSqlExecutor, tenantId: string, account: string, reason: string, now: number): Promise<void> {
  await tx.execute(sql`
    UPDATE google_oauth_grants SET
      status = 'reauth_required', reauth_reason = ${reason.slice(0, 120)}, reauth_at = ${iso(now)}::timestamptz,
      access_token_ciphertext = NULL, access_token_expires_at = NULL, updated_at = ${iso(now)}::timestamptz
    WHERE tenant_id = ${tenantId} AND account_email = ${account}
  `);
}

/** Takes only this account out of the polling roster (listGoogleMailboxes reads active connections). */
export async function markGoogleConnectionError(tenantId: string, account: string, deps: GoogleAuthDeps = {}): Promise<void> {
  await depsDb(deps).execute(sql`
    UPDATE connections SET status = 'error', updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND lower(COALESCE(external_account_id, '')) = ${account}
  `);
}

// --- Revoke ------------------------------------------------------------------

export async function revokeGoogleToken(token: string | undefined, deps: GoogleAuthDeps = {}): Promise<boolean> {
  if (!token) return false;
  const res = await depsFetch(deps)(GOOGLE_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  await res.text().catch(() => "");
  // 400 invalid_token means it was already revoked/expired; either way it is unusable now.
  return res.ok || res.status === 400;
}

/** Revokes at Google (best effort), wipes token material, and marks grant + connection revoked. */
export async function revokeGoogleOAuthGrant(
  tenantId: string,
  email: string,
  deps: GoogleAuthDeps = {},
): Promise<{ revoked: boolean; providerRevoked: boolean | null; mode: string | null }> {
  const account = email.trim().toLowerCase();
  const grant = await findGoogleOAuthGrant(tenantId, account, deps);
  if (!grant) return { revoked: false, providerRevoked: null, mode: null };
  let providerRevoked: boolean | null = null;
  if (grant.mode === "oauth_direct") {
    const cipher = grant.refresh_token_ciphertext ?? grant.access_token_ciphertext;
    const field = grant.refresh_token_ciphertext ? "refresh_token" : "access_token";
    if (cipher) {
      try {
        providerRevoked = await revokeGoogleToken(decryptBound(cipher, googleGrantAad(tenantId, account, field)), deps);
      } catch {
        providerRevoked = false;
      }
    }
  }
  const now = depsNow(deps);
  await depsDb(deps).execute(sql`
    UPDATE google_oauth_grants SET
      status = 'revoked', reauth_reason = 'revoked_by_admin', reauth_at = ${iso(now)}::timestamptz,
      access_token_ciphertext = NULL, access_token_expires_at = NULL,
      refresh_token_ciphertext = NULL, refresh_token_expires_at = NULL,
      token_version = token_version + 1, updated_at = ${iso(now)}::timestamptz
    WHERE tenant_id = ${tenantId} AND account_email = ${account}
  `);
  await depsDb(deps).execute(sql`
    UPDATE connections SET status = 'revoked', updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND lower(COALESCE(external_account_id, '')) = ${account}
  `);
  return { revoked: true, providerRevoked, mode: grant.mode };
}

export async function deleteRevokedGoogleOAuthGrant(tenantId: string, email: string, deps: GoogleAuthDeps = {}): Promise<void> {
  await depsDb(deps).execute(sql`
    DELETE FROM google_oauth_grants
    WHERE tenant_id = ${tenantId} AND account_email = ${email.trim().toLowerCase()} AND status = 'revoked'
  `);
}

function safeErrorCode(code: unknown): string {
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? `: ${code}` : "";
}

export function resetGoogleOAuthStateForTests(): void {
  refreshInFlight.clear();
}
