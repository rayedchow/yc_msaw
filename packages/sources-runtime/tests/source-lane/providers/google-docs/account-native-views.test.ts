import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pollDriveChangesMock = vi.hoisted(() => vi.fn());
const queryActivityMock = vi.hoisted(() => vi.fn(async (_token: string, _options?: unknown) => [] as unknown[]));
const tasks = vi.hoisted(() => [] as Array<{ kind: string; payload: Record<string, unknown>; dedupeKey?: string; groupKey?: string }>);
const roster = vi.hoisted(() => ({ mailboxes: [] as string[] }));
const credentialMode = vi.hoisted(() => ({ byMailbox: {} as Record<string, "oauth_direct" | "domain_wide_delegation" | "composio_proxy"> }));
const proxied = vi.hoisted(() => [] as string[]);

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/polling/_archived-gdocs/gdocs-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/polling/_archived-gdocs/gdocs-api.js")>(),
  pollDriveChanges: pollDriveChangesMock,
  queryActivity: queryActivityMock,
  getDriveFileParents: vi.fn(async () => []),
  resolveActorEmails: vi.fn(async () => new Map()),
  INTER_DOC_DELAY_MS: 0,
}));
vi.mock("../../../../src/integrations/google/mailboxes.js", () => ({
  listGoogleMailboxes: vi.fn(async () => roster.mailboxes),
  getGoogleMailboxState: vi.fn(async () => ({ drivePageToken: "pt-1", lastCommentPollAt: "2026-10-01T00:00:00Z" })),
  updateGoogleMailboxState: vi.fn(async () => {}),
}));
vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ email: "alice@corp.example", authMode: "oauth_direct" })),
  mergeTokenMetadata: vi.fn(async () => {}),
}));
// Every Google call carries the bearer of the account it runs as; the fake Google below answers per account.
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../src/vault/google-auth.js")>();
  return {
    ...real,
    getGoogleAccessToken: vi.fn(async (_t: string, mailbox?: string) => {
      if (mailbox && credentialMode.byMailbox[mailbox.toLowerCase()] === "composio_proxy") throw new real.GoogleBearerUnavailableError(mailbox);
      return `tok:${mailbox ?? "alice@corp.example"}`;
    }),
    getGoogleApiCredential: vi.fn(async (_t: string, mailbox?: string) => {
      const account = (mailbox ?? "alice@corp.example").toLowerCase();
      const mode = credentialMode.byMailbox[account] ?? "oauth_direct";
      if (mode === "composio_proxy") {
        return { kind: "composio_proxy", mode, connectedAccountId: `ca-${account}`, toolkit: "google_super", userId: "u", scopes: [], account, quotaUser: "q" };
      }
      return { kind: "access_token", accessToken: `tok:${account}`, mode, account, quotaUser: "q" };
    }),
    fetchGoogleApi: vi.fn(async (credential: { account: string }, url: string) => {
      proxied.push(url);
      return fetch(url, { headers: { authorization: `Bearer tok:${credential.account}` } });
    }),
  };
});
vi.mock("../../../../src/queue/queue.js", () => ({
  enqueueTask: vi.fn(async (t: { kind: string; payload: Record<string, unknown>; dedupeKey?: string; groupKey?: string }) => {
    tasks.push(t);
    return "task-1";
  }),
}));
vi.mock("../../../../src/queue/dispatch.js", () => ({ enqueueCollectedEventForProcessing: vi.fn(async () => {}), startGooglePolling: vi.fn(async () => {}) }));
vi.mock("../../../../src/polling/_archived-gdocs/gdocs-edits.js", () => ({ processEditActivity: vi.fn(async () => 0) }));
vi.mock("../../../../src/polling/_archived-gdocs/document-summary-tracker.js", () => ({ markGoogleDocSummaryDirty: vi.fn(async () => {}) }));
vi.mock("../../../../src/integrations/source-sync-task.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/integrations/source-sync-task.js")>(),
  runRecordedSourceSyncTask: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
}));
// Shared drive-pdf byte intake is the binary lane's (S3); here it records the donor row the real intake would upsert,
// and remembers whose credential fetched the bytes.
const sharedPdfFetches = vi.hoisted(() => [] as string[]);
vi.mock("../../../../src/integrations/binary/intake.js", async () => {
  const h = await import("./harness.js");
  return {
    intakeBinaryDocument: vi.fn(async (input: { tenantId: string; provider: string; externalId: string; mimeType: string }) => {
      sharedPdfFetches.push(input.externalId);
      await h.query(
        `INSERT INTO binary_documents (tenant_id, provider, external_id, mime_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET tombstoned_at = NULL`,
        [input.tenantId, input.provider, input.externalId, input.mimeType],
      );
      return { status: "stored" };
    }),
    tombstoneBinaryDocument: vi.fn(async (input: { tenantId: string; provider: string; externalId: string }) => {
      const rows = await h.query(`UPDATE binary_documents SET tombstoned_at = now() WHERE tenant_id = $1 AND provider = $2 AND external_id = $3 AND tombstoned_at IS NULL RETURNING id`, [input.tenantId, input.provider, input.externalId]);
      return rows.length;
    }),
  };
});

import { allStoredText, db, fakeFetch, heads, json, liveFile, liveJson, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs, sweepCommentActivity } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { googleIntegration } from "../../../../src/integrations/google/index.js";
import { driveFileDirectory } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { accountRoot, captureAccountView, getAccountCapture, seedAccountCaptures } from "../../../../src/source-lane/providers/google-docs/account-capture.js";
import { accountFileDirectory, accountFilePaths } from "../../../../src/source-lane/providers/google-docs/account-files.js";
import { googleAttributionFor } from "../../../../src/source-lane/providers/google-auth/attribution.js";
import { googleDocsCoverage } from "../../../../src/source-lane/providers/google-docs/coverage.js";
import { runGdocsSourceSweep } from "../../../../src/source-lane/providers/google-docs/sweep.js";
import { gdocsVersionsExport } from "../../../../src/source-lane/providers/google-docs/export-map.js";
import { resetExportFormatsCacheForTests } from "../../../../src/source-lane/providers/google-docs/drive-export.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * View-only (reader/commenter) accounts read their own current Sheets, Slides, other Drive files and Drive PDFs, and
 * the comments Google returns to them, captured under their own credential: never the writer's shared unit (its byte
 * versions, its permission view), never another account's bytes or comments, never download-restricted content.
 */
