import { createHash, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { env } from "../env.js";
import { getTokenMetadata, storeToken } from "./tokens.js";
import {
  fetchGoogleApiViaComposio,
  isGoogleComposioConfigured,
  type GoogleComposioCredential,
} from "./google-composio.js";
import { assertGoogleDwdMailboxApproved } from "./google-dwd-policy.js";
import {
  deleteRevokedGoogleOAuthGrant,
  findGoogleOAuthGrant,
  getGoogleOAuthAccessToken,
  GoogleOAuthError,
  GoogleOAuthReauthRequiredError,
  GoogleOAuthScopeError,
  GOOGLE_DWD_ONLY_SCOPES,
  googleOAuthClientConfig,
  isGoogleOAuthConfigured,
  primaryGoogleOAuthGrant,
  type GoogleOAuthGrantRow,
} from "./google-oauth.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com/v1";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export const SHEPHERD_GOOGLE_WORKSPACE_APP_NAME = "Shepherd";
// Display/docs fallbacks only - the live values are derived from the
// configured service-account key JSON (client_email / client_id) at runtime.
export const SHEPHERD_GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL =
  "shepherd-delegation@shepherd-delegation.iam.gserviceaccount.com";
export const SHEPHERD_GOOGLE_WORKSPACE_CLIENT_ID = "113496416730920355515";

const GOOGLE_WORKSPACE_UNSUPPORTED_DELEGATION_EMAIL_DOMAINS = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "hotmail.co.uk",
  "icloud.com",
  "inbox.com",
  "live.com",
  "live.co.uk",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "tuta.com",
  "tutanota.com",
  "web.de",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "zohomail.com",
]);

export const GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  "https://www.googleapis.com/auth/gmail.addons.current.message.action",
  "https://www.googleapis.com/auth/gmail.addons.current.message.metadata",
  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/calendar.acls.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.calendarlist",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.calendars",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.owned.readonly",
  "https://www.googleapis.com/auth/calendar.events.public.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/drive.apps.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
  "https://www.googleapis.com/auth/drive.meet.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.photos.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.scripts",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
] as const;

export const GOOGLE_CALENDAR_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
] as const;

export const GOOGLE_DOCS_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.activity.readonly",
] as const;

export const GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
] as const;

export const GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export const GOOGLE_GMAIL_TOOL_DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

// --- Delegation token cache ---
const delegationCache = new Map<string, { accessToken: string; expiresAt: number }>();
type GoogleDelegationTokenOptions = {
  forceRefresh?: boolean;
};

// --- Auth mode detection ---

export function isDelegationConfigured(): boolean {
  return Boolean(getServiceAccountClientEmail() && (getServiceAccountPrivateKey() || hasPotentialAdcCallerCredential()));
}

export function isGoogleConfigured(): boolean {
  return isDelegationConfigured() || isGoogleOAuthConfigured() || isGoogleComposioConfigured();
}

export function googleWorkspaceDelegationSetup(): {
  appName: string;
  serviceAccountEmail: string;
  clientId: string;
  scopes: string[];
} {
  return {
    appName: SHEPHERD_GOOGLE_WORKSPACE_APP_NAME,
    serviceAccountEmail: configuredValueOrNull(getServiceAccountClientEmail) ?? SHEPHERD_GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL,
    clientId: configuredValueOrNull(getServiceAccountClientId) ?? SHEPHERD_GOOGLE_WORKSPACE_CLIENT_ID,
    scopes: [...GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES],
  };
}

export function configuredGoogleWorkspaceServiceAccountEmail(): string | null {
  return configuredValueOrNull(getServiceAccountClientEmail);
}

