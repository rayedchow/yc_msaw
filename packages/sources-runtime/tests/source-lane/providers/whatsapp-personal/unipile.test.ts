import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { whatsappPersonalLane, whatsappPersonalIntegration } from "../../../../src/integrations/whatsapp-personal/index.js";
import { instagramPersonalLane } from "../../../../src/integrations/instagram-personal/index.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import type { UnipileMessage } from "../../../../src/integrations/unipile-personal/api.js";

/**
 * Unipile personal lanes (coordinator port of gigabrain 5448774 whatsapp-personal / instagram-personal):
 * operator opt-in, readiness gate, resumable paging with overlap dedupe, donor source identities, immutable
 * versions, Retry-After persisted beyond the donor's 60 s cap, per-connection webhook ownership, deletions,
 * bounded exact attachment bytes, export and truthful coverage. Synthetic data only.
 */
const T = "tenant-unipile";
const T2 = "tenant-unipile-rival";
const BASE = "https://api1.unipile.com:13111/api/v1";
const KEY = "unipile-test-key-123";
const ENV = { UNIPILE_PERSONAL_CONNECTORS_ENABLED: "1", SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test" } as NodeJS.ProcessEnv;

class FakeUnipile {
  accounts: Record<string, Record<string, unknown>> = {
    acc_wa: { id: "acc_wa", type: "WHATSAPP", name: "Ana", sources: [{ status: "OK" }] },
    acc_ig: { id: "acc_ig", type: "INSTAGRAM", name: "ana.ig", sources: [{ status: "OK" }] },
  };
  chats: Record<string, Array<{ id: string; name: string }>> = { acc_wa: [{ id: "chat1", name: "Bo" }, { id: "chat2", name: "Team" }], acc_ig: [{ id: "igchat", name: "Cy" }] };
  messages = new Map<string, UnipileMessage[]>([["chat1", []], ["chat2", []], ["igchat", []]]);
  files = new Map<string, Buffer>();
  calls: URL[] = [];
  /** Hosted-auth link requests (the only POST the lane may send). */
  links: Array<Record<string, unknown>> = [];
  hooks: Array<(url: URL) => Response | undefined> = [];
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(url);
    const method = (init?.method ?? "GET").toUpperCase();
    expect(method === "GET" || (method === "POST" && url.pathname.endsWith("/hosted/accounts/link"))).toBe(true);
    expect(init?.redirect).toBe("error");
    if (new Headers(init?.headers).get("x-api-key") !== KEY) return json({ title: "Unauthorized" }, 401);
    if (method === "POST") {
      this.links.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ object: "HostedAuthURL", url: `https://account.unipile.com/hosted-${this.links.length}` });
    }
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    const p = url.pathname.replace(/^\/api\/v1/, "");
    let m = /^\/accounts\/([^/]+)$/.exec(p);
    if (m) return this.accounts[m[1]!] ? json(this.accounts[m[1]!]) : json({}, 404);
    if (p === "/chats") return json({ items: this.chats[url.searchParams.get("account_id")!] ?? [], cursor: null });
    m = /^\/chats\/([^/]+)\/messages$/.exec(p);
    if (m) {
      const all = [...(this.messages.get(m[1]!) ?? [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
      const after = url.searchParams.get("after");
      let list = all;
      if (after) {
        const at = Number(all.find((x) => x.id === after)?.timestamp ?? 0);
        list = all.filter((x) => Number(x.timestamp) > at);
      }
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const items = list.slice(start, start + limit);
      return json({ items, cursor: start + limit < list.length ? String(start + limit) : null });
    }
    m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(p);
    if (m) {
      const bytes = this.files.get(m[2]!);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } }) : json({}, 404);
    }
    return json({}, 404);
  };
  add(chat: string, n: number, extra: (i: number) => Partial<UnipileMessage> = () => ({})) {
    const list = this.messages.get(chat)!;
    const start = list.length;
    for (let i = 0; i < n; i++) {
      const k = start + i;
      list.push({ id: `${chat}-m${k}`, chat_id: chat, text: `hello ${k}`, sender_id: "peer", timestamp: 1_800_000_000 + k, ...extra(k) });
    }
  }
}

let fake: FakeUnipile;
const deps = (env = ENV) => ({ fetchImpl: fake.fetch, executor: db as never, env });