const deps = { db: db as unknown as SqlDatabase };
const T = "tenant-native";
const ISS = "https://auth.example.test";
const ALICE = "alice@corp.example";
const BOB = "bob@corp.example";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME = "application/vnd.google-apps.presentation";
const PDF_MIME = "application/pdf";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type Caps = { canReadRevisions: boolean; canComment?: boolean; canCopy?: boolean; canDownload?: boolean };
interface FileState {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  body: string;
  caps: Record<string, Caps | "forbidden">;
  copyRequiresWriterPermission?: boolean;
  restrictedForReaders?: boolean;
  /** comments.list per account; default writers/commenters see THREAD, readers 403. */
  comments?: Record<string, "forbidden" | unknown[]>;
  status?: Record<string, Record<string, number>>;
  retryAfter?: string;
}

const THREAD = [{ id: "c-1", content: "Q3 numbers?", author: { displayName: "Alice", emailAddress: ALICE }, createdTime: "2026-10-01T09:00:00Z", modifiedTime: "2026-10-01T09:00:00Z", resolved: false, replies: [] }];
const FORMATS = { [SHEET_MIME]: [XLSX, "application/pdf", "text/csv"], [SLIDES_MIME]: [PPTX, "application/pdf"] };

function google(files: FileState[]) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const accountOf = (init?: RequestInit) => new Headers(init?.headers).get("authorization")?.replace(/^Bearer tok:/, "") ?? "anonymous";
  const caps = (f: FileState, account: string) => f.caps[account];
  const forced = (f: FileState, account: string, op: string) => f.status?.[account]?.[op];
  return fakeFetch([
    (url, init) => {
      if (url.hostname !== "www.googleapis.com" || url.pathname !== "/drive/v3/about") return undefined;
      return json({ exportFormats: FORMATS });
    },
    (url, init) => {
      const m = /^\/drive\/v3\/files\/([^/]+)(\/export|\/comments(?:\/[^/]+)?)?$/.exec(url.pathname);
      if (url.hostname !== "www.googleapis.com" || !m) return undefined;
      const f = byId.get(decodeURIComponent(m[1]!));
      if (!f) return undefined;
      const account = accountOf(init);
      const c = caps(f, account);
      if (!c || c === "forbidden") return json({ error: { code: 404, message: "File not found" } }, 404);
      const tail = m[2] ?? "";
      const op = tail === "/export" ? "export" : tail.startsWith("/comments") ? "comments" : url.searchParams.get("alt") === "media" ? "media" : "get";
      const status = forced(f, account, op);
      if (status) return json({ error: { code: status, errors: [{ reason: status === 403 ? "cannotDownloadFile" : "backend" }] } }, status, f.retryAfter ? { "retry-after": f.retryAfter } : {});
      if (op === "get") {
        return json({
          id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
          copyRequiresWriterPermission: f.copyRequiresWriterPermission ?? false,
          capabilities: { canDownload: true, canCopy: true, ...c },
          ...(f.restrictedForReaders ? { downloadRestrictions: { effectiveDownloadRestrictionWithContext: { restrictedForReaders: true, restrictedForWriters: false } } } : {}),
          // Only a writer sees the full sharing list.
          ...(c.canReadRevisions ? { permissions: [{ id: "p9", type: "user", role: "writer", emailAddress: "hidden-collaborator@corp.example" }] } : {}),
          ...(f.mimeType.startsWith("application/vnd.google-apps.") ? { exportLinks: { [XLSX]: `https://docs.google.com/export/${f.id}?tagged=${account}` } } : {}),
        });
      }
      if (op === "comments") {
        const answer = f.comments?.[account] ?? (c.canReadRevisions || c.canComment ? THREAD : "forbidden");
        if (answer === "forbidden") return json({ error: { code: 403, message: "The user does not have sufficient permissions for this file." } }, 403);
        return json({ comments: answer });
      }
      // Bytes are tagged with the requesting account so a copy proves whose credential fetched it.
      const mime = op === "export" ? url.searchParams.get("mimeType")! : f.mimeType;
      return new Response(Buffer.from(`BYTES ${f.id} ${op} ${mime} ${f.body} as:${account}`), { status: 200, headers: { "content-type": mime } });
    },
    (url, init) => {
      const sheet = url.hostname === "sheets.googleapis.com" && /\/v4\/spreadsheets\/([^/?]+)/.exec(url.pathname);
      const slides = url.hostname === "slides.googleapis.com" && /\/v1\/presentations\/([^/?]+)/.exec(url.pathname);
      const id = (sheet || slides) ? decodeURIComponent(((sheet || slides) as RegExpExecArray)[1]!) : null;
      if (!id) return undefined;
      const f = byId.get(id)!;
      const account = accountOf(init);
      const c = caps(f, account);
      if (!c || c === "forbidden") return json({ error: { code: 404 } }, 404);
      const status = forced(f, account, "native");
      if (status) return json({ error: { code: status } }, status, f.retryAfter ? { "retry-after": f.retryAfter } : {});
      return json(sheet
        ? { spreadsheetId: id, properties: { title: f.name }, sheets: [{ properties: { title: "Q3" }, data: [{ rowData: [{ values: [{ formattedValue: `${f.body} as:${account}` }] }] }] }] }
        : { presentationId: id, title: f.name, slides: [{ objectId: "s1", pageElements: [{ image: { contentUrl: `https://lh3.googleusercontent.com/SLIDE-REQUESTER-${account}` } }, { shape: { text: { textElements: [{ textRun: { content: `${f.body} as:${account}` } }] } } }] }] });
    },
  ]);
}

