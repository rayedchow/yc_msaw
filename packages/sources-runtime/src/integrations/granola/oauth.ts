import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";
import { deleteToken, getTokenFull, storeToken } from "../../vault/tokens.js";

const GRANOLA_AUTH_ISSUER = "https://mcp-auth.granola.ai";
const GRANOLA_AUTHORIZE_URL = `${GRANOLA_AUTH_ISSUER}/oauth2/authorize`;
const GRANOLA_TOKEN_URL = `${GRANOLA_AUTH_ISSUER}/oauth2/token`;
const GRANOLA_REGISTRATION_URL = `${GRANOLA_AUTH_ISSUER}/oauth2/register`;
const GRANOLA_MCP_RESOURCE = "https://mcp.granola.ai/mcp";
const GRANOLA_OAUTH_STATE_PROVIDER = "granola_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const DYNAMIC_CLIENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STATE_VERSION = "v1";
const STATE_PROVIDER = "granola";
const DEFAULT_GRANOLA_SCOPES = "openid profile email offline_access";

export type GranolaOAuthClient = {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_post";
};

export type GranolaOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GranolaOAuthStateMetadata = {
  provider: typeof STATE_PROVIDER;
  userId: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  scope: string;
  resource: string;
  tokenEndpointAuthMethod: GranolaOAuthClient["tokenEndpointAuthMethod"];
  createdAt: string;
};

type LoadedGranolaOAuthState = {
  userId: string;
  codeVerifier: string;
  client: GranolaOAuthClient;
  redirectUri: string;
  scope: string;
};

let dynamicClientCache: { redirectUri: string; client: GranolaOAuthClient; cachedAt: number } | null = null;

export function isGranolaOAuthConfigured(): boolean {
  return Boolean(granolaRedirectUri());
}