/** Starts a hosted-auth link for `tenant`; Unipile's notify then reports `accountId` as created through it. */
async function startLink(lane = whatsappPersonalLane, tenant = T, body: Record<string, unknown> = {}) {
  const r = await lane.connect({ tenantId: tenant, body: { apiKey: KEY, apiBase: BASE, ...body } }, deps());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const b = r.body as { link: { id: string; url: string }; webhook: { url: string; secret: string } };
  return { linkId: b.link.id, name: String(fake.links.at(-1)!.name), id: /\/(up_[0-9a-f]{24})$/.exec(b.webhook.url)![1]!, secret: b.webhook.secret, url: b.webhook.url };
}
function notify(lane: typeof whatsappPersonalLane, linkId: string, payload: Record<string, unknown>) {
  return lane.webhook({ executor: db as never, fetchImpl: fake.fetch }).request(`/hosted/${linkId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
async function connect(lane = whatsappPersonalLane, accountId = "acc_wa", tenant = T, body: Record<string, unknown> = {}) {
  const l = await startLink(lane, tenant, body);
  const n = await notify(lane, l.linkId, { status: "CREATION_SUCCESS", account_id: accountId, name: l.name });
  expect(n.status).toBe(200);
  expect(await n.json()).toMatchObject({ connected: true });
  return l;
}
async function due(table = "whatsapp_personal_connections") {
  await pg.exec(`UPDATE ${table} SET retry_at = NULL, lease_until = NULL`);
}
const msgs = (t = "whatsapp_personal_messages") => query<{ message_id: string; deleted: boolean; deleted_reason: string | null; payload: Record<string, unknown> }>(`SELECT message_id, deleted, deleted_reason, payload FROM ${t} ORDER BY message_ts, message_id`);
const raw = (source = "whatsapp_personal") => query<{ source_event_id: string; event_type: string; user_id: string }>(`SELECT source_event_id, event_type, user_id FROM activity_events WHERE source = $1 ORDER BY source_event_id`, [source]);

function hook(lane: typeof whatsappPersonalLane, connectionId: string, payload: unknown, secret: string) {
  return lane.webhook({ executor: db as never }).request(`/${connectionId}`, { method: "POST", headers: { "x-unipile-secret": secret, "content-type": "application/json" }, body: JSON.stringify(payload) });
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  for (const p of ["whatsapp_personal", "instagram_personal"]) await pg.exec(`DELETE FROM ${p}_attachments; DELETE FROM ${p}_messages; DELETE FROM ${p}_chats; DELETE FROM ${p}_connections;`);
  await pg.exec(`DELETE FROM unipile_personal_hosted_links`);
  await pg.exec(`DELETE FROM activity_events WHERE source IN ('whatsapp_personal','instagram_personal'); DELETE FROM task_queue; DELETE FROM task_schedules; DELETE FROM connections; DELETE FROM source_lane_journal;`);
  fake = new FakeUnipile();
  vi.stubEnv("UNIPILE_PERSONAL_CONNECTORS_ENABLED", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("connect", () => {
  it("requires the operator opt-in, verifies the account read-only, and returns a per-connection webhook secret once", async () => {
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: KEY, apiBase: BASE } }, deps({} as NodeJS.ProcessEnv))).body).toMatchObject({ error: { code: "experimental_connector_disabled" } });
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: "wrong-key-000", apiBase: BASE } }, deps())).body).toMatchObject({ error: { code: "unipile_auth_failed" } });
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: KEY, apiBase: "https://evil.example.com" } }, deps())).status).toBe(400);
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: KEY, tenantId: T2 } }, deps())).status).toBe(400);
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: KEY, apiBase: BASE } }, deps({ UNIPILE_PERSONAL_CONNECTORS_ENABLED: "1" } as NodeJS.ProcessEnv))).body).toMatchObject({ error: { code: "public_url_required" } });
    // An Instagram account reported through a WhatsApp link is refused.
    const ig = await startLink();
    expect(await (await notify(whatsappPersonalLane, ig.linkId, { status: "CREATION_SUCCESS", account_id: "acc_ig", name: ig.name })).json()).toMatchObject({ connected: false, failure: "account_type_mismatch" });
    const c = await connect();
    expect(fake.links.at(-1)).toMatchObject({ type: "create", providers: ["WHATSAPP"], api_url: "https://api1.unipile.com:13111" });
    expect(String(fake.links.at(-1)!.notify_url)).toMatch(/^https:\/\/runtime\.example\.test\/webhooks\/whatsapp-personal\/hosted\/upl_[0-9a-f]{24}$/);
    expect(c.url).toBe(`https://runtime.example.test/webhooks/whatsapp-personal/${c.id}`);
    const [row] = await query<{ api_key_ciphertext: string; webhook_secret_sha256: string }>(`SELECT api_key_ciphertext, webhook_secret_sha256 FROM whatsapp_personal_connections`);
    expect(row!.api_key_ciphertext).not.toContain(KEY);
    expect(row!.webhook_secret_sha256).not.toBe(c.secret);
    expect(JSON.stringify(await whatsappPersonalLane.listConnections(T, db as never))).not.toContain(c.secret);
  });
});

