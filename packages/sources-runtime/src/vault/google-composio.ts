import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { randomToken, sha256Hex } from "./google-grant-crypto.js";
import {
  assertBrowserBinding,
  consumeGoogleAuthorizationState,
  createGoogleAuthorizationState,
  googleAuthPublicBaseUrl,
  GoogleOAuthError,
  normalizeGoogleExpectedAccount,
  normalizeGoogleOAuthCapabilities,
  recordGoogleAuthorizationOutcome,
  rowsOf,
  type GoogleAuthDb,
  type GoogleAuthDeps,
  type GoogleAuthorizationStart,
  type GoogleAuthPrincipal,
  type GoogleConnectedAccount,
  type GoogleOAuthCapability,
} from "./google-oauth.js";

/**
 * Optional Composio-held Google OAuth lane ("composio_proxy").
 *
 * Port of gigabrain codex/google-oauth-composio (e3348e568 link/pending binding,
 * 21feb7132 v3 header params, upstream header passthrough, binary_data.url
 * downloads) WITHOUT that branch's DWD disablement, and with the audit fixes:
 *   * the callback's `status` query parameter is never trusted; the connected
 *     account is fetched from Composio server-side and must be ACTIVE, belong
 *     to the Composio user id we created for this tenant+principal, and use the
 *     configured auth config;
 *   * the state is the same single-use DB state as oauth_direct, so it cannot be
 *     replayed within its TTL, and the connected account id must equal the one
 *     recorded when the link was created for this tenant;
 *   * a connected account id can be bound to only one tenant (unique index).
 * Composio never exposes a bearer token: callers needing one (Docs OT
 * revisions/load) get bearer_unavailable and coverage reports them blocked.
 */

export const GOOGLE_COMPOSIO_CALLBACK_PATH = "/auth/google/composio/callback";
const LINK_PATH = "/api/v3/connected_accounts/link";
const ACCOUNT_PATH = "/api/v3/connected_accounts/";
const PROXY_PATH = "/api/v3/tools/execute/proxy";
const HTTP_TIMEOUT_MS = 20_000;

export type GoogleComposioToolkit =
  | "google_super"
  | "gmail"
  | "google_drive"
  | "google_docs"
  | "google_calendar"
  | "google_admin"
  | "people";

export interface GoogleComposioConfig {
  apiKey: string;
  apiBaseUrl: string;
  authConfigIds: Partial<Record<GoogleComposioToolkit, string>>;
  defaultAuthConfigId: string | null;
}

export function googleComposioConfig(source: Record<string, string | undefined> = process.env): GoogleComposioConfig | null {
  const apiKey = source.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return null;
  const authConfigIds: Partial<Record<GoogleComposioToolkit, string>> = {};
  const perToolkit: Array<[GoogleComposioToolkit, string]> = [
    ["gmail", "COMPOSIO_GOOGLE_GMAIL_AUTH_CONFIG_ID"],
    ["google_drive", "COMPOSIO_GOOGLE_DRIVE_AUTH_CONFIG_ID"],
    ["google_docs", "COMPOSIO_GOOGLE_DOCS_AUTH_CONFIG_ID"],
    ["google_calendar", "COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID"],
    ["google_admin", "COMPOSIO_GOOGLE_ADMIN_AUTH_CONFIG_ID"],
  ];
  for (const [toolkit, name] of perToolkit) {
    const value = source[name]?.trim();
    if (value) authConfigIds[toolkit] = value;
  }
  const defaultAuthConfigId = source.COMPOSIO_GOOGLE_AUTH_CONFIG_ID?.trim() || null;
  if (!defaultAuthConfigId && Object.keys(authConfigIds).length === 0) return null;
  return {
    apiKey,
    apiBaseUrl: (source.COMPOSIO_API_BASE_URL?.trim() || "https://backend.composio.dev").replace(/\/+$/, ""),
    authConfigIds,
    defaultAuthConfigId,
  };
}

export function isGoogleComposioConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return googleComposioConfig(source) !== null;
}

export function googleComposioToolkitFor(capabilities: readonly GoogleOAuthCapability[]): GoogleComposioToolkit {
  if (capabilities.length !== 1) return "google_super";
  switch (capabilities[0]) {
    case "gmail": return "gmail";
    case "calendar": return "google_calendar";
    case "docs": return "google_docs";
    case "contacts": return "people";
    case "directory_admin": return "google_admin";
    default: return "google_super";
  }
}

function authConfigIdFor(config: GoogleComposioConfig, toolkit: GoogleComposioToolkit): string | null {
  return config.authConfigIds[toolkit] ?? config.defaultAuthConfigId;
}

