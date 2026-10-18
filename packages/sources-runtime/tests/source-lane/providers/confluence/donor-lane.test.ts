import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processConfluenceCommentRecord, processConfluencePageRecord, registerAtlassianProcessors } from "../../../../src/integrations/atlassian/processors.js";
import { dispatchRecords } from "../../../../src/integrations/nango/types.js";
import { confluenceCoverage } from "../../../../src/source-lane/providers/confluence/coverage.js";
import { FakeConfluence } from "./fake-confluence.js";
import { CONN, drain, ENG, makeExporter, ROOT, seedSite, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * The donor Nango /records lane through its production processors and
 * materializer, exported by the confluence module into the real yc_msaw store.
 */

const T = "tenant-dn";
const ctx = { tenantId: T, providerConfigKey: "confluence", connectionId: CONN };

beforeAll(async () => {
  await ready;
  registerAtlassianProcessors();
});

beforeEach(async () => {
  await resetAll();
  await connect(T, CONN);
});

function pageRecord(id: string, spaceId: string | null, version: number, body: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: "Release Runbook",
    ...(spaceId ? { spaceId } : {}),
    versionNumber: version,
    bodyStorage: body,
    _nango_metadata: { updated_at: updatedAt, last_action: "UPDATED" },
    ...extra,
  };
}