describe("sync", () => {
  it("waits for the readiness gate (CONNECTING stores nothing and retries)", async () => {
    fake.accounts.acc_wa!.sources = [{ status: "CONNECTING" }];
    fake.add("chat1", 3);
    await connect();
    const r = await whatsappPersonalLane.sync(T, deps());
    expect(r[0]).toMatchObject({ status: "not_ready", reason: "connecting" });
    expect(await msgs()).toEqual([]);
    const [c] = await query<{ retry_at: string }>(`SELECT retry_at FROM whatsapp_personal_connections`);
    expect(Date.parse(c!.retry_at)).toBeGreaterThan(Date.now() + 30_000);
  });

  it("backfills resumably with the donor identities, polls forward, dedupes overlaps and versions changed messages", async () => {
    vi.stubEnv("UNIPILE_PAGES_PER_RUN", "2");
    fake.add("chat1", 250);
    await connect();
    await whatsappPersonalLane.sync(T, deps({ ...ENV, UNIPILE_PAGES_PER_RUN: "2" }));
    expect((await msgs()).length).toBe(100); // chats page + one message page
    for (let i = 0; i < 6; i++) {
      await due();
      await whatsappPersonalLane.sync(T, deps({ ...ENV, UNIPILE_PAGES_PER_RUN: "2" }));
    }
    expect((await msgs()).length).toBe(250);
    const [chat] = await query<{ backfill_complete_at: string | null; newest_message_id: string }>(`SELECT backfill_complete_at, newest_message_id FROM whatsapp_personal_chats WHERE chat_id = 'chat1'`);
    expect(chat!.backfill_complete_at).not.toBeNull();
    expect(chat!.newest_message_id).toBe("chat1-m249");
    expect((await raw()).filter((r) => r.source_event_id.startsWith("whatsapp_personal:chat1:"))).toHaveLength(250);

    // Forward: new messages only via `after`; a changed (reacted) message gets an immutable version row.
    fake.add("chat1", 2);
    fake.messages.get("chat1")![249] = { ...fake.messages.get("chat1")![249]!, reactions: [{ value: "👍" }] };
    await due();
    await whatsappPersonalLane.sync(T, deps());
    expect((await msgs()).length).toBe(252);
    expect(fake.calls.some((u) => u.searchParams.get("after") === "chat1-m249")).toBe(true);
    // Overlap: re-reading the same messages stores nothing new.
    const before = (await raw()).length;
    await pg.exec(`UPDATE whatsapp_personal_chats SET backfill_complete_at = NULL, backfill_cursor = NULL`);
    await due();
    await whatsappPersonalLane.sync(T, deps({ ...ENV, UNIPILE_PAGES_PER_RUN: "50" }));
    await due();
    await whatsappPersonalLane.sync(T, deps({ ...ENV, UNIPILE_PAGES_PER_RUN: "50" }));
    const after = await raw();
    expect(after.length - before).toBe(1); // only the version of the reacted message
    expect(after.some((r) => /^whatsapp_personal:chat1:chat1-m249:v:[0-9a-f]{16}$/.test(r.source_event_id))).toBe(true);
    expect((await msgs()).find((m) => m.message_id === "chat1-m249")!.payload.reactions).toEqual([{ value: "👍" }]);
  });

  it("persists Retry-After beyond 60 s without sleeping, and selected-conversation mode reads only chosen chats", async () => {
    fake.add("chat1", 3);
    fake.add("chat2", 3);
    const c = await connect(whatsappPersonalLane, "acc_wa", T, { selectedChatIds: ["chat2"] });
    fake.hooks.push((url) => (url.pathname.endsWith("/chats/chat2/messages") ? new Response("{}", { status: 429, headers: { "retry-after": "300" } }) : undefined));
    const t0 = Date.now();
    const r = await whatsappPersonalLane.sync(T, deps());
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r[0]).toMatchObject({ status: "rate_limited" });
    const [row] = await query<{ retry_at: string }>(`SELECT retry_at FROM whatsapp_personal_connections WHERE id = $1`, [c.id]);
    expect(Date.parse(row!.retry_at) - t0).toBeGreaterThanOrEqual(299_000);
    fake.hooks = [];
    await due();
    await whatsappPersonalLane.sync(T, deps());
    expect((await msgs()).map((m) => m.message_id).every((id) => id.startsWith("chat2-"))).toBe(true);
    expect(fake.calls.some((u) => u.pathname.endsWith("/chats/chat1/messages"))).toBe(false);
  });

  it("stores attachment bytes exactly from the API host and keeps oversized ones metadata-only", async () => {
    vi.stubEnv("UNIPILE_ATTACHMENT_MAX_BYTES", "1000");
    fake.files.set("att-small", Buffer.from([0, 1, 2, 255, 254]));
    fake.files.set("att-big", Buffer.alloc(5000, 7));
    fake.add("chat1", 1, () => ({ attachments: [{ id: "att-small", mimetype: "image/png" }, { id: "att-big" }] }));
    await connect();
    await whatsappPersonalLane.sync(T, deps({ ...ENV, UNIPILE_ATTACHMENT_MAX_BYTES: "1000" }));
    const atts = await query<{ attachment_id: string; state: string; bytes: Uint8Array | null }>(`SELECT attachment_id, state, bytes FROM whatsapp_personal_attachments ORDER BY attachment_id`);
    expect(atts.map((a) => [a.attachment_id, a.state])).toEqual([["att-big", "too_large"], ["att-small", "stored"]]);
    expect(Buffer.from(atts[1]!.bytes!)).toEqual(Buffer.from([0, 1, 2, 255, 254]));
    const [attExport] = whatsappPersonalLane.exports().slice(1);
    const [{ id }] = await query<{ id: string }>(`SELECT id FROM whatsapp_personal_attachments WHERE attachment_id = 'att-small'`);
    const [put] = await attExport!.map({ tenantId: T, executor: db as never }, id!, { op: "INSERT", enqueuedAt: new Date().toISOString() }, []);
    expect(put).toMatchObject({ op: "put", kind: "binary", path: "sources/whatsapp-personal/acc_wa/chat1/attachments/chat1-m0/att-small" });
    const cov = await whatsappPersonalLane.coverage({ tenantId: T, executor: db as never });
    expect(cov.find((x) => x.scope.endsWith(":attachments"))).toMatchObject({ state: "partial", counts: { stored: 1, metadataOnly: 1 } });
  });
});

