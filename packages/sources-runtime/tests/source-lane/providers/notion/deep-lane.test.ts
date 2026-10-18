import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { notionCoverage } from "../../../../src/source-lane/providers/notion/coverage.js";
import { redact } from "../../../../src/source-lane/providers/notion/model.js";
import { BOT_ID, FakeNotion, richText, SIGNATURE, TOKEN, uid, WORKSPACE_ID } from "./fake-notion.js";
import {
  ATTACH,
  C1_DIR,
  COVER,
  DB1_DIR,
  dir,
  drain,
  DS1_DIR,
  forceFullPass,
  GC1_DIR,
  ID,
  makeExporter,
  P1_DIR,
  P2_DIR,
  PDF,
  PNG,
  ROOT,
  seedWorkspace,
  sweepUntilQuiet,
} from "./fixtures.js";
import { db, query, ready, resetAll } from "./harness.js";

const T = "tenant-n1";
let fake: FakeNotion;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeNotion();
  seedWorkspace(fake);
});

describe("notion deep lane: initial capture", () => {
  it("captures pages, nested blocks, child pages, databases, data source rows, comments and exact file bytes with truthful coverage", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    // Connection identity (no secrets).
    const conn = await yc.json(`${ROOT}/_connection.json`);
    expect(conn).toMatchObject({ connectionId: BOT_ID, workspaceId: WORKSPACE_ID, workspaceName: "Acme", status: "active" });

    // Root page rendered by the donor walker's renderer: nested toggle children beyond one listing page.
    const md = await yc.text(`${P1_DIR}/page.md`);
    expect(md).toContain("# Engineering Handbook");
    expect(md).toContain("# Overview");
    expect(md).toContain("Welcome to the handbook");
    expect(md).toContain("<summary>Details</summary>");
    for (let i = 1; i <= 5; i++) expect(md).toContain(`- Bullet ${i}`);
    expect(md).toContain("Shared snippet");
    expect(md).toContain(`[[Child page: Runbook]](${encodeURI(dir("Runbook", ID.C1))}/page.md)`);
    expect(md).toContain("[[Child database: Tasks]]");
    expect(md).toContain("End of handbook");
    expect(md).toContain("Block comments:");
    expect(md).toContain("Block comment on welcome");
    expect(md).toContain("## Page comments");
    expect(md).toContain("First page comment");
    // Captured files are linked; the external one is recorded, not fetched.
    expect(md).toMatch(/\[diagram\.png \(block [^)]+\)\]\(files\/[0-9a-f]{16}\/diagram\.png\) - \d+ bytes, image\/png/u);
    expect(md).toContain("external link to example.com (not archived)");
    expect(md.indexOf("Welcome to the handbook")).toBeLessThan(md.indexOf("End of handbook"));

    // Exact raw: blocks.json splices the stored (redacted) payloads in Notion order.
    const blocks = await yc.json(`${P1_DIR}/blocks.json`);
    // 9 top-level blocks + 5 toggle children + 1 synced-block child.
    expect(blocks.blockCount).toBe(15);
    expect(blocks.blocks.map((b: any) => b.block.id)).toEqual([ID.H1, ID.PARA, ID.TOGGLE, ID.IMG, ID.EXT, ID.SYNC, ID.C1, ID.DB1, ID.END]);
    expect(blocks.blocks[2].children.map((b: any) => b.block.id)).toEqual([0, 1, 2, 3, 4].map(ID.BULLET));
    expect(blocks.blocks[1].block).toEqual(redact(fake.blocks.get(ID.PARA)));
    expect(blocks.blocks[3].block.image.file.url).toMatch(/^\[redacted/u);
    expect(blocks.blocks[3].block.image.file.expiry_time).toBeTruthy();
    const pageRaw = await yc.json(`${P1_DIR}/page.json`);
    expect(pageRaw.raw.id).toBe(ID.P1);
    expect(pageRaw.raw.cover.file.url).toMatch(/^\[redacted/u);

    // Exact bytes of Notion-hosted files, kind binary; metadata keeps host + path only.
    const imgPath = await yc.find("/diagram.png", P1_DIR);
    const img = await yc.file(imgPath);
    expect(img).toMatchObject({ kind: "binary", contentType: "image/png" });
    expect(img!.bytes.equals(PNG)).toBe(true);
    const imgMeta = await yc.json(imgPath.replace(/diagram\.png$/u, "_file.json"));
    expect(imgMeta).toMatchObject({ ownerType: "block", ownerId: ID.IMG, sourceType: "file", bytes: { status: "stored", size: PNG.length } });
    expect(imgMeta.location).toEqual({ host: "prod-files-secure.s3.us-west-2.amazonaws.com", path: `/${WORKSPACE_ID}/img-1/diagram.png` });
    expect((await yc.file(await yc.find("/cover.png", P1_DIR)))!.bytes.equals(COVER)).toBe(true);
    expect((await yc.file(await yc.find("/note.bin", P1_DIR)))!.bytes.equals(ATTACH)).toBe(true);
    const extMeta = (await yc.paths(P1_DIR)).filter((p) => p.endsWith("_file.json"));
    const metas = await Promise.all(extMeta.map((p) => yc.json(p)));
    expect(metas.find((m) => m.ownerId === ID.EXT)).toMatchObject({ sourceType: "external", bytes: { status: "external" }, location: { host: "example.com", path: "/pic.png" } });

    // Child and grandchild pages are not returned by search: discovered by traversal, nested paths.
    expect(await yc.text(`${C1_DIR}/page.md`)).toContain("Step one: restart");
    expect(await yc.text(`${GC1_DIR}/page.md`)).toContain("Deep content");

    // Database -> data source -> rows (native table), rows 4/5 only reachable by the query.
    expect(await yc.text(`${DB1_DIR}/_database.md`)).toContain(`[Tasks](${encodeURI(dir("Tasks", ID.DS1))}/_data_source.md)`);
    const schema = await yc.text(`${DS1_DIR}/_data_source.md`);
    expect(schema).toContain("| Status | select | Todo, Done |");
    expect(schema).toContain("rows: 5");
    const csv = await yc.text(`${DS1_DIR}/_table.csv`);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("notion_id,Name,Status,Related,Attachments,created_time,last_edited_time,path");
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.includes(",Todo,"))).toHaveLength(3);
    expect(await yc.text(`${DS1_DIR}/${dir("Row 3", ID.ROW(3))}/page.md`)).toContain("Row three body");
    expect(await yc.text(`${DS1_DIR}/${dir("Row 5", ID.ROW(5))}/page.md`)).toContain("# Row 5");
    // Paginated relation (30 items, 25 embedded + has_more) hydrated through the property endpoint.
    const row1 = await yc.json(`${DS1_DIR}/${dir("Row 1", ID.ROW(1))}/page.json`);
    expect(row1.propertiesStatus).toBe("complete");
    expect(row1.hydratedProperties.rel1.results).toHaveLength(30);
    expect(row1.raw.properties.Related.relation).toHaveLength(25);
    expect((await yc.file(await yc.find("/spec.pdf", DS1_DIR)))!.bytes.equals(PDF)).toBe(true);

    // Synced copy on another page renders the original's captured subtree.
    expect(await yc.text(`${P2_DIR}/page.md`)).toContain("Shared snippet");

    // Comments: threads with status, exact raw.
    const comments = await yc.text(`${P1_DIR}/comments.md`);
    expect(comments).toContain("## Discussion d-1");
    expect(comments).toContain("Reply on the page");
    expect(comments).toContain(`- Anchored to: block ${ID.PARA} (paragraph)`);
    const commentsRaw = await yc.json(`${P1_DIR}/comments.json`);
    expect(commentsRaw.comments).toHaveLength(4);
    expect(commentsRaw.comments.every((c: any) => c.status === "open")).toBe(true);

    // Append-only raw ledger: node observations and composed page trees.
    expect((await yc.paths(`${ROOT}/_raw/pages/${ID.P1}/observed`)).length).toBe(1);
    const treePath = (await yc.paths(`${ROOT}/_raw/pages/${ID.P1}/trees`))[0]!;
    const tree = await yc.json(treePath);
    expect(tree.page.id).toBe(ID.P1);
    expect(tree.blocks[2].children[4].block).toEqual(redact(fake.blocks.get(ID.BULLET(4))));
    expect(tree.comments).toHaveLength(4);

    // Every level was paginated (page size 2).
    expect(fake.callsTo(new RegExp(`/blocks/${ID.TOGGLE}/children\\?.*start_cursor=`, "u")).length).toBeGreaterThanOrEqual(2);
    expect(fake.callsTo(new RegExp(`/blocks/${ID.P1}/children\\?.*start_cursor=`, "u")).length).toBeGreaterThanOrEqual(4);
    expect(fake.callsTo(new RegExp(`/comments\\?block_id=${ID.P1}.*start_cursor=`, "u")).length).toBe(1);
    expect(fake.calls.filter((c) => c.url.pathname === `/v1/data_sources/${ID.DS1}/query` && c.body?.start_cursor).length).toBeGreaterThanOrEqual(2);
    expect(fake.callsTo(new RegExp(`/pages/${ID.ROW(1)}/properties/rel1\\?.*start_cursor=`, "u")).length).toBeGreaterThanOrEqual(10);
    // Synced copies are not re-listed (the original's children belong to the original's page).
    expect(fake.callsTo(new RegExp(`/blocks/${ID.COPY}/children`, "u"))).toHaveLength(0);

    // Secrets: the token goes only to api.notion.com, never to the file host; signed URLs are stored nowhere.
    const fileCalls = fake.calls.filter((c) => c.url.hostname !== "api.notion.com");
    expect(fileCalls.length).toBe(4);
    expect(fileCalls.every((c) => c.auth === null)).toBe(true);
    const everything = await yc.allText();
    expect(everything).not.toContain(SIGNATURE);
    expect(everything).not.toContain(TOKEN);
    const dbText = await query<{ t: string }>(`
      SELECT string_agg(x, ' ') AS t FROM (
        SELECT raw::text AS x FROM notion_source_nodes UNION ALL SELECT raw::text FROM notion_source_blocks UNION ALL SELECT raw::text FROM notion_source_comments
        UNION ALL SELECT raw::text FROM notion_source_records UNION ALL SELECT raw::text FROM notion_source_block_versions
        UNION ALL SELECT payload::text FROM notion_source_work UNION ALL SELECT COALESCE(hydrated_properties::text, '') FROM notion_source_nodes
        UNION ALL SELECT COALESCE(url_path, '') || COALESCE(error, '') FROM notion_source_files) s`);
    expect(dbText[0]!.t).not.toContain(SIGNATURE);
    expect(dbText[0]!.t).not.toContain(TOKEN);

    // Coverage: current state complete; history explicitly partial.
    const cov = await notionCoverage({ tenantId: T, executor: db as never });
    const ws = cov.find((c) => c.scope === `workspace:${WORKSPACE_ID}/${BOT_ID}`)!;
    expect(ws.state, ws.reason).toBe("complete");
    expect(ws.counts).toMatchObject({ pages: 9, rows: 5, data_sources: 1, databases: 1, files_stored: 4, files_external: 1, comments_open: 4 });
    expect(cov.find((c) => c.scope.endsWith(":history"))).toMatchObject({ state: "partial" });

    // A second quiet pass changes nothing: no new journal rows, no block re-listing.
    const journalBefore = await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1`, [T]);
    const listingsBefore = fake.callsTo(/\/blocks\/.*\/children/u).length;
    await sweepUntilQuiet(T, fake);
    expect(fake.callsTo(/\/blocks\/.*\/children/u).length).toBe(listingsBefore);
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1`, [T]))[0]!.n).toBe(journalBefore[0]!.n);
    void forceFullPass;
    void uid;
    void richText;
  });
});

