import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { connectGoogleOAuthAccount, connectGoogleWorkspace, disconnectGoogleAccount } from "../../../integrations/google/connect.js";
import { oauthCallbackPage } from "../../../routes/callback-page.js";
import { completeGoogleComposioCallback, GOOGLE_COMPOSIO_CALLBACK_PATH, startGoogleComposioAuthorization } from "../../../vault/google-composio.js";
import { GoogleDwdNotApprovedError } from "../../../vault/google-dwd-policy.js";
import {
  assertGoogleAuthTenant,
  completeGoogleOAuthCallback,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_LAUNCH_PATH,
  GoogleOAuthError,
  launchGoogleAuthorization,
  startGoogleOAuthAuthorization,
  startGoogleOwnershipProof,
  type GoogleAuthPrincipal,
  type GoogleConnectedAccount,
} from "../../../vault/google-oauth.js";
import { sha256Hex } from "../../../vault/google-grant-crypto.js";
import { db } from "../../../db/client.js";
import type { DbExecutor, InternalRouteDeps } from "../../core/types.js";
import { googleAttributionFor } from "./attribution.js";
import { googleAuthStatus } from "./status.js";

/**
 * Google provider-grant setup routes.
 *
 * Internal (yc_msaw -> runtime, mounted by core under /internal/v1 behind the
 * service token): the tenant comes from deps.tenantOf (core's middleware already
 * checked it equals the forwarded principal's tenantNs); the initiating principal
 * is the one core's middleware parsed from `x-procmem-principal` (c.get("principal")),
 * or deps.principalOf. Its scopes must be forwarded too: admin actions need
 * memory:build and status needs memory:read, and a principal without forwarded
 * scopes is refused (fail closed; see patch-requests/google-auth.md).
 *
 * Public (browser): launch + callbacks. They authenticate with the single-use
 * state, the browser-binding cookie set at launch, PKCE/nonce (direct) or a
 * server-side Composio account check. They never create a yc_msaw session and
 * never read a tenant from the query.
 */

/** Shape of core's verified forwarded principal (internal/app.ts ForwardedPrincipal) plus requested `scopes`. */
export interface GoogleAuthForwardedPrincipal {
  tenantNs?: string;
  subject: string;
  issuer: string;
  email?: string | null;
  scopes?: readonly string[];
}

export interface GoogleAuthInternalDeps extends InternalRouteDeps {
  principalOf?(c: Context): GoogleAuthForwardedPrincipal | null;
}

const SCOPE_BUILD = "memory:build";
const SCOPE_READ = "memory:read";

/**
 * Scopes from the same `x-procmem-principal` header core's middleware already
 * authenticated (service token + tenant match). Core's parser keeps only identity
 * fields, so the scope list is read here, and only when its identity matches.
 */
function forwardedScopes(c: Context, principal: GoogleAuthForwardedPrincipal): readonly string[] | null {
  if (Array.isArray(principal.scopes)) return principal.scopes;
  try {
    const raw = JSON.parse(c.req.header("x-procmem-principal") ?? "") as Record<string, unknown>;
    if (raw.subject !== principal.subject || raw.issuer !== principal.issuer) return null;
    if (principal.tenantNs !== undefined && raw.tenantNs !== principal.tenantNs) return null;
    return Array.isArray(raw.scopes) && raw.scopes.every((v) => typeof v === "string") ? (raw.scopes as string[]) : null;
  } catch {
    return null;
  }
}

function principalFor(c: Context, deps: GoogleAuthInternalDeps, scope: string): GoogleAuthPrincipal | Response {
  const principal = deps.principalOf ? deps.principalOf(c) : ((c.get("principal" as never) as GoogleAuthForwardedPrincipal | undefined) ?? null);
  if (!principal || typeof principal.subject !== "string" || !principal.subject || typeof principal.issuer !== "string") {
    return c.json({ error: "A verified yc_msaw principal is required", code: "principal_required" }, 401);
  }
  const scopes = forwardedScopes(c, principal);
  if (!scopes || !scopes.includes(scope)) {
    return c.json({ error: `Missing scope ${scope} on the forwarded principal`, code: "insufficient_scope" }, 403);
  }
  return { subject: principal.subject, issuer: principal.issuer, email: principal.email ?? null };
}

