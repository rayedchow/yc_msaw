import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
  getGoogleAccessToken: vi.fn(async () => "synthetic-bearer"),
}));

import { allStoredText, db, fakeFetch, heads, json, liveFile, liveJson, query, ready, resetTenant } from "./harness.js";
import { snapshotDocContent } from "../../../../src/integrations/google/gdocs/content-snapshot.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { gdocsVersionsExport } from "../../../../src/source-lane/providers/google-docs/export-map.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-content";
const DOC = "doc-content-1";
const EPHEMERAL = "https://lh3.googleusercontent.com/docs/EPHEMERAL-REQUESTER-TOKEN";
const PNG_V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 255, 254]);
const PNG_V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 0, 128]);
const LONG_LINE = "L".repeat(20_000);

function docJson(opts: { title: string; revisionId: string; withAppendix: boolean; body: string }) {
  const tab0 = {
    tabProperties: { tabId: "t.0", title: "Overview", index: 0 },
    documentTab: {
      body: { content: [
        { paragraph: { elements: [{ textRun: { content: `${opts.body}\n` } }] } },
        { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "kix.img1" } }] } },
      ] },
      inlineObjects: { "kix.img1": { inlineObjectProperties: { embeddedObject: { title: "Chart", imageProperties: { contentUri: EPHEMERAL } } } } },
    },
    childTabs: [
      { tabProperties: { tabId: "t.child", title: "Child", parentTabId: "t.0" }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "nested\n" } }] } }] } } },
    ],
  };
  const appendix = { tabProperties: { tabId: "t.1", title: "Appendix", index: 1 }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "Notes\n" } }] } }] } } };
  return { documentId: DOC, title: opts.title, revisionId: opts.revisionId, tabs: opts.withAppendix ? [tab0, appendix] : [tab0] };
}

