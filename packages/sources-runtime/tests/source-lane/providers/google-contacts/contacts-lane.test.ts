import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CONTACTS_FULL_SYNC_PAGES_PER_RUN = "2";
});
vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../google-calendar/harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => {
  const h = await import("../google-calendar/harness.js");
  return {
    ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
    getGoogleApiCredential: vi.fn(async (tenant: string, account: string | undefined, scopes: readonly string[]) => h.syntheticCredential(tenant, account, scopes)),
    isDelegationConfigured: () => h.auth.delegationConfigured,
  };
});

import { FakeGoogle, auth, connectMailbox, db, fakePublish, inlineText, json, mintBindingToken, query, ready, resetTenant } from "../google-calendar/harness.js";
import { runGoogleContactsSync } from "../../../../src/integrations/google/contacts/jobs.js";
import { googleContactsProvider } from "../../../../src/source-lane/providers/google-contacts/index.js";
import { contactPaths, renderContactMarkdown } from "../../../../src/source-lane/providers/google-contacts/export.js";
import { DEFAULT_CONNECTION_PERSON_FIELDS } from "../../../../src/source-lane/providers/google-contacts/sync.js";
import { calendarProvider } from "../../../../src/source-lane/providers/calendar/index.js";
import { clearGoogleLaneDirectoryCacheForTests } from "../../../../src/source-lane/providers/calendar/google-lane.js";
import { SOURCE_PROVIDERS } from "../../../../src/source-lane/providers/index.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { GoogleOAuthScopeError } from "../../../../src/vault/google-oauth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";

const T = "tenant-con-a";
const T2 = "tenant-con-b";
const MB = "ana@acme.test";
const MB2 = "bo@acme.test";
const registry = new SourceProviderRegistry([calendarProvider, googleContactsProvider]);
let fake: FakeGoogle;
let clock = Date.parse("2026-10-01T00:00:00Z");

function person(id: string, name: string, email: string, over: Record<string, any> = {}) {
  clock += 60_000;
  return {
    resourceName: `people/${id}`,
    etag: `%E${clock}`,
    metadata: { sources: [{ type: "CONTACT", id, etag: `#${clock}`, updateTime: new Date(clock).toISOString() }], ...(over.metadata ?? {}) },
    names: [{ displayName: name, metadata: { primary: true } }],
    emailAddresses: [{ value: email, type: "work" }],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "metadata")),
  };
}

function other(id: string, name: string, email: string) {
  return { resourceName: `otherContacts/${id}`, etag: `%O${id}`, metadata: { sources: [{ type: "OTHER_CONTACT", id }] }, names: [{ displayName: name }], emailAddresses: [{ value: email }] };
}

const run = (tenant = T, opts: Parameters<typeof runGoogleContactsSync>[1] = {}) => runGoogleContactsSync(tenant, opts);

async function contacts(tenant = T, mailbox = MB) {
  return query<{ id: string; endpoint: string; resource_name: string; state: string; merged_into: string | null; display_name: string }>(
    `SELECT id::text, endpoint, resource_name, state, merged_into, display_name FROM google_contact_snapshots WHERE tenant_id = $1 AND mailbox = $2 ORDER BY endpoint, resource_name`,
    [tenant, mailbox],
  );
}

async function cursorOf(endpoint: string, tenant = T, mailbox = MB) {
  const [row] = await query(`SELECT * FROM google_contact_lane_cursors WHERE tenant_id = $1 AND mailbox = $2 AND endpoint = $3`, [tenant, mailbox, endpoint]);
  return row;
}

async function exportAll(tenant = T): Promise<Array<Record<string, any>>> {
  const published: Array<Record<string, any>> = [];
  const binding = mintBindingToken(tenant);
  await setTenantBinding(db as never, { tenantId: tenant, bindingId: binding.bindingId, token: binding.token, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry, fetchImpl: fakePublish(published), log: () => {} });
  for (let i = 0; i < 30; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return published;
  }
  throw new Error("exporter did not drain");
}

