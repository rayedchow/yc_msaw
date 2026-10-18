import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { confluenceCoverage } from "../../../../src/source-lane/providers/confluence/coverage.js";
import { runConfluenceSweep } from "../../../../src/source-lane/providers/confluence/sweep.js";
import { FakeConfluence, MEDIA_TOKEN, NANGO_KEY } from "./fake-confluence.js";
import { CLOUD, CONN, drain, ENG, journalCount, makeExporter, OPS, PDF, PNG, ROOT, seedSite, sweepOptions, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

const T = "tenant-c1";
let fake: FakeConfluence;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeConfluence();
  seedSite(fake);
  await connect(T, CONN);
});

const page = (id: string, space = ENG) => `${ROOT}/spaces/${space}/pages/${id}`;
const blog = (id: string, space = ENG) => `${ROOT}/spaces/${space}/blogposts/${id}`;

describe("confluence deep lane: initial full capture", () => {
  it("captures every space, page, blog post, version body, ADF, comment thread, permission, restriction and exact attachment bytes", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    // Site + granted scopes (account permissions are data).
    const site = await yc.json(`${ROOT}/_site.json`);
    expect(site).toMatchObject({ cloudId: CLOUD, connectionId: CONN, siteUrl: "https://acme.atlassian.net", status: "active" });
    expect(site.grantedScopes).toContain("read:confluence-content.all");

    // Spaces with permissions.
    expect(await yc.text(`${ROOT}/spaces/${ENG}/_space.md`)).toContain("- Space key: ENG");
    expect((await yc.json(`${ROOT}/spaces/${ENG}/_permissions.json`)).assignments).toHaveLength(3);

    // Current page: storage-format rendering through the donor converter, exact raw, ADF, restrictions.
    const md = await yc.text(`${page("1001")}/page.md`);
    expect(md).toContain("# Release Runbook");
    expect(md).toContain("Hello **world** v3");
    expect(md).toContain("![[attachment:diagram.png]]");
    expect(md).toContain("- Version: v3");
    expect(md).toContain("- Version history captured: v1..v3 of v3");
    expect(md).toContain("- Restrictions: read: 1 user(s), 1 group(s); update: 0 user(s), 1 group(s)");
    expect(md).toMatch(/\[diagram\.png\]\(attachments\/att-1\/diagram\.png\)/u);
    const pageFile = await yc.file(`${page("1001")}/page.md`);
    expect(pageFile).toMatchObject({ kind: "projection", ordinal: 3, versionRef: "v3" });
    const raw = await yc.json(`${page("1001")}/page.json`);
    expect(raw.raw.body.storage.value).toBe('<p>Hello <strong>world</strong> v3</p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>');
    expect(raw.raw.version.number).toBe(3);
    const adf = await yc.json(`${page("1001")}/page.adf.json`);
    expect(adf).toMatchObject({ version: 3, raw: { type: "doc" } });
    expect((await yc.json(`${page("1001")}/restrictions.json`)).restrictions).toHaveLength(2);

    // Version history: every body from the version API, not only metadata.
    expect(await yc.text(`${page("1001")}/versions/v000001.md`)).toContain("First draft");
    expect(await yc.text(`${page("1001")}/versions/v000002.md`)).toContain("Second *draft*");
    expect(await yc.text(`${page("1001")}/versions/v000003.md`)).toContain("Hello **world** v3");
    const v1raw = await yc.json(`${ROOT}/_raw/page/1001/versions/v000001.json`);
    expect(v1raw).toMatchObject({ recordKind: "version", versionNumber: 1, raw: { version: { number: 1 }, body: { storage: { value: "<p>First draft</p>" } } } });
    expect(v1raw.endpoint).toBe("/wiki/api/v2/pages/1001?version=1");
    expect(fake.callsTo(/\/pages\/1001\?.*version=1/u)).toHaveLength(1);
    expect(await yc.text(`${blog("2001")}/versions/v000001.md`)).toContain("launch v1");
    expect(await yc.text(`${blog("2001")}/blogpost.md`)).toContain("launch v2");

    // Comments: threaded replies, inline highlighted text, resolution, blog comments.
    const comments = await yc.text(`${page("1001")}/comments.md`);
    expect(comments).toContain("### Comment c1");
    expect(comments).toContain("#### Comment c2");
    expect(comments).toContain("Agreed, after QA");
    expect(comments).toContain('- Highlighted text: "Hello world"');
    expect(comments).toContain("- Resolution: open");
    expect(comments.indexOf("Comment c2")).toBeGreaterThan(comments.indexOf("Comment c1"));
    expect(await yc.text(`${blog("2001")}/comments.md`)).toContain("Nice post");

    // Attachments: exact bytes as binary, metadata separately.
    const png = await yc.file(`${page("1001")}/attachments/att-1/diagram.png`);
    expect(png?.kind).toBe("binary");
    expect(png?.contentType).toBe("image/png");
    expect(png?.bytes.equals(PNG)).toBe(true);
    expect((await yc.file(`${page("1002")}/attachments/att-2/spec.pdf`))?.bytes.equals(PDF)).toBe(true);
    const meta = await yc.json(`${page("1001")}/attachments/att-1/_attachment.json`);
    expect(meta.binary).toMatchObject({ status: "stored", size: PNG.length, version: 1 });
    expect(meta.raw).toMatchObject({ id: "att-1", mediaType: "image/png", fileSize: PNG.length });
    expect((await yc.file(`${page("1001")}/attachments/att-1/_attachment.json`))?.kind).toBe("raw");

    // Every observed payload is journaled raw, append-only.
    expect((await yc.paths(`${ROOT}/_raw/page/1001/observed`)).length).toBeGreaterThanOrEqual(2);

    // Credentials never leave the transport; signed media URLs are neither persisted nor exported.
    const media = fake.calls.filter((c) => c.url.hostname === "api.media.atlassian.com");
    expect(media.length).toBe(2);
    expect(media.every((c) => c.auth === null)).toBe(true);
    expect(fake.calls.filter((c) => c.url.hostname !== "api.media.atlassian.com").every((c) => c.connectionId === CONN && c.providerConfigKey === "confluence")).toBe(true);
    const everything = await yc.allText();
    expect(everything).not.toContain(MEDIA_TOKEN);
    expect(everything).not.toContain(NANGO_KEY);
    const dbText = await query<{ t: string }>(`
      SELECT string_agg(x, ' ') AS t FROM (
        SELECT raw::text AS x FROM confluence_source_objects UNION ALL SELECT raw::text FROM confluence_source_records
        UNION ALL SELECT payload::text FROM confluence_source_work UNION ALL SELECT COALESCE(restrictions::text, '') FROM confluence_source_objects) s`);
    expect(dbText[0]!.t).not.toContain(MEDIA_TOKEN);
    expect(dbText[0]!.t).not.toContain(NANGO_KEY);

    // Pagination really happened (page size 2) and followed `_links.next` cursors.
    expect(fake.callsTo(/\/spaces\/100\/pages\?.*cursor=/u).length).toBeGreaterThanOrEqual(1);

    // Truthful coverage: current state complete, history explicitly partial.
    const cov = await confluenceCoverage({ tenantId: T, executor: db as never });
    const siteCov = cov.find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(siteCov.state, siteCov.reason).toBe("complete");
    expect(siteCov.counts).toMatchObject({ spaces: 2, pages: 4, blogposts: 1, comments: 4, attachments: 2, attachmentsStored: 2, historyIncomplete: 0 });
    expect(siteCov.lastSuccessAt).toBeTruthy();
    const hist = cov.find((c) => c.scope === `site:${CLOUD}/${CONN}:history`)!;
    expect(hist.state).toBe("partial");
    expect(hist.reason).toContain("5/5 container(s) have every version");
  });

  it("is idempotent: an unchanged second full pass and delta produce no new exports", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter } = await makeExporter(T);
    await drain(exporter);
    const callsBefore = fake.calls.length;
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    const gen = await query<{ generation: number; full_complete_generation: number }>(`SELECT generation, full_complete_generation FROM confluence_source_sync_state WHERE tenant_id = $1`, [T]);
    expect(gen[0]).toMatchObject({ generation: 2, full_complete_generation: 2 });
    expect(fake.calls.length).toBeGreaterThan(callsBefore);
    // No version bodies, ADF or attachment bytes were fetched again.
    expect(fake.calls.slice(callsBefore).filter((c) => /version=|atlas_doc_format|\/download/u.test(c.url.pathname + c.url.search))).toHaveLength(0);
    expect(await journalCount(T)).toBe(0);
    expect((await exporter.runOnce()).claimed).toBe(0);
  });
});

