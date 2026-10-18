import { beforeEach, describe, expect, it } from "vitest";
import { ownerScopedDirs, personalSegment, scopePublicPath, scopeTenantIdOf } from "../../../../src/source-lane/core/personal-scope.js";
import { hmac, q, reset, runTasks, SERVICE_TOKEN, setup, type Setup } from "./harness.js";

/**
 * Generic Nango records with personal owner scopes (personal-connection-attribution): a "personal" source (the
 * default audience) is connected by each member into their own owner scope, so two members of one organization each
 * connect their own Outlook; their connections, records (even with the same record id), status and disconnects never
 * mix, and the files are published under sources/<source>/<owner segment>/. An "organization" source stays an admin
 * action in the tenant itself. Production lane modules in the real runtime app; FakeNango; PGlite; synthetic data.
 */

const CONFIG = {
  version: 1,
  sources: [
    { source: "outlook", providerConfigKey: "acme-outlook", models: ["OutlookMessage"], pollSeconds: 300 },
    { source: "hubspot", providerConfigKey: "acme-hubspot", models: ["Contact"], audience: "organization" },
  ],
};
const ISSUER = "https://auth.example.test";
const member = (sub: string, scopes = ["memory:read"]) => ({ tenantNs: "acme", subject: sub, issuer: ISSUER, scopes });
const scopeOf = (sub: string) => scopeTenantIdOf("acme", personalSegment({ tenantNs: "acme", issuer: ISSUER, subject: sub }));

