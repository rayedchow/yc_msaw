import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
  getGoogleAccessToken: vi.fn(async () => "tok"),
}));

import { allStoredText, db, fakeFetch, heads, json, liveFile, liveJson, ready, resetTenant, type Route } from "./harness.js";
import { exportDriveFile, resetExportFormatsCacheForTests } from "../../../../src/source-lane/providers/google-docs/drive-export.js";
import { driveFileDirectory, driveFilePaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint, recordDriveFileSeen } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { runGdocsSourceSweep } from "../../../../src/source-lane/providers/google-docs/sweep.js";
import { quotaUserFor } from "../../../../src/source-lane/providers/google-docs/google-fetch.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-drive";
const MAILBOX = "ada@corp.example";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const XLSX_BYTES = Buffer.from("PK\u0003\u0004 synthetic xlsx \u0000ÿ bytes", "latin1");

function fileMeta(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: "Budget 2026", mimeType: SHEET, headRevisionId: "rev-a", modifiedTime: "2026-10-01T00:00:00Z",
    capabilities: { canDownload: true }, permissions: [{ id: "p", type: "domain", role: "reader", domain: "corp.example" }],
    exportLinks: { [XLSX]: `https://docs.google.com/spreadsheets/export?id=${id}&SECRET-LINK-TOKEN` },
    thumbnailLink: "https://lh3.googleusercontent.com/THUMB",
    ...over,
  };
}

function routes(extra: Route[], meta: Record<string, unknown>, exportFormats: Record<string, string[]> = { [SHEET]: ["application/pdf", XLSX, "text/csv"], [SLIDES]: [PPTX, "application/pdf"] }) {
  return fakeFetch([
    ...extra,
    (url) => url.pathname === "/drive/v3/about" ? json({ exportFormats }) : undefined,
    (url) => url.pathname === `/drive/v3/files/${meta.id}` && !url.searchParams.has("alt") ? json(meta) : undefined,
  ]);
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  resetExportFormatsCacheForTests();
  await resetTenant(TENANT);
});

const run = (fileId: string, f: ReturnType<typeof fakeFetch>, now = new Date("2026-10-02T00:00:00Z")) =>
  exportDriveFile({ tenantId: TENANT, fileId, mailbox: MAILBOX, accessToken: "tok", fetchImpl: f.impl, now, deps });

describe("Sheets / Slides via the account's actual exportFormats", () => {
  it("exports the preferred offered format with exact bytes plus native JSON, quota-attributed", async () => {
    const meta = fileMeta("sheet-1");
    const f = routes([
      (url) => url.pathname === "/drive/v3/files/sheet-1/export" && url.searchParams.get("mimeType") === XLSX
        ? new Response(new Uint8Array(XLSX_BYTES), { status: 200, headers: { "content-type": XLSX } }) : undefined,
      (url) => url.hostname === "sheets.googleapis.com" ? json({ spreadsheetId: "sheet-1", sheets: [{ properties: { title: "Q1" }, data: [{ rowData: [{ values: [{ formattedValue: "42" }] }] }] }] }) : undefined,
    ], meta);
    const r = await run("sheet-1", f);
    expect(r.state).toBe("complete");

    const P = driveFilePaths(driveFileDirectory("sheets", "sheet-1", "Budget 2026"));
    const content = await liveFile(TENANT, P.content("Budget 2026.xlsx"));
    expect(content!.bytes.equals(XLSX_BYTES)).toBe(true);
    expect(content!.contentType).toBe(XLSX);
    expect(await liveJson(TENANT, P.native)).toMatchObject({ spreadsheetId: "sheet-1" });
    const drive = await liveJson<{ file: Record<string, unknown> }>(TENANT, P.drive);
    expect(drive.file.permissions).toEqual(meta.permissions);
    expect(drive.file).not.toHaveProperty("exportLinks");
    expect(await liveJson(TENANT, P.status)).toMatchObject({ state: "complete", exportMimeType: XLSX, method: "files.export" });

    for (const call of f.calls.filter((c) => c.url.includes("googleapis.com"))) {
      expect(call.headers.get("x-goog-quota-user")).toBe(quotaUserFor(TENANT, MAILBOX));
    }
    expect(await allStoredText(TENANT)).not.toContain("SECRET-LINK-TOKEN");
  });

  it("falls back to the export link once files.export hits its 10 MB limit, without persisting the link", async () => {
    const meta = fileMeta("sheet-big");
    const f = routes([
      (url) => url.pathname === "/drive/v3/files/sheet-big/export"
        ? json({ error: { errors: [{ reason: "exportSizeLimitExceeded" }], message: "too large" } }, 403) : undefined,
      (url) => url.hostname === "docs.google.com" ? new Response(new Uint8Array(XLSX_BYTES), { status: 200, headers: { "content-type": XLSX } }) : undefined,
      (url) => url.hostname === "sheets.googleapis.com" ? json({ spreadsheetId: "sheet-big" }) : undefined,
    ], meta);
    const r = await run("sheet-big", f);
    expect(r.state).toBe("complete");
    const P = driveFilePaths(driveFileDirectory("sheets", "sheet-big", "Budget 2026"));
    expect((await liveFile(TENANT, P.content("Budget 2026.xlsx")))!.bytes.equals(XLSX_BYTES)).toBe(true);
    expect((await liveJson<{ method: string }>(TENANT, P.status)).method).toMatch(/^exportLinks/);
    expect(await allStoredText(TENANT)).not.toContain("SECRET-LINK-TOKEN");
  });

  it("redacts requester-scoped Slides image contentUrl in native JSON", async () => {
    const meta = fileMeta("deck-1", { name: "Deck", mimeType: SLIDES, exportLinks: {} });
    const f = routes([
      (url) => url.pathname === "/drive/v3/files/deck-1/export" ? new Response(new Uint8Array(Buffer.from("pptx")), { status: 200, headers: { "content-type": PPTX } }) : undefined,
      (url) => url.hostname === "slides.googleapis.com"
        ? json({ presentationId: "deck-1", slides: [{ pageElements: [{ image: { contentUrl: "https://lh3.googleusercontent.com/SLIDE-IMAGE-TOKEN", sourceUrl: "https://example.com/a.png" } }] }] })
        : undefined,
    ], meta);
    expect((await run("deck-1", f)).state).toBe("complete");
    const P = driveFilePaths(driveFileDirectory("slides", "deck-1", "Deck"));
    const native = await liveJson<any>(TENANT, P.native);
    expect(native.slides[0].pageElements[0].image.contentUrl).toBe("[redacted: ephemeral requester-scoped URL]");
    expect(await allStoredText(TENANT)).not.toContain("SLIDE-IMAGE-TOKEN");
  });

  it("is unsupported (not complete) when the account offers no export format", async () => {
    const meta = fileMeta("form-1", { mimeType: "application/vnd.google-apps.form", exportLinks: {} });
    const r = await run("form-1", routes([], meta, {}));
    expect(r.state).toBe("unsupported");
    expect(r.reason).toContain("no_export_format_offered");
  });
});

