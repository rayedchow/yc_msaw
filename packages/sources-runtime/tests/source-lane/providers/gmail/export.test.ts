import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
const credentialMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/vault/google-auth.js")>()),
  getGoogleApiCredential: credentialMock,
}));

import { bindingToken, connectMailbox, db, FakePublishStore, query, ready, resetAll } from "./harness.js";
import { FakeGmail } from "./fake-gmail.js";
import { googleQuotaUser } from "../../../../src/vault/google-auth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { runGmailSourceBackfill, runGmailSourcePoll } from "../../../../src/integrations/gmail/source-sync.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { gmailProvider } from "../../../../src/source-lane/providers/gmail/index.js";
import { gmailCoverage } from "../../../../src/source-lane/providers/gmail/coverage.js";

const T = "tenant-gx";
const MB = "ada@corp.example";
const ROOT = `sources/gmail/${MB}`;
let fake: FakeGmail;
let store: FakePublishStore;
let exporter: SourceExporter;

async function drain(ex = exporter): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const r = await ex.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return;
  }
  throw new Error("exporter did not drain");
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(4096), Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);
const ZIP = Buffer.concat([Buffer.from("PK\u0003\u0004"), randomBytes(9000)]);
const LONG_BODY = `${"Quarterly numbers line. ".repeat(3_000)}THE-END-MARKER`;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetGoogleRateLimitCooldownsForTests();
  fake = new FakeGmail();
  fake.token(`tok:${MB}`, MB);
  credentialMock.mockReset().mockImplementation(async (_t: string, mailbox: string) => ({
    kind: "access_token", accessToken: `tok:${mailbox}`, mode: "oauth_direct", account: mailbox, quotaUser: googleQuotaUser(mailbox, "oauth:test-client"),
  }));
  vi.stubGlobal("fetch", fake.fetch);
  await connectMailbox(T, MB);
  store = new FakePublishStore();
  await setTenantBinding(db as never, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([gmailProvider]), fetchImpl: store.fetch, log: () => {} });

  fake.addMessage(MB, {
    id: "m1",
    threadId: "th1",
    from: "Grace Hopper <grace@partner.example>",
    subject: "Q3 numbers",
    date: new Date("2026-01-01T09:00:00Z"),
    text: LONG_BODY,
    attachments: [
      { filename: "report.pdf", mimeType: "application/pdf", bytes: PDF },
      { filename: "logo.png", mimeType: "image/png", bytes: PNG, inline: true, contentId: "<logo@x>" },
      { filename: "archive.zip", mimeType: "application/zip", bytes: ZIP },
    ],
  });
  fake.addMessage(MB, { id: "m2", threadId: "th1", from: `Ada <${MB}>`, to: "grace@partner.example", subject: "Re: Q3 numbers", date: new Date("2026-01-02T09:00:00Z"), labels: ["SENT"] });
  fake.addMessage(MB, {
    id: "m3",
    subject: "signed link",
    date: new Date("2026-01-03T09:00:00Z"),
    extraHeaders: [{ name: "X-Download", value: "https://storage.googleapis.com/bucket/file?X-Goog-Signature=abc123" }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail export to sources/gmail/<mailbox>/", () => {
  it("publishes exact raw JSON, RFC822 and attachment bytes, untruncated projections, threads and truthful coverage", async () => {
    await runGmailSourceBackfill(T, { config: { attachmentMaxBytes: 5_000 }, continueWork: false });
    await runGmailSourcePoll(T, { continueWork: false });
    await drain();

    const dir = `${ROOT}/messages/2026-01/m1`;
    // Raw message JSON = the stored post-redaction payload; attachment part bytes are not inlined.
    const [row] = await query<{ raw_json: string }>(`SELECT raw_json FROM gmail_source_messages WHERE message_id = 'm1'`);
    expect(store.text(`${dir}/message.json`)).toBe(row!.raw_json);
    const raw = store.json(`${dir}/message.json`);
    const parts = raw.payload.parts as Array<{ filename: string; body: Record<string, unknown> }>;
    expect(parts.find((p) => p.filename === "logo.png")!.body.data).toBeUndefined();
    expect(parts.find((p) => p.filename === "report.pdf")!.body.attachmentId).toBe("att-m1-0");
    expect(store.files.get(`${dir}/message.json`)!.kind).toBe("raw");

    // RFC822 exact bytes.
    const eml = store.files.get(`${dir}/message.eml`)!;
    expect(eml.bytes.equals(fake.mailbox(MB).messages.get("m1")!.raw)).toBe(true);
    expect(eml.contentType).toBe("message/rfc822");

    // Attachments are bytes (detached and inline), with provenance; the over-cap zip is metadata only.
    const pdf = store.files.get(`${dir}/attachments/1--report.pdf`)!;
    expect(pdf.bytes.equals(PDF)).toBe(true);
    expect(pdf.kind).toBe("binary");
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.provenance).toMatchObject({ mailbox: MB, messageId: "m1", threadId: "th1", partId: "1", filename: "report.pdf", capture: "attachments.get" });
    expect(store.files.get(`${dir}/attachments/2--logo.png`)!.bytes.equals(PNG)).toBe(true);
    expect(store.files.get(`${dir}/attachments/2--logo.png`)!.provenance).toMatchObject({ capture: "inline", contentId: "<logo@x>", disposition: "inline" });
    expect(store.find(/archive\.zip$/)).toEqual([]);
    const state = store.json(`${dir}/state.json`);
    expect(state.attachments.find((a: any) => a.filename === "archive.zip")).toMatchObject({ status: "skipped_oversize", path: null });
    expect(state).toMatchObject({ labelIds: ["INBOX", "UNREAD"], folder: "inbox", deleted: null, rfc822: { status: "captured" } });

    // Projection: donor placement under the mailbox, full body (donor truncated at 60k chars), links to bytes.
    const [projection] = store.find(new RegExp(`^${ROOT}/inbox/2026/01/2026-01-01--grace--q3-numbers--message-[0-9a-f]{12}\\.md$`));
    expect(projection).toBeTruthy();
    const md = store.text(projection!);
    expect(md.length).toBeGreaterThan(70_000);
    expect(md).toContain("THE-END-MARKER");
    expect(md).toContain("- Mailbox: ada@corp.example");
    expect(md).toContain("[report.pdf](../../../messages/2026-01/m1/attachments/1--report.pdf)");
    expect(md).toContain("archive.zip (application/zip, 9004 bytes) - bytes skipped oversize");
    expect(md).not.toContain("UNREAD"); // donor label policy: volatile labels stay out of the body
    expect(store.find(new RegExp(`^${ROOT}/sent/2026/01/`))).toHaveLength(1);

    // Thread view.
    const thread = store.text(`${ROOT}/threads/2026/01/th1.md`);
    expect(thread).toContain("- Messages: 2");
    expect(thread.indexOf("Grace Hopper")).toBeLessThan(thread.indexOf("Ada <"));

    // Redaction changed m3's JSON, so its exact RFC822 bytes are withheld instead of bypassing redaction.
    const m3 = store.json(`${ROOT}/messages/2026-01/m3/message.json`);
    expect(JSON.stringify(m3)).toContain("[redacted: credentialed ephemeral URL]");
    expect(JSON.stringify(m3)).not.toContain("X-Goog-Signature=abc123");
    expect(store.files.has(`${ROOT}/messages/2026-01/m3/message.eml`)).toBe(false);
    expect(store.json(`${ROOT}/messages/2026-01/m3/state.json`).rfc822.status).toBe("withheld_redaction");

    // No credentials or volatile requester URLs anywhere in the published tree.
    for (const p of store.paths()) {
      const f = store.files.get(p)!;
      if (f.kind === "binary" || p.endsWith(".eml")) continue;
      expect(f.bytes.toString("utf8")).not.toMatch(/tok:ada|Bearer /);
    }

    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]).toMatchObject({ scope: `mailbox:${MB}`, state: "partial" });
    expect(cov[0]!.reason).toContain("1 attachments over the size cap");
    expect(cov[0]!.reason).toContain("1 RFC822 files withheld");
    expect(cov[0]!.counts).toMatchObject({ messages: 3, attachmentsStored: 2, attachmentsOversize: 1, rfc822Captured: 2 });
  });

  it("moves projections on label changes, removes them on TRASH, tombstones deleted messages, and exports the raw history pages", async () => {
    await runGmailSourceBackfill(T, { continueWork: false });
    await runGmailSourcePoll(T, { continueWork: false });
    await drain();
    const inbox = store.find(new RegExp(`^${ROOT}/inbox/.*q3-numbers`))[0]!;
    expect(inbox).toBeTruthy();

    // Archive (INBOX removed) -> projection moves to archive/, old inbox path deleted.
    const archivedAt = fake.removeLabels(MB, "m1", ["INBOX"]);
    await runGmailSourcePoll(T, { continueWork: false });
    await drain();
    expect(store.files.has(inbox)).toBe(false);
    expect(store.deleted.get(inbox)?.reason).toBe("gmail_placement_changed");
    const archived = store.find(new RegExp(`^${ROOT}/archive/.*q3-numbers`));
    expect(archived).toHaveLength(1);
    const state = store.json(`${ROOT}/messages/2026-01/m1/state.json`);
    expect(state).toMatchObject({ labelIds: ["UNREAD"], folder: "archive", labelHistoryId: String(archivedAt) });
    expect(store.files.get(`${ROOT}/messages/2026-01/m1/state.json`)!.sourceVersion).toEqual({ ref: `gmail-history:${archivedAt}`, ordinal: archivedAt });
    const pages = store.find(new RegExp(`^${ROOT}/_history/\\d{4}-\\d{2}/\\d+\\.json$`));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const lastPage = store.json(pages[pages.length - 1]!);
    expect(lastPage.history.some((r: any) => r.labelsRemoved?.[0]?.labelIds?.[0] === "INBOX")).toBe(true);

    // TRASH -> projection removed (raw kept), thread marks it.
    fake.addLabels(MB, "m1", ["TRASH"]);
    await runGmailSourcePoll(T, { continueWork: false });
    await drain();
    expect(store.files.has(archived[0]!)).toBe(false);
    expect(store.deleted.get(archived[0]!)?.reason).toBe("gmail_label_trash");
    expect(store.files.has(`${ROOT}/messages/2026-01/m1/message.json`)).toBe(true);
    expect(store.json(`${ROOT}/messages/2026-01/m1/state.json`).projection).toEqual({ path: null, excludedBy: "TRASH" });
    expect(store.text(`${ROOT}/threads/2026/01/th1.md`)).toContain("(in Trash)");

    // Permanent deletion -> raw, RFC822 and attachment bytes tombstoned; state.json records the deletion.
    fake.deleteMessage(MB, "m1");
    await runGmailSourcePoll(T, { continueWork: false });
    await drain();
    const dir = `${ROOT}/messages/2026-01/m1`;
    for (const p of [`${dir}/message.json`, `${dir}/message.eml`, `${dir}/attachments/1--report.pdf`, `${dir}/attachments/2--logo.png`]) {
      expect(store.files.has(p), p).toBe(false);
      expect(store.deleted.get(p)?.reason, p).toBe("gmail_provider_deleted");
    }
    const tomb = store.json(`${dir}/state.json`);
    expect(tomb.deleted).toMatchObject({ reason: "provider_deleted" });
    expect(tomb.deleted.historyId).toBe(String(fake.mailbox(MB).historyId));
    const thread = store.text(`${ROOT}/threads/2026/01/th1.md`);
    expect(thread).toContain("- Messages: 1");
    expect(thread).not.toContain("Grace Hopper");

    // Re-export (rebuild) of every row reproduces the same current tree: labels/deletions are row state, not lost.
    const before = new Map([...store.files].map(([p, f]) => [p, f.bytes.toString("base64")]));
    await query(`DELETE FROM source_lane_exported`);
    await exporter.enqueueTenantBackfill(T);
    await drain();
    expect(new Map([...store.files].map(([p, f]) => [p, f.bytes.toString("base64")]))).toEqual(before);
  });

  it("keeps two tenants sharing one mailbox fully separate in storage and export", async () => {
    const T2 = "tenant-gy";
    await connectMailbox(T2, MB);
    await runGmailSourceBackfill(T, { continueWork: false });
    await runGmailSourceBackfill(T2, { continueWork: false });
    const store2 = new FakePublishStore();
    await setTenantBinding(db as never, { tenantId: T2, bindingId: "sb-0123456789abcdee", token: bindingToken(T2), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const fetchByToken: typeof fetch = async (input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return (auth.includes(`psb_${T2}.`) ? store2 : store).fetch(input, init);
    };
    const ex = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([gmailProvider]), fetchImpl: fetchByToken, log: () => {} });
    await drain(ex);
    expect(store.paths().length).toBeGreaterThan(5);
    expect(store2.paths()).toEqual(store.paths());
    // Byte stores are per tenant (no cross-tenant dedupe oracle).
    const chunks = await query<{ tenant_id: string; n: number }>(`SELECT tenant_id, count(*)::int AS n FROM gmail_source_chunks GROUP BY tenant_id ORDER BY tenant_id`);
    expect(chunks.map((c) => c.tenant_id)).toEqual([T, T2]);
    // Deleting the mailbox's message for T only affects T's rows.
    await query(`UPDATE gmail_source_messages SET deleted_at = now(), deleted_reason = 'provider_deleted' WHERE tenant_id = $1 AND message_id = 'm2'`, [T]);
    await drain(ex);
    expect(store.find(new RegExp(`^${ROOT}/sent/`))).toHaveLength(0);
    expect(store2.find(new RegExp(`^${ROOT}/sent/`))).toHaveLength(1);
  });
});