const live = (f: FileState, canReadRevisions?: boolean) => ({
  fileId: f.id,
  file: { name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, trashed: false, parents: [], ...(canReadRevisions === undefined ? {} : { capabilities: { canReadRevisions } }) },
});

async function poll(perMailbox: Record<string, unknown[]>) {
  for (const m of roster.mailboxes) pollDriveChangesMock.mockResolvedValueOnce({ changes: perMailbox[m] ?? [], newPageToken: "pt-2" });
  await pollGoogleDocs(T);
}

async function withGoogle<T>(files: FileState[], run: () => Promise<T>): Promise<{ value: T; calls: Array<{ url: string; headers: Headers }> }> {
  const f = google(files);
  vi.stubGlobal("fetch", f.impl);
  try {
    return { value: await run(), calls: f.calls };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Run the queued account-snapshot tasks through the production handler. */
async function runAccountTasks(files: FileState[]) {
  const handler = googleIntegration.taskHandlers!()["gdocs.account-snapshot"]!;
  return withGoogle(files, async () => {
    const out: Array<Record<string, unknown>> = [];
    for (const t of tasks.splice(0).filter((x) => x.kind === "gdocs.account-snapshot")) {
      out.push({ file: t.payload.docId, ...(await handler(t.payload, { task: { id: "t", queue: "sync", tenantId: T } } as never) as Record<string, unknown>) });
    }
    return out;
  });
}

/** The shared `_drive` lane (alice's unit), as the production poll sweep exports it. */
async function sharedExport(files: FileState[]) {
  return withGoogle(files, () => runGdocsSourceSweep(T, { maxFiles: 10, budgetMs: 60_000, includeDocs: false, deps }));
}

const sheet = (o: Partial<FileState> = {}): FileState => ({
  id: "sheet-1", name: "Budget", mimeType: SHEET_MIME, modifiedTime: "2026-10-01T10:00:00Z", body: "Revenue 100",
  caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false, canComment: true } }, ...o,
});
const deck = (o: Partial<FileState> = {}): FileState => ({
  id: "deck-1", name: "Pitch", mimeType: SLIDES_MIME, modifiedTime: "2026-10-01T10:00:00Z", body: "Slide one",
  caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } }, ...o,
});
const image = (o: Partial<FileState> = {}): FileState => ({
  id: "img-1", name: "chart.png", mimeType: "image/png", modifiedTime: "2026-10-01T10:00:00Z", body: "PNGDATA",
  caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } }, ...o,
});
const pdf = (o: Partial<FileState> = {}): FileState => ({
  id: "pdf-1", name: "Contract.pdf", mimeType: PDF_MIME, modifiedTime: "2026-10-01T10:00:00Z", body: "%PDF-1.7 terms",
  caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } }, ...o,
});

