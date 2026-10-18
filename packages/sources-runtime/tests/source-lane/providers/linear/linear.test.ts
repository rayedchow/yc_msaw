import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { connectLinear, createLinearWebhook, disconnectLinear, linearIntegration, runLinearSync, verifyLinearSignature } from "../../../../src/integrations/linear/lane.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { linearObjectsExport, linearProvider } from "../../../../src/source-lane/providers/linear/index.js";

/**
 * Linear (coordinator port of gigabrain f74c62ca8): full paginated polling of issues/comments/projects/cycles,
 * donor snapshot identity, edits, archive/remove/listing deletions, GraphQL rate limits with persisted reset,
 * signed webhooks bound to a connection and its organization, tenant isolation, export and coverage.
 */
const T = "tenant-linear";
const T2 = "tenant-linear-rival";
const KEY = `lin_api_${"a".repeat(40)}`;
const ORG = "org-1";

class FakeLinear {
  data: Record<string, Array<Record<string, unknown>>> = { issues: [], comments: [], projects: [], cycles: [] };
  calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  hooks: Array<(q: string, v: Record<string, unknown>) => Response | undefined> = [];
  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    expect(url).toBe("https://api.linear.app/graphql");
    const { query: q, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    this.calls.push({ query: q, variables });
    expect(q).not.toMatch(/\bmutation\b/); // read-only
    if (new Headers(init?.headers).get("authorization") !== KEY) return json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 401);
    for (const h of this.hooks) {
      const r = h(q, variables);
      if (r) return r;
    }
    if (q.includes("viewer")) return json({ data: { viewer: { id: "u-viewer", name: "Ada", email: "ada@acme.test", organization: { id: ORG, name: "Acme", urlKey: "acme" } } } });
    const conn = ["issues", "comments", "projects", "cycles"].find((c) => q.includes(`${c}(first:`))!;
    const since = (variables.filter as { updatedAt?: { gte: string } } | undefined)?.updatedAt?.gte;
    const all = this.data[conn]!.filter((n) => !since || String(n.updatedAt) >= since).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    const start = variables.after ? Number(variables.after) : 0;
    const nodes = all.slice(start, start + Number(variables.first));
    return json({ data: { [conn]: { nodes, pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } } } });
  };
  issue(n: number, over: Record<string, unknown> = {}) {
    return { id: `iss-${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, description: `Body ${n}`, state: { id: "s1", name: "Todo" }, team: { id: "t1", name: "Eng", key: "ENG" },
      labels: { nodes: [] }, children: { nodes: [] }, relations: { nodes: [] }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: `2026-09-${String(1 + (n % 28)).padStart(2, "0")}T00:00:00.000Z`, archivedAt: null, trashed: false, ...over };
  }
}

let fake: FakeLinear;
const deps = (env: NodeJS.ProcessEnv = { SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test" } as NodeJS.ProcessEnv) => ({ fetchImpl: fake.fetch, executor: db as never, env });
const objs = (resource = "issue") => query<{ object_id: string; label: string; deleted: boolean; deleted_reason: string | null; payload: Record<string, unknown>; tenant_id: string }>(`SELECT object_id, label, deleted, deleted_reason, payload, tenant_id FROM linear_objects WHERE resource = $1 ORDER BY object_id`, [resource]);
async function connect(tenant = T) {
  const r = await connectLinear({ tenantId: tenant, body: { apiKey: KEY } }, deps());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { connection: { id: string }; webhook: { url: string; secret: string } };
}
const free = () => pg.exec(`UPDATE linear_cursors SET retry_at = NULL, lease_until = NULL; UPDATE linear_connections SET retry_at = NULL`);

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM linear_objects; DELETE FROM linear_cursors; DELETE FROM linear_connections; DELETE FROM activity_events WHERE source = 'linear'; DELETE FROM task_queue; DELETE FROM task_schedules; DELETE FROM connections;`);
  fake = new FakeLinear();
});
afterEach(() => vi.unstubAllEnvs());