export async function buildGranolaOAuthUrl(userId: string): Promise<string> {
  if (!isGranolaOAuthConfigured()) {
    throw new Error("Granola OAuth is not configured. Set WEBHOOK_BASE_URL or GRANOLA_REDIRECT_URI.");
  }

  const redirectUri = granolaRedirectUri()!;
  const client = await granolaOAuthClient(redirectUri);
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const nonce = randomUUID();
  const state = createGranolaOAuthState(nonce);
  const scope = DEFAULT_GRANOLA_SCOPES;

  await storeToken(granolaOAuthStateUserId(nonce), GRANOLA_OAUTH_STATE_PROVIDER, codeVerifier, {
    provider: STATE_PROVIDER,
    userId,
    clientId: client.clientId,
    redirectUri,
    expiresAt: Date.now() + STATE_TTL_MS,
    scope,
    resource: GRANOLA_MCP_RESOURCE,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    createdAt: new Date().toISOString(),
  } satisfies GranolaOAuthStateMetadata, client.clientSecret ?? undefined);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: GRANOLA_MCP_RESOURCE,
  });
  return `${GRANOLA_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeGranolaOAuthCode(
  code: string,
  state: string,
): Promise<{ userId: string; tokenData: GranolaOAuthTokenResponse; client: GranolaOAuthClient }> {
  const loaded = await consumeGranolaOAuthState(state);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: loaded.redirectUri,
    client_id: loaded.client.clientId,
    code_verifier: loaded.codeVerifier,
    resource: GRANOLA_MCP_RESOURCE,
  });
  if (loaded.client.clientSecret && loaded.client.tokenEndpointAuthMethod === "client_secret_post") {
    body.set("client_secret", loaded.client.clientSecret);
  }

  const tokenData = await postGranolaTokenWithDynamicClientRecovery(body, loaded.client.clientId);
  return { userId: loaded.userId, tokenData, client: loaded.client };
}

export async function refreshGranolaOAuthToken(
  userId: string,
  stored: { token: string; refreshToken: string | null; metadata: Record<string, unknown> | null },
): Promise<{ token: string; refreshToken: string | null; metadata: Record<string, unknown> }> {
  if (!stored.refreshToken) {
    throw new Error("Granola OAuth token is expired and no refresh token is available.");
  }
  const metadata = stored.metadata ?? {};
  const clientId = stringMetadata(metadata.client_id) ?? stringMetadata(metadata.clientId);
  if (!clientId) {
    throw new Error("Granola OAuth token is missing client metadata.");
  }
  const clientSecret = env.GRANOLA_CLIENT_ID === clientId ? env.GRANOLA_CLIENT_SECRET ?? null : null;
  const authMethod = stringMetadata(metadata.token_endpoint_auth_method) === "client_secret_post"
    ? "client_secret_post"
    : "none";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: clientId,
    resource: GRANOLA_MCP_RESOURCE,
  });
  if (clientSecret && authMethod === "client_secret_post") body.set("client_secret", clientSecret);

  const tokenData = await postGranolaTokenWithDynamicClientRecovery(body, clientId);
  const nextRefreshToken = tokenData.refresh_token ?? stored.refreshToken;
  const nextMetadata = granolaOAuthTokenMetadata({
    tokenData,
    existing: metadata,
    client: {
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: authMethod,
    },
    ingestionStartRequestedAt: stringMetadata(metadata.ingestionStartRequestedAt) ?? null,
    grant: "refresh",
  });

  await storeToken(userId, "granola", tokenData.access_token!, nextMetadata, nextRefreshToken);
  return { token: tokenData.access_token!, refreshToken: nextRefreshToken, metadata: nextMetadata };
}

export function granolaOAuthTokenMetadata(input: {
  tokenData: GranolaOAuthTokenResponse;
  client: GranolaOAuthClient;
  existing?: Record<string, unknown> | null;
  includeTranscript?: boolean;
  folderId?: string | null;
  previewHasMore?: boolean | null;
  ingestionStartRequestedAt?: string | null;
  /** SOURCE-LANE PATCH (granola): "refresh" keeps the grant's account identity; anything else is a new grant. */
  grant?: "new" | "refresh";
}): Record<string, unknown> {
  if (!input.client.clientId.trim()) {
    throw new Error("Granola OAuth token metadata requires a client id.");
  }
  const now = new Date().toISOString();
  return {
    ...(input.existing ?? {}),
    auth_mode: "oauth_mcp",
    connectedAt: stringMetadata(input.existing?.connectedAt) ?? now,
    connected_at: stringMetadata(input.existing?.connected_at) ?? now,
    includeTranscript: input.includeTranscript ?? input.existing?.includeTranscript ?? true,
    folderId: input.folderId ?? input.existing?.folderId ?? null,
    lastUpdatedAt: stringMetadata(input.existing?.lastUpdatedAt) ?? now,
    previewHasMore: input.previewHasMore ?? input.existing?.previewHasMore ?? false,
    token_type: input.tokenData.token_type ?? input.existing?.token_type ?? "Bearer",
    scope: input.tokenData.scope ?? input.existing?.scope ?? DEFAULT_GRANOLA_SCOPES,
    expires_at: typeof input.tokenData.expires_in === "number"
      ? Date.now() + input.tokenData.expires_in * 1000
      : input.existing?.expires_at ?? null,
    client_id: input.client.clientId,
    token_endpoint_auth_method: input.client.tokenEndpointAuthMethod,
    mcp_resource: GRANOLA_MCP_RESOURCE,
    ingestionStartRequestedAt: input.ingestionStartRequestedAt ?? input.existing?.ingestionStartRequestedAt ?? null,
    // SOURCE-LANE PATCH (granola): account identity from the id_token Granola
    // returned to us directly over TLS (openid scope), so the source lane can
    // tell a reconnect of the same account from a different account. Only the
    // subject and e-mail claims are kept; the id_token itself is not stored.
    ...granolaIdTokenAccount(input.tokenData.id_token, input.grant === "refresh" ? input.existing : null),
    oauth_granted_at: input.grant === "refresh"
      ? stringMetadata(input.existing?.oauth_granted_at) ?? stringMetadata(input.existing?.connectedAt) ?? now
      : now,
  };
}

function granolaIdTokenAccount(
  idToken: string | undefined,
  carriedFrom: Record<string, unknown> | null | undefined,
): { account_subject: string | null; account_email: string | null } {
  const claims = decodeJwtClaims(idToken);
  const subject = typeof claims?.sub === "string" && claims.sub ? claims.sub : null;
  const email = typeof claims?.email === "string" && claims.email ? claims.email : null;
  if (subject) return { account_subject: subject, account_email: email };
  return {
    account_subject: stringMetadata(carriedFrom?.account_subject),
    account_email: stringMetadata(carriedFrom?.account_email),
  };
}

function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isGranolaOAuthTokenMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.auth_mode === "oauth_mcp";
}

export function resetGranolaOAuthClientCacheForTests(): void {
  dynamicClientCache = null;
}

export function granolaOAuthTokenExpiresSoon(metadata: Record<string, unknown> | null | undefined): boolean {
  const expiresAt = typeof metadata?.expires_at === "number" ? metadata.expires_at : null;
  return expiresAt !== null && expiresAt - Date.now() < 60_000;
}

function createGranolaOAuthState(nonce: string): string {
  const payload = Buffer.from(JSON.stringify({
    provider: STATE_PROVIDER,
    nonce,
    expiresAt: Date.now() + STATE_TTL_MS,
  })).toString("base64url");
  return `${STATE_VERSION}.${payload}.${signGranolaOAuthState(payload)}`;
}

async function consumeGranolaOAuthState(state: string): Promise<LoadedGranolaOAuthState> {
  const nonce = validateGranolaOAuthState(state);
  if (!nonce) throw new Error("Invalid or expired Granola authorization request.");

  const stateUserId = granolaOAuthStateUserId(nonce);
  const stored = await getTokenFull(stateUserId, GRANOLA_OAUTH_STATE_PROVIDER);
  await deleteToken(stateUserId, GRANOLA_OAUTH_STATE_PROVIDER);

  const metadata = stored?.metadata as GranolaOAuthStateMetadata | null | undefined;
  if (!stored?.token || !metadata) throw new Error("Granola authorization request expired. Please try again.");
  if (metadata.provider !== STATE_PROVIDER || metadata.expiresAt < Date.now()) {
    throw new Error("Granola authorization request expired. Please try again.");
  }
  if (!metadata.userId || !metadata.clientId || !metadata.redirectUri) {
    throw new Error("Granola authorization request is missing required metadata.");
  }

  return {
    userId: metadata.userId,
    codeVerifier: stored.token,
    client: {
      clientId: metadata.clientId,
      clientSecret: stored.refreshToken,
      tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod ?? "none",
    },
    redirectUri: metadata.redirectUri,
    scope: metadata.scope,
  };
}

function validateGranolaOAuthState(state: string): string | null {
  const [version, payload, signature, ...extra] = state.split(".");
  if (version !== STATE_VERSION || !payload || !signature || extra.length > 0) return null;
  if (!timingSafeStringEqual(signature, signGranolaOAuthState(payload))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const data = decoded as { provider?: unknown; nonce?: unknown; expiresAt?: unknown };
  if (data.provider !== STATE_PROVIDER) return null;
  if (typeof data.nonce !== "string" || !data.nonce) return null;
  if (typeof data.expiresAt !== "number" || data.expiresAt < Date.now()) return null;
  return data.nonce;
}

async function granolaOAuthClient(redirectUri: string): Promise<GranolaOAuthClient> {
  if (env.GRANOLA_CLIENT_ID) {
    return {
      clientId: env.GRANOLA_CLIENT_ID,
      clientSecret: env.GRANOLA_CLIENT_SECRET ?? null,
      tokenEndpointAuthMethod: env.GRANOLA_CLIENT_SECRET ? "client_secret_post" : "none",
    };
  }

  const cachedClient = cachedDynamicGranolaOAuthClient(redirectUri);
  if (cachedClient) return cachedClient;

  const res = await fetch(GRANOLA_REGISTRATION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Shepherd",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const data = await res.json() as {
    client_id?: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.client_id) {
    throw new Error(`Granola OAuth client registration failed: ${data.error_description ?? data.error ?? res.statusText}`);
  }
  if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "none") {
    throw new Error(`Granola OAuth client registration returned unsupported token auth method: ${data.token_endpoint_auth_method}`);
  }

  const client: GranolaOAuthClient = {
    clientId: data.client_id,
    clientSecret: null,
    tokenEndpointAuthMethod: "none",
  };
  dynamicClientCache = { redirectUri, client, cachedAt: Date.now() };
  return client;
}

function cachedDynamicGranolaOAuthClient(redirectUri: string): GranolaOAuthClient | null {
  if (!dynamicClientCache) return null;
  if (dynamicClientCache.redirectUri !== redirectUri) return null;
  if (Date.now() - dynamicClientCache.cachedAt >= DYNAMIC_CLIENT_CACHE_TTL_MS) {
    dynamicClientCache = null;
    return null;
  }
  return dynamicClientCache.client;
}

async function postGranolaTokenWithDynamicClientRecovery(
  body: URLSearchParams,
  clientId: string,
): Promise<GranolaOAuthTokenResponse> {
  try {
    return await postGranolaToken(body);
  } catch (error) {
    if (error instanceof GranolaOAuthError && error.errorCode === "invalid_client") {
      invalidateDynamicGranolaOAuthClient(clientId);
    }
    throw error;
  }
}

function invalidateDynamicGranolaOAuthClient(clientId: string): void {
  if (dynamicClientCache?.client.clientId === clientId) {
    dynamicClientCache = null;
  }
}

async function postGranolaToken(body: URLSearchParams): Promise<GranolaOAuthTokenResponse> {
  const res = await fetch(GRANOLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const data = await res.json() as GranolaOAuthTokenResponse;
  if (!res.ok || data.error) {
    throw new GranolaOAuthError(
      `Granola OAuth failed: ${data.error_description ?? data.error ?? res.statusText}`,
      data.error ?? null,
      res.status,
    );
  }
  if (!data.access_token) throw new Error("Granola OAuth did not return an access token.");
  return data;
}

class GranolaOAuthError extends Error {
  constructor(message: string, readonly errorCode: string | null, readonly status: number) {
    super(message);
    this.name = "GranolaOAuthError";
  }
}

function granolaRedirectUri(): string | null {
  if (env.GRANOLA_REDIRECT_URI) return env.GRANOLA_REDIRECT_URI;
  if (!env.WEBHOOK_BASE_URL) return null;
  return `${env.WEBHOOK_BASE_URL.replace(/\/+$/, "")}/auth/granola/callback`;
}

function granolaOAuthStateUserId(nonce: string): string {
  return `granola_oauth_state:${nonce}`;
}

function signGranolaOAuthState(payload: string): string {
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
  return typeof value === "string" && value.trim() ? value : null;
}