describe("donor Confluence mirror through the source lane", () => {
  it("exports page projections with the version ordinal, so a replayed older record never overwrites a newer page", async () => {
    const { exporter, yc } = await makeExporter(T);
    await processConfluencePageRecord(db as never, pageRecord("page-7", "ENG", 7, "<p>Hello <strong>world</strong> v7</p>", "2026-07-03T00:00:00.000Z"), ctx);
    await processConfluenceCommentRecord(db as never, { id: "c-1", pageId: "page-7", version: { number: 1, createdAt: "2026-07-04T00:00:00.000Z", authorId: "acct-1" }, body: { storage: { value: "<p>Ship it</p>" } }, _nango_metadata: { updated_at: "2026-07-04T00:00:00.000Z" } }, ctx, "FooterComment");
    await drain(exporter);
    const f = await yc.file("sources/confluence/ENG/page-7.md");
    expect(f).toMatchObject({ ordinal: 7, versionRef: "v7", kind: "projection" });
    expect(f!.bytes.toString()).toContain("Hello **world** v7");
    expect(await yc.text("sources/confluence/ENG/page-7-comments.md")).toContain("Ship it");
    const raw = (await yc.paths("sources/confluence/_raw")).find((p) => p.includes("nango%3Aconfluence%3Apage") || p.includes("nango:confluence:page"));
    expect(raw).toBeTruthy();
    expect((await yc.json(raw!)).source_event_id).toBe("nango:confluence:page:page-7:v7");

    // A late, older record: the donor upsert has no version guard and rewrites the mirror row ...
    await processConfluencePageRecord(db as never, pageRecord("page-7", "ENG", 6, "<p>older v6</p>", "2026-07-01T00:00:00.000Z"), ctx);
    expect((await query(`SELECT content FROM mirror_files WHERE path = 'sources/confluence/ENG/page-7.md'`))[0]!.content).toContain("older v6");
    await drain(exporter);
    // ... but yc_msaw keeps v7 (ordinal guard), while both raw records stay in the ledger.
    expect(yc.results.filter((r) => r.path === "sources/confluence/ENG/page-7.md").map((r) => r.outcome)).toEqual(["created", "stale"]);
    expect(await yc.text("sources/confluence/ENG/page-7.md")).toContain("v7");
    expect((await yc.paths("sources/confluence/_raw")).filter((p) => p.includes("page-7"))).toHaveLength(2);
  });

  it("removes the page and comments docs at export when a tombstone has no spaceId (the donor cannot), and keeps them removed on backfill", async () => {
    const { exporter, yc } = await makeExporter(T);
    await processConfluencePageRecord(db as never, pageRecord("page-7", "ENG", 7, "<p>v7</p>", "2026-07-03T00:00:00.000Z"), ctx);
    await processConfluenceCommentRecord(db as never, { id: "c-1", pageId: "page-7", version: { number: 1 }, body: { storage: { value: "<p>Ship it</p>" } }, _nango_metadata: { updated_at: "2026-07-04T00:00:00.000Z" } }, ctx, "FooterComment");
    await drain(exporter);
    // Deleted record carrying only the id.
    await processConfluencePageRecord(db as never, { id: "page-7", _nango_metadata: { last_action: "DELETED", updated_at: "2026-07-05T00:00:00.000Z", deleted_at: "2026-07-05T00:00:00.000Z" } }, ctx);
    expect((await query(`SELECT count(*)::int AS n FROM mirror_files WHERE path LIKE 'sources/confluence/ENG/page-7%'`))[0]!.n).toBe(2); // donor defect: rows stay
    await drain(exporter);
    expect((await yc.tombstone("sources/confluence/ENG/page-7.md"))?.reason).toBe("confluence_page_deleted");
    expect((await yc.tombstone("sources/confluence/ENG/page-7-comments.md"))?.reason).toBe("confluence_page_deleted");

    // Re-provisioning re-journals every mirror row: the stale rows export as deletes, not puts.
    await query(`INSERT INTO source_lane_journal (tenant_id, table_name, row_key, op) SELECT user_id, 'mirror_files', path, 'INSERT' FROM mirror_files WHERE user_id = $1`, [T]);
    await drain(exporter);
    expect(await yc.file("sources/confluence/ENG/page-7.md")).toBeNull();
    expect(await yc.file("sources/confluence/ENG/page-7-comments.md")).toBeNull();
  });

  it("removes the old space's file when a page moves, and a deleted blog post's comments doc", async () => {
    const { exporter, yc } = await makeExporter(T);
    await processConfluencePageRecord(db as never, pageRecord("page-8", "ENG", 1, "<p>v1</p>", "2026-07-01T00:00:00.000Z"), ctx);
    await drain(exporter);
    await processConfluencePageRecord(db as never, pageRecord("page-8", "OPS", 2, "<p>moved v2</p>", "2026-07-02T00:00:00.000Z"), ctx);
    await drain(exporter);
    expect(await yc.text("sources/confluence/OPS/page-8.md")).toContain("moved v2");
    expect((await yc.tombstone("sources/confluence/ENG/page-8.md"))?.reason).toBe("confluence_page_moved");

    await dispatchRecords(db as never, { provider: "confluence", model: "BlogPost", records: [{ id: "bp-1", title: "Launch", spaceId: "ENG", _nango_metadata: { updated_at: "2026-07-01T00:00:00.000Z" } }], ctx });
    await processConfluenceCommentRecord(db as never, { id: "bc-1", blogPostId: "bp-1", version: { number: 1 }, body: { storage: { value: "<p>Nice</p>" } }, _nango_metadata: { updated_at: "2026-07-02T00:00:00.000Z" } }, ctx, "FooterComment");
    await drain(exporter);
    expect(await yc.text("sources/confluence/ENG/bp-1-comments.md")).toContain("Nice");
    await dispatchRecords(db as never, { provider: "confluence", model: "BlogPost", records: [{ id: "bp-1", _nango_metadata: { last_action: "DELETED", updated_at: "2026-07-03T00:00:00.000Z" } }], ctx });
    expect((await query(`SELECT count(*)::int AS n FROM mirror_files WHERE path = 'sources/confluence/ENG/bp-1-comments.md'`))[0]!.n).toBe(1);
    await drain(exporter);
    expect((await yc.tombstone("sources/confluence/ENG/bp-1-comments.md"))?.reason).toBe("confluence_blog_post_deleted");
  });

  it("disables id-only cleanup with several Confluence connections (ids are not site-scoped) and says so in coverage", async () => {
    await connect(T, "conn-second");
    const { exporter, yc } = await makeExporter(T);
    await processConfluencePageRecord(db as never, pageRecord("page-7", "ENG", 7, "<p>v7</p>", "2026-07-03T00:00:00.000Z"), ctx);
    await drain(exporter);
    await processConfluencePageRecord(db as never, { id: "page-7", _nango_metadata: { last_action: "DELETED", updated_at: "2026-07-05T00:00:00.000Z" } }, { ...ctx, connectionId: "conn-second" });
    await drain(exporter);
    expect(await yc.file("sources/confluence/ENG/page-7.md")).not.toBeNull();
    const cov = await confluenceCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === "donor-mirror")).toMatchObject({ state: "partial" });
    expect(cov.find((c) => c.scope === "nango-records")).toMatchObject({ state: "partial", counts: { page: 1, "page.deleted": 1 } });
  });

  it("removes a donor page file when the deep lane confirms the page trashed", async () => {
    const fake = new FakeConfluence();
    seedSite(fake);
    const { exporter, yc } = await makeExporter(T);
    await processConfluencePageRecord(db as never, pageRecord("1004", ENG, 1, "<p>third</p>", "2026-01-04T09:00:00.000Z"), ctx);
    await sweepUntilQuiet(T, fake);
    await drain(exporter);
    expect(await yc.file(`sources/confluence/${ENG}/1004.md`)).not.toBeNull();
    expect(await yc.file(`${ROOT}/spaces/${ENG}/pages/1004/page.md`)).not.toBeNull();
    fake.find("1004").status = "trashed";
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);
    expect((await yc.tombstone(`${ROOT}/spaces/${ENG}/pages/1004/page.md`))?.reason).toBe("confluence_trashed");
    expect((await yc.tombstone(`sources/confluence/${ENG}/1004.md`))?.reason).toBe("confluence_trashed");
  });
});
