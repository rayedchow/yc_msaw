import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db/client.js";
import { env } from "../../env.js";
import { zoomTransport } from "./client.js";

// Ported from askshepherd/aqueduct c7e1415 src/integrations/zoom/oauth.ts (user-managed General OAuth app,
// rotating refresh tokens). SOURCE-LANE PATCH (coordinator): the signed state is also recorded (sha256 only) in
// zoom_oauth_states and consumed atomically, so a state is single-use and bound to the tenant (and principal)
// that started the flow; the donor accepted any unexpired signed state any number of times.

type Executor = Pick<typeof defaultDb, "execute">;
const STATE_TTL_MS = 10 * 60 * 1000;
const SCOPES = [
  "cloud_recording:read:list_user_recordings",
  "cloud_recording:read:list_recording_files",
  "meeting:read:list_past_participants",
].join(" ");

export type ZoomOAuthTokens = { access_token: string; refresh_token: string; expires_in: number; scope?: string; token_type?: string };

const cfg = () => ({
  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  redirect: process.env.ZOOM_REDIRECT_URI ?? ((process.env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL) ? `${(process.env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL)!.replace(/\/+$/u, "")}/auth/zoom/callback` : null),
});

export function zoomRedirectUri(): string | null {
  return cfg().redirect;
}

export function isZoomOAuthConfigured(): boolean {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret && c.redirect);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createZoomOAuthState(tenantId: string, subject: string | null, ex: Executor = defaultDb): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ tenantId, nonce: randomUUID(), expiresAt: Date.now() + STATE_TTL_MS })).toString("base64url");
  const signature = createHmac("sha256", env.ENCRYPTION_KEY).update(payload).digest("base64url");
  const state = `v1.${payload}.${signature}`;
  await ex.execute(sql`
    INSERT INTO zoom_oauth_states (state_sha256, tenant_id, principal_subject, expires_at)
    VALUES (${sha(state)}, ${tenantId}, ${subject}, ${new Date(Date.now() + STATE_TTL_MS).toISOString()}::timestamptz)
  `);
  return state;
}

/** Verify the signature, then consume the recorded state exactly once. */
export async function consumeZoomOAuthState(state: string, ex: Executor = defaultDb): Promise<{ tenantId: string } | null> {
  const [version, payload, signature, ...extra] = state.split(".");
  if (version !== "v1" || !payload || !signature || extra.length) return null;
  const expected = createHmac("sha256", env.ENCRYPTION_KEY).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let tenantId: string;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { tenantId?: unknown; expiresAt?: unknown };
    if (typeof value.tenantId !== "string" || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) return null;
    tenantId = value.tenantId;
  } catch {
    return null;
  }
  const r = await ex.execute(sql`
    UPDATE zoom_oauth_states SET consumed_at = now()
    WHERE state_sha256 = ${sha(state)} AND tenant_id = ${tenantId} AND consumed_at IS NULL AND expires_at > now()
    RETURNING tenant_id
  `);
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return rows.length ? { tenantId } : null;
}

export async function buildZoomOAuthUrl(tenantId: string, subject: string | null, ex: Executor = defaultDb): Promise<string> {
  if (!isZoomOAuthConfigured()) throw new Error("Zoom OAuth is not configured");
  const c = cfg();
  const params = new URLSearchParams({ response_type: "code", client_id: c.clientId!, redirect_uri: c.redirect!, state: await createZoomOAuthState(tenantId, subject, ex), scope: SCOPES });
  return `https://zoom.us/oauth/authorize?${params}`;
}

async function tokenRequest(body: URLSearchParams): Promise<ZoomOAuthTokens> {
  const c = cfg();
  const response = await zoomTransport()("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Zoom OAuth failed (${response.status}): ${text.slice(0, 300)}`), { status: response.status });
  return JSON.parse(text) as ZoomOAuthTokens;
}

export function exchangeZoomOAuthCode(code: string): Promise<ZoomOAuthTokens> {
  return tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: zoomRedirectUri()! }));
}

export function refreshZoomOAuthToken(refreshToken: string): Promise<ZoomOAuthTokens> {
  return tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
}

/** Best-effort revocation at Zoom on disconnect. */
export async function revokeZoomToken(token: string): Promise<void> {
  const c = cfg();
  await zoomTransport()(`https://zoom.us/oauth/revoke?${new URLSearchParams({ token })}`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}` },
    redirect: "error",
  }).catch(() => undefined);
}
