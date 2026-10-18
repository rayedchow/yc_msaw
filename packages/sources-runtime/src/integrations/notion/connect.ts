import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { startNotionPolling } from "../../queue/dispatch.js";
import { enqueueTask } from "../../queue/queue.js";
import { env } from "../../env.js";
import type { ConnectResult } from "../types.js";
import { storeToken } from "../../vault/tokens.js";
import { notionApiWithToken } from "./client.js";

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_VERSION = "v1";
const STATE_PROVIDER = "notion";

interface NotionConnectResult {
  success: boolean;
  botId?: string;
  workspaceId?: string;
  workspaceName?: string;
  error?: string;
}

type NotionOwner =
  | {
      type?: "user";
      user?: {
        id?: string;
        name?: string | null;
        person?: { email?: string | null };
      };
    }
  | {
      type?: "workspace";
      workspace?: boolean;
    };

type NotionOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_icon?: string | null;
  owner?: NotionOwner;
  duplicated_template_id?: string | null;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export function isNotionOAuthConfigured(): boolean {
  return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET && notionRedirectUri());
}

export function createNotionOAuthState(userId: string): string {
  const payload = Buffer.from(JSON.stringify({
    provider: STATE_PROVIDER,
    userId,
    nonce: randomUUID(),
    expiresAt: Date.now() + STATE_TTL_MS,
  })).toString("base64url");
  return `${STATE_VERSION}.${payload}.${signNotionOAuthState(payload)}`;
}

export function validateNotionOAuthState(state: string): { userId: string } | null {
  const [version, payload, signature, ...extra] = state.split(".");
  if (version !== STATE_VERSION || !payload || !signature || extra.length > 0) return null;
  if (!timingSafeStringEqual(signature, signNotionOAuthState(payload))) return null;

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

export function buildNotionOAuthUrl(userId: string): string {
  if (!isNotionOAuthConfigured()) {
    throw new Error("Notion OAuth is not configured. Set NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, and WEBHOOK_BASE_URL or NOTION_REDIRECT_URI.");
  }
  const params = new URLSearchParams({
    client_id: env.NOTION_CLIENT_ID!,
    redirect_uri: notionRedirectUri()!,
    response_type: "code",
    owner: "user",
    state: createNotionOAuthState(userId),
  });
  return `${NOTION_AUTHORIZE_URL}?${params.toString()}`;
}

export async function connectNotion(input: { tenantId: string; body: unknown }): Promise<ConnectResult> {
  if (!isRecord(input.body)) {
    return { status: 400, body: { error: "invalid Notion connect body" } };
  }

  if (input.body.mode === "oauth") {
    try {
      const authorizeUrl = buildNotionOAuthUrl(input.tenantId);
      return { status: 200, body: { authorizeUrl } };
    } catch {
      return { status: 500, body: { error: "Notion OAuth authorization failed" } };
    }
  }

  if (input.body.mode !== "token" || typeof input.body.accessToken !== "string" || !input.body.accessToken.trim()) {
    return { status: 400, body: { error: "invalid Notion connect body" } };
  }

  try {
    const connected = await connectNotionWithToken(input.tenantId, input.body.accessToken);
    if (!connected.success) {
      return { status: 400, body: { error: connected.error ?? "Notion token validation failed" } };
    }
    return { status: 200, body: { provider: "notion", status: "active" } };
  } catch {
    return { status: 500, body: { error: "Notion connection failed" } };
  }
}

export async function exchangeNotionOAuthCode(code: string): Promise<NotionOAuthTokenResponse> {
  if (!isNotionOAuthConfigured()) {
    throw new Error("Notion OAuth is not configured.");
  }

  const res = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: notionRedirectUri(),
    }),
  });

  const data = await res.json() as NotionOAuthTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(`Notion OAuth failed: ${data.error_description ?? data.error ?? res.statusText}`);
  }
  if (!data.access_token) {
    throw new Error("Notion OAuth did not return an access token.");
  }
  return data;
}

