import { sql } from "drizzle-orm";
import { db } from "./client.js";

type DbExecutor = Pick<typeof db, "execute">;

export type ConnectionStatus = "pending" | "active" | "paused" | "revoked" | "error";

export interface UpsertConnectionInput {
  tenantId: string;
  provider: string;
  externalAccountId?: string;
  status: ConnectionStatus;
  metadata?: Record<string, unknown>;
}

export async function upsertConnection(input: UpsertConnectionInput, executor: DbExecutor = db): Promise<void> {
  await executor.execute(sql`
    INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata)
    VALUES (
      ${input.tenantId},
      ${input.provider},
      ${input.externalAccountId ?? null},
      ${input.status},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    ON CONFLICT (tenant_id, provider, (COALESCE(external_account_id, ''))) DO UPDATE SET
      status = EXCLUDED.status,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `);
}

export async function setConnectionStatus(
  tenantId: string,
  provider: string,
  status: ConnectionStatus,
  externalAccountId?: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    UPDATE connections
    SET status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND provider = ${provider}
      ${externalAccountId !== undefined ? sql`AND COALESCE(external_account_id, '') = ${externalAccountId}` : sql``}
  `);
}
