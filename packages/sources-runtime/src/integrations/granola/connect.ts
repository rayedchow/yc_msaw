import { db } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { enqueueTask } from "../../queue/queue.js";
import { startGranolaPolling } from "../../queue/dispatch.js";
import type { ConnectResult } from "../types.js";
import { getTokenMetadata, storeToken } from "../../vault/tokens.js";
import { listGranolaNotes } from "./poller.js";
import {
  buildGranolaOAuthUrl,
  exchangeGranolaOAuthCode,
  granolaOAuthTokenMetadata,
  isGranolaOAuthConfigured,
  type GranolaOAuthTokenResponse,
} from "./oauth.js";
import { listGranolaNotesViaMcp } from "./mcp-client.js";

export interface ConnectGranolaOptions {
  includeTranscript?: boolean;
  folderId?: string;
  startIngestion?: boolean;
}

export async function connectGranola(input: { tenantId: string; body: unknown }): Promise<ConnectResult> {
  if (!isRecord(input.body)) {
    return { status: 400, body: { error: "invalid Granola connect body" } };
  }

  const mode = input.body.mode === undefined && typeof input.body.apiKey === "string" ? "api_key" : input.body.mode;
  if (mode === "oauth") {
    try {
      const authorizeUrl = await buildGranolaOAuthUrl(input.tenantId);
      return { status: 200, body: { authorizeUrl } };
    } catch {
      return { status: 500, body: { error: "Granola OAuth authorization failed" } };
    }
  }

  if (mode !== "api_key" || typeof input.body.apiKey !== "string") {
    return { status: 400, body: { error: "invalid Granola connect body" } };
  }

  const options = granolaApiKeyConnectOptions(input.body);
  if (!options.ok) {
    return { status: 400, body: { error: "invalid Granola connect body" } };
  }

  try {
    const connected = await connectGranolaWithToken(input.tenantId, input.body.apiKey, options.value);
    if (!connected.success) {
      return { status: 400, body: { error: connected.error ?? "Granola API key validation failed" } };
    }
    return { status: 200, body: { provider: "granola", status: "active" } };
  } catch {
    return { status: 500, body: { error: "Granola connection failed" } };
  }
}

