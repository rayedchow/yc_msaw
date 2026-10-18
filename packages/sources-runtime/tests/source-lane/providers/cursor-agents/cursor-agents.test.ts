import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import {
  connectCursorAgents, createCursorAgentsWebhook, cursorAgentsIntegration, disconnectCursorAgents, parseCursorAgent, runCursorAgentsSync, verifyCursorWebhookSignature,
} from "../../../../src/integrations/cursor-agents/lane.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { cursorAgentsExport, cursorAgentsProvider } from "../../../../src/source-lane/providers/cursor-agents/index.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";

/**
 * Cursor background agents, read-only (coordinator port of gigabrain 9411c1a36): paginated listing with a
 * persisted cursor and failed-page recovery, immutable snapshot versions, conversations, Retry-After,
 * tombstones, signed webhooks bound to a connection, tenant isolation, export and coverage. Synthetic data.
 */
const T = "tenant-cursor";
const T2 = "tenant-cursor-rival";
const KEY = "key_cursor_test_123";
const ENV = { SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test" } as NodeJS.ProcessEnv;

class FakeCursor {
  agents: Array<Record<string, unknown>> = [];
  conversations = new Map<string, Record<string, unknown>>();
  calls: Array<{ url: URL; method: string }> = [];
  hooks: Array<(url: URL) => Response | undefined> = [];
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    expect(url.origin).toBe("https://api.cursor.com");
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET"); // read-only: never launch/followup/delete
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401);
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    if (url.pathname === "/v0/agents") {
      const limit = Number(url.searchParams.get("limit"));
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return json({ agents: this.agents.slice(start, start + limit), ...(start + limit < this.agents.length ? { nextCursor: String(start + limit) } : {}) });
    }
    const m = /^\/v0\/agents\/([^/]+)\/conversation$/.exec(url.pathname);
    if (m) return json(this.conversations.get(m[1]!) ?? { id: m[1], messages: [] });
    return json({}, 404);
  };
  add(n: number, status = "RUNNING") {
    const start = this.agents.length;
    for (let i = 0; i < n; i++) {
      const id = `bc_${start + i}`;
      this.agents.push({ id, name: `agent ${start + i}`, status, source: { repository: "github.com/acme/app", ref: "main" }, target: { branchName: `cursor/${id}` }, createdAt: "2026-10-01T00:00:00Z" });
      this.conversations.set(id, { id, messages: [{ id: `${id}-m1`, type: "user_message", text: "fix the bug" }, { id: `${id}-m2`, type: "assistant_message", text: "done" }] });
    }
  }
}