function tenantFor(c: Context, deps: GoogleAuthInternalDeps): string {
  return assertGoogleAuthTenant(deps.tenantOf(c));
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > 16 * 1024) throw new GoogleOAuthError("Request body too large", { code: "invalid_request", status: 413 });
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new GoogleOAuthError("Body must be a JSON object", { code: "invalid_request", status: 400 });
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof GoogleOAuthError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  if (err instanceof GoogleDwdNotApprovedError) return c.json({ error: err.message, code: err.code }, 403);
  console.error("google-auth route failed:", err instanceof Error ? err.name : "error");
  return c.json({ error: "Google auth request failed", code: "internal_error" }, 500);
}

export function registerGoogleAuthInternalRoutes(app: Hono, deps: GoogleAuthInternalDeps): void {
  const base = "/tenants/:tenantId/google/auth";

  app.get(base, async (c) => {
    try {
      const principal = principalFor(c, deps, SCOPE_READ);
      if (principal instanceof Response) return principal;
      return c.json(await googleAuthStatus(tenantFor(c, deps)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Body: {broker?: "google" | "composio", capabilities?: [...], account?: "self" | {email}}
  app.post(`${base}/oauth/start`, async (c) => {
    try {
      // Self-service (owner-only sources): a member grants their own account; the callback's expected-account check
      // proves control of the address, and the grant records them as its owner.
      const principal = principalFor(c, deps, SCOPE_READ);
      if (principal instanceof Response) return principal;
      const tenantId = tenantFor(c, deps);
      const body = await readJson(c);
      const broker = body.broker ?? "google";
      if (broker !== "google" && broker !== "composio") {
        throw new GoogleOAuthError('broker must be "google" or "composio"', { code: "invalid_request", status: 400 });
      }
      const input = { tenantId, principal, capabilities: body.capabilities, account: body.account };
      const start = broker === "composio" ? await startGoogleComposioAuthorization(input) : await startGoogleOAuthAuthorization(input);
      return c.json(start, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Owner-only attribution of mailbox-less Google paths (Docs/Drive dirs, Drive PDFs) for the FORWARDED principal only:
  // its proven Google accounts and the units those mailboxes see. yc_msaw asks per viewer; nobody can report it.
  app.get(`${base}/attribution`, async (c) => {
    try {
      const principal = principalFor(c, deps, SCOPE_READ);
      if (principal instanceof Response) return principal;
      c.header("Cache-Control", "no-store");
      return c.json(await googleAttributionFor(tenantFor(c, deps), principal, db as unknown as DbExecutor));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Body: {account?: "self" | {email}}. Identity-only Google sign-in: proves the member controls the address (e.g. a
  // domain-wide-delegation mailbox) and records them as its owner; no data grant, the collection mode is unchanged.
  app.post(`${base}/ownership/start`, async (c) => {
    try {
      const principal = principalFor(c, deps, SCOPE_READ);
      if (principal instanceof Response) return principal;
      const body = await readJson(c);
      return c.json(await startGoogleOwnershipProof({ tenantId: tenantFor(c, deps), principal, account: body.account }), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Body: {email}. The mailbox must be inside the operator-approved DWD allowlist.
  app.post(`${base}/dwd/mailboxes`, async (c) => {
    try {
      const principal = principalFor(c, deps, SCOPE_BUILD);
      if (principal instanceof Response) return principal;
      const tenantId = tenantFor(c, deps);
      const body = await readJson(c);
      const result = await connectGoogleWorkspace({ tenantId, body: { userEmail: body.email } });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete(`${base}/accounts/:email`, async (c) => {
    try {
      const principal = principalFor(c, deps, SCOPE_BUILD);
      if (principal instanceof Response) return principal;
      const result = await disconnectGoogleAccount({ tenantId: tenantFor(c, deps), email: c.req.param("email") ?? "" });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

export function bindingCookieName(state: string): string {
  // __Host-: Secure, Path=/, no Domain - cannot be set or read by sibling hosts.
  return `__Host-pgo_${sha256Hex(state).slice(0, 16)}`;
}

function page(c: Context, input: { title: string; body: string; error?: boolean }, status: number): Response {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  return c.html(oauthCallbackPage({ ...input, autoClose: !input.error }), status as 200);
}

function callbackFailurePage(c: Context, err: unknown): Response {
  const code = err instanceof GoogleOAuthError ? err.code : "error";
  const body = err instanceof GoogleOAuthError && err.code !== "token_exchange_failed" && err.code !== "id_token_invalid"
    ? err.message
    : "Google connection failed. Please start the connection again.";
  console.error("Google OAuth callback rejected:", code);
  return page(c, { title: "Google not connected", body, error: true }, err instanceof GoogleOAuthError && err.status >= 400 && err.status < 500 ? err.status : 400);
}

async function activate(account: GoogleConnectedAccount): Promise<void> {
  const result = await connectGoogleOAuthAccount(account);
  if (result.status !== 200) throw new GoogleOAuthError("Google account could not be activated", { code: "invalid_request", status: 500 });
}

function successBody(account: GoogleConnectedAccount): string {
  if (account.ownershipProof) return `${account.email} is verified as yours. Its data stays collected the way it was set up; you can close this window.`;
  const partial = account.missingScopes.length
    ? ` Some requested permissions were not granted (${account.missingScopes.length}); those data sources stay blocked until you reconnect and grant them.`
    : "";
  return `${account.email} is connected (${account.mode === "composio_proxy" ? "via Composio" : "Google OAuth"}).${partial} You can close this window.`;
}

export function registerGoogleAuthPublicRoutes(app: Hono): void {
  app.get(GOOGLE_OAUTH_LAUNCH_PATH, async (c) => {
    const state = c.req.query("state");
    try {
      const launch = await launchGoogleAuthorization(state);
      setCookie(c, bindingCookieName(state!), launch.bindingCookie, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: launch.maxAgeSeconds,
      });
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cache-Control", "no-store");
      return c.redirect(launch.redirectUrl, 302);
    } catch (err) {
      return callbackFailurePage(c, err);
    }
  });

  app.get(GOOGLE_OAUTH_CALLBACK_PATH, async (c) => {
    const state = c.req.query("state");
    const cookieName = state ? bindingCookieName(state) : null;
    try {
      const account = await completeGoogleOAuthCallback({
        state,
        code: c.req.query("code"),
        error: c.req.query("error"),
        bindingCookie: cookieName ? getCookie(c, cookieName) : undefined,
      });
      if (account.ownershipProof) return page(c, { title: "Google account verified", body: successBody(account) }, 200);
      await activate(account);
      return page(c, { title: "Google connected", body: successBody(account) }, 200);
    } catch (err) {
      return callbackFailurePage(c, err);
    } finally {
      if (cookieName) deleteCookie(c, cookieName, { path: "/", secure: true });
    }
  });

  app.get(GOOGLE_COMPOSIO_CALLBACK_PATH, async (c) => {
    const state = c.req.query("state");
    const cookieName = state ? bindingCookieName(state) : null;
    try {
      // `status` in the query is ignored; the account is verified with Composio server-side.
      const account = await completeGoogleComposioCallback({
        state,
        connectedAccountId: c.req.query("connected_account_id") ?? c.req.query("connectedAccountId"),
        bindingCookie: cookieName ? getCookie(c, cookieName) : undefined,
      });
      await activate(account);
      return page(c, { title: "Google connected", body: successBody(account) }, 200);
    } catch (err) {
      return callbackFailurePage(c, err);
    } finally {
      if (cookieName) deleteCookie(c, cookieName, { path: "/", secure: true });
    }
  });
}