/** This is a display surface (onboarding/setup docs) - never let a malformed key JSON turn it into a 500. */
function configuredValueOrNull(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export function isGoogleWorkspaceDelegationEmailSupported(email: string): boolean {
  const domain = domainFromEmail(email);
  return Boolean(domain && !GOOGLE_WORKSPACE_UNSUPPORTED_DELEGATION_EMAIL_DOMAINS.has(domain));
}

function getServiceAccountClientEmail(): string | null {
  const parsed = readServiceAccountJson();
  if (parsed?.client_email) return parsed.client_email;
  return env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_CLIENT_EMAIL?.trim() || null;
}

function getServiceAccountPrivateKey(): string | null {
  const parsed = readServiceAccountJson();
  if (parsed?.private_key) return normalizePrivateKey(parsed.private_key);
  const pk = env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (pk) return normalizePrivateKey(pk);
  return null;
}

/** OAuth client id of the configured service account (the key JSON's client_id). */
function getServiceAccountClientId(): string | null {
  return readServiceAccountJson()?.client_id ?? null;
}

function readServiceAccountJson(): { client_email?: string; private_key?: string; client_id?: string } | null {
  const workspaceJson = env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  if (workspaceJson) {
    return parseServiceAccountJson(workspaceJson, "GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON", true);
  }

  const adcJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (adcJson) {
    return parseServiceAccountJson(adcJson, "GOOGLE_APPLICATION_CREDENTIALS_JSON", false);
  }

  const credentialsPath = explicitGoogleCredentialsPath();
  if (credentialsPath) {
    return parseServiceAccountJson(
      readRequiredFile(credentialsPath, "GOOGLE_APPLICATION_CREDENTIALS"),
      `GOOGLE_APPLICATION_CREDENTIALS (${credentialsPath})`,
      false,
    );
  }

  return null;
}

function parseServiceAccountJson(
  value: string,
  source: string,
  requireServiceAccount: boolean,
): { client_email?: string; private_key?: string; client_id?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`${source} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : undefined;
  const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : undefined;
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id : undefined;
  if (clientEmail || privateKey) return { client_email: clientEmail, private_key: privateKey, client_id: clientId };
  if (requireServiceAccount) {
    throw new Error(`${source} must include service account client_email and private_key fields`);
  }
  return null;
}

function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, "\n").trim();
}

function hasPotentialAdcCallerCredential(): boolean {
  return readAuthorizedUserAdc() !== null;
}

// --- Delegation-based access token ---

async function getDelegationAccessToken(
  userEmail: string,
  scopes: string[],
  options: GoogleDelegationTokenOptions = {},
): Promise<string> {
  const cacheKey = `${userEmail}:${scopes.join(" ")}`;
  const cached = delegationCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_MS) {
    return cached.accessToken;
  }

  const clientEmail = getServiceAccountClientEmail()!;
  const privateKey = getServiceAccountPrivateKey();

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    sub: userEmail,
    iat: now,
    exp: now + 3600,
  };

  let assertion: string;
  if (privateKey) {
    assertion = signJwt({ alg: "RS256", typ: "JWT" }, claims, privateKey);
  } else {
    assertion = await signJwtWithIamCredentials(clientEmail, claims);
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
  });

  const data = await response.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string };

  if (!response.ok || !data.access_token) {
    throw new Error(`Google delegation failed: ${data.error_description ?? data.error ?? response.status}`);
  }

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  delegationCache.set(cacheKey, { accessToken: data.access_token, expiresAt });

  return data.access_token;
}

async function signJwtWithIamCredentials(serviceAccountEmail: string, payload: Record<string, unknown>): Promise<string> {
  const callerToken = await getAdcCallerToken();
  if (!callerToken) {
    throw new Error("Google delegation keyless signing needs ADC with iam.serviceAccounts.signJwt. Locally, run gcloud auth application-default login with Service Account Token Creator. On Railway/Vercel, set GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON or GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY instead.");
  }

  const response = await fetch(
    `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:signJwt`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${callerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: JSON.stringify(payload) }),
    },
  );

  const data = await response.json() as { signedJwt?: string; error?: { message?: string } };
  if (!response.ok || !data.signedJwt) {
    throw new Error(`Delegation JWT signing failed: ${data.error?.message ?? response.status}`);
  }
  return data.signedJwt;
}

let adcCache: { token: string; expiresAt: number } | null = null;

async function getAdcCallerToken(): Promise<string | null> {
  if (adcCache && adcCache.expiresAt > Date.now() + 30_000) return adcCache.token;

  const adc = readAuthorizedUserAdc();
  if (!adc) return null;

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: adc.client_id ?? "", client_secret: adc.client_secret ?? "", refresh_token: adc.refresh_token }),
    });
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    adcCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  } catch {
    return null;
  }
}

function readAuthorizedUserAdc(): { client_id?: string; client_secret?: string; refresh_token: string; type: string } | null {
  const adcJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (adcJson) {
    return parseAuthorizedUserAdc(adcJson, "GOOGLE_APPLICATION_CREDENTIALS_JSON", true);
  }

  const explicitPath = explicitGoogleCredentialsPath();
  if (explicitPath) {
    return parseAuthorizedUserAdc(
      readRequiredFile(explicitPath, "GOOGLE_APPLICATION_CREDENTIALS"),
      `GOOGLE_APPLICATION_CREDENTIALS (${explicitPath})`,
      true,
    );
  }

  const defaultPath = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  if (!existsSync(defaultPath)) return null;
  try {
    return parseAuthorizedUserAdc(readFileSync(defaultPath, "utf8"), defaultPath, false);
  } catch {
    return null;
  }
}

function parseAuthorizedUserAdc(
  value: string,
  source: string,
  explicit: boolean,
): { client_id?: string; client_secret?: string; refresh_token: string; type: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    if (!explicit) return null;
    throw new Error(`${source} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    if (!explicit) return null;
    throw new Error(`${source} must be a JSON object`);
  }
  if (parsed.type !== "authorized_user" || typeof parsed.refresh_token !== "string") return null;
  return {
    type: "authorized_user",
    refresh_token: parsed.refresh_token,
    client_id: typeof parsed.client_id === "string" ? parsed.client_id : undefined,
    client_secret: typeof parsed.client_secret === "string" ? parsed.client_secret : undefined,
  };
}

