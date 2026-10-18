import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { startNangoPolling } from "../../queue/dispatch.js";
import type { ConnectResult } from "../types.js";
import { NangoClient } from "./client.js";
import { disableNangoPollSchedule } from "./tasks.js";

export function nangoConnectForProvider(provider: string): (input: { tenantId: string; body: unknown }) => Promise<ConnectResult> {
  return (input) => connectNangoProvider(input, provider);
}

export async function connectNangoProvider(
  input: { tenantId: string; body: unknown },
  provider: string,
): Promise<ConnectResult> {
  const providerConfigKey = providerConfigKeyFromBody(input.body) ?? provider;
  try {
    await upsertConnection({
      tenantId: input.tenantId,
      provider,
      status: "pending",
      metadata: {
        authMode: "nango",
        providerConfigKey,
        connectSessionCreatedAt: new Date().toISOString(),
      },
    });

    const session = await new NangoClient().createConnectSession({
      tenantId: input.tenantId,
      allowedIntegrations: [providerConfigKey],
    });

    // Scheduled polling floor is the source of truth; webhooks only accelerate
    // it (and the non-webhook lane never gets them). The poll task no-ops
    // until the connection reconciles to active with a Nango connection id.
    await startNangoPolling(input.tenantId, provider);
    await ensureDefaultKbForTenant(db, input.tenantId);

    return {
      status: 200,
      body: {
        provider,
        status: "pending",
        sessionToken: session.sessionToken,
        ...(session.connectLink ? { connectLink: session.connectLink, authUrl: session.connectLink } : {}),
      },
    };
  } catch (err) {
    return {
      status: isMissingNangoSecret(err) ? 503 : 502,
      body: { error: "Nango connect session creation failed" },
    };
  }
}

export async function disconnectNangoProvider(input: {
  tenantId: string;
  provider: string;
  providerConfigKey?: string;
  client?: Pick<NangoClient, "deleteConnection">;
}): Promise<void> {
  // SOURCE-LANE PATCH (coordinator, final-audit M3): delete EVERY Nango connection this tenant holds for the provider
  // (multi-site Jira/Confluence/GitHub/Bitbucket), not only the most recently updated one, so none keeps syncing.
  const client = input.client ?? new NangoClient();
  const seen = new Set<string>();
  for (const row of await nangoConnectionsForTenant(input.tenantId, input.provider)) {
    const providerConfigKey = input.providerConfigKey ?? stringValue(row.provider_config_key) ?? input.provider;
    const connectionId = stringValue(row.external_account_id) ?? stringValue(row.nango_connection_id);
    if (!connectionId || seen.has(`${providerConfigKey}\u0000${connectionId}`)) continue;
    seen.add(`${providerConfigKey}\u0000${connectionId}`);
    await client.deleteConnection({ providerConfigKey, connectionId });
  }
  await disableNangoPollSchedule(db, input.tenantId, input.provider);
  await db.execute(sql`
    UPDATE conversation_watermarks
    SET is_active = false,
        last_polled_at = now()
    WHERE user_id = ${input.tenantId}
      AND provider = ${input.provider}
  `);
}

async function nangoConnectionsForTenant(
  tenantId: string,
  provider: string,
): Promise<Array<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null }>> {
  const rows = rowsFromExecute<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null }>(await db.execute(sql`
    SELECT
      external_account_id,
      metadata->>'nangoConnectionId' AS nango_connection_id,
      metadata->>'providerConfigKey' AS provider_config_key
    FROM connections
    WHERE tenant_id = ${tenantId}
      AND provider = ${provider}
    ORDER BY updated_at DESC
  `));
  return rows;
}

function providerConfigKeyFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return stringValue((body as Record<string, unknown>).providerConfigKey);
}

function isMissingNangoSecret(error: unknown): boolean {
  return error instanceof Error && /NANGO_SECRET_KEY/iu.test(error.message);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