function googleRoutes(state: { doc: unknown; png: Buffer }) {
  return fakeFetch([
    (url) => url.hostname === "docs.googleapis.com" ? json(state.doc) : undefined,
    (url) => url.href === EPHEMERAL ? new Response(new Uint8Array(state.png), { status: 200, headers: { "content-type": "image/png" } }) : undefined,
    (url) => url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${DOC}`
      ? json({
        id: DOC, name: "doc", mimeType: "application/vnd.google-apps.document",
        permissions: [{ id: "p1", type: "user", role: "writer", emailAddress: "ada@corp.example" }],
        capabilities: { canDownload: true, canReadRevisions: true },
        exportLinks: { "application/pdf": "https://docs.google.com/feeds/download/SECRET-EXPORT-LINK" },
        thumbnailLink: "https://lh3.googleusercontent.com/THUMB-SECRET",
      })
      : undefined,
    // History lane fetches are covered by history-export.test.ts; here the endpoint is forbidden.
    (url) => url.hostname === "docs.google.com" ? new Response("", { status: 403 }) : undefined,
  ]);
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  await resetTenant(TENANT);
});

describe("Docs content export through the donor content-snapshot path", () => {
  it("exports native JSON, native tabs, exact image bytes and Drive permissions without ever persisting contentUri", async () => {
    const state = { doc: docJson({ title: "Plan", revisionId: "rev-1", withAppendix: true, body: "Hello" }), png: PNG_V1 };
    const f = googleRoutes(state);
    vi.stubGlobal("fetch", f.impl);
    try {
      const r = await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-01T10:00:00Z", updatedByEmail: "ada@corp.example" });
      expect(r.status).toBe("captured");
    } finally {
      vi.unstubAllGlobals();
    }
    const P = docPaths(docDirectory(DOC, "Plan"));

    const native = await liveFile(TENANT, P.nativeDocument);
    expect(native!.contentType).toBe("application/json");
    const nativeJson = JSON.parse(native!.bytes.toString("utf8"));
    expect(nativeJson.revisionId).toBe("rev-1");
    expect(nativeJson.tabs[0].documentTab.inlineObjects["kix.img1"].inlineObjectProperties.embeddedObject.imageProperties.contentUri)
      .toBe("[redacted: ephemeral requester-scoped URL]");

    const child = await liveJson<{ tab: { tabProperties: { parentTabId: string } } }>(TENANT, P.nativeTab("t.child"));
    expect(child.tab.tabProperties.parentTabId).toBe("t.0");
    expect((await liveJson<{ childTabIds: string[] }>(TENANT, P.nativeTab("t.0"))).childTabIds).toEqual(["t.child"]);

    const image = await liveFile(TENANT, P.imageBytes("kix.img1", ".png"));
    expect(image!.kind).toBe("binary");
    expect(image!.bytes.equals(PNG_V1)).toBe(true);
    expect(await liveJson(TENANT, P.imageMeta("kix.img1"))).toMatchObject({ objectId: "kix.img1", kind: "image", altText: "Chart", sizeBytes: PNG_V1.byteLength });

    const drive = await liveJson<{ file: Record<string, unknown> }>(TENANT, P.drive);
    expect(drive.file.permissions).toEqual([{ id: "p1", type: "user", role: "writer", emailAddress: "ada@corp.example" }]);
    expect(drive.file).not.toHaveProperty("exportLinks");
    expect(drive.file).not.toHaveProperty("thumbnailLink");

    const stored = await allStoredText(TENANT);
    expect(stored).not.toContain("EPHEMERAL-REQUESTER-TOKEN");
    expect(stored).not.toContain("SECRET-EXPORT-LINK");
    expect(stored).not.toContain("THUMB-SECRET");

    // Snapshot-diff baseline + donor mirror still written; history honestly blocked.
    const diffs = await heads(TENANT, `${P.historyDir}/snapshot-diffs/`);
    expect(diffs).toHaveLength(1);
    expect(await liveJson(TENANT, diffs[0].path)).toMatchObject({ eventType: "doc_snapshot_baselined", revisionId: "rev-1" });
    const mirror = await query<{ path: string }>(`SELECT path FROM mirror_files WHERE user_id = $1 ORDER BY path`, [TENANT]);
    expect(mirror.some((m) => m.path.endsWith("/raw.md"))).toBe(true);
    expect((await getCheckpoint(TENANT, DOC, deps))!.contentState).toBe("complete");
  });

  it("versions a rename, removed tabs, changed image bytes and an uncapped revision diff", async () => {
    const state = { doc: docJson({ title: "Plan", revisionId: "rev-1", withAppendix: true, body: "Hello" }) as unknown, png: PNG_V1 };
    const f = googleRoutes(state);
    vi.stubGlobal("fetch", f.impl);
    try {
      await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-01T10:00:00Z" });
      state.doc = docJson({ title: "Plan v2", revisionId: "rev-2", withAppendix: false, body: LONG_LINE });
      state.png = PNG_V2;
      await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-02T10:00:00Z" });
    } finally {
      vi.unstubAllGlobals();
    }
    const oldP = docPaths(docDirectory(DOC, "Plan"));
    const newP = docPaths(docDirectory(DOC, "Plan v2"));
    expect(oldP.nativeDocument).not.toBe(newP.nativeDocument);

    // Old directory: every file tombstoned (moved), none live.
    const oldHeads = await heads(TENANT, `${docDirectory(DOC, "Plan")}/`);
    expect(oldHeads.length).toBeGreaterThan(0);
    expect(oldHeads.every((h) => h.op === "delete")).toBe(true);
    const reasons = await query<{ deleted_reason: string }>(
      `SELECT DISTINCT deleted_reason FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path LIKE $2 AND op = 'delete'`,
      [TENANT, `${docDirectory(DOC, "Plan")}/%`],
    );
    expect(reasons.map((r) => r.deleted_reason)).toEqual(["moved"]);

    // New directory: the appendix tab is gone (tombstoned), the image has both versions.
    expect((await heads(TENANT, newP.nativeTab("t.1")))[0]).toMatchObject({ op: "delete" });
    const img = await liveFile(TENANT, newP.imageBytes("kix.img1", ".png"));
    expect(img!.bytes.equals(PNG_V2)).toBe(true);
    const imgVersions = await query<{ seq: number; sha256: string }>(
      `SELECT seq, sha256 FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2 ORDER BY seq`, [TENANT, newP.imageBytes("kix.img1", ".png")]);
    expect(imgVersions).toHaveLength(2); // moved copy of v1, then v2

    // Revision diff is complete (the donor capped text at 12,000 chars).
    const diffHeads = (await heads(TENANT, `${newP.historyDir}/snapshot-diffs/`)).filter((h) => h.op === "put");
    const diffs = await Promise.all(diffHeads.map((h) => liveJson<Record<string, any>>(TENANT, h.path)));
    const changed = diffs.find((d) => d.eventType === "doc_content_changed")!;
    expect(changed).toMatchObject({ previousRevisionId: "rev-1", revisionId: "rev-2", sourceEventId: `gdocs:diff:${DOC}:rev-1:rev-2` });
    const tab0 = changed.tabChanges.find((t: any) => t.tabId === "t.0");
    expect(tab0.unifiedDiff).toContain(`+${LONG_LINE}`);
    expect(tab0.unifiedDiff.length).toBeGreaterThan(20_000);
    expect(changed.tabChanges.find((t: any) => t.tabId === "t.1")).toMatchObject({ change: "removed" });
    expect(changed.attribution.confidence).toBe("unknown");
  });

  it("maps journaled versions to exact-byte puts and deletes through the registered extraTable", async () => {
    const state = { doc: docJson({ title: "Plan", revisionId: "rev-1", withAppendix: true, body: "Hello" }) as unknown, png: PNG_V1 };
    const f = googleRoutes(state);
    vi.stubGlobal("fetch", f.impl);
    try {
      await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-01T10:00:00Z" });
      state.doc = docJson({ title: "Plan v2", revisionId: "rev-2", withAppendix: true, body: "Hello" });
      await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-02T10:00:00Z" });
    } finally {
      vi.unstubAllGlobals();
    }
    const journal = await query<{ row_key: string; op: "INSERT"; enqueued_at: Date }>(
      `SELECT row_key, op, enqueued_at FROM source_lane_journal WHERE tenant_id = $1 AND table_name = 'gdocs_source_file_versions' ORDER BY id`, [TENANT]);
    const ctx = { tenantId: TENANT, executor: db };
    const changes = [];
    for (const j of journal) {
      changes.push(...await gdocsVersionsExport.map(ctx as never, j.row_key, { op: j.op, enqueuedAt: new Date(j.enqueued_at).toISOString() }, []));
    }
    const imagePut = changes.find((c) => c.op === "put" && c.path === docPaths(docDirectory(DOC, "Plan")).imageBytes("kix.img1", ".png"));
    expect(imagePut).toMatchObject({ op: "put", kind: "binary", contentType: "image/png" });
    expect((imagePut as { content: Buffer }).content.equals(PNG_V1)).toBe(true);
    const moved = changes.filter((c) => c.op === "delete");
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((c) => c.op === "delete" && c.reason === "moved")).toBe(true);
    for (const c of changes) expect(c.path.startsWith("sources/google-docs/")).toBe(true);
  });

  it("re-materializes a restored doc even though its revision rows already exist", async () => {
    const state = { doc: docJson({ title: "Plan", revisionId: "rev-1", withAppendix: false, body: "Hello" }) as unknown, png: PNG_V1 };
    const f = googleRoutes(state);
    vi.stubGlobal("fetch", f.impl);
    try {
      await snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-01T10:00:00Z" });
      await query(`DELETE FROM mirror_files WHERE user_id = $1`, [TENANT]);
      const again = await snapshotDocContent(TENANT, DOC, { modifiedTime: null, forceMaterialize: true });
      expect(again.status).toBe("deduped_revision");
    } finally {
      vi.unstubAllGlobals();
    }
    const mirror = await query<{ path: string }>(`SELECT path FROM mirror_files WHERE user_id = $1`, [TENANT]);
    expect(mirror.length).toBeGreaterThan(0);
  });
});