describe("confluence deep lane: updates, moves and deletions", () => {
  it("delta picks up a new page version, a new reply and a new attachment version", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    const now = new Date().toISOString();
    fake.find("1001").versions.push({ number: 4, createdAt: now, title: "Release Runbook", body: "<p>Hello <strong>world</strong> v4</p>" });
    fake.comments.push({ id: "c5", kind: "footer", cloudId: CLOUD, containerType: "page", containerId: "1001", parentCommentId: "c2", version: 1, createdAt: now, updatedAt: now, authorId: "acct-5", body: "<p>QA passed</p>" });
    const att = fake.attachments.find((a) => a.id === "att-1")!;
    const PNG2 = Buffer.concat([PNG, Buffer.from([0x00, 0x01, 0x02])]);
    Object.assign(att, { version: 2, updatedAt: now, bytes: PNG2 });
    const before = fake.calls.length;
    await sweepUntilQuiet(T, fake);
    // Delta via CQL, not a full re-listing.
    const since = fake.calls.slice(before);
    expect(since.some((c) => c.url.pathname.endsWith("/wiki/rest/api/content/search"))).toBe(true);
    expect(since.some((c) => c.url.pathname.endsWith("/spaces"))).toBe(false);
    await drain(exporter);

    expect(await yc.text(`${page("1001")}/page.md`)).toContain("Hello **world** v4");
    expect((await yc.file(`${page("1001")}/page.md`))?.ordinal).toBe(4);
    expect(await yc.text(`${page("1001")}/versions/v000004.md`)).toContain("v4");
    expect(await yc.text(`${page("1001")}/versions/v000003.md`)).toContain("v3");
    const comments = await yc.text(`${page("1001")}/comments.md`);
    expect(comments).toContain("##### Comment c5");
    expect(comments).toContain("QA passed");
    const bin = await yc.file(`${page("1001")}/attachments/att-1/diagram.png`);
    expect(bin?.bytes.equals(PNG2)).toBe(true);
    expect(bin?.ordinal).toBe(2);
    // The store keeps the earlier attachment bytes as history of the same path.
    expect((await yc.history(`${page("1001")}/attachments/att-1/diagram.png`)).map((v) => v.size)).toEqual([PNG2.length, PNG.length]);
  });

  it("moves a page with its versions, comments and attachments to the new space and removes the old paths", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file(`${page("1002")}/versions/v000001.md`)).not.toBeNull();

    const child = fake.find("1002");
    child.spaceId = OPS;
    child.versions.push({ number: 2, createdAt: new Date().toISOString(), title: "Child page", body: "<p>child body (moved)</p>" });
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    expect(await yc.text(`${page("1002", OPS)}/page.md`)).toContain("child body (moved)");
    expect(await yc.file(`${page("1002", OPS)}/versions/v000001.md`)).not.toBeNull();
    expect((await yc.file(`${page("1002", OPS)}/attachments/att-2/spec.pdf`))?.bytes.equals(PDF)).toBe(true);
    for (const p of ["page.md", "page.json", "versions/v000001.md", "attachments/att-2/spec.pdf", "attachments/att-2/_attachment.json"]) {
      expect(await yc.file(`${page("1002")}/${p}`), p).toBeNull();
      expect((await yc.tombstone(`${page("1002")}/${p}`))?.reason, p).toBe("source_path_changed");
    }
    // Raw ledger paths do not depend on placement.
    expect(await yc.file(`${ROOT}/_raw/page/1002/versions/v000001.json`)).not.toBeNull();
  });

  it("tombstones trashed pages, 404-confirmed purged blog posts and a deleted space with everything in it", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    fake.find("1004").status = "trashed";
    fake.containers.splice(fake.containers.indexOf(fake.find("2001")), 1); // purged: gone from every listing and 404 by id
    const opsIdx = fake.spaces.findIndex((s) => s.id === OPS);
    fake.spaces.splice(opsIdx, 1); // whole space deleted (its pages 404 too)
    fake.find("1003").status = "purged";
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);

    expect(await yc.file(`${page("1004")}/page.md`)).toBeNull();
    expect((await yc.tombstone(`${page("1004")}/page.md`))?.reason).toBe("confluence_trashed");
    expect((await yc.tombstone(`${blog("2001")}/blogpost.md`))?.reason).toBe("confluence_not_found");
    expect((await yc.tombstone(`${blog("2001")}/comments.md`))?.reason).toBe("confluence_not_found");
    expect((await yc.tombstone(`${blog("2001")}/versions/v000001.md`))?.reason).toBe("confluence_container_not_found");
    expect((await yc.tombstone(`${ROOT}/spaces/${OPS}/_space.md`))?.reason).toBe("confluence_space_not_found");
    expect((await yc.tombstone(`${page("1003", OPS)}/page.md`))?.reason).toBe("confluence_space_not_found");
    // History survives in the store and the raw ledger is never deleted.
    expect((await yc.history(`${page("1004")}/page.md`)).map((v) => v.kind)).toEqual(["tombstone", "projection"]);
    expect(await yc.file(`${ROOT}/_raw/blogpost/2001/versions/v000001.json`)).not.toBeNull();
    // The rest of ENG is untouched.
    expect(await yc.text(`${page("1001")}/page.md`)).toContain("v3");
    const confirms = fake.callsTo(/\/wiki\/api\/v2\/(spaces\/200|blogposts\/2001)(\?|$)/u);
    expect(confirms.length).toBeGreaterThanOrEqual(2);

    // Restore from trash brings the page back.
    fake.find("1004").status = "current";
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);
    expect(await yc.text(`${page("1004")}/page.md`)).toContain("third");
  });

  it("never deletes during a partial scan: an inaccessible or failing listing confirms nothing", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    const before = fake.calls.length;
    fake.containers.splice(fake.containers.indexOf(fake.find("1002")), 1); // really gone ...
    fake.intercept((u) => /\/spaces\/100\/pages$/u.test(u.pathname) && u.searchParams.getAll("status").includes("current"), () => Response.json({ message: "restricted" }, { status: 403 }), 99);
    fake.intercept((u) => /\/spaces\/100\/blogposts$/u.test(u.pathname) && !u.searchParams.getAll("status").includes("trashed"), () => new Response("upstream", { status: 500 }), 99);
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0, maxItemAttempts: 1 });
    await drain(exporter);

    // ... but its listing did not complete, so nothing was confirmed or tombstoned.
    expect(await yc.text(`${page("1002")}/page.md`)).toContain("child body");
    expect(fake.calls.slice(before).filter((c) => /\/wiki\/api\/v2\/pages\/1002$/u.test(c.url.pathname))).toHaveLength(0);
    expect(await yc.text(`${blog("2001")}/blogpost.md`)).toContain("launch v2");
    const st = (await query(`SELECT generation, generation_phase, full_complete_generation, generation_failed_items FROM confluence_source_sync_state WHERE tenant_id = $1`, [T]))[0]!;
    expect(st).toMatchObject({ generation: 2, generation_phase: "closed", full_complete_generation: 1, generation_failed_items: 1 });
    const cov = (await confluenceCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("finished with 1 failed item(s)");
  });

  it("keeps a page the grant can no longer read (403 on confirmation) instead of deleting it", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    // The page disappears from the listing, and reading it is forbidden.
    const hidden = fake.find("1004");
    hidden.status = "draft";
    fake.intercept((u) => u.pathname.endsWith("/wiki/api/v2/pages/1004"), () => Response.json({ message: "forbidden" }, { status: 403 }), 5);
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);
    const md = await yc.text(`${page("1004")}/page.md`);
    expect(md).toContain("third");
    expect(md).toContain("- Inaccessible since:");
    const cov = (await confluenceCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("no longer readable by this grant");
  });
});