const bobRoot = accountRoot(BOB);
const P = {
  sheet: accountFilePaths(accountFileDirectory(bobRoot, "sheets", "sheet-1", "Budget")),
  deck: accountFilePaths(accountFileDirectory(bobRoot, "slides", "deck-1", "Pitch")),
  image: accountFilePaths(accountFileDirectory(bobRoot, "files", "img-1", "chart.png")),
  pdf: accountFilePaths(accountFileDirectory(bobRoot, "pdf", "pdf-1", "Contract.pdf")),
};
const dirOf = (p: { drive: string }) => p.drive.replace(/\/drive\.json$/, "");
const tree = async (p: { drive: string }) => (await heads(T, `${dirOf(p)}/`)).filter((h) => h.op === "put").map((h) => h.path.slice(dirOf(p).length + 1)).sort();
const text = async (path: string) => (await liveFile(T, path))?.bytes.toString("utf8") ?? null;

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  pollDriveChangesMock.mockReset();
  queryActivityMock.mockReset();
  queryActivityMock.mockResolvedValue([]);
  tasks.length = 0;
  proxied.length = 0;
  sharedPdfFetches.length = 0;
  credentialMode.byMailbox = {};
  resetGoogleRateLimitCooldownsForTests();
  resetExportFormatsCacheForTests();
  roster.mailboxes = [ALICE, BOB];
  await resetTenant(T);
  await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM binary_documents WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM google_account_owner_proofs WHERE tenant_id = $1`, [T]);
  for (const [m, sub] of [[ALICE, "user_alice"], [BOB, "user_bob"]]) {
    await query(`INSERT INTO google_account_owner_proofs (tenant_id, account_email, google_sub, proven_by_subject, proven_by_issuer) VALUES ($1, $2, $3, $4, $5)`, [T, m, `g-${sub}`, sub, ISS]);
  }
});

describe("view-only accounts read their own Sheets, Slides, Drive files and PDFs", () => {
  it("captures every native type as bob, in the formats his own Drive offers, and leaves alice's shared units untouched", async () => {
    const files = [sheet(), deck(), image(), pdf()];
    await poll({ [ALICE]: files.map((f) => live(f, true)), [BOB]: files.map((f) => live(f, false)) });
    // The feed scheduled exactly one account capture per file, all bob's (alice reads the full units).
    expect(tasks.filter((t) => t.kind === "gdocs.account-snapshot").map((t) => [t.payload.docId, t.payload.mailbox, t.groupKey]).sort())
      .toEqual(["deck-1", "img-1", "pdf-1", "sheet-1"].map((id) => [id, BOB, `${T}:gdocs`]));
    const shared = await sharedExport(files);
    expect(shared.value.results.map((r) => [r.fileId, r.state]).sort()).toEqual([["deck-1", "complete"], ["img-1", "complete"], ["sheet-1", "complete"]]);
    const sharedHeads = await heads(T, "sources/google-docs/_drive/");

    const run = await runAccountTasks(files);
    // Enqueue order of the donor poll: the drive-pdf intake runs before the other lane changes.
    expect(run.value.map((r) => [r.file, r.status, r.apiCalls])).toEqual([
      // files.get + alt=media
      ["pdf-1", "complete", 2],
      // files.get + about.exportFormats (once per account per hour) + files.export + spreadsheets.get + comments.list
      ["sheet-1", "complete", 5],
      // files.get + files.export + presentations.get + comments.list (a reader: Google answers 403, nothing kept)
      ["deck-1", "complete", 4],
      // files.get + alt=media (non-editor files: comments are read when the account's own activity reports some)
      ["img-1", "complete", 2],
    ]);
    // Every Google call of the account captures ran as bob.
    expect(new Set(run.calls.map((c) => c.headers.get("authorization")))).toEqual(new Set([`Bearer tok:${BOB}`]));
    expect(run.calls.filter((c) => new URL(c.url).pathname === "/drive/v3/about")).toHaveLength(1);

    // Sheet: bob's xlsx export, native grid JSON and the comments Google shows the commenter.
    expect(await tree(P.sheet)).toEqual(["capture.json", "comments.json", "content/Budget.xlsx", "drive.json", "native.json"]);
    expect(await text(P.sheet.content("Budget.xlsx"))).toBe(`BYTES sheet-1 export ${XLSX} Revenue 100 as:${BOB}`);
    expect(await text(P.sheet.native)).toContain(`Revenue 100 as:${BOB}`);
    expect(await liveJson(T, P.sheet.comments)).toMatchObject({ account: BOB, complete: true, comments: [{ id: "c-1", content: "Q3 numbers?" }] });
    expect(await liveJson(T, P.sheet.capture)).toMatchObject({ state: "complete", account: BOB, credentialMode: "oauth_direct", exportMimeType: XLSX, comments: { state: "complete" } });
    // Slides: requester-tagged image URLs are redacted, as in the shared lane; a reader gets no comments.
    expect(await tree(P.deck)).toEqual(["capture.json", "content/Pitch.pptx", "drive.json", "native.json"]);
    expect(await text(P.deck.native)).not.toContain("SLIDE-REQUESTER");
    expect(await text(P.deck.native)).toContain(`Slide one as:${BOB}`);
    expect((await getAccountCapture(T, "deck-1", BOB, deps))!.commentsState).toBe("not_visible");
    // Binary file and PDF: exact bytes Google served bob.
    expect(await text(P.image.content("chart.png"))).toBe(`BYTES img-1 media image/png PNGDATA as:${BOB}`);
    expect(await tree(P.pdf)).toEqual(["capture.json", "content/Contract.pdf", "drive.json"]);
    expect(await text(P.pdf.content("Contract.pdf"))).toBe(`BYTES pdf-1 media application/pdf %PDF-1.7 terms as:${BOB}`);

    // Nothing of alice's view or other writer-only material is in bob's copies.
    for (const h of await heads(T, `${bobRoot}/`)) {
      const body = (await liveFile(T, h.path))?.bytes.toString("latin1") ?? "";
      expect(body).not.toContain(`as:${ALICE}`);
      expect(body).not.toContain("hidden-collaborator");
      expect(body).not.toContain("docs.google.com/export");
    }
    expect(await allStoredText(T)).not.toContain(`SLIDE-REQUESTER-${BOB}`);
    // Alice's shared units are byte-identical; their bytes are alice's.
    expect(await heads(T, "sources/google-docs/_drive/")).toEqual(sharedHeads);
    expect(await text(`${driveFileDirectory("sheets", "sheet-1", "Budget")}/content/Budget.xlsx`)).toContain(`as:${ALICE}`);
    // Attribution unchanged: bob's shared units stay view-only (withheld by the consumer), alice keeps hers in full.
    const bobUnits = (await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units;
    expect(bobUnits.length).toBeGreaterThan(0);
    expect(bobUnits.every((u) => !u.revisions)).toBe(true);
    expect((await googleAttributionFor(T, { subject: "user_alice", issuer: ISS }, db as never)).units.every((u) => u.revisions)).toBe(true);
    // Publishes through the normal versions export, with account provenance.
    const [row] = await query<{ id: string }>(`SELECT id FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2`, [T, P.pdf.content("Contract.pdf")]);
    const changes = await gdocsVersionsExport.map({ tenantId: T, executor: db } as never, String(row!.id), { enqueuedAt: new Date().toISOString() } as never, []);
    expect(changes[0]).toMatchObject({ op: "put", provenance: { externalId: "pdf-1", account: BOB, credentialMode: "oauth_direct", api: "files.get alt=media" } });

    // Coverage: one account scope, every type counted, nothing withheld or uncaptured.
    const reports = await googleDocsCoverage({ tenantId: T, executor: db } as never);
    // `partial` only because this harness records no gdocs.poll run (coverage marks every scope not current then).
    const bobScope = reports.find((r) => r.scope === `account:${BOB}`)!;
    expect(bobScope.reason).toContain("not current: no completed gdocs.poll");
    expect(bobScope).toMatchObject({ state: "partial", counts: { complete: 4, sheets: 1, slides: 1, files: 1, pdfs: 1, notYetCaptured: 0, comments_complete: 1, comments_not_visible: 1 } });
    expect(reports.find((r) => r.scope === `account:${ALICE}`)).toBeUndefined();
  });

  it("is idempotent per version (1 files.get), follows edits with its own history, and never mixes in the writer's versions", async () => {
    const s1 = sheet();
    await poll({ [ALICE]: [live(s1, true)], [BOB]: [live(s1, false)] });
    await runAccountTasks([s1]);
    const versions = await query(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path LIKE $2`, [T, `${bobRoot}/%`]);
    // Same version again: no task; a forced run costs one files.get and writes nothing.
    await poll({ [ALICE]: [], [BOB]: [live(s1, false)] });
    expect(tasks).toEqual([]);
    const again = await withGoogle([s1], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(again.value).toMatchObject({ state: "complete", reason: "already_captured_for_version", apiCalls: 1 });
    expect(await query(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path LIKE $2`, [T, `${bobRoot}/%`])).toEqual(versions);

    // Alice's shared unit moves on (writer-only edit captured under alice).
    await sharedExport([{ ...s1, modifiedTime: "2026-10-02T10:00:00Z", body: "Writer draft" }]);
    // Bob's next own version: his content advances; his earlier capture stays his own history.
    const s2 = { ...s1, modifiedTime: "2026-10-03T10:00:00Z", body: "Revenue 140" };
    await poll({ [ALICE]: [], [BOB]: [live(s2, false)] });
    const r2 = await runAccountTasks([s2]);
    // A new version re-reads content only: comments were read on the first capture and no comment activity was seen.
    expect(r2.value[0]).toMatchObject({ status: "complete", apiCalls: 3 });
    const contentPath = P.sheet.content("Budget.xlsx");
    expect(await text(contentPath)).toBe(`BYTES sheet-1 export ${XLSX} Revenue 140 as:${BOB}`);
    const history = await query<{ seq: number; size: number }>(`SELECT seq, size FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2 ORDER BY seq`, [T, contentPath]);
    expect(history).toHaveLength(2);
    for (const h of await heads(T, `${bobRoot}/`)) expect((await liveFile(T, h.path))?.bytes.toString("latin1") ?? "").not.toContain("Writer draft");

    // Renamed at Google: bob's copy moves to the new directory, the old-named export is retired, his history follows.
    const s3 = { ...s2, name: "Budget 2026", modifiedTime: "2026-10-04T10:00:00Z", body: "Revenue 150" };
    await poll({ [ALICE]: [], [BOB]: [{ fileId: "sheet-1", file: { ...live(s3, false).file } }] });
    await runAccountTasks([s3]);
    const renamed = accountFilePaths(accountFileDirectory(bobRoot, "sheets", "sheet-1", "Budget 2026"));
    expect(await tree(P.sheet)).toEqual([]);
    expect(await tree(renamed)).toEqual(["capture.json", "comments.json", "content/Budget 2026.xlsx", "drive.json", "native.json"]);
    expect(await text(renamed.content("Budget 2026.xlsx"))).toBe(`BYTES sheet-1 export ${XLSX} Revenue 150 as:${BOB}`);
  });

  it("follows the account's role: upgrade supersedes the copy, downgrade captures again, access loss and trash retire it", async () => {
    const s = sheet();
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s, false)] });
    await runAccountTasks([s]);
    expect(await liveFile(T, P.sheet.content("Budget.xlsx"))).not.toBeNull();
    // Bob becomes a writer: the full unit is his read now; his copy is retired.
    await poll({ [ALICE]: [], [BOB]: [live({ ...s, modifiedTime: "2026-10-02T10:00:00Z" }, true)] });
    expect(tasks).toEqual([]);
    expect(await tree(P.sheet)).toEqual([]);
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.state).toBe("superseded");
    // Back to reader: captured again.
    const s3 = { ...s, modifiedTime: "2026-10-03T10:00:00Z" };
    await poll({ [ALICE]: [], [BOB]: [live(s3, false)] });
    await runAccountTasks([s3]);
    expect(await liveFile(T, P.sheet.content("Budget.xlsx"))).not.toBeNull();
    // Bob loses access: only his copy is tombstoned; alice's unit stays.
    await sharedExport([s3]);
    await poll({ [ALICE]: [], [BOB]: [{ fileId: "sheet-1", removed: true }] });
    expect(await tree(P.sheet)).toEqual([]);
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.state).toBe("retired");
    expect(await liveFile(T, `${driveFileDirectory("sheets", "sheet-1", "Budget")}/drive.json`)).not.toBeNull();

    // PDFs: bob's copy follows his own feed too; trash (tenant-wide) retires every account copy.
    const p = pdf();
    await poll({ [ALICE]: [live(p, true)], [BOB]: [live(p, false)] });
    await runAccountTasks([p]);
    expect(await liveFile(T, P.pdf.content("Contract.pdf"))).not.toBeNull();
    await poll({ [ALICE]: [], [BOB]: [{ fileId: "pdf-1", removed: true }] });
    expect(await tree(P.pdf)).toEqual([]);
    expect((await query(`SELECT tombstoned_at FROM binary_documents WHERE tenant_id = $1 AND external_id = 'pdf-1'`, [T]))[0]).toMatchObject({ tombstoned_at: null });
    await poll({ [ALICE]: [], [BOB]: [live({ ...p, modifiedTime: "2026-10-04T10:00:00Z" }, false)] });
    await runAccountTasks([{ ...p, modifiedTime: "2026-10-04T10:00:00Z" }]);
    expect(await liveFile(T, P.pdf.content("Contract.pdf"))).not.toBeNull();
    await poll({ [ALICE]: [{ fileId: "pdf-1", file: { ...live(p, true).file, trashed: true } }], [BOB]: [] });
    expect(await tree(P.pdf)).toEqual([]);
    expect((await getAccountCapture(T, "pdf-1", BOB, deps))!.state).toBe("retired");
  });

  it("honours download/copy restrictions for the account: metadata and comments only, content retired, nothing borrowed", async () => {
    const s = sheet();
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s, false)] });
    await runAccountTasks([s]);
    expect(await liveFile(T, P.sheet.native)).not.toBeNull();
    for (const [i, restriction] of ([
      { copyRequiresWriterPermission: true },
      { caps: { ...s.caps, [BOB]: { canReadRevisions: false, canComment: true, canDownload: false } } },
      { restrictedForReaders: true },
    ] as Array<Partial<FileState>>).entries()) {
      const r = { ...s, ...restriction, modifiedTime: `2026-10-0${i + 2}T10:00:00Z` };
      const out = await withGoogle([r], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
      expect(out.value).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account" });
      // No export, media or native read was even attempted.
      expect(out.calls.filter((c) => /\/export|alt=media|sheets\.googleapis/.test(c.url))).toEqual([]);
      expect(await tree(P.sheet)).toEqual(["capture.json", "comments.json", "drive.json"]);
    }
    expect(await liveJson(T, P.sheet.capture)).toMatchObject({ state: "blocked", content: "not_exported: download/copy disabled for this account" });
    // A restricted PDF never gets bytes for bob, and alice's shared PDF unit is not lent to him.
    const p = pdf({ caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false, canDownload: false } } });
    await poll({ [ALICE]: [live(p, true)], [BOB]: [live(p, false)] });
    const run = await runAccountTasks([p]);
    expect(run.value).toEqual([expect.objectContaining({ file: "pdf-1", status: "blocked", reason: "copy_restricted_for_account", apiCalls: 1 })]);
    expect(await tree(P.pdf)).toEqual(["capture.json", "drive.json"]);
    // Coverage names the blocked capability for bob.
    const bob = (await googleDocsCoverage({ tenantId: T, executor: db } as never)).find((x) => x.scope === `account:${BOB}`)!;
    expect(bob).toMatchObject({ state: "blocked", counts: { blocked: 2 } });
    expect(bob.reason).toContain("copy_restricted_for_account");
  });

  it("follows a restriction switched on or off without a new file version (final-combined-review N-1)", async () => {
    const s = sheet();
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s, false)] });
    await runAccountTasks([s]);
    expect(await liveFile(T, P.sheet.native)).not.toBeNull();
    // A capture that runs for another reason (sweep, comment activity) on the same version still honours a restriction.
    const r = { ...s, copyRequiresWriterPermission: true };
    const forced = await withGoogle([r], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(forced.value).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account" });
    expect(await tree(P.sheet)).toEqual(["capture.json", "comments.json", "drive.json"]);
    // Switched off again, reported by bob's own feed with the same modifiedTime: captured again.
    const withRestriction = (f: FileState, on: boolean) => ({ ...live(f, false), file: { ...live(f, false).file, copyRequiresWriterPermission: on } });
    await poll({ [ALICE]: [live(s, true)], [BOB]: [withRestriction(s, false)] });
    expect((await runAccountTasks([s])).value).toEqual([expect.objectContaining({ file: "sheet-1", status: "complete" })]);
    expect(await liveFile(T, P.sheet.native)).not.toBeNull();
    // Switched on, again only in the feed's restriction fields: the content is tombstoned without waiting for an edit.
    await poll({ [ALICE]: [live(r, true)], [BOB]: [withRestriction(r, true)] });
    expect((await runAccountTasks([r])).value).toEqual([expect.objectContaining({ file: "sheet-1", status: "blocked", reason: "copy_restricted_for_account" })]);
    expect(await tree(P.sheet)).toEqual(["capture.json", "comments.json", "drive.json"]);
  });

  it("does not download the shared PDF unit for a mailbox that may only view it (final-performance-check)", async () => {
    const p = pdf();
    sharedPdfFetches.length = 0;
    // Only bob (view-only) sees the PDF: he gets his own copy; the shared unit nobody could read is not downloaded.
    await poll({ [ALICE]: [], [BOB]: [live(p, false)] });
    await runAccountTasks([p]);
    expect(await liveFile(T, P.pdf.content("Contract.pdf"))).not.toBeNull();
    expect(sharedPdfFetches).toEqual([]);
    expect(await query(`SELECT 1 FROM binary_documents WHERE tenant_id = $1 AND external_id = 'pdf-1'`, [T])).toEqual([]);
    // Once a mailbox that may read revisions sees it, its own feed intakes the shared unit as before.
    await poll({ [ALICE]: [live(p, true)], [BOB]: [] });
    expect(sharedPdfFetches).toEqual(["pdf-1"]);
    // An unattributed feed (no roster mailbox) and an unknown capability keep the donor behaviour.
    await poll({ [ALICE]: [live({ ...p, modifiedTime: "2026-10-05T10:00:00Z" })], [BOB]: [] });
    expect(sharedPdfFetches).toEqual(["pdf-1", "pdf-1"]);
  });

  it("fails closed under the account's own credential: 5xx/429/403/404 export nothing new, Retry-After is the floor", async () => {
    const base = sheet();
    await poll({ [ALICE]: [live(base, true)], [BOB]: [live(base, false)] });
    // Export 5xx: error with a retry time; the content of the failed attempt is not exported.
    const err = await withGoogle([{ ...base, status: { [BOB]: { export: 500 } } }], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(err.value.state).toBe("error");
    expect(await liveFile(T, P.sheet.content("Budget.xlsx"))).toBeNull();
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.retryAt).not.toBeNull();
    // 429 with Retry-After: pending, retry no earlier than the server asked.
    resetGoogleRateLimitCooldownsForTests();
    const now = new Date("2026-10-18T12:00:00Z");
    const limited = await withGoogle([{ ...base, status: { [BOB]: { export: 429 } }, retryAfter: "600" }], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps, now }));
    expect(limited.value).toMatchObject({ state: "pending", reason: "rate_limited" });
    expect(Date.parse((await getAccountCapture(T, "sheet-1", BOB, deps))!.retryAt!)).toBeGreaterThanOrEqual(now.getTime() + 600_000);
    resetGoogleRateLimitCooldownsForTests();
    // Google refuses the export to bob (403 cannotDownloadFile): blocked for bob, metadata only; no fallback.
    const refused = await withGoogle([{ ...base, status: { [BOB]: { export: 403 } } }], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(refused.value).toMatchObject({ state: "blocked" });
    expect(refused.value.reason).toContain("export:http_403:cannotDownloadFile");
    expect(await liveFile(T, P.sheet.content("Budget.xlsx"))).toBeNull();
    // Success, then Drive no longer shows bob the file: his copy is retired at capture time.
    await withGoogle([{ ...base, modifiedTime: "2026-10-05T10:00:00Z" }], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(await liveFile(T, P.sheet.content("Budget.xlsx"))).not.toBeNull();
    const gone = await withGoogle([{ ...base, modifiedTime: "2026-10-06T10:00:00Z", caps: { ...base.caps, [BOB]: "forbidden" } }], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(gone.value).toMatchObject({ state: "blocked", reason: "access_lost:files.get_http_404" });
    expect(await tree(P.sheet)).toEqual([]);
    // No capture for a mailbox outside the roster, or one that never saw the file, and no Google call.
    expect((await withGoogle([base], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: "carol@corp.example", deps }))).value).toMatchObject({ state: "skipped", reason: "not_visible_to_account", apiCalls: 0 });
    roster.mailboxes = [ALICE];
    expect((await withGoogle([base], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }))).value).toMatchObject({ state: "blocked", reason: "mailbox_not_in_roster", apiCalls: 0 });
  });
});

describe("comments the account's own Drive Activity reports are re-read as that account", () => {
  const activity = (fileId: string, title: string, mimeType: string) => ({
    primaryActionDetail: { comment: { post: { subtype: "ADDED" }, mentionedUsers: [] } },
    actions: [{ detail: { comment: { post: { subtype: "ADDED" } } } }],
    actors: [],
    targets: [{ driveItem: { name: `items/${fileId}`, title, mimeType }, fileComment: { legacyCommentId: "c-2" } }],
    timestamp: "2026-10-02T11:00:00Z",
  });

  it("bob's comment activity refreshes only bob's comments (files.get + comments.list); alice's activity never touches his copy", async () => {
    const s = sheet();
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s, false)] });
    await runAccountTasks([s]);
    const reply = [...THREAD, { id: "c-2", content: "Updated in v2", author: { displayName: "Bob", emailAddress: BOB }, createdTime: "2026-10-02T11:00:00Z", modifiedTime: "2026-10-02T11:00:00Z", resolved: false, replies: [] }];
    const s2 = { ...s, comments: { [BOB]: reply, [ALICE]: reply } };

    // Alice's sweep sees the activity: her mailbox reads the shared ledger; bob's copy is not scheduled.
    queryActivityMock.mockImplementation(async (token: string) => (token === `tok:${ALICE}` ? [activity("sheet-1", "Budget", SHEET_MIME)] : []));
    await withGoogle([s2], () => sweepCommentActivity(T));
    expect(tasks.filter((t) => t.kind === "gdocs.account-snapshot")).toEqual([]);
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.commentsDue).toBe(false);

    // Bob's own sweep sees it: his comments are re-read as bob, content is not re-fetched.
    queryActivityMock.mockImplementation(async (token: string) => (token === `tok:${BOB}` ? [activity("sheet-1", "Budget", SHEET_MIME)] : []));
    await withGoogle([s2], () => sweepCommentActivity(T));
    expect(tasks.filter((t) => t.kind === "gdocs.account-snapshot").map((t) => [t.payload.docId, t.payload.mailbox])).toEqual([["sheet-1", BOB]]);
    const run = await runAccountTasks([s2]);
    expect(run.value).toEqual([expect.objectContaining({ status: "complete", reason: "comments_refreshed", apiCalls: 2 })]);
    expect(run.calls.filter((c) => c.url.includes("googleapis.com")).map((c) => new URL(c.url).pathname)).toEqual(["/drive/v3/files/sheet-1", "/drive/v3/files/sheet-1/comments"]);
    expect(new Set(run.calls.map((c) => c.headers.get("authorization")))).toEqual(new Set([`Bearer tok:${BOB}`]));
    expect((await liveJson<{ comments: Array<{ id: string }> }>(T, P.sheet.comments)).comments.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(await query(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2`, [T, P.sheet.comments])).toEqual([{ n: 2 }]);
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))).toMatchObject({ commentsDue: false, commentsState: "complete" });

    // A transient comments failure keeps the previous comments.json and stays due (the hourly sweep retries it).
    queryActivityMock.mockImplementation(async (token: string) => (token === `tok:${BOB}` ? [activity("sheet-1", "Budget", SHEET_MIME)] : []));
    await withGoogle([s2], () => sweepCommentActivity(T));
    const failing = await runAccountTasks([{ ...s2, status: { [BOB]: { comments: 500 } } }]);
    expect(failing.value[0]).toMatchObject({ status: "complete", reason: "comments:comments.list_http_500:backend" });
    expect(await liveFile(T, P.sheet.comments)).not.toBeNull();
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.commentsDue).toBe(true);
    const sweep = await withGoogle([s2], () => runGdocsSourceSweep(T, { maxFiles: 5, budgetMs: 60_000, includeDocs: true, deps }));
    expect(sweep.value.results.filter((r) => r.lane === "doc-account")).toEqual([{ fileId: "sheet-1", lane: "doc-account", state: "complete", reason: "comments_refreshed" }]);
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.commentsDue).toBe(false);

    // Comments Google refuses to the account later: its comments.json is retired, nothing borrowed from alice's.
    await withGoogle([s2], async () => {
      queryActivityMock.mockImplementation(async (token: string) => (token === `tok:${BOB}` ? [activity("sheet-1", "Budget", SHEET_MIME)] : []));
      await sweepCommentActivity(T);
    });
    await runAccountTasks([{ ...s2, comments: { [BOB]: "forbidden", [ALICE]: reply } }]);
    expect(await liveFile(T, P.sheet.comments)).toBeNull();
    expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.commentsState).toBe("not_visible");
  });
});