function explicitGoogleCredentialsPath(): string | null {
  return process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || null;
}

function readRequiredFile(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${label} at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: string): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${h}.${p}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

// --- Main access token / credential functions (explicit mode per account) ---
//
// Every (tenant, Google account) resolves to exactly one mode, and a failure in
// that mode is surfaced; it never falls back to another mode:
//   * an account with a google_oauth_grants row uses that grant (oauth_direct
//     bearer, or composio_proxy which never yields a bearer);
//   * any other account uses domain-wide delegation, and only if it lies inside
//     the operator-approved allowlist for this tenant (google-dwd-policy.ts).
// With no account argument, the tenant's DWD admin mailbox (token metadata) is
// used if DWD is connected, otherwise its oldest OAuth grant. The former
// process-global GOOGLE_WORKSPACE_USER_EMAIL fallback was removed: one env
// mailbox shared by every tenant is exactly the cross-tenant credential to avoid.

export type GoogleAuthMode = "domain_wide_delegation" | "oauth_direct" | "composio_proxy";

export type GoogleApiCredential =
  | { kind: "access_token"; accessToken: string; mode: "domain_wide_delegation" | "oauth_direct"; account: string; quotaUser: string }
  | (GoogleComposioCredential & { mode: "composio_proxy"; account: string; quotaUser: string });

export class GoogleBearerUnavailableError extends GoogleOAuthError {
  constructor(readonly account: string) {
    super(
      `Google account ${account} is connected through Composio, which does not expose a bearer token; this job needs direct API access (use fetchGoogleApi) or a DWD/OAuth connection.`,
      { code: "bearer_unavailable", status: 409 },
    );
    this.name = "GoogleBearerUnavailableError";
  }
}

/**
 * Opaque quota attribution for X-Goog-Quota-User (≤ 40 chars, no raw email).
 * Keyed by the upstream identity actually consuming quota - the Google account
 * plus the credential it is used through (service account / OAuth client /
 * Composio) - and deliberately NOT by tenant, so the same mailbox reached from
 * two bindings never looks like two budgets. Google ignores the header unless
 * the quota project is identified, so it is attribution, not isolation.
 */
export function googleQuotaUser(account: string, upstreamIdentity: string): string {
  return `q${createHash("sha256").update(`${upstreamIdentity}\n${account.trim().toLowerCase()}`).digest("hex").slice(0, 39)}`;
}

