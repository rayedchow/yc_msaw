import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enroll, events, ingest, message, mirror, query, ready, resetTenant, wire, type Enrolled } from "./harness.js";

/**
 * Edit / unsend history in the raw row and the mutation ledger, tapbacks, contact binding,
 * and the conversation/month projection rendered from them.
 */

const T = "acme";
let d: Enrolled;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T);
  d = await enroll(T);
});

async function monthFile(month = "2026-09"): Promise<string> {
  const f = (await mirror(T)).find((x) => x.path.endsWith(`/${month}.md`));
  if (!f) throw new Error(`no projection for ${month}: ${(await mirror(T)).map((x) => x.path).join(", ")}`);
  return f.content;
}

async function mutations() {
  return query<{ kinds: string[]; previous_payload: Record<string, any>; uploaded: Record<string, any>; binding_id: string }>(
    `SELECT kinds, previous_payload, uploaded, binding_id FROM imessage_message_mutations WHERE tenant_id = $1 ORDER BY observed_at`,
    [T],
  );
}

describe("edits and unsends", () => {
  it("keeps every edited version in the row, the mutation ledger and the projection", async () => {
    await ingest(d, [message({ messageId: "G-E", text: "first draft" })]);
    await ingest(d, [message({ messageId: "G-E", text: "second draft", editedAt: "2026-09-10T12:05:00.000Z" })]);
    await ingest(d, [message({ messageId: "G-E", text: "final text", editedAt: "2026-09-10T12:09:00.000Z" })]);
    // Replaying the last state is a no-op.
    expect(await ingest(d, [message({ messageId: "G-E", text: "final text", editedAt: "2026-09-10T12:09:00.000Z" })])).toMatchObject({ skipped: 1, updated: 0 });

    const [row] = await events(T);
    expect(row!.raw_payload).toMatchObject({
      text: "final text",
      _original_text: "first draft",
      _edit_history: [
        { text: "first draft", at: "2026-09-10T12:05:00.000Z" },
        { text: "second draft", at: "2026-09-10T12:09:00.000Z" },
      ],
      _retracted: false,
    });
    const m = await mutations();
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.previous_payload.text)).toEqual(["first draft", "second draft"]);
    expect(m[0]!.kinds).toEqual(expect.arrayContaining(["text", "edit"]));
    expect(m[1]!.uploaded.text).toBe("final text");

    const md = await monthFile();
    expect(md).toContain("final text (edited 09-10 12:09)");
    expect(md).toContain("earlier version (replaced 09-10 12:05): “first draft”");
    expect(md).toContain("earlier version (replaced 09-10 12:09): “second draft”");
    // Lifecycle: rendered rows are mirrored.
    expect(row!.processing_status).toBe("mirrored");
  });

  it("renders an unsent message as unsent with the text it had, also after an edit, and never rolls back on a stale replay", async () => {
    await ingest(d, [message({ messageId: "G-U", text: "oops" })]);
    await ingest(d, [message({ messageId: "G-U", text: "oops, fixed", editedAt: "2026-09-10T12:01:00.000Z" })]);
    await ingest(d, [message({ messageId: "G-U", text: null, editedAt: "2026-09-10T12:01:00.000Z", retractedAt: "2026-09-10T12:02:00.000Z" })]);
    let [row] = await events(T);
    expect(row!.record_kind).toBe("tombstone");
    expect(row!.event_type).toBe("message_unsent");
    expect(row!.raw_payload).toMatchObject({ _retracted: true, _original_text: "oops", _text_before_unsend: "oops, fixed", text: null });

    // An older observation (another Mac, a queued retry) arrives late: state does not regress,
    // but its alias evidence is kept.
    const late = await ingest(d, [message({ messageId: "G-U", text: "oops", chatId: "SMS;-;+15550001111" })]);
    expect(late.updated).toBe(1);
    [row] = await events(T);
    expect(row!.raw_payload).toMatchObject({ _retracted: true, text: null, _text_before_unsend: "oops, fixed" });
    expect(row!.raw_payload._observed_raw_chat_ids).toContain("SMS;-;+15550001111");
    const m = await mutations();
    expect(m.at(-1)!.kinds).toEqual(["alias"]);

    const md = await monthFile();
    expect(md).toContain("[unsent 09-10 12:02]");
    expect(md).toContain("text before unsend: “oops, fixed”");
    expect(md).toContain("earlier version (replaced 09-10 12:01): “oops”");
    // The unsend is not an edit: no fake "earlier version" for the last text.
    expect(md).not.toContain("earlier version (replaced 09-10 12:01): “oops, fixed”");
    expect(row!.raw_payload._edit_history).toEqual([{ text: "oops", at: "2026-09-10T12:01:00.000Z" }]);
    expect(md).not.toMatch(/\*\* \+15550001111: oops/u);
  });

  it("says when the pre-unsend text was never captured", async () => {
    await ingest(d, [message({ messageId: "G-U0", text: null, retractedAt: "2026-09-10T12:02:00.000Z" })]);
    expect(await monthFile()).toContain("text before unsend was not captured");
  });
});

