import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { ensureDefaultKbSchedule } from "../queue/dispatch.js";

type DbExecutor = Pick<typeof db, "execute">;

export interface EnsureTenantInput {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export async function ensureTenant(input: EnsureTenantInput, executor: DbExecutor = db): Promise<void> {
  await executor.execute(sql`
    INSERT INTO tenants (id, name, slug, metadata)
    VALUES (
      ${input.id},
      ${input.name},
      ${slugify(input.id)},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      metadata = tenants.metadata || EXCLUDED.metadata,
      updated_at = now()
  `);
  await ensureDefaultKbSchedule(input.id, executor);
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "tenant";
}