describe("confluence deep lane: rate limits and checkpoints", () => {
  it("persists Retry-After on the shared Atlassian bucket, defers other tenants on the same site, and resumes from the stored cursor", async () => {
    // Second tenant connected to the same site through the same OAuth app (Nango integration).
    const T2 = "tenant-c2";
    fake.site("conn-b", CLOUD, "https://acme.atlassian.net");
    await connect(T2, "conn-b");
    let seen = 0;
    fake.intercept(
      (u) => /\/spaces\/100\/pages$/u.test(u.pathname) && u.searchParams.has("cursor") && ++seen === 1,
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
    );
    const first = await runConfluenceSweep(db as never, T, sweepOptions(fake));
    expect(first.sites[0]).toMatchObject({ outcome: "deferred" });
    const q = (await query(`SELECT quota_key, blocked_until, last_status, last_retry_after_ms FROM confluence_source_quota`))[0]!;
    expect(q.quota_key).toBe(`atlassian:confluence:${CLOUD}`);
    expect(q.last_status).toBe(429);
    expect(Number(q.last_retry_after_ms)).toBe(120_000);
    const wait = new Date(q.blocked_until).getTime() - Date.now();
    expect(wait).toBeGreaterThan(110_000);
    expect(wait).toBeLessThanOrEqual(120_500);
    const item = (await query(`SELECT state, payload FROM confluence_source_work WHERE tenant_id = $1 AND item_key = 'content:100:page'`, [T]))[0]!;
    expect(item.state).toBe("pending");
    expect(item.payload.cursor).toMatch(/cursor=/u);

    // While cooling down nobody calls the site: not this tenant, not the other tenant on the same bucket.
    const calls = fake.calls.length;
    expect((await runConfluenceSweep(db as never, T, sweepOptions(fake))).sites[0]).toMatchObject({ outcome: "deferred" });
    expect((await runConfluenceSweep(db as never, T2, sweepOptions(fake))).sites[0]).toMatchObject({ outcome: "deferred" });
    expect(fake.calls.slice(calls).filter((c) => c.url.pathname.includes("/ex/confluence/"))).toHaveLength(0);
    const cov = (await confluenceCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("rate limit cooldown until");

    // Cooldown over: resume exactly at the checkpoint (the first ENG page is not re-listed).
    await query(`UPDATE confluence_source_quota SET blocked_until = now() - interval '1 second'`);
    await sweepUntilQuiet(T, fake);
    const firstPages = fake.callsTo(/\/spaces\/100\/pages\?/u).filter((c) => !c.url.searchParams.has("cursor") && c.url.searchParams.getAll("status").includes("current"));
    expect(firstPages).toHaveLength(1);
    expect((await query(`SELECT full_complete_generation FROM confluence_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.full_complete_generation).toBe(1);
    expect(Number((await query(`SELECT rate_limit_streak FROM confluence_source_quota`))[0]!.rate_limit_streak)).toBe(0);
  });

  it("backs off exponentially when a 429 carries no Retry-After, and stops at the request budget with a checkpoint", async () => {
    fake.rateLimitNext((u) => u.pathname.endsWith("/wiki/api/v2/spaces"), null);
    await runConfluenceSweep(db as never, T, sweepOptions(fake));
    const a = (await query(`SELECT blocked_until FROM confluence_source_quota`))[0]!;
    const waitA = new Date(a.blocked_until).getTime() - Date.now();
    expect(waitA).toBeGreaterThan(50_000);
    expect(waitA).toBeLessThanOrEqual(61_000);
    await query(`UPDATE confluence_source_quota SET blocked_until = now() - interval '1 second'`);
    fake.rateLimitNext((u) => u.pathname.endsWith("/wiki/api/v2/spaces"), null);
    await runConfluenceSweep(db as never, T, sweepOptions(fake));
    const b = (await query(`SELECT blocked_until, rate_limit_streak FROM confluence_source_quota`))[0]!;
    expect(Number(b.rate_limit_streak)).toBe(2);
    expect(new Date(b.blocked_until).getTime() - Date.now()).toBeGreaterThan(110_000);
    await query(`UPDATE confluence_source_quota SET blocked_until = now() - interval '1 second'`);

    // A tiny budget stops mid-listing; the next run continues from the checkpoint.
    const r = await runConfluenceSweep(db as never, T, sweepOptions(fake, { maxRequestsPerSite: 3 }));
    expect(r.sites[0]!.requests).toBe(3);
    await sweepUntilQuiet(T, fake);
    expect((await query(`SELECT full_complete_generation FROM confluence_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.full_complete_generation).toBe(1);
  });
});