export async function connectNotionWithOAuthToken(
  userId: string,
  tokenData: NotionOAuthTokenResponse,
  opts: { startIngestion?: boolean } = {},
): Promise<NotionConnectResult> {
  if (!tokenData.access_token) return { success: false, error: "Notion OAuth did not return an access token." };
  try {
    const ingestionStartRequestedAt = (opts.startIngestion ?? true) ? new Date().toISOString() : null;
    await storeToken(userId, "notion", tokenData.access_token, {
      auth_mode: "oauth",
      token_type: tokenData.token_type ?? "bearer",
      botId: tokenData.bot_id ?? null,
      workspaceId: tokenData.workspace_id ?? null,
      workspaceName: tokenData.workspace_name ?? null,
      workspaceIcon: tokenData.workspace_icon ?? null,
      duplicatedTemplateId: tokenData.duplicated_template_id ?? null,
      owner: ownerMetadata(tokenData.owner),
      expires_at: typeof tokenData.expires_in === "number" ? Date.now() + tokenData.expires_in * 1000 : null,
      connected_at: new Date().toISOString(),
      ingestionStartRequestedAt,
    }, tokenData.refresh_token);

    await upsertConnection({
      tenantId: userId,
      provider: "notion",
      externalAccountId: tokenData.workspace_id,
      status: "active",
      metadata: { authMode: "oauth" },
    });

    if (opts.startIngestion ?? true) {
      await scheduleNotionIngestion(userId);
    }
    await ensureDefaultKbForTenant(db, userId);

    return {
      success: true,
      botId: tokenData.bot_id,
      workspaceId: tokenData.workspace_id,
      workspaceName: tokenData.workspace_name,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function connectNotionWithToken(
  userId: string,
  accessToken: string,
): Promise<NotionConnectResult> {
  const token = accessToken.trim();
  if (!token) return { success: false, error: "Notion accessToken is required" };

  try {
    const bot = await validateNotionToken(token);
    await storeToken(userId, "notion", token, {
      auth_mode: "manual_token",
      botId: bot.id,
      botName: bot.name ?? null,
      workspaceId: bot.bot?.workspace_id ?? null,
      workspaceName: bot.bot?.workspace_name ?? null,
      connected_at: new Date().toISOString(),
      ingestionStartRequestedAt: new Date().toISOString(),
    });

    await upsertConnection({
      tenantId: userId,
      provider: "notion",
      externalAccountId: bot.bot?.workspace_id ?? undefined,
      status: "active",
      metadata: { authMode: "manual_token" },
    });

    await scheduleNotionIngestion(userId);
    await ensureDefaultKbForTenant(db, userId);

    return {
      success: true,
      botId: bot.id,
      workspaceId: bot.bot?.workspace_id ?? undefined,
      workspaceName: bot.bot?.workspace_name ?? undefined,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scheduleNotionIngestion(userId: string): Promise<void> {
  await startNotionPolling(userId);
  await enqueueTask({
    queue: "backfill",
    tenantId: userId,
    kind: "notion.backfill",
    payload: { userId, days: null, maxPages: null },
    groupKey: `${userId}:notion`,
    dedupeKey: `${userId}:notion:backfill:initial`,
  });
}

async function validateNotionToken(token: string): Promise<{
  id: string;
  name?: string | null;
  bot?: { workspace_id?: string | null; workspace_name?: string | null };
}> {
  return notionApiWithToken<{
    id: string;
    name?: string | null;
    bot?: { workspace_id?: string | null; workspace_name?: string | null };
  }>(token, "/users/me");
}

function notionRedirectUri(): string | null {
  if (env.NOTION_REDIRECT_URI) return env.NOTION_REDIRECT_URI;
  if (!env.WEBHOOK_BASE_URL) return null;
  return `${env.WEBHOOK_BASE_URL}/auth/notion/callback`;
}

function ownerMetadata(owner: NotionOwner | undefined): Record<string, unknown> | null {
  if (!owner) return null;
  if (owner.type === "user" && owner.user) {
    return {
      type: "user",
      id: owner.user.id ?? null,
      name: owner.user.name ?? null,
      email: owner.user.person?.email ?? null,
    };
  }
  if (owner.type === "workspace") {
    return { type: "workspace", workspace: true };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signNotionOAuthState(payload: string): string {
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
