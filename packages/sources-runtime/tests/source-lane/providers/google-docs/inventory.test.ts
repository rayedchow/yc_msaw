import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { db, fakeFetch, json, query, ready, resetTenant } from "./harness.js";
import { listInventory, runDriveInventory, type InventoryDeps } from "../../../../src/source-lane/providers/google-docs/inventory.js";
import { googleDocsProvider } from "../../../../src/source-lane/providers/google-docs/index.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { quotaUserFor } from "../../../../src/source-lane/providers/google-docs/google-fetch.js";
import { GoogleOAuthScopeError } from "../../../../src/vault/google-oauth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * Coordinator: full Drive inventory (files untouched since connect are captured), resumable per mailbox,
 * Retry-After honoured, gaps reported, and `drive-inventory` coverage complete only after a gap-free listing.
 * PGlite with the real migration plan; donor recordSourceLaneLiveChanges + enqueueContentSnapshotsForDocs run for real.
 */
const T = "tenant-inventory";
const MB = "ana@acme.test";
const MB2 = "bo@acme.test";
const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const FOLDER = "application/vnd.google-apps.folder";
const PDF = "application/pdf";

type F = { id: string; name: string; mimeType: string; modifiedTime: string; trashed?: boolean };
const file = (id: string, mimeType: string, extra: Partial<F> = {}): F => ({ id, name: `name-${id}`, mimeType, modifiedTime: "2025-01-01T00:00:00.000Z", ...extra });

/** A fake Drive: per (corpora, driveId) an array of pages. */
function fakeDrive(opts: {
  user: F[][];
  drives?: Record<string, F[][]>;
  hooks?: Array<(url: URL) => Response | undefined>;
}) {
  return fakeFetch([
    (url) => {
      for (const h of opts.hooks ?? []) {
        const r = h(url);
        if (r) return r;
      }
      return undefined;
    },
    (url) => (url.pathname === "/drive/v3/drives" ? json({ drives: Object.keys(opts.drives ?? {}).map((id) => ({ id })) }) : undefined),
    (url) => {
      if (url.pathname !== "/drive/v3/files") return undefined;
      const pages = url.searchParams.get("corpora") === "drive" ? opts.drives?.[url.searchParams.get("driveId")!] : opts.user;
      if (!pages) return json({ error: { code: 404, message: "not found", errors: [{ reason: "notFound" }] } }, 404);
      const i = Number(url.searchParams.get("pageToken")?.split(":")[1] ?? 0);
      const next = i + 1 < pages.length ? `${url.searchParams.get("driveId") ?? "user"}:${i + 1}` : undefined;
      return json({ files: pages[i] ?? [], ...(next ? { nextPageToken: next } : {}) });
    },
  ]);
}

const pdfCalls: string[][] = [];
function deps(fetch: ReturnType<typeof fakeFetch>, extra: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    db: db as unknown as SqlDatabase,
    fetchImpl: fetch.impl,
    mailboxes: [MB],
    accessToken: async () => "synthetic-bearer",
    hooks: { processPdfs: async (_t, changes) => void pdfCalls.push(changes.map((c) => c.fileId)) },
    ...extra,
  };
}

/** final-audit M4: Docs coverage is complete only while gdocs.poll keeps succeeding; record one that just did. */
const polledNow = (tenant: string) =>
  query(`INSERT INTO source_sync_runs (user_id, provider, status, coverage_to, metadata, completed_at) VALUES ($1, 'google', 'completed', now(), '{"taskKind":"gdocs.poll"}', now())`, [tenant]);
const coverage = async () => {
  await polledNow(T);
  return (await googleDocsProvider.coverage!({ tenantId: T, executor: db as never })).find((r) => r.scope === "drive-inventory")!;
};

async function connectMailboxes(...emails: string[]) {
  for (const e of emails) {
    await query(`INSERT INTO connections (tenant_id, provider, status, external_account_id) VALUES ($1, 'google', 'active', $2)`, [T, e]);
  }
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  pdfCalls.length = 0;
  await resetTenant(T);
  await query(`DELETE FROM gdocs_drive_inventory WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM connections WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM task_queue WHERE tenant_id = $1`, [T]);
});

