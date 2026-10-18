import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createYcDeviceAuthority } from "../../../../src/integrations/coding-sessions/lane.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { db, mintKey, ready, resetTenant } from "./harness.js";

/** The shared yc_msaw device authority (coding sessions, office audio): only yc_msaw's 401 revokes (final-audit L1). */

const T = "acme-auth";

beforeAll(async () => {
  await ready;
  await resetTenant(T);
  await setTenantBinding(db as never, { tenantId: T, bindingId: "sb-0123456789abcdef", token: `psb_${T}.sb-0123456789abcdef.${randomBytes(32).toString("base64url")}`, publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
});

describe("createYcDeviceAuthority", () => {
  it("revokes only on 401 and fails closed (unavailable) on 403, 404 and 5xx", async () => {
    const { key, bindingId } = mintKey(T);
    const device = { tenantNs: T, bindingId };
    const verdict = async (status: number) =>
      createYcDeviceAuthority(db as never, "coding-sessions", (async () => new Response("{}", { status })) as typeof fetch).verify(key, device as never);
    expect(await verdict(401)).toMatchObject({ state: "revoked" });
    for (const status of [403, 404, 500, 503]) expect(await verdict(status)).toMatchObject({ state: "unavailable" });
  });
});
