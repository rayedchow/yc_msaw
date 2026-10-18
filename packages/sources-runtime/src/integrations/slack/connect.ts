import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { env } from "../../env.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { startSlackPolling } from "../../queue/dispatch.js";
import { enqueueTask } from "../../queue/queue.js";
import type { ConnectResult } from "../types.js";
import { getTokenMetadata, storeToken } from "../../vault/tokens.js";

const SLACK_USER_SCOPES = [
  "team:read",
  "users:read",
  "users:read.email",
  "users.profile:read",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "mpim:read",
  "mpim:history",
  "im:read",
  "im:history",
  "reactions:read",
  "files:read",
].join(",");

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_VERSION = "v1";
const STATE_PROVIDER = "slack";

interface SlackConnectResult {
  success: boolean;
  teamName?: string;
  slackUserId?: string;
  slackTeamId?: string;
  error?: string;
}

type SlackOAuthResponse =
  | {
      ok: true;
      authed_user: { access_token: string; id: string };
      team: { id: string; name: string };
    }
  | { ok: false; error: string };

type SlackAuthTestResponse =
  | {
      ok: true;
      user_id: string;
      team_id: string;
      team: string;
    }
  | { ok: false; error: string };

export function getSlackOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export function isSlackOAuthConfigured(): boolean {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && slackRedirectUri());
}

export function createSlackOAuthState(userId: string): string {
  const payload = Buffer.from(JSON.stringify({
    provider: STATE_PROVIDER,
    userId,
    nonce: randomUUID(),
    expiresAt: Date.now() + STATE_TTL_MS,
  })).toString("base64url");
  return `${STATE_VERSION}.${payload}.${signSlackOAuthState(payload)}`;
}

export function validateSlackOAuthState(state: string): { userId: string } | null {
  const [version, payload, signature, ...extra] = state.split(".");
  if (version !== STATE_VERSION || !payload || !signature || extra.length > 0) return null;
  if (!timingSafeStringEqual(signature, signSlackOAuthState(payload))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const data = decoded as { provider?: unknown; userId?: unknown; expiresAt?: unknown };
  if (data.provider !== STATE_PROVIDER) return null;
  if (typeof data.userId !== "string" || !data.userId) return null;
  if (typeof data.expiresAt !== "number" || data.expiresAt < Date.now()) return null;
  return { userId: data.userId };
}

export function buildSlackOAuthUrl(userId: string): string {
  if (!isSlackOAuthConfigured()) {
    throw new Error("Slack OAuth is not configured. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and WEBHOOK_BASE_URL or SLACK_REDIRECT_URI.");
  }
  return getSlackOAuthUrl(env.SLACK_CLIENT_ID!, slackRedirectUri()!, createSlackOAuthState(userId));
}

export async function connectSlack(input: { tenantId: string; body: unknown }): Promise<ConnectResult> {
  if (!isRecord(input.body) || input.body.mode !== "oauth") {
    return { status: 400, body: { error: "invalid Slack connect body" } };
  }

  try {
    return { status: 200, body: { authorizeUrl: buildSlackOAuthUrl(input.tenantId) } };
  } catch {
    return { status: 500, body: { error: "Slack OAuth authorization failed" } };
  }
}

export async function exchangeSlackOAuthCode(
  code: string,
): Promise<{ token: string; userId: string; teamId: string; teamName: string }> {
  if (!isSlackOAuthConfigured()) {
    throw new Error("Slack OAuth is not configured.");
  }
  return exchangeSlackCode(env.SLACK_CLIENT_ID!, env.SLACK_CLIENT_SECRET!, code, slackRedirectUri()!);
}

export async function exchangeSlackCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ token: string; userId: string; teamId: string; teamName: string }> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json() as SlackOAuthResponse;
  if (!data.ok) {
    throw new Error(`Slack OAuth failed: ${data.error}`);
  }

  return {
    token: data.authed_user.access_token,
    userId: data.authed_user.id,
    teamId: data.team.id,
    teamName: data.team.name,
  };
}

export async function connectSlackWithToken(
  userId: string,
  slackToken: string,
): Promise<SlackConnectResult> {
  // Validate the token
  const res = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${slackToken}` },
  });
  const data = await res.json() as SlackAuthTestResponse;

  if (!data.ok) {
    return { success: false, error: `Invalid Slack token: ${data.error}` };
  }

  // Workspace lock: an existing (non-revoked) Slack connection pins the team.
  // Silently switching workspaces would corrupt per-channel watermarks and raw
  // continuity, so a different team id is a hard reject. The token metadata
  // check covers the common path; the connections-row check covers rows whose
  // token was lost (external_account_id is the Slack team id by convention).
  const existingMetadata = await getTokenMetadata(userId, "slack");
  const storedTeamId = stringMetadata(existingMetadata?.slackTeamId) ?? await activeSlackConnectionTeamId(userId);
  if (storedTeamId && storedTeamId !== data.team_id) {
    return {
      success: false,
      error: "Slack is already connected to a different workspace. Disconnect it before connecting another workspace.",
    };
  }

  await storeToken(userId, "slack", slackToken, {
    ...(existingMetadata ?? {}),
    auth_mode: "user_oauth",
    slackUserId: data.user_id,
    slackTeamId: data.team_id,
    teamName: data.team,
    connected_at: stringMetadata(existingMetadata?.connected_at) ?? new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
  });

  await upsertConnection({
    tenantId: userId,
    provider: "slack",
    externalAccountId: data.team_id,
    status: "active",
    metadata: {
      authMode: "user_oauth",
      slackUserId: data.user_id,
      slackTeamId: data.team_id,
      teamName: data.team,
    },
  });

  await startSlackPolling(userId);
  await enqueueTask({
    queue: "sync",
    tenantId: userId,
    kind: "slack.discover",
    payload: { tenantId: userId },
    groupKey: `${userId}:slack`,
    dedupeKey: `${userId}:slack:discover:initial`,
  });
  await ensureDefaultKbForTenant(db, userId);

  return {
    success: true,
    teamName: data.team,
    slackUserId: data.user_id,
    slackTeamId: data.team_id,
  };
}

async function activeSlackConnectionTeamId(userId: string): Promise<string | null> {
  const rows = rowsFromExecute<{ external_account_id: string | null; slack_team_id: string | null }>(await db.execute(sql`
    SELECT external_account_id, metadata->>'slackTeamId' AS slack_team_id
    FROM connections
    WHERE tenant_id = ${userId}
      AND provider = 'slack'
      AND status <> 'revoked'
    ORDER BY updated_at DESC
    LIMIT 1
  `));
  const row = rows[0];
  if (!row) return null;
  return stringMetadata(row.external_account_id) ?? stringMetadata(row.slack_team_id);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function slackRedirectUri(): string | null {
  if (env.SLACK_REDIRECT_URI) return env.SLACK_REDIRECT_URI;
  if (!env.WEBHOOK_BASE_URL) return null;
  return `${env.WEBHOOK_BASE_URL.replace(/\/+$/, "")}/auth/slack/callback`;
}

function signSlackOAuthState(payload: string): string {
  return createHmac("sha256", env.ENCRYPTION_KEY)
    .update(`${STATE_VERSION}.${payload}`)
    .digest("base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