let fake: FakeCursor;
const deps = (env = ENV) => ({ fetchImpl: fake.fetch, executor: db as never, env });
const snaps = () => query<{ agent_id: string; status: string; deleted: boolean; deleted_reason: string | null; conversation_state: string }>(`SELECT agent_id, status, deleted, deleted_reason, conversation_state FROM cursor_agents_snapshots ORDER BY agent_id`);
const raws = () => query<{ source_event_id: string; user_id: string }>(`SELECT source_event_id, user_id FROM activity_events WHERE source = 'cursor_background_agents' ORDER BY source_event_id`);
async function connect(tenant = T) {
  const r = await connectCursorAgents({ tenantId: tenant, body: { apiKey: KEY } }, deps());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const b = r.body as { connection: { id: string }; webhook: { url: string; secret: string } };
  return { id: b.connection.id, secret: b.webhook.secret, url: b.webhook.url };
}
const due = () => pg.exec(`UPDATE cursor_agents_connections SET retry_at = NULL, lease_until = NULL`);

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM cursor_agents_snapshots; DELETE FROM cursor_agents_connections; DELETE FROM activity_events WHERE source = 'cursor_background_agents'; DELETE FROM task_queue; DELETE FROM task_schedules; DELETE FROM connections; DELETE FROM source_lane_journal;`);
  fake = new FakeCursor();
});
afterEach(() => vi.unstubAllEnvs());

describe("cursor agents", () => {
  it("connects read-only with an encrypted key and a per-connection webhook secret", async () => {
    expect((await connectCursorAgents({ tenantId: T, body: { apiKey: "wrong_key_000" } }, deps())).body).toMatchObject({ error: { code: "invalid_api_key" } });
    expect((await connectCursorAgents({ tenantId: T, body: { apiKey: KEY, apiBase: "https://evil.example.com" } }, deps())).status).toBe(400);
    expect((await connectCursorAgents({ tenantId: T, body: { apiKey: KEY, tenantId: T2 } }, deps())).status).toBe(400);
    const c = await connect();
    expect(c.url).toBe(`https://runtime.example.test/webhooks/cursor-agents/${c.id}`);
    const [row] = await query<{ api_key_ciphertext: string; webhook_secret_ciphertext: string }>(`SELECT api_key_ciphertext, webhook_secret_ciphertext FROM cursor_agents_connections`);
    expect(row!.api_key_ciphertext).not.toContain(KEY);
    expect(row!.webhook_secret_ciphertext).not.toContain(c.secret);
    expect(fake.calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("lists all pages resumably, recovers a failed page, stores conversations and versions changes immutably", async () => {
    fake.add(250);
    await connect();
    let failed = false;
    fake.hooks.push((url) => (!failed && url.pathname === "/v0/agents" && url.searchParams.get("cursor") === "200" ? ((failed = true), json({ error: "busy" }, 429, { "retry-after": "240" })) : undefined));
    vi.stubEnv("CURSOR_AGENTS_CONVERSATIONS_PER_RUN", "500");
    const t0 = Date.now();
    const r1 = await runCursorAgentsSync(T, deps({ ...ENV, CURSOR_AGENTS_CONVERSATIONS_PER_RUN: "500" }));
    expect(r1[0]).toMatchObject({ status: "rate_limited", agents: 200 });
    const [c] = await query<{ list_cursor: string; retry_at: string }>(`SELECT list_cursor, retry_at FROM cursor_agents_connections`);
    expect(c!.list_cursor).toBe("200");
    expect(Date.parse(c!.retry_at) - t0).toBeGreaterThanOrEqual(239_000);
    expect((await runCursorAgentsSync(T, deps()))[0]!.status).toBe("skipped");
    await due();
    const r2 = await runCursorAgentsSync(T, deps({ ...ENV, CURSOR_AGENTS_CONVERSATIONS_PER_RUN: "500" }));
    expect(r2[0]).toMatchObject({ status: "ok", agents: 50 });
    expect(fake.calls.filter((x) => x.url.pathname === "/v0/agents" && x.url.searchParams.get("cursor") === "200").length).toBe(2);
    expect((await snaps()).filter((s) => s.conversation_state === "stored")).toHaveLength(250);
    expect((await raws()).filter((r) => /^cursor_background_agents:agent:bc_\d+$/.test(r.source_event_id))).toHaveLength(250);

    // A status change: a new immutable raw version, the donor id row untouched.
    fake.agents[0]!.status = "FINISHED";
    fake.agents[0]!.target = { branchName: "cursor/bc_0", prUrl: "https://github.com/acme/app/pull/9" };
    await due();
    await runCursorAgentsSync(T, deps({ ...ENV, CURSOR_AGENTS_CONVERSATIONS_PER_RUN: "500" }));
    const versions = (await raws()).filter((r) => r.source_event_id.startsWith("cursor_background_agents:agent:bc_0"));
    expect(versions.map((v) => v.source_event_id)).toEqual(["cursor_background_agents:agent:bc_0", expect.stringMatching(/^cursor_background_agents:agent:bc_0:v:[0-9a-f]{16}$/)]);
    expect((await snaps()).find((s) => s.agent_id === "bc_0")!.status).toBe("FINISHED");
  });

  it("tombstones agents a completed listing no longer returns, and maps snapshots to files per tenant", async () => {
    fake.add(3, "FINISHED");
    const c = await connect();
    await runCursorAgentsSync(T, deps());
    fake.agents.splice(1, 1);
    await due();
    await runCursorAgentsSync(T, deps());
    expect((await snaps()).find((s) => s.agent_id === "bc_1")).toMatchObject({ deleted: true, deleted_reason: "not_in_full_listing" });
    const [{ id }] = await query<{ id: string }>(`SELECT id FROM cursor_agents_snapshots WHERE agent_id = 'bc_0'`);
    const j = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const files = await cursorAgentsExport.map({ tenantId: T, executor: db as never }, id!, j, []);
    expect(files.map((f) => f.path)).toEqual([`sources/cursor-agents/${c.id}/bc_0/agent.json`, `sources/cursor-agents/${c.id}/bc_0/conversation.json`]);
    expect(JSON.parse((files[1] as { content: Buffer }).content.toString()).messages).toHaveLength(2);
    expect(await cursorAgentsExport.map({ tenantId: T2, executor: db as never }, id!, j, [])).toEqual([]);
    const cov = await cursorAgentsProvider.coverage!({ tenantId: T, executor: db as never });
    expect(cov.find((x) => x.scope.endsWith(":agents"))!.state).toBe("complete");
    expect(cov.find((x) => x.scope.endsWith(":conversations"))!.state).toBe("complete");
  });

  it("accepts only correctly signed webhooks for the URL's connection, deduplicates by X-Webhook-ID, and refuses after revoke", async () => {
    const c = await connect();
    const rival = await connect(T2);
    const body = JSON.stringify({ event: "statusChange", timestamp: "2026-10-01T00:00:00Z", id: "bc_7", status: "FINISHED" });
    const sign = (secret: string, raw = body) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyCursorWebhookSignature(c.secret, body, sign(c.secret))).toBe(true);
    const app = createCursorAgentsWebhook({ executor: db as never });
    const send = (id: string, sig: string, raw = body, hid = "wh-1") => app.request(`/${id}`, { method: "POST", headers: { "x-webhook-signature": sig, "x-webhook-id": hid, "x-webhook-event": "statusChange" }, body: raw });
    expect((await send(c.id, sign(rival.secret))).status).toBe(401);
    expect((await send(c.id, sign(c.secret), body.replace("FINISHED", "ERROR"))).status).toBe(401);
    expect((await send(c.id, sign(c.secret))).status).toBe(200);
    expect(await (await send(c.id, sign(c.secret))).json()).toMatchObject({ received: true, duplicate: true });
    expect((await raws()).map((r) => [r.source_event_id, r.user_id])).toEqual([["cursor_background_agents:webhook:wh-1", T]]);
    expect((await query(`SELECT kind FROM task_queue WHERE tenant_id = $1 AND kind = 'cursor_agents.sync' AND dedupe_key LIKE '%webhook'`, [T])).length).toBe(1);
    await disconnectCursorAgents({ tenantId: T });
    expect((await send(c.id, sign(c.secret), body, "wh-2")).status).toBe(401);
    expect((await cursorAgentsProvider.coverage!({ tenantId: T, executor: db as never }))[0]).toMatchObject({ state: "blocked" });
  });

  it("is registered and keeps the donor parser contract", () => {
    expect(integrationById("cursor_background_agents")).toBe(cursorAgentsIntegration);
    expect(defaultRegistry().extraTable("cursor_agents_snapshots")?.provider).toBe(cursorAgentsProvider);
    expect(() => parseCursorAgent({ name: "x" })).toThrow(/missing id/);
    expect(parseCursorAgent({ id: "bc_1", target: { url: "" } }).target.url).toBeUndefined();
  });
});