function call(s: Setup, who: ReturnType<typeof member>, method: string, route: string, body?: unknown) {
  return s.app.request(`/internal/v1/tenants/acme${route}`, {
    method,
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": JSON.stringify(who), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A member connects through a server-created session consumed by Nango's signed auth webhook (production path). */
async function connect(s: Setup, who: ReturnType<typeof member>, source: string, connectionId: string): Promise<Response> {
  const res = await call(s, who, "POST", "/nango-records/connect-sessions", { source });
  if (res.status !== 201) return res;
  const session = s.nango.sessions[s.nango.sessions.length - 1]!;
  const tags = session.tags as Record<string, string>;
  const pck = (session.allowed_integrations as string[])[0]!;
  s.nango.addConnection({ connection_id: connectionId, provider_config_key: pck, tags });
  const body = JSON.stringify({ type: "auth", operation: "creation", connectionId, providerConfigKey: pck, provider: "microsoft", authMode: "OAUTH2", environment: "DEV", success: true, tags });
  const hook = await s.app.request("/webhooks/nango-records", { method: "POST", headers: { "Content-Type": "application/json", "X-Nango-Hmac-Sha256": hmac(body) }, body });
  expect(hook.status).toBe(204);
  return res;
}

describe("personal Nango sources in members' own owner scopes", () => {
  let s: Setup;
  beforeEach(async () => {
    await reset();
    await q("TRUNCATE source_lane_personal_scopes CASCADE");
    s = setup({ config: CONFIG });
  });

  it("lets two plain members connect their own account of one source; records, status and disconnects stay per owner", async () => {
    const bob = member("user_bob");
    const carol = member("user_carol");
    expect((await connect(s, bob, "outlook", "conn-bob")).status).toBe(201);
    expect((await connect(s, carol, "outlook", "conn-carol")).status).toBe(201);
    expect(await q("SELECT tenant_id, connection_id FROM nango_records_connections ORDER BY connection_id")).toEqual([
      { tenant_id: scopeOf("user_bob"), connection_id: "conn-bob" },
      { tenant_id: scopeOf("user_carol"), connection_id: "conn-carol" },
    ]);
    // The same provider record id in both accounts is two records, one per owner.
    s.nango.upsert("acme-outlook", "conn-bob", "OutlookMessage", { id: "m1", subject: "bob's mail needle-bob" });
    s.nango.upsert("acme-outlook", "conn-carol", "OutlookMessage", { id: "m1", subject: "carol's mail needle-carol" });
    expect((await call(s, bob, "POST", "/nango-records/sync", {})).status).toBe(200);
    expect((await call(s, carol, "POST", "/nango-records/sync", {})).status).toBe(200);
    await runTasks(s);
    const events = await q<{ user_id: string; raw: string }>("SELECT user_id, raw_payload::text AS raw FROM activity_events WHERE source = 'outlook' ORDER BY user_id");
    expect(events.map((e) => [e.user_id, /needle-[a-z]+/.exec(e.raw)?.[0]]).sort()).toEqual(
      [[scopeOf("user_bob"), "needle-bob"], [scopeOf("user_carol"), "needle-carol"]].sort(),
    );
    expect(await q("SELECT count(*)::int AS n FROM activity_events WHERE user_id = 'acme'")).toEqual([{ n: 0 }]);

    // Status: each member sees their own personal connections; an admin sees no member's personal connection.
    const bobStatus = (await (await call(s, bob, "GET", "/nango-records")).json()) as Record<string, any>;
    expect(bobStatus.personal.segment).toBe(personalSegment({ tenantNs: "acme", issuer: ISSUER, subject: "user_bob" }));
    expect(bobStatus.personal.sources.find((x: any) => x.source === "outlook").connections.map((c: any) => c.connectionId)).toEqual(["conn-bob"]);
    expect(JSON.stringify(bobStatus)).not.toContain("conn-carol");
    expect(bobStatus.sources).toEqual([]); // organization sources' connections are admin-only
    const admin = (await (await call(s, member("user_alice", ["memory:read", "memory:build"]), "GET", "/nango-records")).json()) as Record<string, any>;
    expect(JSON.stringify(admin)).not.toContain("conn-bob");
    expect(JSON.stringify(admin)).not.toContain("conn-carol");
    expect(admin.sources.map((x: any) => x.source)).toEqual(["hubspot"]);

    // Disconnect reaches only the caller's own connection.
    expect((await call(s, carol, "DELETE", "/nango-records/connections/outlook/conn-bob")).status).toBe(404);
    expect((await call(s, bob, "DELETE", "/nango-records/connections/outlook/conn-bob")).status).toBe(200);
    expect(await q("SELECT connection_id, status FROM nango_records_connections ORDER BY connection_id")).toEqual([
      { connection_id: "conn-bob", status: "revoked" },
      { connection_id: "conn-carol", status: "active" },
    ]);
    // A session id of another member is not found for the caller.
    const session = (await (await call(s, bob, "POST", "/nango-records/connect-sessions", { source: "outlook" })).json()) as { sessionId: string };
    expect((await call(s, carol, "GET", `/nango-records/connect-sessions/${session.sessionId}`)).status).toBe(404);
    expect((await call(s, bob, "GET", `/nango-records/connect-sessions/${session.sessionId}`)).status).toBe(200);
  });

  it("never lets another member attach an existing connection, even through a signed webhook naming it", async () => {
    const bob = member("user_bob");
    const carol = member("user_carol");
    expect((await connect(s, bob, "outlook", "conn-bob")).status).toBe(201);
    // carol opens her own session; a (Nango-signed) auth delivery that names bob's existing connection with her tag
    // does not move it: the connection stays bound to bob's owner scope.
    expect((await call(s, carol, "POST", "/nango-records/connect-sessions", { source: "outlook" })).status).toBe(201);
    const tags = s.nango.sessions[s.nango.sessions.length - 1]!.tags as Record<string, string>;
    const body = JSON.stringify({ type: "auth", operation: "creation", connectionId: "conn-bob", providerConfigKey: "acme-outlook", provider: "microsoft", authMode: "OAUTH2", environment: "DEV", success: true, tags });
    await s.app.request("/webhooks/nango-records", { method: "POST", headers: { "Content-Type": "application/json", "X-Nango-Hmac-Sha256": hmac(body) }, body });
    expect(await q("SELECT tenant_id FROM nango_records_connections WHERE connection_id = 'conn-bob'")).toEqual([{ tenant_id: scopeOf("user_bob") }]);
    const carolStatus = (await (await call(s, carol, "GET", "/nango-records")).json()) as Record<string, any>;
    expect(JSON.stringify(carolStatus)).not.toContain("conn-bob");
  });

  it("keeps organization sources an admin action in the tenant itself", async () => {
    expect((await call(s, member("user_bob"), "POST", "/nango-records/connect-sessions", { source: "hubspot" })).status).toBe(403);
    expect((await connect(s, member("user_alice", ["memory:read", "memory:build"]), "hubspot", "conn-org")).status).toBe(201);
    expect(await q("SELECT tenant_id FROM nango_records_connections WHERE connection_id = 'conn-org'")).toEqual([{ tenant_id: "acme" }]);
    expect((await call(s, member("user_bob"), "DELETE", "/nango-records/connections/hubspot/conn-org")).status).toBe(403);
  });

  it("publishes personal sources (only) under the owner segment", () => {
    const dirs = ownerScopedDirs(s.registry.modules);
    expect(dirs.has("outlook")).toBe(true);
    expect(dirs.has("hubspot")).toBe(false);
    const scope = { scopeTenantId: scopeOf("user_bob"), parentTenantId: "acme", segment: personalSegment({ tenantNs: "acme", issuer: ISSUER, subject: "user_bob" }) };
    expect(scopePublicPath(scope, "sources/outlook/acme-outlook/conn-bob/OutlookMessage/m1.json", dirs)).toBe(`sources/outlook/${scope.segment}/acme-outlook/conn-bob/OutlookMessage/m1.json`);
    expect(() => scopePublicPath(scope, "sources/hubspot/acme-hubspot/x.json", dirs)).toThrow();
  });
});