describe("notion deep lane: changes over time", () => {
  it("re-walks an edited page: edited, inserted and removed blocks; history and a new raw tree; unchanged pages are not re-listed", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const before = await yc.text(`${P1_DIR}/page.md`);
    expect(before).toContain("End of handbook");

    const t = fake.tick(5);
    const para = fake.blocks.get(ID.PARA)!;
    para.paragraph.rich_text = richText("Welcome to the edited handbook");
    para.last_edited_time = t;
    const kids = fake.children.get(ID.P1)!;
    kids.splice(kids.findIndex((b) => b.id === ID.END), 1);
    const inserted = fake.block(uid(0x4ff), "quote", { rich_text: richText("Inserted quote"), color: "default" });
    inserted.parent = { type: "page_id", page_id: ID.P1 };
    kids.splice(1, 0, inserted);
    fake.children.set(inserted.id, []);
    fake.pages.get(ID.P1)!.last_edited_time = t;
    // A row edit (property only) re-exports the native table.
    const row3 = fake.pages.get(ID.ROW(3))!;
    row3.properties.Status.select = { id: "o2", name: "Done", color: "green" };
    row3.last_edited_time = t;

    const c1Listings = fake.callsTo(new RegExp(`/blocks/${ID.C1}/children`, "u")).length;
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    const md = await yc.text(`${P1_DIR}/page.md`);
    expect(md).toContain("Welcome to the edited handbook");
    expect(md).toContain("> Inserted quote");
    expect(md).not.toContain("End of handbook");
    expect(md.indexOf("Inserted quote")).toBeLessThan(md.indexOf("Welcome to the edited handbook"));
    expect((await yc.history(`${P1_DIR}/page.md`)).length).toBe(2);
    expect((await yc.history(`${P1_DIR}/blocks.json`)).length).toBe(2);
    expect((await yc.paths(`${ROOT}/_raw/pages/${ID.P1}/trees`)).length).toBe(2);
    expect((await yc.paths(`${ROOT}/_raw/pages/${ID.P1}/observed`)).length).toBe(2);
    // The removed block's raw stays in the older tree snapshot.
    const trees = await Promise.all((await yc.paths(`${ROOT}/_raw/pages/${ID.P1}/trees`)).map((p) => yc.json(p)));
    expect(trees.some((tr) => tr.blocks.some((b: any) => b.block.id === ID.END))).toBe(true);
    expect(trees.some((tr) => !tr.blocks.some((b: any) => b.block.id === ID.END))).toBe(true);
    // Unchanged child page not re-listed by the delta.
    expect(fake.callsTo(new RegExp(`/blocks/${ID.C1}/children`, "u")).length).toBe(c1Listings);
    const csv = await yc.text(`${DS1_DIR}/_table.csv`);
    expect(csv.split("\r\n").find((l) => l.startsWith(ID.ROW(3)))).toContain(",Done,");
    expect((await yc.history(`${DS1_DIR}/_table.csv`)).length).toBe(2);
  });

  it("trash removes a page subtree from the readable tree (raw kept); restore brings it back at the same path with history", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    // Trash the child page (and, as Notion does, its subpage); the parent's child_page block disappears.
    let t = fake.tick(3);
    for (const id of [ID.C1, ID.GC1]) Object.assign(fake.pages.get(id)!, { in_trash: true, last_edited_time: t });
    const kids = fake.children.get(ID.P1)!;
    const c1Block = kids.splice(kids.findIndex((b) => b.id === ID.C1), 1)[0]!;
    fake.pages.get(ID.P1)!.last_edited_time = t;
    // The change poll alone (no full pass): the parent's walk sees the child_page block vanish,
    // re-reads the child (in_trash) and then its subpage.
    const generation = (await query(`SELECT generation FROM notion_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.generation;
    await sweepUntilQuiet(T, fake);
    expect((await query(`SELECT generation FROM notion_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.generation).toBe(generation);
    await drain(exporter);

    expect(await yc.file(`${C1_DIR}/page.md`)).toBeNull();
    expect(await yc.tombstone(`${C1_DIR}/page.md`)).toMatchObject({ reason: "notion_trashed" });
    expect(await yc.tombstone(`${GC1_DIR}/page.md`)).toMatchObject({ reason: "notion_trashed" });
    expect(await yc.text(`${P1_DIR}/page.md`)).not.toContain("Child page: Runbook");
    // Raw ledger keeps the trashed observation.
    const observed = await Promise.all((await yc.paths(`${ROOT}/_raw/pages/${ID.C1}/observed`)).map((p) => yc.json(p)));
    expect(observed.some((o) => o.raw.in_trash === true)).toBe(true);
    const cov = await notionCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `workspace:${WORKSPACE_ID}/${BOT_ID}`)!.counts).toMatchObject({ tombstoned: 2 });

    // Restore.
    t = fake.tick(3);
    for (const id of [ID.C1, ID.GC1]) Object.assign(fake.pages.get(id)!, { in_trash: false, last_edited_time: t });
    kids.splice(6, 0, c1Block);
    fake.pages.get(ID.P1)!.last_edited_time = t;
    await sweepUntilQuiet(T, fake);
    await drain(exporter);
    expect(await yc.text(`${C1_DIR}/page.md`)).toContain("Step one: restart");
    expect(await yc.text(`${GC1_DIR}/page.md`)).toContain("Deep content");
    expect((await yc.history(`${C1_DIR}/page.md`)).length).toBe(3);
    expect(await yc.text(`${P1_DIR}/page.md`)).toContain("Child page: Runbook");
  });

  it("a moved page and its subtree change paths (old paths deleted as source_path_changed, files follow)", async () => {
    // A great-grandchild under the page that will move, with a hosted file.
    const ggc = uid(0x203);
    fake.addPage(ggc, { title: "Appendix", parent: { type: "page_id", page_id: ID.GC1 } });
    fake.appendChildren(ggc, [fake.block(uid(0x413), "pdf", { caption: [], ...fake.hostedFile("pdf-2", "appendix.pdf", PDF) })], "page_id");
    fake.appendChildren(ID.GC1, [fake.block(ggc, "child_page", { title: "Appendix" })], "page_id");
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const oldDir = `${GC1_DIR}/${dir("Appendix", ggc)}`;
    expect(await yc.text(`${oldDir}/page.md`)).toContain("# Appendix");
    const oldPdf = await yc.find("/appendix.pdf", oldDir);

    // Move "Deep Dive" from Runbook to Team Notes.
    const t = fake.tick(4);
    const gc1 = fake.pages.get(ID.GC1)!;
    gc1.parent = { type: "page_id", page_id: ID.P2 };
    gc1.last_edited_time = t;
    fake.hiddenFromSearch.delete(ID.GC1);
    const c1Kids = fake.children.get(ID.C1)!;
    const moved = c1Kids.splice(c1Kids.findIndex((b) => b.id === ID.GC1), 1)[0]!;
    moved.parent = { type: "page_id", page_id: ID.P2 };
    fake.children.get(ID.P2)!.push(moved);
    fake.pages.get(ID.C1)!.last_edited_time = t;
    fake.pages.get(ID.P2)!.last_edited_time = t;
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    const newGc1 = `${P2_DIR}/${dir("Deep Dive", ID.GC1)}`;
    expect(await yc.text(`${newGc1}/page.md`)).toContain("Deep content");
    expect(await yc.text(`${newGc1}/${dir("Appendix", ggc)}/page.md`)).toContain("# Appendix");
    expect((await yc.file(await yc.find("/appendix.pdf", newGc1)))!.bytes.equals(PDF)).toBe(true);
    expect(await yc.tombstone(`${GC1_DIR}/page.md`)).toMatchObject({ reason: "source_path_changed" });
    expect(await yc.tombstone(`${oldDir}/page.md`)).toMatchObject({ reason: "source_path_changed" });
    expect(await yc.tombstone(oldPdf)).toMatchObject({ reason: "source_path_changed" });
    expect(await yc.text(`${P2_DIR}/page.md`)).toContain("[[Child page: Deep Dive]]");
    expect(await yc.text(`${C1_DIR}/page.md`)).not.toContain("Deep Dive");
  });

  it("resolved comments are kept as resolved, deleted comments keep their content marked deleted, unshared pages are tombstoned", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    const list = fake.comments.get(ID.P1)!;
    const cm2 = list.splice(list.findIndex((c) => c.id === ID.CM2), 1)[0]!;
    fake.resolvedComments.set(ID.CM2, cm2);
    list.splice(list.findIndex((c) => c.id === ID.CM3), 1);
    fake.pages.delete(ID.P2);
    fake.children.delete(ID.P2);
    await forceFullPass(T);
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    const comments = await yc.text(`${P1_DIR}/comments.md`);
    expect(comments).toMatch(new RegExp(`### Comment ${ID.CM2}\\n\\n- Status: resolved`, "u"));
    expect(comments).toMatch(new RegExp(`### Comment ${ID.CM3}\\n\\n- Status: deleted \\(detected `, "u"));
    expect(comments).toContain("Second thread");
    const raw = await yc.json(`${P1_DIR}/comments.json`);
    expect(raw.comments.find((c: any) => c.comment.id === ID.CM3)).toMatchObject({ status: "deleted", deletedReason: expect.stringContaining("404") });
    const md = await yc.text(`${P1_DIR}/page.md`);
    expect(md).toContain("First page comment");
    expect(md).not.toContain("Reply on the page");
    expect(md).not.toContain("Second thread");
    expect(fake.callsTo(new RegExp(`/comments/${ID.CM3}$`, "u"))).toHaveLength(1);

    expect(await yc.tombstone(`${P2_DIR}/page.md`)).toMatchObject({ reason: "notion_not_found_or_unshared" });
    expect(await yc.file(`${P1_DIR}/page.md`)).not.toBeNull();
  });
});