describe("full Drive inventory", () => {
  it("lists My Drive and every shared drive resumably, checkpoints every lane file and completes coverage", async () => {
    await connectMailboxes(MB);
    const drive = fakeDrive({
      user: [
        [file("d1", DOC), file("s1", SHEET), file("folder1", FOLDER), file("p1", PDF)],
        [file("bin1", "image/png"), file("t1", DOC, { trashed: true })],
      ],
      drives: { sd1: [[file("d2", DOC)]] },
    });
    expect((await coverage()).state).toBe("pending");

    // Two pages per call: the run stops mid-listing and resumes from the persisted page token.
    const first = await runDriveInventory(T, { maxPages: 2, budgetMs: 60_000, deps: deps(drive) });
    expect(first.stoppedFor).toBe("pages");
    const [mid] = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(mid).toMatchObject({ state: "running", phases: ["user", "drive:sd1"], phaseIndex: 1, pageToken: null, pages: 2 });
    expect((await coverage()).state).toBe("partial");

    await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) });
    const [done] = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(done).toMatchObject({ state: "complete", filesListed: 6, filesRecorded: 4, pdfsListed: 1, gaps: [] });

    // Lane files (not folders, not PDFs, not trashed) have pending checkpoints the sweep will export.
    for (const id of ["d1", "s1", "bin1", "d2"]) expect((await getCheckpoint(T, id, { db: db as unknown as SqlDatabase }))?.contentState, id).toBe("pending");
    for (const id of ["folder1", "p1", "t1"]) expect(await getCheckpoint(T, id, { db: db as unknown as SqlDatabase }), id).toBeNull();
    expect(pdfCalls).toEqual([["p1"]]);
    const tasks = await query<{ kind: string; payload: { docId: string } }>(`SELECT kind, payload FROM task_queue WHERE tenant_id = $1 ORDER BY payload->>'docId'`, [T]);
    expect(tasks.map((t) => [t.kind, t.payload.docId])).toEqual([["gdocs.content-snapshot", "d1"], ["gdocs.content-snapshot", "d2"]]);

    // Every googleapis call is attributed to the mailbox identity, and listings are scoped per corpus.
    expect(drive.calls.every((c) => c.headers.get("x-goog-quota-user") === quotaUserFor(T, MB))).toBe(true);
    const listed = drive.calls.filter((c) => c.url.includes("/drive/v3/files")).map((c) => new URL(c.url));
    expect(listed.every((u) => u.searchParams.get("q") === "trashed=false" && u.searchParams.get("corpora") !== "allDrives")).toBe(true);

    const cov = await coverage();
    expect(cov).toMatchObject({ state: "complete", counts: { mailboxes: 1, mailboxesListedCompletely: 1, filesListed: 6 } });
    expect(cov.lastSuccessAt).toBeTruthy();

    // A completed run is not re-listed before the refresh interval.
    const calls = drive.calls.length;
    expect((await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) })).mailboxes[0]!.state).toBe("skipped");
    expect(drive.calls.length).toBe(calls);
  });

  it("honours Retry-After on a rate-limited page and resumes from the same page token", async () => {
    await connectMailboxes(MB);
    let limited = true;
    const drive = fakeDrive({
      user: [[file("a", SHEET)], [file("b", SHEET)]],
      hooks: [(url) => {
        if (limited && url.pathname === "/drive/v3/files" && url.searchParams.get("pageToken") === "user:1") {
          limited = false;
          return json({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 429, { "retry-after": "120" });
        }
        return undefined;
      }],
    });
    const before = Date.now();
    await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) });
    const [row] = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(row).toMatchObject({ state: "running", reason: "rate_limited", pageToken: "user:1", filesListed: 1 });
    expect(Date.parse(row!.retryAt!)).toBeGreaterThanOrEqual(before + 120_000);

    // Inside the window: skipped, no request.
    const calls = drive.calls.length;
    expect((await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) })).mailboxes[0]!.state).toBe("skipped");
    expect(drive.calls.length).toBe(calls);

    resetGoogleRateLimitCooldownsForTests();
    await query(`UPDATE gdocs_drive_inventory SET retry_at = now() - interval '1 second' WHERE tenant_id = $1`, [T]);
    await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) });
    expect(new URL(drive.calls[calls]!.url).searchParams.get("pageToken")).toBe("user:1");
    const [done] = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(done).toMatchObject({ state: "complete", filesListed: 2 });
  });

  it("reports gaps (a shared drive that can no longer be listed, incompleteSearch) as partial, never complete", async () => {
    await connectMailboxes(MB);
    const drive = fakeDrive({
      user: [[file("a", SHEET)]],
      drives: { sdGone: [[file("x", SHEET)]] },
      hooks: [
        (url) => (url.searchParams.get("driveId") === "sdGone" ? json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404) : undefined),
        (url) => (url.pathname === "/drive/v3/files" && url.searchParams.get("corpora") === "user" ? json({ files: [file("a", SHEET)], incompleteSearch: true }) : undefined),
      ],
    });
    await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) });
    const [row] = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(row!.state).toBe("partial");
    expect(row!.gaps.map((g) => g.phase).sort()).toEqual(["drive:sdGone", "user"]);
    expect(row!.lastCompleteAt).toBeNull();
    const cov = await coverage();
    expect(cov.state).toBe("partial");
    expect(cov.reason).toMatch(/incompleteSearch|notFound|404/);
  });

  it("blocks one mailbox on a credential failure without failing the others, and the tenant stays partial", async () => {
    await connectMailboxes(MB, MB2);
    const drive = fakeDrive({ user: [[file("a", SHEET)]] });
    const result = await runDriveInventory(T, {
      maxPages: 5,
      budgetMs: 60_000,
      deps: deps(drive, {
        mailboxes: [MB, MB2],
        accessToken: async (m) => {
          if (m === MB2) throw new GoogleOAuthScopeError(m, ["https://www.googleapis.com/auth/drive.readonly"]);
          return "synthetic-bearer";
        },
      }),
    });
    expect(result.mailboxes.map((m) => [m.mailbox, m.state])).toEqual([[MB, "complete"], [MB2, "blocked"]]);
    const rows = await listInventory(T, { db: db as unknown as SqlDatabase });
    expect(rows.find((r) => r.mailbox === MB2)).toMatchObject({ state: "blocked", reason: "insufficient_scope" });
    const cov = await coverage();
    expect(cov.state).toBe("partial");
    expect(cov.counts).toMatchObject({ mailboxes: 2, mailboxesListedCompletely: 1 });
  });

  it("a roster mailbox that has not been listed keeps coverage below complete", async () => {
    await connectMailboxes(MB);
    const drive = fakeDrive({ user: [[file("a", SHEET)]] });
    await runDriveInventory(T, { maxPages: 5, budgetMs: 60_000, deps: deps(drive) });
    expect((await coverage()).state).toBe("complete");
    await connectMailboxes(MB2);
    const cov = await coverage();
    expect(cov.state).toBe("partial");
    expect(cov.counts).toMatchObject({ mailboxes: 2, mailboxesNotStarted: 1 });
  });
});