const coverage = (tenant = T) => googleContactsProvider.coverage!({ tenantId: tenant, executor: db as never });

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T, T2);
  resetGoogleRateLimitCooldownsForTests();
  clearGoogleLaneDirectoryCacheForTests();
  auth.failures.clear();
  auth.failureFor = null;
  auth.delegationConfigured = false;
  fake = new FakeGoogle();
  vi.stubGlobal("fetch", fake.fetch);
  await connectMailbox(T, MB);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("google-contacts module", () => {
  it("registers next to every existing source provider without collisions", () => {
    const all = new SourceProviderRegistry([...SOURCE_PROVIDERS.filter((m) => m.id !== "google-contacts"), googleContactsProvider]);
    expect(all.get("google-contacts")).toBe(googleContactsProvider);
    expect(all.extraTable("google_contact_snapshots")?.provider).toBe(googleContactsProvider);
    expect(all.extraTable("google_calendar_event_snapshots")?.provider.id).toBe("calendar");
    expect(all.forEventSource("calendar")?.id).toBe("calendar");
  });
});

describe("resumable initial listing and incremental sync tokens", () => {
  it("checkpoints pages, commits the sync token after the last page and derives the donor names table", async () => {
    for (const [id, name] of [["c1", "Rivera, Sam"], ["c2", "Lee Kim"], ["c3", "Ana Ortiz"], ["c4", "Bo Chan"], ["c5", "Cy Dale"]]) {
      fake.putPerson(T, MB, "connections", person(id!, name!, `${id}@ext.test`));
    }
    fake.putPerson(T, MB, "otherContacts", other("o1", "Auto Sam", "c1@ext.test"));
    fake.putPerson(T, MB, "otherContacts", other("o2", "Only Other", "o2@ext.test"));

    const r1 = await run();
    expect(r1.capHit).toBe(true);
    let c = await cursorOf("connections");
    expect(c.sync_token).toBeNull();
    expect(c.full_sync_page_token).toBe("ppp:4");
    expect((await coverage()).find((x) => x.scope === `mailbox:${MB}/connections`)!.state).toBe("partial");
    const firstCall = fake.calls.find((x) => x.url.pathname === "/v1/people/me/connections")!;
    expect(firstCall.url.searchParams.get("personFields")).toBe(DEFAULT_CONNECTION_PERSON_FIELDS);
    expect(firstCall.url.searchParams.get("requestSyncToken")).toBe("true");
    expect(firstCall.url.searchParams.get("personFields")).not.toMatch(/photos/);

    const mark = fake.calls.length;
    await run();
    const resumed = fake.calls.slice(mark).find((x) => x.url.pathname === "/v1/people/me/connections")!;
    expect(resumed.url.searchParams.get("pageToken")).toBe("ppp:4");
    c = await cursorOf("connections");
    expect(c.sync_token).toMatch(/^pp:\d+$/);
    expect((await cursorOf("other_contacts")).sync_token).toMatch(/^pp:\d+$/);
    expect((await contacts()).filter((x) => x.state === "active")).toHaveLength(7);

    // Donor names table: saved contact beats the auto-collected name; comma name swapped.
    const names = await query<{ email: string; display_name: string; source: string }>(
      `SELECT email, display_name, source FROM google_contact_names WHERE tenant_id = $1 ORDER BY email`, [T],
    );
    expect(names.find((n) => n.email === "c1@ext.test")).toMatchObject({ display_name: "Sam Rivera", source: "connections" });
    expect(names.find((n) => n.email === "o2@ext.test")).toMatchObject({ display_name: "Only Other", source: "other_contacts" });

    expect((await coverage()).find((x) => x.scope === `mailbox:${MB}/connections`)).toMatchObject({ state: "complete" });

    // Incremental: one changed contact, nothing re-listed.
    fake.putPerson(T, MB, "connections", person("c2", "Lee Kim", "c2@ext.test", { phoneNumbers: [{ value: "+1 555 0100", type: "mobile" }] }));
    const mark2 = fake.calls.length;
    const r3 = await run();
    expect(r3.contactsChanged).toBe(1);
    const inc = fake.calls.slice(mark2).filter((x) => x.url.pathname === "/v1/people/me/connections");
    expect(inc).toHaveLength(1);
    expect(inc[0]!.url.searchParams.get("syncToken")).toBe(c.sync_token);

    const published = await exportAll();
    const paths = contactPaths(MB, "connections", "people/c2");
    const md = published.filter((x) => x.op === "put" && x.path === paths.md).at(-1)!;
    expect(inlineText(md)).toContain("+1 555 0100 (mobile)");
    const raw = JSON.parse(inlineText(published.filter((x) => x.op === "put" && x.path === paths.json).at(-1)!));
    expect(raw.person.phoneNumbers).toEqual([{ value: "+1 555 0100", type: "mobile" }]);
    const rev = published.map((x) => (x.op === "put" && x.path.includes("--connections--c2--r") ? JSON.parse(inlineText(x)) : null)).filter((x) => x?.op === "updated")[0];
    expect(rev.diff.map((d: any) => d.path)).toEqual(expect.arrayContaining(["/phoneNumbers", "/etag"]));
    expect(published.some((x) => x.path.startsWith("sources/google-contacts/accounts/ana@acme.test/other-contacts/o1."))).toBe(true);
  });
});

