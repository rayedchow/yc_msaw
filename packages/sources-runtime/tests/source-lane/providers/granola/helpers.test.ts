import { describe, expect, it } from "vitest";
import {
  clampGranolaWatermark,
  granolaComparableHash,
  granolaRetryAfterFromError,
  GRANOLA_WATERMARK_SAFETY_MS,
  parseGranolaRetryAfter,
} from "../../../../src/integrations/granola/poller.js";
import { granolaSpeakers } from "../../../../src/source-lane/providers/granola/export-map.js";
import { granolaInventoryKey } from "../../../../src/source-lane/providers/granola/state.js";

describe("Granola poller helpers (production functions)", () => {
  it("parses Retry-After as delta-seconds or HTTP-date, also from surfaced error messages", () => {
    const now = Date.parse("2026-10-18T00:00:00.000Z");
    expect(parseGranolaRetryAfter("7", now)).toBe(7_000);
    expect(parseGranolaRetryAfter("Sun, 18 Oct 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(parseGranolaRetryAfter(null, now)).toBeNull();
    expect(granolaRetryAfterFromError(new Error("Granola API failed (429); retry-after=Sun, 18 Oct 2026 00:05:00 GMT: slow: down"), now)).toBe(300_000);
    expect(granolaRetryAfterFromError(new Error("Granola MCP request failed (429); retry-after=30: x"), now)).toBe(30_000);
    expect(granolaRetryAfterFromError(new Error("Granola API failed (429): no header"), now)).toBe(0);
    expect(granolaRetryAfterFromError(new Error("Granola API failed (500): boom"), now)).toBeNull();
  });

  it("never lets the watermark pass run start minus the safety margin, nor move backwards", () => {
    const start = "2026-10-18T12:00:00.000Z";
    const bound = new Date(Date.parse(start) - GRANOLA_WATERMARK_SAFETY_MS).toISOString();
    expect(clampGranolaWatermark("2026-10-18T11:00:00.000Z", start, "2026-10-18T10:00:00.000Z")).toBe("2026-10-18T11:00:00.000Z");
    expect(clampGranolaWatermark("2026-10-18T11:59:30.000Z", start, "2026-10-18T10:00:00.000Z")).toBe(bound);
    expect(clampGranolaWatermark("2026-10-18T11:59:30.000Z", start, "2026-10-18T11:59:45.000Z")).toBe("2026-10-18T11:59:45.000Z");
    expect(clampGranolaWatermark("not a date", start, null)).toBeNull();
  });

  it("compares stored observations on provider content only (fetch metadata and key order ignored)", () => {
    const a = { id: "n1", title: "T", transcript: [{ text: "x", speaker: { source: "microphone" } }], api: { fetchedAt: "1" }, _content_hash: "a" };
    const b = { _content_hash: "b", api: { fetchedAt: "2" }, transcript: [{ speaker: { source: "microphone" }, text: "x" }], title: "T", id: "n1" };
    expect(granolaComparableHash(a)).toBe(granolaComparableHash(b));
    expect(granolaComparableHash({ ...a, transcript: [] })).not.toBe(granolaComparableHash(a));
  });

  it("lists transcript speakers exactly as labelled, and keys inventories by account and folder scope", () => {
    expect(granolaSpeakers([
      { speaker: { source: "microphone" }, text: "a", start_time: "1" },
      { speaker: { source: "speaker", diarization_label: "B" }, text: "b" },
      { speaker: { source: "microphone" }, text: "c" },
      { text: "no speaker" },
    ])).toEqual([
      { source: "microphone", diarization_label: null, name: null, email: null, segments: 2, firstStart: "1" },
      { source: "speaker", diarization_label: "B", name: null, email: null, segments: 1, firstStart: null },
      { source: null, diarization_label: null, name: null, email: null, segments: 1, firstStart: null },
    ]);
    const base = { authMode: "api_key" as const, accountFingerprint: "f1", folderId: null };
    expect(granolaInventoryKey(base)).toBe(granolaInventoryKey({ ...base }));
    expect(granolaInventoryKey(base)).not.toBe(granolaInventoryKey({ ...base, accountFingerprint: "f2" }));
    expect(granolaInventoryKey(base)).not.toBe(granolaInventoryKey({ ...base, folderId: "fld" }));
  });
});