export async function getGoogleApiCredential(
  userId: string,
  delegatedUserEmail?: string,
  scopes: readonly string[] = GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES,
  options: GoogleDelegationTokenOptions = {},
): Promise<GoogleApiCredential> {
  const explicit = delegatedUserEmail?.trim().toLowerCase() || null;
  let grant: GoogleOAuthGrantRow | null = null;
  let dwdEmail: string | null = null;
  let metadata: Record<string, unknown> | null = null;

  if (explicit) {
    grant = await findGoogleOAuthGrant(userId, explicit);
    if (!grant) dwdEmail = explicit;
  } else {
    metadata = await getTokenMetadata(userId, "google");
    const storedUsesDelegation = metadata?.delegation === true || metadata?.authMode === "domain_wide_delegation";
    const storedEmail = storedGoogleDelegationEmail(metadata);
    if (storedUsesDelegation && storedEmail) {
      dwdEmail = storedEmail.toLowerCase();
    } else {
      grant = await primaryGoogleOAuthGrant(userId);
    }
  }

  if (grant) {
    const account = grant.account_email;
    if (grant.mode === "composio_proxy") {
      if (grant.status !== "active") throw new GoogleOAuthReauthRequiredError(account, grant.reauth_reason ?? grant.status);
      const dwdOnly = scopes.filter((s) => (GOOGLE_DWD_ONLY_SCOPES as readonly string[]).includes(s));
      if (dwdOnly.length) throw new GoogleOAuthScopeError(account, dwdOnly);
      return {
        kind: "composio_proxy",
        mode: "composio_proxy",
        connectedAccountId: grant.composio_connected_account_id!,
        toolkit: (grant.composio_toolkit ?? "google_super") as GoogleComposioCredential["toolkit"],
        userId: grant.composio_user_id ?? "",
        scopes: [...scopes],
        account,
        quotaUser: googleQuotaUser(account, `composio:${grant.composio_toolkit ?? "google_super"}`),
      };
    }
    const accessToken = await getGoogleOAuthAccessToken(userId, account, scopes, { forceRefresh: options.forceRefresh });
    return { kind: "access_token", accessToken, mode: "oauth_direct", account, quotaUser: googleQuotaUser(account, `oauth:${googleOAuthClientConfig()?.clientId ?? "unconfigured"}`) };
  }

  if (!dwdEmail) {
    throw new Error("Google is not connected for this tenant. Connect a Google account with OAuth, or approve and connect a Workspace mailbox with domain-wide delegation.");
  }
  if (!isDelegationConfigured()) {
    metadata ??= await getTokenMetadata(userId, "google");
    const storedUsesDelegation = metadata?.delegation === true || metadata?.authMode === "domain_wide_delegation";
    if (storedUsesDelegation) {
      throw new Error("Google Workspace domain-wide delegation is connected, but this worker is missing service account credentials. Set GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON or GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY on this service.");
    }
    throw new Error(`Google account ${dwdEmail} is not connected via OAuth for this tenant, and domain-wide delegation is not configured on this service.`);
  }
  if (!isGoogleWorkspaceDelegationEmailSupported(dwdEmail)) {
    throw new Error("Google Workspace domain-wide delegation requires a managed Google Workspace email, not a personal email account.");
  }
  // Checked before the (service-account-global) token cache so an unapproved
  // tenant can never receive a token minted for another tenant's mailbox.
  assertGoogleDwdMailboxApproved(userId, dwdEmail);
  const accessToken = await getDelegationAccessToken(dwdEmail, [...scopes], options);
  return { kind: "access_token", accessToken, mode: "domain_wide_delegation", account: dwdEmail, quotaUser: googleQuotaUser(dwdEmail, `dwd:${getServiceAccountClientEmail() ?? "unknown"}`) };
}

export async function getGoogleAccessToken(
  userId: string,
  delegatedUserEmail?: string,
  scopes: readonly string[] = GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES,
  options: GoogleDelegationTokenOptions = {},
): Promise<string> {
  const credential = await getGoogleApiCredential(userId, delegatedUserEmail, scopes, options);
  if (credential.kind === "access_token") return credential.accessToken;
  throw new GoogleBearerUnavailableError(credential.account);
}

/** Single transport for either credential kind (gigabrain e3348e568 seam). */
export async function fetchGoogleApi(credential: GoogleApiCredential, url: string, init: RequestInit = {}): Promise<Response> {
  if (credential.kind === "access_token") {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    if (!headers.has("X-Goog-Quota-User")) headers.set("X-Goog-Quota-User", credential.quotaUser);
    return fetch(url, { ...init, headers });
  }
  const headers = new Headers(init.headers);
  if (!headers.has("X-Goog-Quota-User")) headers.set("X-Goog-Quota-User", credential.quotaUser);
  return fetchGoogleApiViaComposio(credential, url, { ...init, headers });
}