/** Composio user id: tenant-scoped and principal-specific, never the bare yc_msaw subject. */
export function googleComposioUserId(tenantId: string, principal: GoogleAuthPrincipal): string {
  return `procmem:${tenantId}:${sha256Hex(`${principal.issuer}\n${principal.subject}`).slice(0, 24)}`;
}

interface ComposioDeps extends GoogleAuthDeps {
  composio?: GoogleComposioConfig | null;
}

function requireComposio(deps: ComposioDeps): GoogleComposioConfig {
  const config = deps.composio === undefined ? googleComposioConfig() : deps.composio;
  if (!config) {
    throw new GoogleOAuthError("Composio Google OAuth is not configured (COMPOSIO_API_KEY and a COMPOSIO_GOOGLE_*_AUTH_CONFIG_ID).", {
      code: "not_configured",
      status: 503,
    });
  }
  return config;
}

export async function startGoogleComposioAuthorization(
  input: { tenantId: string; principal: GoogleAuthPrincipal; capabilities?: unknown; account?: unknown },
  deps: ComposioDeps = {},
): Promise<GoogleAuthorizationStart> {
  const config = requireComposio(deps);
  const publicBaseUrl = googleAuthPublicBaseUrl();
  const base = deps.config?.publicBaseUrl ?? publicBaseUrl;
  if (!base) throw new GoogleOAuthError("SOURCES_RUNTIME_PUBLIC_URL is required for Composio callbacks", { code: "not_configured", status: 503 });
  const capabilities = normalizeGoogleOAuthCapabilities(input.capabilities);
  const account = normalizeGoogleExpectedAccount(input.account);
  const toolkit = googleComposioToolkitFor(capabilities);
  const authConfigId = authConfigIdFor(config, toolkit);
  if (!authConfigId) throw new GoogleOAuthError(`No Composio auth config for toolkit ${toolkit}`, { code: "not_configured", status: 503 });

  const state = randomToken(32);
  const userId = googleComposioUserId(input.tenantId, input.principal);
  const callbackUrl = `${base}${GOOGLE_COMPOSIO_CALLBACK_PATH}?state=${encodeURIComponent(state)}`;
  const res = await (deps.fetch ?? fetch)(`${config.apiBaseUrl}${LINK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new GoogleOAuthError(`Composio Google OAuth link failed (${res.status})`, { code: "token_exchange_failed", status: 502 });
  const redirectUrl = stringField(data, "redirect_url") ?? stringField(data, "redirectUrl");
  const connectedAccountId = stringField(data, "connected_account_id") ?? stringField(data, "connectedAccountId");
  if (!redirectUrl || !connectedAccountId) {
    throw new GoogleOAuthError("Composio link response did not include a redirect URL and connected account id", { code: "token_exchange_failed", status: 502 });
  }

  const { start } = await createGoogleAuthorizationState({
    tenantId: input.tenantId,
    principal: input.principal,
    mode: "composio_proxy",
    capabilities,
    account,
    redirectUri: callbackUrl,
    publicBaseUrl: base,
    composio: { connectedAccountId, userId, toolkit, redirectUrl },
    state,
  }, deps);
  return start;
}

export async function completeGoogleComposioCallback(
  input: { state?: string; connectedAccountId?: string; bindingCookie?: string },
  deps: ComposioDeps = {},
): Promise<GoogleConnectedAccount> {
  const row = await consumeGoogleAuthorizationState(input.state, "composio_proxy", deps);
  if (!row) throw new GoogleOAuthError("This Google connection request is invalid, expired or was already used. Start again.", { code: "invalid_state" });
  const state = input.state!;
  try {
    assertBrowserBinding(row, input.bindingCookie);
    if (!input.connectedAccountId || !row.composio_user_id || input.connectedAccountId !== row.composio_connected_account_id) {
      throw new GoogleOAuthError("Callback connected account was not initiated for this connection request.", { code: "invalid_state" });
    }
    const config = requireComposio(deps);
    const account = await fetchComposioConnectedAccount(config, row.composio_connected_account_id, deps);
    const expectedAuthConfig = authConfigIdFor(config, (row.composio_toolkit ?? "google_super") as GoogleComposioToolkit);
    if (account.status !== "ACTIVE") {
      throw new GoogleOAuthError(`Composio connected account is ${account.status ?? "unknown"}, not ACTIVE.`, { code: "access_denied" });
    }
    if (account.userId !== row.composio_user_id) {
      throw new GoogleOAuthError("Composio connected account belongs to a different user.", { code: "account_mismatch", status: 403 });
    }
    if (expectedAuthConfig && account.authConfigId && account.authConfigId !== expectedAuthConfig) {
      throw new GoogleOAuthError("Composio connected account uses an unexpected auth config.", { code: "account_mismatch", status: 403 });
    }
    const credential = {
      kind: "composio_proxy" as const,
      connectedAccountId: row.composio_connected_account_id,
      toolkit: (row.composio_toolkit ?? "google_super") as GoogleComposioToolkit,
      userId: row.composio_user_id!,
      scopes: [] as string[],
    };
    const email = await composioAccountEmail(credential, config, deps);
    if (!row.expected_email || email !== row.expected_email) {
      throw new GoogleOAuthError("The Google account that consented is not the account this connection was started for.", {
        code: "account_mismatch",
        status: 403,
      });
    }
    const connected: GoogleConnectedAccount = {
      tenantId: row.tenant_id,
      mode: "composio_proxy",
      email,
      googleSub: null,
      hostedDomain: null,
      grantedScopes: [],
      requestedScopes: Array.isArray(row.requested_scopes) ? (row.requested_scopes as string[]) : [],
      // Composio does not report granted Google scopes; coverage says so instead of claiming them.
      missingScopes: [],
      capabilities: (Array.isArray(row.capabilities) ? row.capabilities : []) as GoogleOAuthCapability[],
      connectedBy: { subject: row.principal_subject, issuer: row.principal_issuer },
    };
    await storeComposioGrant(connected, credential, deps);
    await recordGoogleAuthorizationOutcome(state, "connected", deps);
    return connected;
  } catch (err) {
    const code = err instanceof GoogleOAuthError ? err.code : "error";
    await recordGoogleAuthorizationOutcome(state, `failed:${code}`, deps).catch(() => undefined);
    throw err;
  }
}

async function fetchComposioConnectedAccount(
  config: GoogleComposioConfig,
  id: string,
  deps: ComposioDeps,
): Promise<{ status: string | null; userId: string | null; authConfigId: string | null }> {
  const res = await (deps.fetch ?? fetch)(`${config.apiBaseUrl}${ACCOUNT_PATH}${encodeURIComponent(id)}`, {
    headers: { "x-api-key": config.apiKey },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new GoogleOAuthError(`Composio connected account lookup failed (${res.status})`, { code: "token_exchange_failed", status: 502 });
  const authConfig = isRecord(data.auth_config) ? data.auth_config : null;
  return {
    status: stringField(data, "status")?.toUpperCase() ?? null,
    userId: stringField(data, "user_id"),
    authConfigId: authConfig ? stringField(authConfig, "id") : null,
  };
}

async function composioAccountEmail(
  credential: GoogleComposioCredential,
  config: GoogleComposioConfig,
  deps: ComposioDeps,
): Promise<string> {
  const probes = credential.toolkit === "google_drive" || credential.toolkit === "google_docs"
    ? ["https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"]
    : credential.toolkit === "google_calendar"
      ? ["https://www.googleapis.com/calendar/v3/calendars/primary"]
      : ["https://gmail.googleapis.com/gmail/v1/users/me/profile", "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"];
  for (const url of probes) {
    const res = await fetchGoogleApiViaComposio(credential, url, {}, { ...deps, composio: config });
    if (!res.ok) continue;
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    const email = stringField(data ?? {}, "emailAddress")
      ?? (isRecord(data?.user) ? stringField(data.user, "emailAddress") : null)
      ?? (url.includes("/calendars/primary") ? stringField(data ?? {}, "id") : null);
    if (email && email.includes("@")) return email.toLowerCase();
  }
  throw new GoogleOAuthError("Could not determine which Google account the Composio connection belongs to.", {
    code: "id_token_invalid",
    status: 502,
  });
}

async function storeComposioGrant(account: GoogleConnectedAccount, credential: GoogleComposioCredential, deps: GoogleAuthDeps): Promise<void> {
  const db = deps.db ?? (defaultDb as unknown as GoogleAuthDb);
  const now = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  await db.execute(sql`
    INSERT INTO google_oauth_grants (
      tenant_id, account_email, mode, composio_connected_account_id, composio_user_id, composio_toolkit,
      status, connected_by_subject, connected_by_issuer, created_at, updated_at
    ) VALUES (
      ${account.tenantId}, ${account.email}, 'composio_proxy', ${credential.connectedAccountId}, ${credential.userId},
      ${credential.toolkit}, 'active', ${account.connectedBy.subject}, ${account.connectedBy.issuer},
      ${now}::timestamptz, ${now}::timestamptz
    )
    ON CONFLICT (tenant_id, account_email) DO UPDATE SET
      mode = 'composio_proxy',
      google_sub = NULL,
      access_token_ciphertext = NULL, access_token_expires_at = NULL,
      refresh_token_ciphertext = NULL, refresh_token_expires_at = NULL,
      granted_scopes = '{}',
      composio_connected_account_id = EXCLUDED.composio_connected_account_id,
      composio_user_id = EXCLUDED.composio_user_id,
      composio_toolkit = EXCLUDED.composio_toolkit,
      status = 'active', reauth_reason = NULL, reauth_at = NULL,
      connected_by_subject = EXCLUDED.connected_by_subject,
      connected_by_issuer = EXCLUDED.connected_by_issuer,
      token_version = google_oauth_grants.token_version + 1,
      updated_at = EXCLUDED.updated_at
  `);
}

export interface GoogleComposioCredential {
  kind: "composio_proxy";
  connectedAccountId: string;
  toolkit: GoogleComposioToolkit;
  userId: string;
  scopes: string[];
}

/** Composio v3 proxy execute. Upstream status/headers (incl. Retry-After) pass through; binaries stay bytes. */
export async function fetchGoogleApiViaComposio(
  credential: GoogleComposioCredential,
  url: string,
  options: RequestInit = {},
  deps: ComposioDeps = {},
): Promise<Response> {
  const config = requireComposio(deps);
  const body = requestBodyAsJson(options.body);
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(`${config.apiBaseUrl}${PROXY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify({
      connected_account_id: credential.connectedAccountId,
      endpoint: url,
      method: options.method ?? "GET",
      ...(body === undefined ? {} : { body }),
      parameters: requestHeadersAsComposioParameters(options.headers),
    }),
    signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
  });

  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const headers = new Headers({ "Content-Type": "application/json" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(JSON.stringify(data ?? { error: "composio_proxy_failed" }), { status: response.status, headers });
  }

  const upstreamStatus = typeof data?.status === "number" ? data.status : response.status;
  const upstreamHeaders = responseHeadersFromComposio(data?.headers);
  const binaryDownloadUrl = isRecord(data?.binary_data) ? stringField(data.binary_data, "url") : null;
  if (binaryDownloadUrl) {
    const binaryResponse = await doFetch(binaryDownloadUrl);
    return new Response(binaryResponse.body, { status: binaryResponse.status, headers: binaryResponse.headers });
  }
  return new Response(JSON.stringify(data?.data ?? data ?? {}), { status: upstreamStatus, headers: upstreamHeaders });
}

export async function revokeGoogleComposioAccount(connectedAccountId: string, deps: ComposioDeps = {}): Promise<boolean> {
  const config = requireComposio(deps);
  const res = await (deps.fetch ?? fetch)(`${config.apiBaseUrl}${ACCOUNT_PATH}${encodeURIComponent(connectedAccountId)}`, {
    method: "DELETE",
    headers: { "x-api-key": config.apiKey },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  await res.text().catch(() => "");
  return res.ok || res.status === 404;
}

/** Composio grants for a tenant (used by revoke + status). */
export async function composioGrantAccountId(tenantId: string, email: string, deps: GoogleAuthDeps = {}): Promise<string | null> {
  const db = deps.db ?? (defaultDb as unknown as GoogleAuthDb);
  const rows = rowsOf<{ composio_connected_account_id: string | null }>(await db.execute(sql`
    SELECT composio_connected_account_id FROM google_oauth_grants
    WHERE tenant_id = ${tenantId} AND account_email = ${email.trim().toLowerCase()} AND mode = 'composio_proxy'
  `));
  return rows[0]?.composio_connected_account_id ?? null;
}

function requestBodyAsJson(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  return body;
}

function requestHeadersAsComposioParameters(headers: HeadersInit | undefined): Array<{ name: string; value: string; type: "header" }> {
  if (!headers) return [];
  let entries: Array<[string, string]>;
  if (headers instanceof Headers) {
    entries = [];
    headers.forEach((value, name) => entries.push([name, value]));
  } else {
    entries = Array.isArray(headers) ? (headers as Array<[string, string]>) : Object.entries(headers);
  }
  return entries
    .filter(([name]) => name.toLowerCase() !== "authorization")
    .map(([name, value]) => ({ name, value: String(value), type: "header" as const }));
}

function responseHeadersFromComposio(value: unknown): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (!isRecord(value)) return headers;
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") headers.set(name, headerValue);
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return headers;
}

function stringField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