describe("comment activity floods are bounded per sweep and drained by the hourly sweep", () => {
  it("30 commented files: 25 tasks now, all 30 due and reported, the source sweep re-reads the rest as bob", async () => {
    const files = Array.from({ length: 30 }, (_, i) => sheet({ id: `sheet-${i}`, name: `Sheet ${i}` }));
    await poll({ [ALICE]: files.map((f) => live(f, true)), [BOB]: files.map((f) => live(f, false)) });
    await runAccountTasks(files);
    queryActivityMock.mockImplementation(async (token: string) => (token === `tok:${BOB}` ? files.map((f) => ({
      primaryActionDetail: { comment: { post: { subtype: "ADDED" } } }, actors: [],
      targets: [{ driveItem: { name: `items/${f.id}`, title: f.name, mimeType: SHEET_MIME } }], timestamp: "2026-10-02T11:00:00Z",
    })) : []));
    await withGoogle(files, () => sweepCommentActivity(T));
    expect(tasks.filter((t) => t.kind === "gdocs.account-snapshot")).toHaveLength(25);
    expect(await query(`SELECT count(*)::int AS n FROM gdocs_account_captures WHERE tenant_id = $1 AND comments_due`, [T])).toEqual([{ n: 30 }]);
    const bob = (await googleDocsCoverage({ tenantId: T, executor: db } as never)).find((r) => r.scope === `account:${BOB}`)!;
    expect(bob).toMatchObject({ state: "partial", counts: { commentsDue: 30 } });
    tasks.length = 0; // the hourly sweep alone drains them, as bob
    const sweep = await withGoogle(files, () => runGdocsSourceSweep(T, { maxFiles: 30, budgetMs: 60_000, includeDocs: true, deps }));
    expect(sweep.value.results.filter((r) => r.lane === "doc-account" && r.reason === "comments_refreshed")).toHaveLength(30);
    expect(new Set(sweep.calls.filter((c) => c.url.includes("/comments")).map((c) => c.headers.get("authorization")))).toEqual(new Set([`Bearer tok:${BOB}`]));
    expect(await query(`SELECT count(*)::int AS n FROM gdocs_account_captures WHERE tenant_id = $1 AND comments_due`, [T])).toEqual([{ n: 0 }]);
  });
});