describe("deletions, merges and resets", () => {
  beforeEach(async () => {
    fake.pageSize = 50;
    fake.putPerson(T, MB, "connections", person("c1", "Sam Rivera", "sam@ext.test"));
    fake.putPerson(T, MB, "connections", person("c2", "Samuel Rivera", "samuel@ext.test"));
    fake.putPerson(T, MB, "connections", person("c3", "Lee Kim", "lee@ext.test"));
    await run();
    await exportAll();
  });

  it("tombstones deleted contacts and keeps their history", async () => {
    fake.putPerson(T, MB, "connections", { resourceName: "people/c3", etag: "%gone", metadata: { deleted: true } });
    const r = await run();
    expect(r.contactsDeleted).toBe(1);
    expect((await contacts()).find((x) => x.resource_name === "people/c3")!.state).toBe("deleted");
    const published = await exportAll();
    const paths = contactPaths(MB, "connections", "people/c3");
    expect(published.filter((x) => x.op === "delete").map((x) => [x.path, x.reason]).sort()).toEqual([[paths.json, "deleted"], [paths.md, "deleted"]]);
    const revs = await query<{ op: string }>(`SELECT op FROM google_contact_revisions WHERE tenant_id = $1 AND resource_name = 'people/c3' ORDER BY id`, [T]);
    expect(revs.map((x) => x.op)).toEqual(["created", "deleted"]);
  });

  it.each([
    ["deleted resource first", true],
    ["surviving resource first", false],
  ])("records a Google merge as merged_into the surviving resource (%s)", async (_label, deletedFirst) => {
    const survivor = person("c2", "Samuel Rivera", "samuel@ext.test", {
      metadata: { previousResourceNames: ["people/c1"] },
      emailAddresses: [{ value: "samuel@ext.test" }, { value: "sam@ext.test" }],
    });
    const gone = { resourceName: "people/c1", etag: "%merged", metadata: { deleted: true } };
    if (deletedFirst) {
      fake.putPerson(T, MB, "connections", gone);
      fake.putPerson(T, MB, "connections", { ...survivor, resourceName: "people/c2" });
    } else {
      fake.putPerson(T, MB, "connections", { ...survivor, resourceName: "people/c2" });
      fake.putPerson(T, MB, "connections", gone);
    }
    // Fake orders by resourceName (c1 before c2); reorder the page when the survivor comes first.
    if (!deletedFirst) fake.hooks.push(({ url }) => {
      if (url.pathname !== "/v1/people/me/connections" || !url.searchParams.get("syncToken")) return undefined;
      return json({ connections: [{ ...survivor, resourceName: "people/c2" }, gone], nextSyncToken: `pp:${fake.seq}` });
    });
    await run();
    const rows = await contacts();
    expect(rows.find((x) => x.resource_name === "people/c1")).toMatchObject({ state: "merged", merged_into: "people/c2" });
    expect(rows.find((x) => x.resource_name === "people/c2")).toMatchObject({ state: "active" });
    const published = await exportAll();
    const old = contactPaths(MB, "connections", "people/c1");
    expect(published.filter((x) => x.op === "delete" && x.path === old.json).map((x) => x.reason)).toEqual(["merged_into:people/c2"]);
    const merged = published.map((x) => (x.op === "put" && x.path.includes("--connections--c1--r") ? JSON.parse(inlineText(x)) : null)).find((x) => x?.op === "merged");
    expect(merged).toMatchObject({ state: "merged", mergedInto: "people/c2", resourceName: "people/c1" });
  });

  it("re-lists after an expired sync token and removes contacts the listing no longer returns", async () => {
    const before = await contacts();
    fake.account(T, MB).people.connections.delete("people/c3"); // gone without a deletion marker we could see
    fake.putPerson(T, MB, "connections", person("c1", "Sam R.", "sam@ext.test"));
    fake.expirePeopleSyncTokens(T, MB, "connections");
    const r = await run();
    expect(r.resets).toBe(1);
    expect(r.contactsRemoved).toBe(1);
    const rows = await contacts();
    expect(rows.find((x) => x.resource_name === "people/c3")!.state).toBe("removed");
    expect(rows.find((x) => x.resource_name === "people/c1")).toMatchObject({ state: "active", display_name: "Sam R." });
    expect(rows.find((x) => x.resource_name === "people/c2")!.id).toBe(before.find((x) => x.resource_name === "people/c2")!.id);
    expect((await cursorOf("connections")).sync_token).toMatch(/^pp:/);
    const published = await exportAll();
    expect(published.find((x) => x.op === "delete" && x.path === contactPaths(MB, "connections", "people/c3").json)?.reason).toBe("removed_from_full_listing");
    // Restored when it reappears.
    fake.putPerson(T, MB, "connections", person("c3", "Lee Kim", "lee@ext.test"));
    await run();
    expect((await contacts()).find((x) => x.resource_name === "people/c3")!.state).toBe("active");
    expect((await query<{ op: string }>(`SELECT op FROM google_contact_revisions WHERE tenant_id = $1 AND resource_name = 'people/c3' ORDER BY id`, [T])).map((x) => x.op))
      .toEqual(["created", "removed", "restored"]);
  });

  it("re-lists from scratch when the configured field mask changes", async () => {
    process.env.GOOGLE_CONTACTS_PERSON_FIELDS = "names,emailAddresses";
    try {
      await run();
      const c = await cursorOf("connections");
      expect(c.field_mask).toBe("emailAddresses,names,metadata");
      expect(c.sync_token).toMatch(/^pp:/);
      const call = fake.calls.filter((x) => x.url.pathname === "/v1/people/me/connections").at(-1)!;
      expect(call.url.searchParams.get("syncToken")).toBeNull();
    } finally {
      delete process.env.GOOGLE_CONTACTS_PERSON_FIELDS;
    }
  });
});