export async function connectGranolaWithToken(
  userId: string,
  apiKey: string,
  opts: ConnectGranolaOptions = {},
): Promise<{
  success: boolean;
  error?: string;
  hasMore?: boolean;
}> {
  const token = apiKey.trim();
  if (!token) return { success: false, error: "granolaApiKey is required" };

  const existingMetadata = await getTokenMetadata(userId, "granola");
  const firstTimeConnect = !hasGranolaWatermark(existingMetadata);
  const includeTranscript = resolveIncludeTranscript(existingMetadata, opts);
  const folderId = resolveFolderId(existingMetadata, opts);

  let preview: Awaited<ReturnType<typeof listGranolaNotes>>;
  try {
    preview = await listGranolaNotes(token, {
      folderId: folderId ?? undefined,
      pageSize: 1,
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return storeGranolaApiKeyConnection(userId, token, {
    existingMetadata,
    firstTimeConnect,
    includeTranscript,
    folderId,
    previewHasMore: preview.hasMore,
    startIngestion: opts.startIngestion,
  });
}

async function storeGranolaApiKeyConnection(
  userId: string,
  token: string,
  input: {
    existingMetadata: Record<string, unknown> | null;
    firstTimeConnect: boolean;
    includeTranscript: boolean;
    folderId: string | null;
    previewHasMore: boolean;
    startIngestion?: boolean;
  },
): Promise<{ success: boolean; hasMore?: boolean }> {
  const now = new Date().toISOString();
  await storeToken(userId, "granola", token, {
    ...(input.existingMetadata ?? {}),
    auth_mode: "api_key",
    connectedAt: stringMetadata(input.existingMetadata?.connectedAt) ?? now,
    includeTranscript: input.includeTranscript,
    folderId: input.folderId,
    lastUpdatedAt: stringMetadata(input.existingMetadata?.lastUpdatedAt) ?? now,
    previewHasMore: input.previewHasMore,
  });

  await finishGranolaConnection(userId, "api_key", input.firstTimeConnect, input.startIngestion);

  return {
    success: true,
    hasMore: input.previewHasMore,
  };
}

export async function connectGranolaWithOAuthToken(
  userId: string,
  tokenData: GranolaOAuthTokenResponse,
  opts: ConnectGranolaOptions & {
    clientId?: string;
    tokenEndpointAuthMethod?: "none" | "client_secret_post";
  } = {},
): Promise<{
  success: boolean;
  error?: string;
  hasMore?: boolean;
}> {
  if (!tokenData.access_token) return { success: false, error: "Granola OAuth did not return an access token." };
  const clientId = opts.clientId?.trim();
  if (!clientId) return { success: false, error: "Granola OAuth client metadata is missing." };

  const existingMetadata = await getTokenMetadata(userId, "granola");
  const firstTimeConnect = !hasGranolaWatermark(existingMetadata);
  const includeTranscript = resolveIncludeTranscript(existingMetadata, opts);
  const folderId = resolveFolderId(existingMetadata, opts);
  const client = {
    clientId,
    clientSecret: null,
    tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod ?? "none",
  } as const;
  const metadata = granolaOAuthTokenMetadata({
    tokenData,
    existing: existingMetadata,
    client,
    includeTranscript,
    folderId,
    previewHasMore: false,
  });

  await storeToken(userId, "granola", tokenData.access_token, metadata, tokenData.refresh_token);

  let previewHasMore = false;
  try {
    const preview = await listGranolaNotesViaMcp(tokenData.access_token, {
      folderId: folderId ?? undefined,
      pageSize: 1,
    });
    previewHasMore = preview.hasMore;
  } catch {
    console.warn("[granola] OAuth token stored but MCP preview failed; polling will retry later.");
  }

  if (previewHasMore) {
    await storeToken(userId, "granola", tokenData.access_token, granolaOAuthTokenMetadata({
      tokenData,
      existing: metadata,
      client,
      includeTranscript,
      folderId,
      previewHasMore,
    }), tokenData.refresh_token);
  }

  await finishGranolaConnection(userId, "oauth_mcp", firstTimeConnect, opts.startIngestion);

  return {
    success: true,
    hasMore: previewHasMore,
  };
}

function resolveIncludeTranscript(
  existingMetadata: Record<string, unknown> | null,
  opts: ConnectGranolaOptions,
): boolean {
  if (opts.includeTranscript !== undefined) return opts.includeTranscript;
  return typeof existingMetadata?.includeTranscript === "boolean"
    ? existingMetadata.includeTranscript
    : true;
}

function resolveFolderId(
  existingMetadata: Record<string, unknown> | null,
  opts: ConnectGranolaOptions,
): string | null {
  if (opts.folderId !== undefined) return opts.folderId;
  return typeof existingMetadata?.folderId === "string" ? existingMetadata.folderId : null;
}

function hasGranolaWatermark(metadata: Record<string, unknown> | null): boolean {
  return typeof metadata?.lastUpdatedAt === "string" && metadata.lastUpdatedAt.trim().length > 0;
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function granolaApiKeyConnectOptions(
  body: Record<string, unknown>,
): { ok: true; value: { folderId?: string; includeTranscript?: boolean } } | { ok: false } {
  const value: { folderId?: string; includeTranscript?: boolean } = {};
  if (body.folderId !== undefined) {
    if (typeof body.folderId !== "string" || !body.folderId.trim()) return { ok: false };
    value.folderId = body.folderId.trim();
  }
  if (body.includeTranscript !== undefined) {
    if (typeof body.includeTranscript !== "boolean") return { ok: false };
    value.includeTranscript = body.includeTranscript;
  }
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function finishGranolaConnection(
  tenantId: string,
  authMode: "api_key" | "oauth_mcp",
  firstTimeConnect: boolean,
  startIngestion = true,
): Promise<void> {
  await upsertConnection({
    tenantId,
    provider: "granola",
    externalAccountId: undefined,
    status: "active",
    metadata: { authMode },
  });
  await ensureDefaultKbForTenant(db, tenantId);

  if (!startIngestion) return;
  await startGranolaPolling(tenantId);
  if (firstTimeConnect) {
    await enqueueTask({
      queue: "backfill",
      tenantId,
      kind: "granola.backfill",
      payload: { tenantId },
      groupKey: `${tenantId}:granola`,
      dedupeKey: `${tenantId}:granola:backfill:initial`,
    });
  }
}

export {
  buildGranolaOAuthUrl,
  exchangeGranolaOAuthCode,
  isGranolaOAuthConfigured,
};
