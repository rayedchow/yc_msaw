import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enroll, events, ingest, message, mirror, query, ready, resetTenant, type Enrolled } from "./harness.js";

/**
 * Cases from the donor receiver suite (gigabrain@5448774e brain/tests/routes/imessage-ingest.test.ts)
 * that the source lane keeps: classification, blocked service handles, DM counterpart
 * derivation, groups, membership, stickers/audio/effects, replies, attachment placeholders.
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

async function month(conversationPrefix: string): Promise<string> {
  const f = (await mirror(T)).find((x) => x.path.includes(conversationPrefix) && x.path.endsWith("/2026-09.md"));
  if (!f) throw new Error(`no month file under ${conversationPrefix}: ${(await mirror(T)).map((x) => x.path).join(", ")}`);
  return f.content;
}

describe("donor parity", () => {
  it("skips messages involving Shepherd-owned service handles (not stored, not rejected)", async () => {
    const r = await ingest(d, [message({ messageId: "G-BLOCK", chatId: "iMessage;-;+13054098546", participant: "+13054098546" }), message({ messageId: "G-OK" })]);
    expect(r).toMatchObject({ stored: 1, skipped: 1, rejected: 0 });
    expect((await events(T)).map((e) => e.raw_payload.messageId)).toEqual(["G-OK"]);
    expect(await query(`SELECT 1 FROM imessage_ingest_rejections WHERE tenant_id = $1`, [T])).toHaveLength(0);
  });

  it("derives the DM counterpart for a sent message without participant and renders it as me", async () => {
    await ingest(d, [message({ messageId: "G-SENT", isFromMe: true, participant: null, text: "on my way" })]);
    const [row] = await events(T);
    expect(row!.event_type).toBe("message_sent");
    expect(row!.raw_payload).toMatchObject({ participant: "+15550001111", _normalized_conversation_id: "imessage:dm:+15550001111", _counterpart_handle: "+15550001111" });
    expect(await month("-chat-")).toContain("** me: on my way");
  });

  it("handles group messages, membership changes and renames", async () => {
    const group = { chatId: "iMessage;+;chat777", chatKind: "group", chatName: "Climbing Crew" };
    await ingest(d, [
      message({ ...group, messageId: "G-G1", rowId: 1, participant: "+15550002222", text: "who's in for saturday" }),
      message({ ...group, messageId: "G-G2", rowId: 2, kind: "memberAdded", text: null, participant: "+15550002222", affectedParticipant: "+15550003333", createdAt: "2026-09-10T12:01:00.000Z" }),
      message({ ...group, messageId: "G-G3", rowId: 3, kind: "nameChanged", text: null, newGroupName: "Crag Crew", createdAt: "2026-09-10T12:02:00.000Z" }),
    ]);
    const rows = await events(T);
    expect(rows.map((r) => r.event_type)).toEqual(["group_message", "member_added", "name_changed"]);
    expect(rows[0]!.raw_payload._normalized_conversation_id).toBe("imessage:group:iMessage;+;chat777");
    const md = await month("crag-crew-chat-");
    expect(md).toContain("Conversation type: group");
    expect(md).toContain("added +15550003333 to the conversation");
    expect(md).toContain("renamed the conversation to “Crag Crew”");
  });

  it("classifies stickers and audio and renders effects, replies and services", async () => {
    await ingest(d, [
      message({ messageId: "G-S1", rowId: 1, text: "see you there", service: "SMS", sendEffect: "com.apple.MobileSMS.expressivesend.impact" }),
      message({ messageId: "G-S2", rowId: 2, text: null, attachments: [{ id: "st", fileName: "sticker.heic", mimeType: "image/heic", isSticker: true }], createdAt: "2026-09-10T12:01:00.000Z" }),
      message({ messageId: "G-S3", rowId: 3, text: null, isAudioMessage: true, attachments: [{ id: "au", fileName: "Audio Message.caf", mimeType: "audio/x-caf" }], createdAt: "2026-09-10T12:02:00.000Z" }),
      message({ messageId: "G-S4", rowId: 4, text: "yes!", service: "RCS", replyToMessageId: "G-S1", threadRootMessageId: "G-S1", createdAt: "2026-09-10T12:03:00.000Z" }),
    ]);
    expect((await events(T)).map((r) => r.event_type)).toEqual(["message_received", "sticker", "audio_message", "message_received"]);
    const md = await month("-chat-");
    expect(md).toContain("see you there (sent with effect impact)");
    expect(md).toContain("[attachment: sticker.heic (image/heic, sticker); metadata only]");
    expect(md).toContain("[audio message]");
    expect(md).toContain("↩ reply to “see you there”: yes!");
  });

  it("updates a placeholder when attachment metadata becomes available, with history", async () => {
    await ingest(d, [message({ messageId: "G-P", text: null, hasAttachments: true, attachments: [] })]);
    expect(await month("-chat-")).toContain("[attachment; details not uploaded]");
    const r = await ingest(d, [message({ messageId: "G-P", text: null, hasAttachments: true, attachments: [{ id: "a1", fileName: "IMG_7.JPG", mimeType: "image/jpeg", sizeBytes: 2048, transferStatus: "complete" }] })]);
    expect(r).toMatchObject({ updated: 1 });
    const [m] = await query<{ kinds: string[] }>(`SELECT kinds FROM imessage_message_mutations WHERE tenant_id = $1`, [T]);
    expect(m!.kinds).toContain("attachments");
    expect(await month("-chat-")).toContain("[attachment: IMG_7.JPG (image/jpeg, 2 KB); metadata only]");
  });
});
