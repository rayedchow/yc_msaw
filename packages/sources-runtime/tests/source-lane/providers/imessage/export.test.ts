import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { db, enroll, ingest, message, mintBinding, query, ready, registry, resetTenant, wire, type Enrolled } from "./harness.js";

/**
 * The core exporter (journal -> provider mapping -> publish) over real iMessage ingest:
 * raw rows, the mutation and rejection ledgers, projections and their moves all reach the
 * yc_msaw publish protocol; the donor month layout is not exported.
 */

const T = "acme";
let d: Enrolled;
let published: Array<Record<string, any>>;
let exporter: SourceExporter;

function fakePublish(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "PUT" && url.pathname.startsWith("/v1/sources/blobs/")) return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/status-report") return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/publish") {
      const body = JSON.parse(String(init?.body)) as { batchId: string; changes: Array<Record<string, any>> };
      published.push(...body.changes);
      return Response.json({
        batchId: body.batchId,
        commitId: `c-${published.length}`,
        seq: published.length,
        results: body.changes.map((c) => ({ path: c.path, outcome: c.op === "put" ? "created" : "deleted", versionId: c.op === "put" ? `v-${c.sha256.slice(0, 8)}` : null })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return;
  }
  throw new Error("exporter did not drain");
}

function content(change: Record<string, any>): string {
  return Buffer.from(change.inline, "base64").toString("utf8");
}

function puts(prefix: string) {
  return published.filter((c) => c.op === "put" && c.path.startsWith(prefix));
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T);
  published = [];
  exporter = new SourceExporter({ db: db as never, registry, fetchImpl: fakePublish(), log: () => {} });
  const b = mintBinding(T);
  await setTenantBinding(db as never, { tenantId: T, bindingId: b.bindingId, token: b.bindingToken, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
  d = await enroll(T);
});

describe("iMessage export through the core journal", () => {
  it("publishes raw rows, mutation history, rejections and projections", async () => {
    await ingest(d, [message({ messageId: "G-X", text: "v1" }), { not: "a message" }]);
    await drain();
    const raw = puts("sources/imessage/_raw/");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.kind).toBe("raw");
    expect(raw[0]!.path).toMatch(/^sources\/imessage\/_raw\/[^/]+\/2026-09\/[^/]+\.json$/u);
    expect(content(raw[0]!)).toContain('"v1"');
    expect(raw[0]!.provenance).toMatchObject({ table: "activity_events", sourceEventId: "imessage:message:G-X" });
    const rejected = puts("sources/imessage/_rejected/");
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(content(rejected[0]!))).toMatchObject({ schema: "procmem.imessage.rejected-upload/v1", reason: "messageId is required", uploaded: { not: "a message" } });
    const month = puts("sources/imessage/conversations/").find((c) => c.path.endsWith("/2026-09.md"))!;
    expect(month.kind).toBe("projection");
    expect(content(month)).toContain("v1");
    expect(puts("sources/imessage/conversations/").some((c) => c.path.endsWith("/conversation.json"))).toBe(true);

    // An edit: new raw state, the previous state as a mutation file, and a re-rendered month.
    published = [];
    await ingest(d, [message({ messageId: "G-X", text: "v2", editedAt: "2026-09-10T12:30:00.000Z" })]);
    await drain();
    expect(content(puts("sources/imessage/_raw/").find((c) => !c.path.includes("/_mutations/"))!)).toContain('"v2"');
    const mutation = puts("sources/imessage/_raw/").find((c) => c.path.includes("/_mutations/"))!;
    const m = JSON.parse(content(mutation));
    expect(m).toMatchObject({ schema: "procmem.imessage.mutation/v1", kinds: expect.arrayContaining(["text", "edit"]), previous_payload: { text: "v1" }, uploaded: { text: "v2" } });
    expect(content(puts("sources/imessage/conversations/").find((c) => c.path.endsWith("/2026-09.md"))!)).toContain("earlier version");
  });

  it("publishes deletes when a conversation's projection moves, and keeps archived duplicates as raw", async () => {
    await ingest(d, [message({ messageId: "G-M", text: "hello" })]);
    await drain();
    const oldDir = puts("sources/imessage/conversations/")[0]!.path.split("/").slice(0, 4).join("/");
    published = [];
    await wire("POST", "/sync-contacts", d, { contacts: [{ handle: "+15550001111", name: "Grace Hopper" }] });
    await drain();
    const deletes = published.filter((c) => c.op === "delete").map((c) => c.path);
    expect(deletes).toEqual(expect.arrayContaining([`${oldDir}/2026-09.md`, `${oldDir}/conversation.json`]));
    expect(puts("sources/imessage/conversations/grace-hopper-chat-").length).toBeGreaterThanOrEqual(2);
    expect(puts("sources/imessage/contacts.json")).toHaveLength(1);

    // A pre-existing donor duplicate gets archived (source imessage_alias) and is still exported raw.
    await query(
      `INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id)
       VALUES ($1, 'imessage', 'message_received', '2026-09-10T12:00:00Z', $2::jsonb, 'imessage:iMessage;-;+15550001111:G-M')`,
      [T, JSON.stringify(message({ messageId: "G-M", text: "hello" }))],
    );
    published = [];
    await ingest(d, [message({ messageId: "G-M", text: "hello", chatId: "SMS;-;+15550001111" })]);
    await drain();
    const archived = puts("sources/imessage/_raw/").find((c) => c.provenance?.archivedDuplicate === true);
    expect(archived).toBeTruthy();
    expect(content(archived!)).toContain("_archived_duplicate_source");
  });

  it("does not export the donor month renderer's layout", async () => {
    await query(`INSERT INTO mirror_files (path, user_id, content) VALUES ('sources/imessage/2026-09/grace.md', $1, '- reaction: {"kind":"love"}')`, [T]);
    await drain();
    expect(published.filter((c) => c.path === "sources/imessage/2026-09/grace.md")).toEqual([]);
  });
});