describe("tapbacks", () => {
  const target = { messageId: "G-T", text: "dinner at 8?" };
  const tap = (over: Record<string, unknown>) =>
    message({ kind: "reaction", text: null, participant: "+15550001111", ...over, reaction: { kind: "love", targetMessageId: "p:0/G-T", emoji: null, isRemoved: false, textRange: null, appBundleId: null, ...(over.reaction as object) } });

  it("renders reactions against their target and keeps current reactions as added minus removed", async () => {
    await ingest(d, [message({ ...target, isFromMe: true, rowId: 1 })]);
    await ingest(d, [tap({ messageId: "G-R1", rowId: 2, createdAt: "2026-09-10T12:01:00.000Z" })]);
    let rows = await events(T);
    expect(rows.find((r) => r.raw_payload.messageId === "G-R1")!.event_type).toBe("tapback");
    let md = await monthFile();
    expect(md).toContain("❤️ Loved “dinner at 8?”");
    expect(md).toContain("reactions: ❤️ +15550001111");
    expect(md).not.toContain("[object Object]");
    expect(md).not.toContain('{"kind"');

    await ingest(d, [tap({ messageId: "G-R2", rowId: 3, createdAt: "2026-09-10T12:02:00.000Z", reaction: { isRemoved: true } })]);
    rows = await events(T);
    expect(rows.find((r) => r.raw_payload.messageId === "G-R2")!.event_type).toBe("tapback_removed");
    md = await monthFile();
    expect(md).toContain("removed ❤️ (loved) from “dinner at 8?”");
    expect(md).not.toMatch(/^\s+- reactions:/mu);
  });

  it("re-renders the target's month when a reaction arrives in a later month", async () => {
    await ingest(d, [message({ ...target, rowId: 1, createdAt: "2026-08-31T23:59:00.000Z" })]);
    expect(await monthFile("2026-08")).not.toMatch(/^\s+- reactions:/mu);
    await ingest(d, [tap({ messageId: "G-R3", rowId: 2, createdAt: "2026-09-01T00:01:00.000Z", reaction: { kind: "laugh" }, isFromMe: true })]);
    expect(await monthFile("2026-08")).toContain("reactions: 😂 me");
    expect(await monthFile("2026-09")).toContain("😂 Laughed at “dinner at 8?”");
  });
});

describe("contacts and local status", () => {
  it("binds synced contact names to handles, exports contacts.json and re-renders affected conversations", async () => {
    await ingest(d, [message({ messageId: "G-C", text: "hi" })]);
    const before = (await mirror(T)).map((f) => f.path);
    expect(before.some((p) => p.includes("/15550001111-chat-"))).toBe(true);

    const res = await wire("POST", "/sync-contacts", d, { userId: "ignored", contacts: [{ handle: "+1 (555) 000-1111", name: "Grace Hopper" }, { handle: "", name: "x" }, { name: "no handle" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: 1, invalid: 2, contactsProcessed: 3, affectedConversations: 1 });

    const files = await mirror(T);
    const contacts = JSON.parse(files.find((f) => f.path === "sources/imessage/contacts.json")!.content);
    expect(contacts.contacts[0]).toMatchObject({ handle: "+15550001111", name: "Grace Hopper" });
    // The conversation moved to its named directory; the old one is gone.
    expect(files.some((p) => p.path.includes("/grace-hopper-chat-"))).toBe(true);
    expect(files.some((p) => p.path.includes("/15550001111-chat-"))).toBe(false);
    expect(await monthFile()).toContain("Grace Hopper: hi");
    // Raw payloads stay as uploaded (no in-place rename).
    expect((await events(T))[0]!.raw_payload._resolved_name).toBeNull();
    // Unchanged re-sync stores nothing.
    expect(await (await wire("POST", "/sync-contacts", d, { contacts: [{ handle: "+15550001111", name: "Grace Hopper" }] })).json()).toMatchObject({ stored: 0, unchanged: 1 });
    expect((await wire("POST", "/sync-contacts", d, { contacts: "nope" })).status).toBe(400);
  });

  it("stores the device's local status for coverage", async () => {
    const res = await wire("POST", "/local-status", d, { status: { status: "running", queuedMessages: 12, deviceId: "11111111-1111-4111-8111-111111111111", agentVersion: "0.9.0-test" } });
    expect(res.status).toBe(200);
    const [dev] = await query<any>(`SELECT local_status, local_status_at FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]);
    expect(dev.local_status).toMatchObject({ status: "running", queuedMessages: 12 });
  });
});

describe("attachments", () => {
  it("keeps attachment metadata and says bytes were not uploaded", async () => {
    await ingest(d, [message({ messageId: "G-A", text: null, hasAttachments: true, attachments: [{ id: "att-1", fileName: "IMG_0001.HEIC", mimeType: "image/heic", sizeBytes: 2_500_000, transferStatus: "complete", isSticker: false }] })]);
    const [row] = await events(T);
    expect(row!.raw_payload.attachments[0]).toMatchObject({ fileName: "IMG_0001.HEIC", sizeBytes: 2_500_000 });
    expect(await monthFile()).toContain("[attachment: IMG_0001.HEIC (image/heic, 2.4 MB); metadata only]");
  });
});
