import { sql } from "drizzle-orm";
import { decrypt, encrypt } from "../../vault/encryption.js";
import type { DbExecutor } from "../core/types.js";
import { assertPublishUrl } from "./publish-client.js";

/**
 * Runtime side of a yc_msaw source binding: one publish credential per runtime
 * tenant, stored encrypted with the donor vault key. Written only by the
 * service-authenticated internal API, where yc_msaw supplies the tenant from its
 * verified principal.
 */

export interface TenantBinding {
  tenantId: string;
  bindingId: string;
  token: string;
  publishUrl: string;
  providers: string[];
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

const TOKEN_RE = /^psb_[a-z0-9][a-z0-9-]{0,79}\.sb-[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/;

export async function setTenantBinding(db: DbExecutor, b: TenantBinding): Promise<void> {
  if (!TOKEN_RE.test(b.token)) throw new Error("binding token is malformed");
  // The token embeds the namespace it was minted for; it must be this tenant's.
  if (!b.token.startsWith(`psb_${b.tenantId}.`)) throw new Error("binding token belongs to a different tenant");
  const url = assertPublishUrl(b.publishUrl);
  await db.execute(sql`
    INSERT INTO source_lane_bindings (tenant_id, binding_id, token_ciphertext, publish_url, providers)
    VALUES (${b.tenantId}, ${b.bindingId}, ${encrypt(b.token)}, ${url.href}, ${JSON.stringify(b.providers)}::jsonb)
    ON CONFLICT (tenant_id) DO UPDATE SET
      binding_id = EXCLUDED.binding_id,
      token_ciphertext = EXCLUDED.token_ciphertext,
      publish_url = EXCLUDED.publish_url,
      providers = EXCLUDED.providers,
      updated_at = now()
  `);
}

export async function getTenantBinding(db: DbExecutor, tenantId: string): Promise<TenantBinding | null> {
  const r = rows<{ binding_id: string; token_ciphertext: string; publish_url: string; providers: string[] }>(
    await db.execute(sql`SELECT binding_id, token_ciphertext, publish_url, providers FROM source_lane_bindings WHERE tenant_id = ${tenantId}`),
  )[0];
  if (!r) return null;
  return { tenantId, bindingId: r.binding_id, token: decrypt(r.token_ciphertext), publishUrl: r.publish_url, providers: r.providers };
}

export async function deleteTenantBinding(db: DbExecutor, tenantId: string): Promise<boolean> {
  const r = rows<{ tenant_id: string }>(await db.execute(sql`DELETE FROM source_lane_bindings WHERE tenant_id = ${tenantId} RETURNING tenant_id`));
  return r.length > 0;
}

export async function boundTenants(db: DbExecutor): Promise<string[]> {
  return rows<{ tenant_id: string }>(await db.execute(sql`SELECT tenant_id FROM source_lane_bindings ORDER BY tenant_id`)).map((r) => r.tenant_id);
}
