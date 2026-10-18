import { createHash, randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import {
  ConfluenceApiError,
  ConfluenceAuthError,
  ConfluenceClient,
  ConfluenceRateLimitedError,
  parseNextLink,
  resolveDownloadRedirect,
  retryAfterMsOf,
} from "../../../../src/source-lane/providers/confluence/api.js";
import { confluenceCoverage } from "../../../../src/source-lane/providers/confluence/coverage.js";
import { runConfluenceSweep } from "../../../../src/source-lane/providers/confluence/sweep.js";
import { FakeConfluence, NANGO_BASE, NANGO_KEY } from "./fake-confluence.js";
import { CLOUD, CONN, drain, ENG, makeExporter, PNG, ROOT, seedSite, sweepOptions, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

const T = "tenant-tr";
const target = { providerConfigKey: "confluence", connectionId: CONN, cloudId: CLOUD, siteUrl: "https://acme.atlassian.net" };
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

describe("Confluence transport through the Nango proxy", () => {
  it("accepts only site-relative wiki pagination links (or the site's own host)", () => {
    expect(parseNextLink("/wiki/api/v2/spaces?cursor=abc&limit=2", null)).toEqual({ path: "/wiki/api/v2/spaces", params: { cursor: ["abc"], limit: ["2"] } });
    expect(parseNextLink("/rest/api/content/search?next=true&cursor=x", null).path).toBe("/wiki/rest/api/content/search");
    expect(parseNextLink("https://acme.atlassian.net/wiki/api/v2/pages?cursor=1", "https://acme.atlassian.net").path).toBe("/wiki/api/v2/pages");
    for (const bad of ["https://evil.example/wiki/api/v2/spaces?cursor=1", "http://acme.atlassian.net/wiki/api/v2/pages", "/wiki/../oauth/token", "/admin/secrets", "//evil.example/wiki/api/v2/x"]) {
      expect(() => parseNextLink(bad, "https://acme.atlassian.net"), bad).toThrow(ConfluenceApiError);
    }
  });

  it("follows download redirects only to Atlassian media hosts without credentials, or back through the proxy", () => {
    const current = new URL(`${NANGO_BASE}/proxy/ex/confluence/${CLOUD}/wiki/rest/api/content/1/child/attachment/a/download`);
    expect(resolveDownloadRedirect("https://api.media.atlassian.com/file/x/binary?token=t", CLOUD, NANGO_BASE, current)).toMatchObject({ authenticated: false });
    const rel = resolveDownloadRedirect("/wiki/download/attachments/1/a.png?version=1", CLOUD, NANGO_BASE, current);
    expect(rel.authenticated).toBe(true);
    expect(rel.url.href).toBe(`${NANGO_BASE}/proxy/ex/confluence/${CLOUD}/wiki/download/attachments/1/a.png?version=1`);
    for (const bad of ["https://evil.example/x", "http://api.media.atlassian.com/file/x", "https://user:pw@api.media.atlassian.com/x", "https://atlassian.com.evil.example/x", "/oauth/token", "/wiki/../x"]) {
      expect(() => resolveDownloadRedirect(bad, CLOUD, NANGO_BASE, current), bad).toThrow(ConfluenceApiError);
    }
  });

  it("parses Retry-After (seconds, HTTP date) and Atlassian X-RateLimit-Reset", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(retryAfterMsOf(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
    expect(retryAfterMsOf(new Headers({ "retry-after": "Sat, 17 Oct 2026 10:01:00 GMT" }), now)).toBe(60_000);
    expect(retryAfterMsOf(new Headers({ "x-ratelimit-reset": "2026-10-17T10:00:45Z" }), now)).toBe(45_000);
    expect(retryAfterMsOf(new Headers({}), now)).toBeNull();
  });

  it("raises typed errors: 429 with deadline, 401 as auth, tolerated optional-scope 401, and no silent redirects", async () => {
    const c = new ConfluenceClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch, now: () => Date.parse("2026-10-17T10:00:00Z") });
    fake.rateLimitNext(() => true, "7");
    const err = await c.get(target, "/wiki/api/v2/spaces").catch((e) => e);
    expect(err).toBeInstanceOf(ConfluenceRateLimitedError);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.retryAt.toISOString()).toBe("2026-10-17T10:00:07.000Z");
    fake.intercept(() => true, () => Response.json({ code: 401, message: "Unauthorized; scope does not match" }, { status: 401 }), 2);
    expect(await c.get(target, "/wiki/api/v2/spaces").catch((e) => e)).toBeInstanceOf(ConfluenceAuthError);
    expect((await c.get(target, `/wiki/api/v2/spaces/${ENG}/permissions`, {}, [401, 403])).status).toBe(401);
    fake.intercept(() => true, () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    expect((await c.get(target, "/wiki/api/v2/spaces").catch((e) => e)).code).toBe("unexpected_redirect");
    expect(fake.calls.some((x) => x.url.hostname === "evil.example")).toBe(false);
    await expect(c.get(target, "/oauth/token/accessible-resources" as string)).rejects.toThrow(/non-wiki/u);
  });
});

describe("Confluence sweep transport safety", () => {
  it("refuses a pagination link to another host and does not mark the inventory complete", async () => {
    fake.intercept(
      (u) => u.pathname.endsWith("/wiki/api/v2/spaces") && !u.searchParams.has("cursor"),
      () => Response.json({ results: [{ id: ENG, key: "ENG", name: "Engineering", status: "current", type: "global" }], _links: { next: "https://evil.example/wiki/api/v2/spaces?cursor=steal" } }),
      99,
    );
    await sweepUntilQuiet(T, fake, { maxItemAttempts: 1 });
    expect(fake.calls.some((c) => c.url.hostname === "evil.example")).toBe(false);
    const st = (await query(`SELECT full_complete_generation, generation_failed_items FROM confluence_source_sync_state WHERE tenant_id = $1`, [T]))[0]!;
    expect(st.full_complete_generation).toBeNull();
    expect(Number(st.generation_failed_items)).toBe(1);
    const w = (await query(`SELECT state, last_error FROM confluence_source_work WHERE tenant_id = $1 AND item_key = 'spaces'`, [T]))[0]!;
    expect(w).toMatchObject({ state: "failed" });
    expect(w.last_error).toContain("another host");
  });

  it("never sends a credential to an untrusted redirect target; falls back cleanly on same-site redirects", async () => {
    fake.downloadMode = "evil-redirect";
    await sweepUntilQuiet(T, fake, { maxItemAttempts: 1 });
    expect(fake.calls.some((c) => c.url.hostname === "evil.example")).toBe(false);
    const att = (await query(`SELECT binary_status FROM confluence_source_objects WHERE tenant_id = $1 AND content_id = 'att-1'`, [T]))[0]!;
    expect(att.binary_status).toBe("pending");
    const cov = (await confluenceCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("without current bytes");

    // Same-site relative redirect: followed through the authenticated proxy, bytes stored.
    fake.downloadMode = "wiki-redirect";
    const failed = await query(`SELECT state, last_error FROM confluence_source_work WHERE tenant_id = $1 AND kind = 'download'`, [T]);
    expect(failed.every((w) => w.state === "failed" && /refusing download redirect to evil\.example/u.test(w.last_error))).toBe(true);
    await query(`UPDATE confluence_source_work SET state = 'pending', attempts = 0, not_before = NULL WHERE tenant_id = $1 AND kind = 'download'`, [T]);
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect((await yc.file(`${ROOT}/spaces/${ENG}/pages/1001/attachments/att-1/diagram.png`))?.bytes.equals(PNG)).toBe(true);
    expect(fake.callsTo(/\/wiki\/download\/attachments\/1001\//u).every((c) => c.auth === `Bearer ${NANGO_KEY}`)).toBe(true);
  });

  it("streams a multi-chunk attachment (> 8 MiB) into ordered chunks and exports the exact bytes", async () => {
    const big = Buffer.concat([randomBytes(8 * 1024 * 1024), Buffer.from([0x00, 0xff, 0x0a]), randomBytes(1000)]);
    fake.attachments.push({ id: "att-9m", cloudId: CLOUD, containerType: "page", containerId: "1001", title: "dump.bin", mediaType: "application/octet-stream", version: 1, updatedAt: new Date(0).toISOString(), bytes: big });
    await sweepUntilQuiet(T, fake);
    const blob = (await query(`SELECT size, chunks FROM confluence_source_blobs WHERE tenant_id = $1 AND sha256 = $2`, [T, createHash("sha256").update(big).digest("hex")]))[0]!;
    expect(Number(blob.size)).toBe(big.length);
    expect(blob.chunks.map((c: { size: number }) => c.size)).toEqual([8 * 1024 * 1024, big.length - 8 * 1024 * 1024]);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const f = await yc.file(`${ROOT}/spaces/${ENG}/pages/1001/attachments/att-9m/dump.bin`);
    expect(f?.kind).toBe("binary");
    expect(f?.bytes.equals(big)).toBe(true);
  }, 60_000);

  it("reports attachments over the capture limit as too_large metadata, never as complete", async () => {
    fake.attachments.push({ id: "att-big", cloudId: CLOUD, containerType: "page", containerId: "1001", title: "huge.bin", mediaType: "application/octet-stream", version: 1, updatedAt: new Date(0).toISOString(), bytes: Buffer.alloc(10), fileSize: 5_000_000_000 });
    // Declared small but streams more than the limit: cut off while streaming.
    fake.attachments.push({ id: "att-liar", cloudId: CLOUD, containerType: "page", containerId: "1001", title: "liar.bin", mediaType: "application/octet-stream", version: 1, updatedAt: new Date(0).toISOString(), bytes: Buffer.alloc(9000, 7), fileSize: 100 });
    await sweepUntilQuiet(T, fake, { maxAttachmentBytes: 8000 });
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const dir = `${ROOT}/spaces/${ENG}/pages/1001/attachments`;
    expect((await yc.json(`${dir}/att-big/_attachment.json`)).binary).toMatchObject({ status: "too_large" });
    expect((await yc.json(`${dir}/att-liar/_attachment.json`)).binary).toMatchObject({ status: "too_large" });
    expect(await yc.file(`${dir}/att-big/huge.bin`)).toBeNull();
    expect(await yc.file(`${dir}/att-liar/liar.bin`)).toBeNull();
    expect(fake.callsTo(/att-big\/download/u)).toHaveLength(0);
    expect(await yc.text(`${ROOT}/spaces/${ENG}/pages/1001/page.md`)).toContain("bytes too_large");
    const cov = (await confluenceCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("2 over the size limit");
  });

  it("blocks coverage when the Nango connection is unknown or the grant is rejected, and keeps content when a site is removed", async () => {
    await connect(T, "conn-unknown");
    await sweepUntilQuiet(T, fake);
    const cov = await confluenceCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === "connection:conn-unknown")).toMatchObject({ state: "blocked" });
    expect(cov.find((c) => c.scope === `site:${CLOUD}/${CONN}`)?.state).toBe("complete");

    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    fake.sites.set(CONN, []); // access to the site removed from the grant
    await runConfluenceSweep(db as never, T, sweepOptions(fake, { siteRefreshMs: 0 }));
    const after = await confluenceCoverage({ tenantId: T, executor: db as never });
    expect(after.find((c) => c.scope === `site:${CLOUD}/${CONN}`)).toMatchObject({ state: "blocked" });
    expect(after.find((c) => c.scope === `site:${CLOUD}/${CONN}`)?.reason).toContain("no longer reachable");
    await drain(exporter);
    expect(await yc.text(`${ROOT}/spaces/${ENG}/pages/1001/page.md`)).toContain("v3");
    expect((await yc.json(`${ROOT}/_site.json`)).status).toBe("removed");
  });

  it("isolates tenants and sites: the same content id on two sites never shares state or paths", async () => {
    const T2 = "tenant-other";
    const other = "cloud-2222";
    fake.site("conn-z", other, "https://other.atlassian.net");
    fake.space(other, ENG, "ENG2");
    fake.page({ id: "1001", cloudId: other, spaceId: ENG, versions: [{ number: 1, createdAt: new Date(0).toISOString(), title: "Other tenant page", body: "<p>other tenant secret</p>" }] });
    await connect(T2, "conn-z");
    await sweepUntilQuiet(T, fake);
    await sweepUntilQuiet(T2, fake);
    const rows = await query<{ tenant_id: string; cloud_id: string }>(`SELECT tenant_id, cloud_id FROM confluence_source_objects WHERE content_type = 'page' AND content_id = '1001' ORDER BY tenant_id`);
    expect(rows).toEqual([{ tenant_id: T2, cloud_id: other }, { tenant_id: T, cloud_id: CLOUD }]);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.allText()).not.toContain("other tenant secret");
  });
});
