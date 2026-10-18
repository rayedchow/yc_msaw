import { describe, expect, it } from "vitest";
import { defaultEventChanges, defaultMirrorChanges, encodeSegment, envelopeSidecarPath, rawEventDocument, rawEventPath, SKIPPED_MIRROR_PATHS } from "../../../src/source-lane/export/mapping.js";
import { defaultRegistry, fallbackProviderDir } from "../../../src/source-lane/registry.js";

const registry = defaultRegistry();
const row = {
  id: "00000000-0000-0000-0000-000000000001",
  source: "gdocs",
  source_namespace: "drive:user@example.com",
  source_object_id: "doc:1AbC/def",
  record_kind: "snapshot",
  event_type: "doc_edited",
  timestamp: "2026-10-03T04:05:06.000Z",
  source_updated_at: "2026-10-03T04:05:00.000Z",
  source_event_id: "gdocs:edit_detected:1AbC:rev/42",
  created_at: "2026-10-03T04:05:07.000Z",
  raw_payload_text: '{"id": "1AbC", "big": 12345678901234567890, "__proto__": {"x": 1}}',
  extracted_entities_text: null,
};

describe("default source mappings", () => {
  it("places raw events by provider, namespace, object and month with path-safe segments", () => {
    expect(rawEventPath(registry, row)).toBe("sources/google-docs/_raw/drive:user@example.com/doc:1AbC%2Fdef/2026-10/gdocs:edit_detected:1AbC:rev%2F42.json");
    expect(rawEventPath(registry, { ...row, source: "hubspot-crm", source_namespace: null, source_object_id: null })).toBe(
      "sources/hubspot-crm/_raw/_/_/2026-10/gdocs:edit_detected:1AbC:rev%2F42.json",
    );
    expect(fallbackProviderDir("Nango:Linear_App")).toBe("nango-linear-app");
    expect(encodeSegment("..")).toBe("%2E%2E");
    expect(encodeSegment("a%b")).toBe("a%25b");
    expect(encodeSegment("x".repeat(400)).length).toBeLessThan(160);
  });

  it("embeds the stored jsonb text verbatim (no JavaScript number loss, __proto__ kept)", () => {
    const doc = rawEventDocument(row).toString("utf8");
    expect(doc).toContain('"raw_payload": {"id": "1AbC", "big": 12345678901234567890, "__proto__": {"x": 1}}');
    expect(JSON.parse(doc).source_event_id).toBe(row.source_event_id);
    const [change] = defaultEventChanges(registry, row, { op: "INSERT", enqueuedAt: "2026-10-03T05:00:00.000Z" });
    expect(change).toMatchObject({ op: "put", kind: "raw", contentType: "application/json", capturedAt: row.created_at });
    const [updated] = defaultEventChanges(registry, row, { op: "UPDATE", enqueuedAt: "2026-10-04T00:00:00.000Z" });
    expect(updated!.capturedAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("maps mirror rows to projections with the envelope as provenance, sidecars for large envelopes, deletes for missing rows", () => {
    const base = { path: "sources/jira/ENG/ENG-1.md", user_id: "t", content: "# ENG-1\n", content_sha: "c", meta_sha: "m", updated_at: "2026-10-03T00:00:00.000Z" };
    const [small] = defaultMirrorChanges(base.path, { ...base, meta: { provider: "jira", versionRef: "2026-10-02T00:00:00Z", sourceUpdatedAt: "2026-10-02T00:00:00.000Z" } }, "2026-10-03T00:00:00.000Z");
    expect(small).toMatchObject({ op: "put", contentType: "text/markdown; charset=utf-8", sourceVersion: { ref: "2026-10-02T00:00:00Z" }, sourceUpdatedAt: "2026-10-02T00:00:00.000Z" });
    expect((small as { provenance: Record<string, unknown> }).provenance.envelope).toBeTruthy();
    const big = defaultMirrorChanges(base.path, { ...base, meta: { provider: "jira", sourceRefs: Array.from({ length: 2000 }, (_, i) => ({ anchor: `Comment ${i}`, ref: "x".repeat(20) })) } }, "2026-10-03T00:00:00.000Z");
    expect(big.map((c) => c.path)).toEqual([base.path, envelopeSidecarPath(base.path)]);
    expect(envelopeSidecarPath(base.path)).toBe("sources/jira/_meta/ENG/ENG-1.md.json");
    expect(defaultMirrorChanges(base.path, null, "2026-10-05T00:00:00.000Z")).toEqual([
      expect.objectContaining({ op: "delete", path: base.path, deletedAt: "2026-10-05T00:00:00.000Z", reason: "mirror_row_deleted" }),
    ]);
    expect(SKIPPED_MIRROR_PATHS.has("sources/index.md")).toBe(true);
    expect(defaultMirrorChanges("sources/index.md", { ...base, path: "sources/index.md", meta: null }, "x")).toEqual([]);
  });

  it("assigns every donor activity source and mirror root to exactly one provider module", () => {
    for (const [source, id] of [["gdocs", "google-docs"], ["gmail", "gmail"], ["calendar", "calendar"], ["slack", "slack"], ["notion_comments_api", "notion"], ["granola", "granola"], ["imessage", "imessage"], ["jira", "jira"], ["confluence", "confluence"], ["github", "github"], ["bitbucket", "bitbucket"]]) {
      expect(registry.forEventSource(source!)?.id, source).toBe(id);
    }
    for (const root of ["bitbucket", "calendar", "confluence", "github", "gmail", "google-docs", "granola", "imessage", "jira", "notion", "slack"]) {
      expect(registry.forMirrorPath(`sources/${root}/x.md`)?.id).toBe(root);
    }
  });
});
