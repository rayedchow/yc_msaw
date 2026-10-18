import { upsertConnection } from "../../db/connections.js";
import { db as defaultDb } from "../../db/client.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import { deleteToken, getTokenFull, getTokenMetadata, storeToken } from "../../vault/tokens.js";
import type { ConnectResult } from "../types.js";
import { buildZoomOAuthUrl, revokeZoomToken, type ZoomOAuthTokens } from "./oauth.js";

// Ported from askshepherd/aqueduct c7e1415 src/integrations/zoom/connect.ts. SOURCE-LANE PATCH (coordinator):
// schedules come from the lane itself (the donor added startZoomPolling to the shared dispatch.ts); no default-KB
// (graph) wiring; disconnect revokes the grant at Zoom.
type Executor = Pick<typeof defaultDb, "execute">;
export const ZOOM_POLL_FREQUENCY_SECONDS = 300;

export async function connectZoom(input: { tenantId: string; body: unknown }, ex: Executor = defaultDb): Promise<ConnectResult> {
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : null;
  if (!body || body.mode !== "oauth" || Object.keys(body).some((k) => k !== "mode")) return { status: 400, body: { error: "invalid Zoom connect body (expected {\"mode\":\"oauth\"})" } };
  try {
    return { status: 200, body: { authorizeUrl: await buildZoomOAuthUrl(input.tenantId, null, ex) } };
  } catch (err) {
    return { status: 503, body: { error: err instanceof Error ? err.message : "Zoom OAuth authorization failed" } };
  }
}

export async function connectZoomWithTokens(tenantId: string, tokens: ZoomOAuthTokens, ex: Executor = defaultDb): Promise<void> {
  const existing = await getTokenMetadata(tenantId, "zoom");
  const firstConnect = !existing?.connectedAt;
  await storeToken(tenantId, "zoom", tokens.access_token, {
    ...(existing ?? {}),
    connectedAt: typeof existing?.connectedAt === "string" ? existing.connectedAt : new Date().toISOString(),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope ?? null,
  }, tokens.refresh_token);
  await upsertConnection({ tenantId, provider: "zoom", status: "active", metadata: { authMode: "user_oauth" } }, ex);
  await upsertTaskSchedule({ tenantId, kind: "zoom.poll", frequencySeconds: ZOOM_POLL_FREQUENCY_SECONDS, queue: "sync", groupKey: `${tenantId}:zoom` }, ex);
  if (firstConnect) await enqueueTask({ queue: "backfill", tenantId, kind: "zoom.backfill", payload: { tenantId }, groupKey: `${tenantId}:zoom`, dedupeKey: `${tenantId}:zoom:backfill:initial` }, ex);
}

export async function disconnectZoom(input: { tenantId: string }): Promise<void> {
  const stored = await getTokenFull(input.tenantId, "zoom").catch(() => null);
  if (stored?.refreshToken) await revokeZoomToken(stored.refreshToken);
  await deleteToken(input.tenantId, "zoom");
}
