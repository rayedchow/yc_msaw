import { sql } from "drizzle-orm";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { NangoClient, type NangoConnection } from "./client.js";
import { activateNangoConnection } from "./sync-enqueue.js";
import type { NangoExecutor } from "./types.js";

export const NANGO_CONNECTION_PROVIDERS = ["jira", "confluence", "bitbucket", "github"] as const;

export interface ReconcileNangoConnectionsOptions {
  client?: Pick<NangoClient, "listConnections">;
}

export interface ReconcileNangoConnectionsResult {
  providers: string[];
  remoteConnections: number;
  matched: number;
  promoted: number;
  enqueued: number;
}

export async function reconcileNangoConnectionsForTenant(
  executor: NangoExecutor,
  tenantId: string,
  providerConfigKey?: string,
  options: ReconcileNangoConnectionsOptions = {},
): Promise<ReconcileNangoConnectionsResult> {
  const providers = await pendingNangoProviderConfigKeys(executor, tenantId, providerConfigKey);
  if (providers.length === 0) {
    return { providers: [], remoteConnections: 0, matched: 0, promoted: 0, enqueued: 0 };
  }

  const client = options.client ?? new NangoClient();
  const connections = await client.listConnections(providerConfigKey ? { providerConfigKey } : {});
  const providerSet = new Set(providers.map(normalizeKey));
  let remoteConnections = 0;
  let matched = 0;
  let promoted = 0;
  let enqueued = 0;

  for (const connection of connections) {
    remoteConnections += 1;
    if (!matchesTenantProvider(connection, tenantId, providerSet)) continue;
    matched += 1;

    const didPromote = await promotePendingConnection(executor, {
      tenantId,
      providerConfigKey: connection.providerConfigKey,
      connectionId: connection.connectionId,
    });
    if (!didPromote) continue;

    promoted += 1;
    const fanout = await activateNangoConnection(executor, {
      tenantId,
      provider: connection.providerConfigKey,
      providerConfigKey: connection.providerConfigKey,
      connectionId: connection.connectionId,
    });
    enqueued += fanout.enqueued;
  }

  return { providers, remoteConnections, matched, promoted, enqueued };
}

async function pendingNangoProviderConfigKeys(
  executor: NangoExecutor,
  tenantId: string,
  providerConfigKey?: string,
): Promise<string[]> {
  const rows = rowsFromExecute<{ provider: string }>(await executor.execute(sql`
    SELECT DISTINCT provider
    FROM connections
    WHERE tenant_id = ${tenantId}
      ${providerConfigKey
        ? sql`AND provider = ${providerConfigKey}`
        : sql`AND provider IN (${sql.join(NANGO_CONNECTION_PROVIDERS.map((provider) => sql`${provider}`), sql`, `)})`}
      AND status IN ('pending', 'error')
      AND external_account_id IS NULL
  `));
  return [...new Set(rows.map((row) => stringValue(row.provider)).filter((provider): provider is string => Boolean(provider)))];
}

async function promotePendingConnection(
  executor: NangoExecutor,
  input: { tenantId: string; providerConfigKey: string; connectionId: string },
): Promise<boolean> {
  const metadata = {
    authMode: "nango",
    providerConfigKey: input.providerConfigKey,
    nangoConnectionId: input.connectionId,
    lastPullReconciledAt: new Date().toISOString(),
  };
  const rows = rowsFromExecute<{ id: string }>(await executor.execute(sql`
    UPDATE connections
    SET status = 'active',
        external_account_id = ${input.connectionId},
        metadata = metadata || ${JSON.stringify(metadata)}::jsonb,
        updated_at = now()
    WHERE tenant_id = ${input.tenantId}
      AND provider = ${input.providerConfigKey}
      AND status IN ('pending', 'error')
      AND external_account_id IS NULL
    RETURNING id
  `));
  if (rows.length === 0) return false;
  await ensureDefaultKbForTenant(executor, input.tenantId);
  return true;
}

function matchesTenantProvider(connection: NangoConnection, tenantId: string, providerSet: Set<string>): boolean {
  return connection.endUserId === tenantId && providerSet.has(normalizeKey(connection.providerConfigKey));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
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