describe("webhooks", () => {
  it("bind the tenant through the connection URL + secret, store events with donor ids, and tombstone deletions", async () => {
    const c = await connect();
    const rival = await connect(whatsappPersonalLane, "acc_wa", T2);
    const payload = { event: "message_received", account_id: "acc_wa", chat_id: "chat1", message: { id: "w1", chat_id: "chat1", text: "hi", sender_id: "peer", timestamp: 1_800_000_100 } };
    expect((await hook(whatsappPersonalLane, c.id, payload, "wrong")).status).toBe(401);
    expect((await hook(whatsappPersonalLane, c.id, payload, rival.secret)).status).toBe(401);
    expect((await hook(whatsappPersonalLane, c.id, { ...payload, account_id: "acc_other" }, c.secret)).status).toBe(401);
    expect(await (await hook(whatsappPersonalLane, c.id, payload, c.secret)).json()).toEqual({ received: true, stored: true });
    expect(await (await hook(whatsappPersonalLane, c.id, payload, c.secret)).json()).toEqual({ received: true, stored: false });
    expect((await raw()).map((r) => [r.source_event_id, r.user_id])).toEqual([["whatsapp_personal:chat1:w1", T]]);

    await hook(whatsappPersonalLane, c.id, { event: "message_deleted", account_id: "acc_wa", chat_id: "chat1", message: { id: "w1", chat_id: "chat1" } }, c.secret);
    expect((await raw()).map((r) => r.source_event_id)).toEqual(["whatsapp_personal:chat1:w1", "whatsapp_personal:chat1:w1:message_deleted"]);
    expect((await msgs()).find((m) => m.message_id === "w1")).toMatchObject({ deleted: true, deleted_reason: "message_deleted" });

    await hook(whatsappPersonalLane, c.id, { AccountStatus: { account_id: "acc_wa", message: "CREDENTIALS" } }, c.secret);
    expect((await whatsappPersonalLane.listConnections(T, db as never))[0]!.sourceStatus).toBe("CREDENTIALS");
    await whatsappPersonalIntegration.disconnect!({ tenantId: T });
    expect((await hook(whatsappPersonalLane, c.id, payload, c.secret)).status).toBe(401);
  });

  it("Instagram keeps the donor's message-only webhook semantics and always-partial history", async () => {
    const c = await connect(instagramPersonalLane, "acc_ig");
    await hook(instagramPersonalLane, c.id, { event: "message_received", account_id: "acc_ig", chat_id: "igchat", message: { id: "i1", chat_id: "igchat", text: "yo", sender_id: "acc_ig", timestamp: 1_800_000_000 } }, c.secret);
    await hook(instagramPersonalLane, c.id, { event: "message_reaction", account_id: "acc_ig", chat_id: "igchat", message: { id: "i1", chat_id: "igchat" } }, c.secret);
    expect((await raw("instagram_personal")).map((r) => [r.source_event_id, r.event_type])).toEqual([["instagram_personal:igchat:i1", "message_sent"]]);
    fake.add("igchat", 2);
    await instagramPersonalLane.sync(T, deps());
    const cov = await instagramPersonalLane.coverage({ tenantId: T, executor: db as never });
    expect(cov.find((x) => x.scope.endsWith(":history"))).toMatchObject({ state: "partial" });
    expect(cov.find((x) => x.scope.endsWith(":history"))!.reason).toMatch(/limited recent slice/);
    expect(cov.find((x) => x.scope.endsWith(":forward"))!.state).toBe("complete");
  });
});

