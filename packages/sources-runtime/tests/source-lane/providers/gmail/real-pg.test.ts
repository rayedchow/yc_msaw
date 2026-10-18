import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeGmail } from "./fake-gmail.js";
import { FakePublishStore, bindingToken } from "./harness-publish.js";

/**
 * Gmail lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster): the full
 * source-lane migration plan, journal triggers on generated keys, numeric history-id ordering,
 * the cross-tenant mailbox lease under real concurrency, and the exporter. Creates and drops its
 * own database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const credentialMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/vault/google-auth.js")>()),
  getGoogleApiCredential: credentialMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};
const MB = "pg-shared@corp.example";

describe.skipIf(!PG)("gmail source lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `gmail_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.sync = await import("../../../../src/integrations/gmail/source-sync.js");
    mods.store = await import("../../../../src/integrations/gmail/source-store.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
    mods.gmail = await import("../../../../src/source-lane/providers/gmail/index.js");
    mods.auth = await import("../../../../src/vault/google-auth.js");
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await sql?.end({ timeout: 5 });
    try {
      const client = await import("../../../../src/db/client.js");
      await (client as Any).pgClient?.end?.({ timeout: 5 });
    } catch {
      // client may not have been created
    }
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("captures, orders history numerically, serialises one mailbox across tenants and exports through the journal", async () => {
    const fake = new FakeGmail();
    // History ids near 2^53 are compared as SQL numeric / BigInt, never as lossy JS arithmetic.
    const big = 9_007_199_254_740_900;
    fake.mailbox(MB, big);
    fake.token(`tok:${MB}`, MB);
    for (const id of ["p1", "p2", "p3"]) fake.addMessage(MB, { id, date: new Date(`2026-02-0${id.slice(1)}T08:00:00Z`) });
    vi.stubGlobal("fetch", fake.fetch);
    credentialMock.mockImplementation(async (_t: string, mailbox: string) => ({
      kind: "access_token", accessToken: `tok:${mailbox}`, mode: "domain_wide_delegation", account: mailbox, quotaUser: mods.auth.googleQuotaUser(mailbox, "dwd:sa"),
    }));
    for (const t of ["pg-t1", "pg-t2"]) {
      await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES (${t}, 'google', ${MB}, 'active')`;
    }

    // Real concurrency: both tenants race for the same mailbox; exactly one holds the lease at a time.
    const [a, b] = await Promise.all([
      mods.sync.runGmailSourceBackfill("pg-t1", { continueWork: false }),
      mods.sync.runGmailSourceBackfill("pg-t2", { continueWork: false }),
    ]);
    const outcomes = [a.mailboxes[0].outcome, b.mailboxes[0].outcome].sort();
    expect(outcomes).toEqual(["busy", "ok"]);
    const loser = a.mailboxes[0].outcome === "busy" ? "pg-t1" : "pg-t2";
    expect((await mods.sync.runGmailSourceBackfill(loser, { continueWork: false })).mailboxes[0].outcome).toBe("ok");

    fake.removeLabels(MB, "p1", ["UNREAD"]);
    await mods.sync.runGmailSourcePoll("pg-t1", { continueWork: false });
    const [row] = await sql`SELECT label_ids, label_history_id::text AS h FROM gmail_source_messages WHERE tenant_id = 'pg-t1' AND message_id = 'p1'`;
    expect(row.label_ids).toEqual(["INBOX"]);
    expect(BigInt(row.h)).toBeGreaterThan(BigInt(big));
    const state = await mods.store.getSyncState(mods.db.db, "pg-t1", MB);
    expect(state.historyId).toBe(String(fake.mailbox(MB).historyId));
    expect(state.fullCompleteGeneration).toBe(1);

    // Journal triggers fired on the generated source_key; the exporter publishes them.
    const journal = await sql`SELECT DISTINCT table_name FROM source_lane_journal WHERE tenant_id = 'pg-t1' ORDER BY table_name`;
    expect(journal.map((r: Any) => r.table_name)).toEqual(["gmail_source_history_pages", "gmail_source_messages", "gmail_source_threads"]);
    const store = new FakePublishStore();
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: "pg-t1", bindingId: "sb-0123456789abcdef", token: bindingToken("pg-t1"), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: new mods.registry.SourceProviderRegistry([mods.gmail.gmailProvider]), fetchImpl: store.fetch, log: () => {} });
    for (let i = 0; i < 10; i++) if ((await exporter.runOnce()).claimed === 0) break;
    expect(store.find(/\/messages\/2026-02\/p1\/state\.json$/)).toHaveLength(1);
    expect(store.json(store.find(/p1\/state\.json$/)[0]!).labelIds).toEqual(["INBOX"]);
    expect(store.find(/\/inbox\/2026\/02\//)).toHaveLength(3);
    expect(store.find(/\.eml$/)).toHaveLength(3);
    // Tenant isolation: pg-t2 rows were not exported into pg-t1's binding.
    expect(store.paths().every((p) => p.startsWith(`sources/gmail/${MB}/`))).toBe(true);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = 'pg-t1'`)[0].n).toBe(0);
  });
});
