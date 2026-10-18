/** Synthetic Notion workspace shared by the PGlite and real-PostgreSQL suites (no database imports). */
import { compactId } from "../../../../src/source-lane/providers/notion/paths.js";
import { BOT_ID, FakeNotion, richText, TOKEN, uid, WORKSPACE_ID } from "./fake-notion.js";

export const ROOT = `sources/notion/_workspaces/${WORKSPACE_ID}/${BOT_ID}`;

export const ID = {
  P1: uid(0x101),
  P2: uid(0x102),
  C1: uid(0x201),
  GC1: uid(0x202),
  DB1: uid(0x301),
  DS1: uid(0x302),
  H1: uid(0x401),
  PARA: uid(0x402),
  TOGGLE: uid(0x403),
  IMG: uid(0x404),
  EXT: uid(0x405),
  SYNC: uid(0x406),
  SYNC_CHILD: uid(0x407),
  END: uid(0x408),
  COPY: uid(0x409),
  C1_PARA: uid(0x410),
  GC1_PARA: uid(0x411),
  P2_PARA: uid(0x412),
  CM1: uid(0x501),
  CM2: uid(0x502),
  CM3: uid(0x503),
  CMB: uid(0x504),
  ROW: (i: number) => uid(0x600 + i),
  BULLET: (i: number) => uid(0x700 + i),
} as const;

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("diagram-bytes-\u0000ÿ-end", "latin1")]);
export const COVER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 0, 255]);
export const PDF = Buffer.from("%PDF-1.7\n%âã\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
export const ATTACH = Buffer.from("comment attachment bytes \u0001\u0002", "latin1");

export const dir = (title: string, id: string) => `${title}--${compactId(id)}`;
export const P1_DIR = `${ROOT}/${dir("Engineering Handbook", ID.P1)}`;
export const C1_DIR = `${P1_DIR}/${dir("Runbook", ID.C1)}`;
export const GC1_DIR = `${C1_DIR}/${dir("Deep Dive", ID.GC1)}`;
export const DB1_DIR = `${P1_DIR}/${dir("Tasks", ID.DB1)}`;
export const DS1_DIR = `${DB1_DIR}/${dir("Tasks", ID.DS1)}`;
export const P2_DIR = `${ROOT}/${dir("Team Notes", ID.P2)}`;

/**
 * Workspace: a shared root page with nested blocks (toggle with more children than one
 * listing page), Notion-hosted and external images, a synced block original, an inline
 * database with a data source and 5 rows (one with a 30-item relation, one with a hosted PDF
 * in a files property), a child page and grandchild page that search does not return,
 * page-level and block-level comments (one with an attachment), a second page holding a
 * synced copy.
 */
export function seedWorkspace(fake: FakeNotion): void {
  fake.addPage(ID.P1, { title: "Engineering Handbook", parent: { type: "workspace", workspace: true }, cover: fake.hostedFile("cover-1", "cover.png", COVER) });
  const bullets = Array.from({ length: 5 }, (_, i) => fake.block(ID.BULLET(i), "bulleted_list_item", { rich_text: richText(`Bullet ${i + 1}`), color: "default" }));
  fake.appendChildren(ID.P1, [
    fake.block(ID.H1, "heading_1", { rich_text: richText("Overview"), is_toggleable: false, color: "default" }),
    fake.block(ID.PARA, "paragraph", { rich_text: richText("Welcome to the handbook"), color: "default" }),
    fake.block(ID.TOGGLE, "toggle", { rich_text: richText("Details"), color: "default" }),
    fake.block(ID.IMG, "image", { caption: [], ...fake.hostedFile("img-1", "diagram.png", PNG) }),
    fake.block(ID.EXT, "image", { caption: richText("External pic"), type: "external", external: { url: "https://example.com/pic.png" } }),
    fake.block(ID.SYNC, "synced_block", { synced_from: null }),
    fake.block(ID.C1, "child_page", { title: "Runbook" }),
    fake.block(ID.DB1, "child_database", { title: "Tasks" }),
    fake.block(ID.END, "paragraph", { rich_text: richText("End of handbook"), color: "default" }),
  ], "page_id");
  fake.appendChildren(ID.TOGGLE, bullets);
  fake.appendChildren(ID.SYNC, [fake.block(ID.SYNC_CHILD, "paragraph", { rich_text: richText("Shared snippet"), color: "default" })]);

  fake.addPage(ID.C1, { title: "Runbook", parent: { type: "page_id", page_id: ID.P1 } });
  fake.appendChildren(ID.C1, [
    fake.block(ID.C1_PARA, "paragraph", { rich_text: richText("Step one: restart"), color: "default" }),
    fake.block(ID.GC1, "child_page", { title: "Deep Dive" }),
  ], "page_id");
  fake.addPage(ID.GC1, { title: "Deep Dive", parent: { type: "page_id", page_id: ID.C1 } });
  fake.appendChildren(ID.GC1, [fake.block(ID.GC1_PARA, "paragraph", { rich_text: richText("Deep content"), color: "default" })], "page_id");
  fake.hiddenFromSearch.add(ID.C1);
  fake.hiddenFromSearch.add(ID.GC1);

  fake.addDatabase(ID.DB1, { title: "Tasks", parent: { type: "page_id", page_id: ID.P1 }, dataSources: [{ id: ID.DS1, name: "Tasks" }] });
  fake.addDataSource(ID.DS1, {
    title: "Tasks",
    databaseId: ID.DB1,
    databaseParent: { type: "page_id", page_id: ID.P1 },
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Status: { id: "st%3A", name: "Status", type: "select", select: { options: [{ id: "o1", name: "Todo", color: "red" }, { id: "o2", name: "Done", color: "green" }] } },
      Related: { id: "rel1", name: "Related", type: "relation", relation: { data_source_id: ID.DS1, type: "single_property", single_property: {} } },
      Attachments: { id: "att1", name: "Attachments", type: "files", files: {} },
    },
  });
  for (let i = 1; i <= 5; i++) {
    const props: Record<string, any> = {
      Status: { id: "st%3A", type: "select", select: { id: i % 2 ? "o1" : "o2", name: i % 2 ? "Todo" : "Done", color: i % 2 ? "red" : "green" } },
      Related: { id: "rel1", type: "relation", relation: i === 1 ? Array.from({ length: 25 }, (_, k) => ({ id: uid(0x900 + k) })) : [], has_more: i === 1 },
      Attachments: { id: "att1", type: "files", files: i === 2 ? [{ name: "spec.pdf", ...fake.hostedFile("pdf-1", "spec.pdf", PDF) }] : [] },
    };
    fake.addPage(ID.ROW(i), { title: `Row ${i}`, parent: { type: "data_source_id", data_source_id: ID.DS1, database_id: ID.DB1 }, properties: props });
    fake.appendChildren(ID.ROW(i), i === 3 ? [fake.block(uid(0x800 + i), "paragraph", { rich_text: richText("Row three body"), color: "default" })] : [], "page_id");
  }
  fake.propertyItems.set(`${ID.ROW(1)}/rel1`, Array.from({ length: 30 }, (_, k) => ({ object: "property_item", id: "rel1", type: "relation", relation: { id: uid(0x900 + k) } })));
  // Rows 4 and 5 are only reachable through the data source query.
  fake.hiddenFromSearch.add(ID.ROW(4));
  fake.hiddenFromSearch.add(ID.ROW(5));

  fake.addPage(ID.P2, { title: "Team Notes", parent: { type: "workspace", workspace: true } });
  fake.appendChildren(ID.P2, [
    fake.block(ID.COPY, "synced_block", { synced_from: { type: "block_id", block_id: ID.SYNC } }, { hasChildren: true }),
    fake.block(ID.P2_PARA, "paragraph", { rich_text: richText("Notes body"), color: "default" }),
  ], "page_id");
  fake.blocks.get(ID.COPY)!.has_children = true;

  fake.comment(ID.CM1, ID.P1, "First page comment", { pageId: ID.P1, discussion: "d-1" });
  fake.comment(ID.CM2, ID.P1, "Reply on the page", { pageId: ID.P1, discussion: "d-1" });
  fake.comment(ID.CM3, ID.P1, "Second thread", { pageId: ID.P1, discussion: "d-2" });
  fake.comment(ID.CMB, ID.PARA, "Block comment on welcome", { pageId: ID.P1, blockLevel: true, attachments: [{ category: "image", file: { url: fake.signedUrl("att-1", "note.bin"), expiry_time: "2026-10-01T11:00:00.000Z" } }] });
  fake.fileBytes.set("att-1", ATTACH);
}

export function credentialFor(token = TOKEN, metadata: Record<string, unknown> = { auth_mode: "oauth", botId: BOT_ID, workspaceId: WORKSPACE_ID, workspaceName: "Acme" }) {
  return async () => ({ token, refreshToken: null, metadata });
}