describe("registration and export", () => {
  it("registers both connectors and modules and maps messages to files per tenant", async () => {
    expect(integrationById("whatsapp_personal")).toBeTruthy();
    expect(integrationById("instagram_personal")).toBeTruthy();
    const reg = defaultRegistry();
    expect(reg.extraTable("whatsapp_personal_messages")?.provider.id).toBe("whatsapp-personal");
    expect(reg.extraTable("instagram_personal_messages")?.provider.id).toBe("instagram-personal");
    fake.add("chat1", 1);
    await connect();
    await whatsappPersonalLane.sync(T, deps());
    const [{ id }] = await query<{ id: string }>(`SELECT id FROM whatsapp_personal_messages`);
    const [msgExport] = whatsappPersonalLane.exports();
    const journal = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const [put] = await msgExport!.map({ tenantId: T, executor: db as never }, id!, journal, []);
    expect(put).toMatchObject({ op: "put", path: "sources/whatsapp-personal/acc_wa/chat1/2027-01/chat1-m0.json" });
    expect(await msgExport!.map({ tenantId: T2, executor: db as never }, id!, journal, [])).toEqual([]);
    vi.stubEnv("UNIPILE_PERSONAL_CONNECTORS_ENABLED", "0");
    expect((await whatsappPersonalLane.coverage({ tenantId: T, executor: db as never }))[0]).toMatchObject({ state: "blocked" });
    expect((await whatsappPersonalLane.sync(T, deps({} as NodeJS.ProcessEnv)))[0]).toMatchObject({ status: "disabled" });
  });
});

