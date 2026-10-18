import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../providers/bitbucket/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, pg, query, ready } from "../providers/bitbucket/harness.js";
import { disconnectNangoProvider } from "../../../src/integrations/nango/connect.js";
import { resolveTenantForNangoConnection } from "../../../src/integrations/nango/webhook.js";

/** Coordinator regression for final-audit M3 (shared nango/connect.ts, nango/webhook.ts). PGlite, real SQL. */

const T = "tenant-nd";
const conn = (id: string, status = "active") =>
  pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES ($1, 'jira', $2, $3, $4::jsonb)`, [T, id, status, JSON.stringify({ providerConfigKey: "jira", nangoConnectionId: id })]);

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM connections; DELETE FROM task_schedules;`);
});

describe("Nango disconnect with several connections", () => {
  it("deletes every connection of the provider at Nango, not only the newest", async () => {
    await conn("site-a");
    await conn("site-b");
    const deleteConnection = vi.fn(async () => undefined);
    await disconnectNangoProvider({ tenantId: T, provider: "jira", client: { deleteConnection } as never });
    expect(deleteConnection.mock.calls.map((c) => (c as unknown as [{ connectionId: string }])[0].connectionId).sort()).toEqual(["site-a", "site-b"]);
  });

  it("maps sync webhooks only to active connections; auth-style lookups still see any row", async () => {
    await conn("site-live");
    await conn("site-gone", "revoked");
    expect(await resolveTenantForNangoConnection(db as never, { providerConfigKey: "jira", connectionId: "site-live" }, { activeOnly: true })).toBe(T);
    expect(await resolveTenantForNangoConnection(db as never, { providerConfigKey: "jira", connectionId: "site-gone" }, { activeOnly: true })).toBeNull();
    expect(await resolveTenantForNangoConnection(db as never, { providerConfigKey: "jira", connectionId: "site-gone" })).toBe(T);
    expect(await query(`SELECT count(*)::int AS n FROM connections`)).toEqual([{ n: 2 }]);
  });
});
