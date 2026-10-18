import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
  getGoogleAccessToken: vi.fn(async () => "synthetic-bearer"),
}));

import { db, fakeFetch, heads, json, liveFile, query, ready, resetTenant } from "./harness.js";
import { snapshotDocContent } from "../../../../src/integrations/google/gdocs/content-snapshot.js";
import { storeDocImages } from "../../../../src/integrations/google/gdocs/images.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { googleDocsCoverage } from "../../../../src/source-lane/providers/google-docs/coverage.js";
import { runGdocsSourceSweep } from "../../../../src/source-lane/providers/google-docs/sweep.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * Audit L2 (provider-repairs): a Doc with more embedded images than the per-doc limit (default 1000,
 * GDOCS_IMAGE_MAX_PER_DOC) must not silently lose references. Every ref is counted, the limit only bounds one run's
 * fetches, never-captured images go first so a continuation run captures the rest, and the gap is reported.
 * Production path: snapshotDocContent (documents.get + storeDocImages) -> source export -> checkpoint/coverage.
 * Synthetic data only; the ephemeral contentUri must never be stored.
 */
const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-image-cap";
const DOC = "doc-image-cap";
const N = 1001;
const objectId = (i: number) => `kix.img${String(i).padStart(4, "0")}`;
const uri = (i: number) => `https://lh3.googleusercontent.com/docs/EPHEMERAL-${i}`;
const png = (i: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i & 0xff, (i >> 8) & 0xff]);

function manyImageDoc(revisionId: string) {
  const inlineObjects: Record<string, unknown> = {};
  const content: unknown[] = [{ paragraph: { elements: [{ textRun: { content: "Gallery\n" } }] } }];
  for (let i = 0; i < N; i++) {
    inlineObjects[objectId(i)] = { inlineObjectProperties: { embeddedObject: { title: `Figure ${i}`, imageProperties: { contentUri: uri(i) } } } };
    content.push({ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: objectId(i) } }] } });
  }
  return { documentId: DOC, title: "Gallery", revisionId, tabs: [{ tabProperties: { tabId: "t.0", title: "Gallery", index: 0 }, documentTab: { body: { content }, inlineObjects } }] };
}

function routes(state: { doc: unknown; imageCalls: string[] }) {
  return fakeFetch([
    (url) => (url.hostname === "docs.googleapis.com" ? json(state.doc) : undefined),
    (url) => {
      const m = /EPHEMERAL-(\d+)$/u.exec(url.href);
      if (!m) return undefined;
      state.imageCalls.push(url.href);
      return new Response(new Uint8Array(png(Number(m[1]))), { status: 200, headers: { "content-type": "image/png" } });
    },
    (url) => (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${DOC}` ? json({ id: DOC, name: "Gallery", mimeType: "application/vnd.google-apps.document" }) : undefined),
    (url) => (url.hostname === "docs.google.com" ? new Response("", { status: 403 }) : undefined),
  ]);
}

async function capture(state: { doc: unknown; imageCalls: string[] }, run: () => Promise<unknown>) {
  vi.stubGlobal("fetch", routes(state).impl);
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

const storedImageIds = async () => (await query<{ object_id: string }>(`SELECT object_id FROM google_doc_images WHERE user_id = $1 AND doc_id = $2 ORDER BY object_id`, [TENANT, DOC])).map((r) => r.object_id);


beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  await resetTenant(TENANT);
});

describe("Docs embedded images over the per-doc limit (audit L2)", () => {
  it("counts all 1001 refs, fetches 1000 this run, reports the 1 gap, and a re-run captures exactly the missing one", async () => {
    const raw = manyImageDoc("rev-1");
    const calls: string[] = [];
    const fetcher = async (u: string) => {
      calls.push(u);
      return new Response(new Uint8Array(png(Number(/EPHEMERAL-(\d+)$/u.exec(u)![1]))), { status: 200, headers: { "content-type": "image/png" } });
    };
    const first = await storeDocImages(TENANT, DOC, raw, fetcher, { refetchFresh: true });
    expect(first).toEqual({ refsFound: N, fetched: 1000, skippedFresh: 0, skippedTooLarge: 0, failed: 0, overCapMissing: 1, overCapKeptPrevious: 0 });
    expect(first.fetched + first.overCapMissing + first.overCapKeptPrevious + first.failed + first.skippedTooLarge + first.skippedFresh).toBe(first.refsFound);
    expect((await storedImageIds())).toHaveLength(1000);
    expect(await storedImageIds()).not.toContain(objectId(1000));

    // Continuation: the never-captured image is fetched first; the least recently fetched one keeps earlier bytes.
    calls.length = 0;
    const second = await storeDocImages(TENANT, DOC, raw, fetcher, { refetchFresh: true });
    expect(second).toMatchObject({ refsFound: N, fetched: 1000, overCapMissing: 0, overCapKeptPrevious: 1 });
    expect(calls[0]).toBe(uri(1000));
    expect(await storedImageIds()).toHaveLength(N);

    // Live-fetch path (24 h fresh window): nothing is re-downloaded and nothing is reported missing.
    calls.length = 0;
    const third = await storeDocImages(TENANT, DOC, raw, fetcher);
    expect(third).toMatchObject({ refsFound: N, fetched: 0, skippedFresh: N, overCapMissing: 0, overCapKeptPrevious: 0 });
    expect(calls).toHaveLength(0);
  }, 60_000);

  it("the content snapshot reports the gap as partial (not complete) and the sweep continuation completes it with every image file live", async () => {
    const state = { doc: manyImageDoc("rev-1") as unknown, imageCalls: [] as string[] };
    const r = await capture(state, () => snapshotDocContent(TENANT, DOC, { modifiedTime: "2026-10-01T10:00:00Z" })) as { status: string };
    expect(r.status).toBe("captured");
    expect(state.imageCalls).toHaveLength(1000);
    const cp = await getCheckpoint(TENANT, DOC, deps);
    expect(cp!.contentState).toBe("partial");
    expect(cp!.contentReason).toContain("images_over_per_run_cap_pending:1");
    const P = docPaths(docDirectory(DOC, "Gallery"));
    expect(await liveFile(TENANT, P.imageMeta(objectId(1000)))).toBeNull();
    const cov = (await googleDocsCoverage({ tenantId: TENANT, executor: db as never })).find((c) => c.scope === "docs-content")!;
    expect(cov.state).not.toBe("complete");

    // The production sweep picks up the due partial content and re-runs the snapshot (fresh contentUris).
    state.imageCalls.length = 0;
    await capture(state, () => runGdocsSourceSweep(TENANT, { now: new Date(Date.now() + 3_600_000), maxFiles: 5, budgetMs: 60_000, includeDocs: true, deps }));
    expect(state.imageCalls[0]).toBe(uri(1000));
    const done = await getCheckpoint(TENANT, DOC, deps);
    expect(done!.contentState).toBe("complete");
    expect(done!.contentReason ?? "").not.toContain("images_over_per_run_cap_pending");
    const image = await liveFile(TENANT, P.imageBytes(objectId(1000), ".png"));
    expect(image!.bytes.equals(png(1000))).toBe(true);
    const imageHeads = (await heads(TENANT, `${P.imagesDir}/`)).filter((h) => h.op === "put" && !h.path.endsWith(".json"));
    expect(imageHeads).toHaveLength(N);
    const stored = JSON.stringify(await query(`SELECT * FROM google_doc_images WHERE user_id = $1 LIMIT 5`, [TENANT]));
    expect(stored).not.toContain("EPHEMERAL-");
  }, 120_000);
});