/** Which mode an account of this tenant resolves to (null = not connected / not approved). */
export async function resolveGoogleAuthMode(tenantId: string, account: string): Promise<GoogleAuthMode | null> {
  const grant = await findGoogleOAuthGrant(tenantId, account);
  if (grant) return grant.mode;
  try {
    assertGoogleDwdMailboxApproved(tenantId, account);
  } catch {
    return null;
  }
  return isDelegationConfigured() ? "domain_wide_delegation" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedGoogleDelegationEmail(metadata: Record<string, unknown> | null): string | null {
  const email = metadata?.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

function domainFromEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 0) return null;
  const domain = normalized.slice(at + 1).trim();
  return domain || null;
}

// --- Per-user OAuth helpers (implemented in google-oauth.ts: DB state, PKCE, nonce) ---

export { buildGoogleAuthorizeUrl as buildGoogleOAuthUrl, exchangeGoogleCode } from "./google-oauth.js";

export async function getGmailProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) { await res.text(); throw new Error(`Gmail profile request failed (${res.status})`); }
  return res.json();
}

export async function connectGoogleWorkspaceDelegation(
  userId: string,
  userEmail: string,
): Promise<{ connected: true; email: string; historyId: string; scopes: string[] }> {
  if (!isDelegationConfigured()) {
    throw new Error("Google Workspace domain-wide delegation is not configured on Shepherd's backend.");
  }

  const normalizedEmail = userEmail.trim().toLowerCase();
  if (!normalizedEmail) throw new Error("Google Workspace delegated user email is required.");
  if (!isGoogleWorkspaceDelegationEmailSupported(normalizedEmail)) {
    throw new Error("Google Workspace domain-wide delegation requires a managed Google Workspace email, not a personal email account.");
  }
  assertGoogleDwdMailboxApproved(userId, normalizedEmail);
  const oauthGrant = await findGoogleOAuthGrant(userId, normalizedEmail);
  if (oauthGrant && oauthGrant.status !== "revoked") {
    throw new GoogleOAuthError(
      "This Google account is already connected with per-user OAuth on this tenant. Disconnect it before switching it to domain-wide delegation.",
      { code: "mode_conflict", status: 409 },
    );
  }
  // A revoked OAuth row would otherwise keep pinning this account to the OAuth mode.
  if (oauthGrant) await deleteRevokedGoogleOAuthGrant(userId, normalizedEmail);

  const accessToken = await getGoogleAccessToken(userId, normalizedEmail, GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES, {
    forceRefresh: true,
  });
  const profile = await getGmailProfile(accessToken);
  const scopes = [...GOOGLE_WORKSPACE_DOMAIN_WIDE_DELEGATION_SCOPES];

  // Multi-mailbox: the token row carries the tenant's ADMIN subject (used for
  // Directory API enumeration) plus service-account facts. Only the FIRST
  // connect writes it; additional mailboxes must not clobber the admin email
  // or the legacy cursors that seed google_mailbox_sync_state. Their roster
  // membership is the connections row; their cursors live per-mailbox.
  const existing = await getTokenMetadata(userId, "google");
  if (!existing || storedGoogleDelegationEmail(existing) === profile.emailAddress.trim().toLowerCase()) {
    await storeToken(userId, "google", "delegation", {
      email: profile.emailAddress,
      historyId: profile.historyId,
      delegation: true,
      authMode: "domain_wide_delegation",
      serviceAccountEmail: getServiceAccountClientEmail() ?? SHEPHERD_GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL,
      clientId: getServiceAccountClientId() ?? SHEPHERD_GOOGLE_WORKSPACE_CLIENT_ID,
      scopes,
      connectedAt: new Date().toISOString(),
    });
  }

  return {
    connected: true,
    email: profile.emailAddress,
    historyId: profile.historyId,
    scopes,
  };
}

export async function verifyGoogleWorkspaceDelegationConnection(
  userId: string,
): Promise<{ connected: true; email: string; historyId: string } | null> {
  const metadata = await getTokenMetadata(userId, "google");
  const email = storedGoogleDelegationEmail(metadata);
  const usesDelegation = metadata?.delegation === true || metadata?.authMode === "domain_wide_delegation";
  if (!email || !usesDelegation) return null;

  try {
    const accessToken = await getGoogleAccessToken(userId, email, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES, {
      forceRefresh: true,
    });
    const profile = await getGmailProfile(accessToken);
    return {
      connected: true,
      email: profile.emailAddress,
      historyId: profile.historyId,
    };
  } catch {
    return null;
  }
}