describe("lanes, backfill and legacy", () => {
  it("uses the account's own lane: DWD impersonates bob; Composio proxies as bob", async () => {
    const s = sheet();
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s, false)] });
    credentialMode.byMailbox[BOB] = "domain_wide_delegation";
    expect((await withGoogle([s], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }))).value.state).toBe("complete");
    expect(await liveJson(T, P.sheet.capture)).toMatchObject({ credentialMode: "domain_wide_delegation" });
    credentialMode.byMailbox[BOB] = "composio_proxy";
    const s2 = { ...s, modifiedTime: "2026-10-02T10:00:00Z", body: "Via proxy" };
    expect((await withGoogle([s2], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }))).value.state).toBe("complete");
    expect(proxied.some((u) => u.includes("/export"))).toBe(true);
    expect(proxied.some((u) => u.startsWith("https://sheets.googleapis.com/"))).toBe(true);
    expect(await text(P.sheet.content("Budget.xlsx"))).toBe(`BYTES sheet-1 export ${XLSX} Via proxy as:${BOB}`);
    expect(await liveJson(T, P.sheet.capture)).toMatchObject({ credentialMode: "composio_proxy" });
  });

  it("the hourly sweep seeds files bob was seen viewing before this lane (Sheets via checkpoints, PDFs via drive-pdf rows)", async () => {
    const files = [sheet(), pdf()];
    await poll({ [ALICE]: files.map((f) => live(f, true)), [BOB]: files.map((f) => live(f, false)) });
    // Legacy: the rows and tasks never existed (recorded before 9105).
    tasks.length = 0;
    await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
    const before = (await googleDocsCoverage({ tenantId: T, executor: db } as never)).find((r) => r.scope === `account:${BOB}`)!;
    expect(before).toMatchObject({ state: "partial", counts: { notYetCaptured: 2 } });
    expect(await seedAccountCaptures(T, 1, deps)).toBe(1); // bounded
    await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
    const sweep = await withGoogle(files, () => runGdocsSourceSweep(T, { maxFiles: 10, budgetMs: 60_000, includeDocs: true, deps }));
    expect(sweep.value.results.filter((r) => r.lane === "doc-account").map((r) => [r.fileId, r.state]).sort()).toEqual([["pdf-1", "complete"], ["sheet-1", "complete"]]);
    expect(await liveFile(T, P.pdf.content("Contract.pdf"))).not.toBeNull();
    expect((await googleDocsCoverage({ tenantId: T, executor: db } as never)).find((r) => r.scope === `account:${BOB}`)).toMatchObject({ counts: { notYetCaptured: 0, sheets: 1, pdfs: 1 } });
  });

  it("a writer-only file, an unknown capability, folders and shortcuts never produce an account view", async () => {
    const s = sheet();
    const folder = { fileId: "folder-1", file: { name: "Team", mimeType: "application/vnd.google-apps.folder", modifiedTime: s.modifiedTime, capabilities: { canReadRevisions: false } } };
    const shortcut = { fileId: "sc-1", file: { name: "Link", mimeType: "application/vnd.google-apps.shortcut", modifiedTime: s.modifiedTime, capabilities: { canReadRevisions: false } } };
    await poll({ [ALICE]: [live(s, true)], [BOB]: [live(s), folder, shortcut] });
    expect(tasks.filter((t) => t.kind === "gdocs.account-snapshot")).toEqual([]);
    expect(await query(`SELECT file_id FROM gdocs_account_captures WHERE tenant_id = $1`, [T])).toEqual([]);
    expect((await withGoogle([s], () => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }))).value).toMatchObject({ state: "skipped", reason: "capability_not_observed", apiCalls: 0 });
    expect(await heads(T, `${bobRoot}/`)).toEqual([]);
  });
});