describe("per-endpoint auth, quota and tenant isolation", () => {
  it("blocks only the endpoint whose scope is missing", async () => {
    fake.putPerson(T, MB, "connections", person("c1", "Sam Rivera", "sam@ext.test"));
    auth.failureFor = (_t, account, scopes) =>
      scopes.includes("https://www.googleapis.com/auth/contacts.other.readonly") ? new GoogleOAuthScopeError(account, ["https://www.googleapis.com/auth/contacts.other.readonly"]) : undefined;
    const r = await run();
    expect(r.endpointsComplete).toBe(1);
    expect(r.endpointsBlocked).toBe(1);
    const reports = await coverage();
    expect(reports.find((x) => x.scope === `mailbox:${MB}/connections`)!.state).toBe("complete");
    expect(reports.find((x) => x.scope === `mailbox:${MB}/other_contacts`)).toMatchObject({ state: "blocked" });
    expect(reports.find((x) => x.scope === "roster")!.state).toBe("blocked");
  });

  it("isolates a People API 429 to that mailbox and honours Retry-After", async () => {
    await connectMailbox(T, MB2);
    fake.putPerson(T, MB2, "connections", person("b1", "Bee", "bee@ext.test"));
    fake.hooks.push(({ account }) => (account === `${T}:${MB}` ? json({ error: { code: 429, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 429, { "Retry-After": "300" }) : undefined));
    const r = await run();
    expect(r.mailboxesRateLimited).toBe(1);
    expect((await contacts(T, MB2)).map((x) => x.resource_name)).toEqual(["people/b1"]);
    const [status] = await query(`SELECT state, next_attempt_at FROM google_source_mailbox_status WHERE tenant_id = $1 AND lane = 'contacts' AND mailbox = $2`, [T, MB]);
    expect(status.state).toBe("rate_limited");
    expect(new Date(status.next_attempt_at).getTime() - Date.now()).toBeGreaterThanOrEqual(299_000);
    const mark = fake.calls.length;
    await run();
    expect(fake.calls.slice(mark).some((x) => x.account === `${T}:${MB}`)).toBe(false);
  });

  it("keeps same-named mailboxes of two tenants apart", async () => {
    fake.pageSize = 50;
    await connectMailbox(T2, MB);
    fake.putPerson(T, MB, "connections", person("c1", "Tenant A Person", "a@ext.test"));
    fake.putPerson(T2, MB, "connections", person("c1", "Tenant B Person", "b@ext.test"));
    await run(T);
    await run(T2);
    fake.putPerson(T2, MB, "connections", { resourceName: "people/c1", metadata: { deleted: true } });
    await run(T2);
    expect((await contacts(T)).map((x) => [x.state, x.display_name])).toEqual([["active", "Tenant A Person"]]);
    expect((await contacts(T2)).map((x) => x.state)).toEqual(["deleted"]);
    const [a] = await contacts(T);
    expect(await googleContactsProvider.extraTables![0]!.map({ tenantId: T2, executor: db as never }, a!.id, { op: "UPDATE", enqueuedAt: new Date().toISOString() }, [])).toEqual([]);
    const published = await exportAll(T);
    expect(published.some((x) => JSON.stringify(x).includes("Tenant B"))).toBe(false);
    expect((await query(`SELECT 1 FROM google_contact_names WHERE tenant_id = $1 AND email = 'b@ext.test'`, [T]))).toEqual([]);
  });
});

describe("readable projection", () => {
  it("renders a contact card from the stored payload", () => {
    const md = renderContactMarkdown({
      resourceName: "people/c9",
      names: [{ displayName: "Dana Wu" }],
      emailAddresses: [{ value: "dana@ext.test", type: "home" }],
      phoneNumbers: [{ value: "+44 20 7946 0000", type: "work" }],
      organizations: [{ name: "Acme", title: "CTO" }],
    }, { mailbox: MB, endpoint: "connections", resourceName: "people/c9", sourceUpdatedAt: "2026-10-01T00:00:00.000Z" });
    expect(md).toContain("# Dana Wu");
    expect(md).toContain("- **Emails:** dana@ext.test (home)");
    expect(md).toContain("- **Phones:** +44 20 7946 0000 (work)");
    expect(md).toContain("- **Organizations:** CTO, Acme");
    expect(md).toContain("saved contact of ana@acme.test");
  });
});