describe("owner scopes (personal-connection-attribution)", () => {
  it("lets each member connect their own account; another member of the organization cannot attach an account already connected", async () => {
    const { ensurePersonalScope } = await import("../../../../src/source-lane/core/personal-scope.js");
    const bob = await ensurePersonalScope(db as never, { tenantNs: T, issuer: "https://issuer.test", subject: "user_bob" });
    const carol = await ensurePersonalScope(db as never, { tenantNs: T, issuer: "https://issuer.test", subject: "user_carol" });
    const bobLink = await connect(whatsappPersonalLane, "acc_wa", bob.scopeTenantId);
    // Holding the (workspace-wide) Unipile key is not proof of whose account it is: bob's account stays bob's.
    const r = await whatsappPersonalLane.connect({ tenantId: carol.scopeTenantId, body: { apiKey: KEY, accountId: "acc_wa", apiBase: BASE } }, deps());
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "hosted_auth_required" } });
    // Even a notify naming bob's account through carol's own link cannot move it.
    const carolLink = await startLink(whatsappPersonalLane, carol.scopeTenantId);
    expect(await (await notify(whatsappPersonalLane, carolLink.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: carolLink.name })).json()).toMatchObject({ connected: false, failure: "account_connected_by_another_member" });
    // A replayed notify for bob's consumed link is refused, and carol cannot read bob's link status.
    expect((await notify(whatsappPersonalLane, bobLink.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: bobLink.name })).status).toBe(409);
    expect((await whatsappPersonalLane.connect({ tenantId: carol.scopeTenantId, body: { linkId: bobLink.linkId } }, deps())).status).toBe(404);
    expect(await query("SELECT tenant_id FROM whatsapp_personal_connections WHERE account_id = 'acc_wa'")).toEqual([{ tenant_id: bob.scopeTenantId }]);
    // Another organization is a different tenant: its own member connects normally.
    const dave = await ensurePersonalScope(db as never, { tenantNs: T2, issuer: "https://issuer.test", subject: "user_dave" });
    await connect(whatsappPersonalLane, "acc_wa", dave.scopeTenantId);
  });
});

describe("hosted auth (owner-acl-reaudit-2 NEW-3)", () => {
  it("attaches only the account Unipile reports for this member's own unexpired, single-use link", async () => {
    // A workspace API key plus a colleague's linked account id is refused outright.
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { apiKey: KEY, accountId: "acc_wa", apiBase: BASE } }, deps())).body).toMatchObject({ error: { code: "hosted_auth_required" } });
    const l = await startLink(whatsappPersonalLane, T, { selectedChatIds: ["chat1"] });
    expect(fake.links.at(-1)!.name).not.toBe(l.linkId);
    expect(await query("SELECT name_sha256 FROM unipile_personal_hosted_links")).not.toContainEqual({ name_sha256: l.name });
    // A forged notify without the secret name, or with another link's name, attaches nothing.
    expect((await notify(whatsappPersonalLane, l.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa" })).status).toBe(401);
    const other = await startLink(whatsappPersonalLane, T2);
    expect((await notify(whatsappPersonalLane, l.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: other.name })).status).toBe(401);
    expect((await notify(instagramPersonalLane, l.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: l.name })).status).toBe(404);
    expect(await query("SELECT count(*)::int AS n FROM whatsapp_personal_connections")).toEqual([{ n: 0 }]);
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { linkId: l.linkId } }, deps())).body).toMatchObject({ link: { status: "pending" }, connection: null });
    // Unipile's real notify connects it to the link's own tenant, with the link's chat selection; the key is moved off the link.
    expect(await (await notify(whatsappPersonalLane, l.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: l.name })).json()).toMatchObject({ connected: true });
    expect(await query("SELECT id, tenant_id, sync_mode, selected_chat_ids FROM whatsapp_personal_connections")).toEqual([{ id: l.id, tenant_id: T, sync_mode: "selected_conversations", selected_chat_ids: ["chat1"] }]);
    expect(await query("SELECT status, account_id, api_key_ciphertext FROM unipile_personal_hosted_links WHERE id = $1", [l.linkId])).toEqual([{ status: "connected", account_id: "acc_wa", api_key_ciphertext: "" }]);
    expect((await whatsappPersonalLane.connect({ tenantId: T, body: { linkId: l.linkId } }, deps())).body).toMatchObject({ link: { status: "connected" }, connection: { id: l.id, accountId: "acc_wa" } });
    // The webhook secret handed out with the link authenticates deliveries for the connection.
    expect((await hook(whatsappPersonalLane, l.id, { event: "message_received", account_id: "acc_wa", chat_id: "chat1", message_id: "w1", message: "hi", timestamp: 1_800_000_100 }, l.secret)).status).toBe(200);
    // Expired links attach nothing.
    const late = await startLink();
    await pg.exec(`UPDATE unipile_personal_hosted_links SET expires_at = now() - interval '1 second' WHERE id = '${late.linkId}'`);
    expect((await notify(whatsappPersonalLane, late.linkId, { status: "CREATION_SUCCESS", account_id: "acc_wa", name: late.name })).status).toBe(410);
    expect(await query("SELECT count(*)::int AS n FROM whatsapp_personal_connections")).toEqual([{ n: 1 }]);
  });
});