describe("linear", () => {
  it("connects read-only, pages every resource fully and resumes across runs with the donor snapshot ids", async () => {
    expect((await connectLinear({ tenantId: T, body: { apiKey: "nope" } }, deps())).status).toBe(400);
    expect((await connectLinear({ tenantId: T, body: { apiKey: KEY, tenantId: T2 } }, deps())).status).toBe(400);
    const { connection, webhook } = await connect();
    expect(webhook.url).toBe(`https://runtime.example.test/webhooks/linear/${connection.id}`);
    fake.data.issues = Array.from({ length: 230 }, (_, i) => fake.issue(i));
    fake.data.comments = [{ id: "c1", body: "hi", issue: { id: "iss-1", identifier: "ENG-1" }, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" }];
    fake.data.projects = [{ id: "proj-12345678", name: "Q4 launch", state: "started", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" }];
    fake.data.cycles = [{ id: "cyc-1", number: 7, team: { key: "ENG" }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" }];
    await runLinearSync(T, deps({ LINEAR_PAGES_PER_RUN: "2" } as NodeJS.ProcessEnv));
    expect((await objs()).length).toBe(200);
    await free();
    await runLinearSync(T, deps({ LINEAR_PAGES_PER_RUN: "10" } as NodeJS.ProcessEnv));
    expect((await objs()).length).toBe(230);
    expect((await objs("comment")).length).toBe(1);
    expect((await objs("project")).length).toBe(1);
    expect((await objs("cycle")).length).toBe(1);
    const ids = (await query<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE source = 'linear' AND source_event_id LIKE 'linear:issue:iss-1:%'`)).map((r) => r.source_event_id);
    expect(ids).toEqual([`linear:issue:iss-1:updated:${fake.data.issues[1]!.updatedAt}`]);
    expect(fake.calls.every((c) => /includeArchived: true/.test(c.query) || c.query.includes("viewer"))).toBe(true);
  });

  it("captures edits as new snapshots via the delta watermark and tombstones archived, removed and unlisted objects", async () => {
    await connect();
    fake.data.issues = [fake.issue(1), fake.issue(2), fake.issue(3)];
    await runLinearSync(T, deps());
    // Edit (newer updatedAt) + archive + disappearance.
    fake.data.issues[0] = fake.issue(1, { title: "Renamed", updatedAt: "2026-10-01T00:00:00.000Z" });
    fake.data.issues[1] = fake.issue(2, { archivedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:01.000Z" });
    fake.data.issues.splice(2, 1);
    await free();
    await runLinearSync(T, deps());
    expect(fake.calls.at(-4)!.variables.filter).toBeTruthy(); // delta pass
    let rows = await objs();
    expect(rows.find((r) => r.object_id === "iss-1")!.payload.title).toBe("Renamed");
    expect(rows.find((r) => r.object_id === "iss-2")).toMatchObject({ deleted: true, deleted_reason: "archived" });
    expect(rows.find((r) => r.object_id === "iss-3")!.deleted).toBe(false); // a delta cannot prove deletion
    // The next full pass (forced by aging last_full_at) reconciles the missing issue.
    await pg.exec(`UPDATE linear_cursors SET last_full_at = now() - interval '13 hours'`);
    await free();
    await runLinearSync(T, deps());
    rows = await objs();
    expect(rows.find((r) => r.object_id === "iss-3")).toMatchObject({ deleted: true, deleted_reason: "not_in_full_listing" });
    expect((await query(`SELECT 1 FROM activity_events WHERE source_event_id = 'linear:issue:iss-1:updated:2026-10-01T00:00:00.000Z'`)).length).toBe(1);
  });

  it("persists GraphQL rate limits (RATELIMITED) for the whole connection and resumes at the failed page", async () => {
    await connect();
    fake.data.issues = Array.from({ length: 150 }, (_, i) => fake.issue(i));
    let hit = false;
    fake.hooks.push((q, v) => (!hit && q.includes("issues(first:") && v.after === "100" ? ((hit = true), json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, 400, { "x-ratelimit-requests-reset": String(Date.now() + 120_000) })) : undefined));
    const r = await runLinearSync(T, deps());
    expect(r.find((x) => x.resource === "issue")!.status).toBe("rate_limited");
    const [c] = await query<{ retry_at: string }>(`SELECT retry_at FROM linear_connections`);
    expect(Date.parse(c!.retry_at) - Date.now()).toBeGreaterThan(100_000);
    expect((await runLinearSync(T, deps()))[0]!.status).toBe("skipped");
    await free();
    await runLinearSync(T, deps());
    expect((await objs()).length).toBe(150);
    expect(fake.calls.filter((x) => x.query.includes("issues(first:") && x.variables.after === "100").length).toBe(2);
  });

  it("verifies signed deliveries for the URL's connection and organization, deduplicates by delivery id, and applies removes", async () => {
    const a = await connect();
    const b = await connect(T2);
    fake.data.issues = [fake.issue(5)];
    await runLinearSync(T, deps());
    const app = createLinearWebhook({ executor: db as never });
    const body = (over: Record<string, unknown> = {}) => JSON.stringify({ action: "remove", type: "Issue", data: { id: "iss-5" }, organizationId: ORG, webhookTimestamp: Date.now(), createdAt: new Date().toISOString(), ...over });
    const send = (id: string, raw: string, secret: string, delivery = "d-1") => app.request(`/${id}`, { method: "POST", headers: { "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"), "linear-delivery": delivery }, body: raw });
    const raw = body();
    expect(verifyLinearSignature(raw, createHmac("sha256", a.webhook.secret).update(raw).digest("hex"), a.webhook.secret)).toBe(true);
    expect((await send(a.connection.id, raw, b.webhook.secret)).status).toBe(401);
    expect((await send(a.connection.id, body({ organizationId: "org-other" }), a.webhook.secret)).status).toBe(401);
    expect((await send(a.connection.id, body({ webhookTimestamp: Date.now() - 3_600_000 }), a.webhook.secret)).status).toBe(401);
    expect(await (await send(a.connection.id, raw, a.webhook.secret)).json()).toMatchObject({ received: true, eventType: "Issue.remove" });
    expect(await (await send(a.connection.id, raw, a.webhook.secret)).json()).toMatchObject({ duplicate: true });
    expect((await objs()).find((r) => r.object_id === "iss-5")).toMatchObject({ deleted: true, deleted_reason: "removed", tenant_id: T });
    expect((await query(`SELECT user_id FROM activity_events WHERE source_event_id = 'linear:webhook:d-1'`)).map((r) => r.user_id)).toEqual([T]);
    await disconnectLinear({ tenantId: T });
    expect((await send(a.connection.id, body(), a.webhook.secret, "d-2")).status).toBe(401);
  });

  it("exports issue JSON + readable markdown that move with the identifier, isolated per tenant, with coverage", async () => {
    expect(integrationById("linear")).toBe(linearIntegration);
    await connect();
    fake.data.issues = [fake.issue(9)];
    await runLinearSync(T, deps());
    const [{ id }] = await query<{ id: string }>(`SELECT id FROM linear_objects WHERE resource = 'issue'`);
    const j = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const files = await linearObjectsExport.map({ tenantId: T, executor: db as never }, id!, j, []);
    expect(files.map((f) => f.path)).toEqual(["sources/linear/acme/issues/ENG-9.json", "sources/linear/acme/issues/ENG-9.md"]);
    expect((files[1] as { content: Buffer }).content.toString()).toContain("# ENG-9 Issue 9");
    expect(await linearObjectsExport.map({ tenantId: T2, executor: db as never }, id!, j, [])).toEqual([]);
    const cov = await linearProvider.coverage!({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope.endsWith(":issues"))!.state).toBe("complete");
    expect(cov.find((c) => c.scope.endsWith(":webhook"))!.state).toBe("partial");
  });
});