describe("binary Drive files via alt=media", () => {
  const binMeta = (over: Record<string, unknown> = {}) => fileMeta("bin-1", { name: "photo.raw", mimeType: "image/x-raw", headRevisionId: undefined, md5Checksum: "md5-1", ...over });
  const media = (bytes: Buffer, headers: Record<string, string> = {}): Route =>
    (url) => url.pathname === "/drive/v3/files/bin-1" && url.searchParams.get("alt") === "media" ? new Response(new Uint8Array(bytes), { status: 200, headers }) : undefined;

  it("stores exact bytes larger than one 8 MiB chunk", async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    const r = await run("bin-1", routes([media(bytes)], binMeta()));
    expect(r.state).toBe("complete");
    const P = driveFilePaths(driveFileDirectory("files", "bin-1", "photo.raw"));
    const stored = await liveFile(TENANT, P.content("photo.raw"));
    expect(stored!.bytes.equals(bytes)).toBe(true);
  });

  it("reports partial (never complete, no truncated file) above the explicit size limit", async () => {
    const r = await exportDriveFile({
      tenantId: TENANT, fileId: "bin-1", mailbox: MAILBOX, accessToken: "tok",
      fetchImpl: routes([media(Buffer.alloc(64))], binMeta()).impl, deps, limits: { mediaMaxBytes: 10 },
    });
    expect(r.state).toBe("partial");
    expect(r.reason).toContain("over_limit");
    expect((await heads(TENANT, `${driveFileDirectory("files", "bin-1", "photo.raw")}/content/`))).toEqual([]);
    expect(await liveJson(TENANT, driveFilePaths(driveFileDirectory("files", "bin-1", "photo.raw")).status))
      .toMatchObject({ state: "partial", limits: { mediaMaxBytes: 10 } });
  });

  it("is blocked when source permissions forbid download", async () => {
    const r = await run("bin-1", routes([media(Buffer.from("x"))], binMeta({ capabilities: { canDownload: false } })));
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("download_restricted_by_source_permissions");
  });

  it("repeat exports of the same Drive version are skipped; a new version is exported", async () => {
    const f1 = routes([media(Buffer.from("one"))], binMeta());
    expect((await run("bin-1", f1)).state).toBe("complete");
    expect((await run("bin-1", f1)).state).toBe("skipped");
    const f2 = routes([media(Buffer.from("two"))], binMeta({ md5Checksum: "md5-2", modifiedTime: "2026-10-03T00:00:00Z" }));
    expect((await run("bin-1", f2)).state).toBe("complete");
    const P = driveFilePaths(driveFileDirectory("files", "bin-1", "photo.raw"));
    expect((await liveFile(TENANT, P.content("photo.raw")))!.bytes.toString()).toBe("two");
    expect((await liveFile(TENANT, P.content("photo.raw")))!.seq).toBe(2);
  });

  it("defers on 429 with Retry-After instead of failing, and the sweep stops for that identity", async () => {
    await recordDriveFileSeen(TENANT, { fileId: "bin-1", mailbox: MAILBOX, mimeType: "image/x-raw", name: "photo.raw", version: "md5-1", modifiedTime: "2026-10-01T00:00:00Z" }, deps);
    await recordDriveFileSeen(TENANT, { fileId: "bin-2", mailbox: MAILBOX, mimeType: "image/x-raw", name: "b", version: "m", modifiedTime: "2026-10-01T00:00:00Z" }, deps);
    const f = fakeFetch([() => json({ error: { message: "slow down" } }, 429, { "retry-after": "600" })]);
    vi.stubGlobal("fetch", f.impl);
    try {
      const now = new Date();
      const out = await runGdocsSourceSweep(TENANT, { now, maxFiles: 5, budgetMs: 10_000, includeDocs: false, deps });
      expect(out.stoppedFor).toBe("rate_limited");
      expect(f.calls).toHaveLength(1);
      const cp = await getCheckpoint(TENANT, out.results[0].fileId, deps);
      expect(cp!.contentState).toBe("pending");
      expect(Date.parse(cp!.contentRetryAt!) - now.getTime()).toBeGreaterThanOrEqual(600_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
