import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * final-transport-qa: independent post-fix check of final-combined-review N-1 through the REAL changes feed.
 *
 * account-native-views.test.ts mocks pollDriveChanges, so the feed half of the fix (gdocs-api.ts requesting the
 * restriction fields) is not exercised there. Here the production pollDriveChanges runs against a fake Drive whose
 * changes.list honours the `fields` mask the way Drive does (only requested fields come back), and everything after
 * it is production code: pollGoogleDocs -> lifecycle.recordLiveChange -> noteAccountView -> the account-snapshot task
 * handler -> captureAccountView, the comment-activity sweep, and the Google rate-limit classification.
 * Synthetic data only (PGlite).
 */
const queryActivityMock = vi.hoisted(() => vi.fn(async (_token: string, _options?: unknown) => [] as unknown[]));
const tasks = vi.hoisted(() => [] as Array<{ kind: string; payload: Record<string, unknown>; dedupeKey?: string; groupKey?: string }>);
const roster = vi.hoisted(() => ({ mailboxes: [] as string[] }));

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/polling/_archived-gdocs/gdocs-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/polling/_archived-gdocs/gdocs-api.js")>(),
  // pollDriveChanges is NOT replaced: the production feed request (and its `fields` mask) is under test.
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
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../src/vault/google-auth.js")>();
  return {
    ...real,
    getGoogleAccessToken: vi.fn(async (_t: string, mailbox?: string) => `tok:${mailbox ?? "alice@corp.example"}`),
    getGoogleApiCredential: vi.fn(async (_t: string, mailbox?: string) => {
      const account = (mailbox ?? "alice@corp.example").toLowerCase();
      return { kind: "access_token", accessToken: `tok:${account}`, mode: "oauth_direct", account, quotaUser: "q" };
    }),
    fetchGoogleApi: vi.fn(async (credential: { account: string }, url: string) => fetch(url, { headers: { authorization: `Bearer tok:${credential.account}` } })),
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
vi.mock("../../../../src/integrations/binary/intake.js", () => ({
  intakeBinaryDocument: vi.fn(async () => ({ status: "stored" })),
  tombstoneBinaryDocument: vi.fn(async () => 0),
}));

import { db, fakeFetch, heads, json, liveFile, liveJson, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs, sweepCommentActivity } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { googleIntegration } from "../../../../src/integrations/google/index.js";
import { accountRoot, captureAccountView, getAccountCapture } from "../../../../src/source-lane/providers/google-docs/account-capture.js";
import { accountFileDirectory, accountFilePaths } from "../../../../src/source-lane/providers/google-docs/account-files.js";
import { resetExportFormatsCacheForTests } from "../../../../src/source-lane/providers/google-docs/drive-export.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const T = "tenant-n1-feed";
const ALICE = "alice@corp.example";
const BOB = "bob@corp.example";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const THREAD = [{ id: "c-1", content: "Q3 numbers?", author: { displayName: "Alice", emailAddress: ALICE }, createdTime: "2026-10-01T09:00:00Z", modifiedTime: "2026-10-01T09:00:00Z", resolved: false, replies: [] }];

/** How an owner disables download/copy for readers (Drive exposes it in three ways; any one is a restriction). */
type Restriction = "none" | "copyRequiresWriterPermission" | "downloadRestrictions" | "capabilitiesOnly";
interface SheetState { modifiedTime: string; restriction: Restriction; body: string }

// ---------------------------------------------------------------- Drive `fields` partial-response mask
type Mask = Map<string, Mask | null>;
function parseMask(s: string): Mask {
  const out: Mask = new Map();
  let i = 0;
  const parse = (into: Mask): void => {
    while (i < s.length) {
      let name = "";
      while (i < s.length && !",()".includes(s[i]!)) name += s[i++];
      let sub: Mask | null = null;
      if (s[i] === "(") {
        i++;
        sub = new Map();
        parse(sub);
        i++; // ')'
      }
      if (name) into.set(name.trim(), sub);
      if (s[i] === ",") i++;
      else if (s[i] === ")" || i >= s.length) return;
    }
  };
  parse(out);
  return out;
}
function applyMask(v: unknown, mask: Mask | null): unknown {
  if (mask === null || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => applyMask(x, mask));
  const o: Record<string, unknown> = {};
  for (const [k, sub] of mask) if (k in (v as Record<string, unknown>)) o[k] = applyMask((v as Record<string, unknown>)[k], sub);
  return o;
}

/** The full Drive file resource as `account` sees it (readers lose copy/download when the owner restricts). */
function resource(s: SheetState, account: string): Record<string, unknown> {
  const writer = account === ALICE;
  const restricted = s.restriction !== "none" && !writer;
  return {
    kind: "drive#file", id: "sheet-1", name: "Budget", mimeType: SHEET_MIME, modifiedTime: s.modifiedTime, md5Checksum: undefined, headRevisionId: undefined,
    trashed: false, parents: ["root"], owners: [{ displayName: "Alice", emailAddress: ALICE }], lastModifyingUser: { displayName: "Alice", emailAddress: ALICE },
    viewersCanCopyContent: s.restriction === "none",
    copyRequiresWriterPermission: s.restriction === "copyRequiresWriterPermission",
    ...(s.restriction === "downloadRestrictions" || s.restriction === "none"
      ? { downloadRestrictions: { itemDownloadRestriction: { restrictedForReaders: s.restriction === "downloadRestrictions", restrictedForWriters: false }, effectiveDownloadRestrictionWithContext: { restrictedForReaders: s.restriction === "downloadRestrictions", restrictedForWriters: false } } }
      : {}),
    capabilities: { canReadRevisions: writer, canComment: true, canEdit: writer, canShare: writer, canCopy: !restricted, canDownload: !restricted },
  };
}

interface Override { match: (u: URL, account: string) => boolean; respond: () => Response }
let state: SheetState;
let feed: Record<string, boolean>; // whether the account's changes feed reports the file this poll
let override: Override | null;
const changesFields: string[] = [];

function google() {
  const accountOf = (init?: RequestInit) => new Headers(init?.headers).get("authorization")?.replace(/^Bearer tok:/, "") ?? "anonymous";
  return fakeFetch([
    (url, init) => {
      const account = accountOf(init);
      if (override?.match(url, account)) return override.respond();
      return undefined;
    },
    (url, init) => {
      if (url.hostname !== "www.googleapis.com" || url.pathname !== "/drive/v3/changes") return undefined;
      const account = accountOf(init);
      changesFields.push(url.searchParams.get("fields") ?? "");
      const body = { kind: "drive#changeList", newStartPageToken: "pt-2", changes: feed[account] ? [{ kind: "drive#change", changeType: "file", time: new Date().toISOString(), removed: false, fileId: "sheet-1", file: resource(state, account) }] : [] };
      return json(applyMask(body, parseMask(url.searchParams.get("fields") ?? "")));
    },
    (url) => (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/about" ? json({ exportFormats: { [SHEET_MIME]: [XLSX, "application/pdf"] } }) : undefined),
    (url, init) => {
      const m = /^\/drive\/v3\/files\/sheet-1(\/export|\/comments)?$/.exec(url.pathname);
      if (url.hostname !== "www.googleapis.com" || !m) return undefined;
      const account = accountOf(init);
      if (!m[1]) return json(resource(state, account));
      if (m[1] === "/comments") return json({ comments: THREAD });
      const r = resource(state, account) as { capabilities: { canDownload: boolean } };
      if (!r.capabilities.canDownload) return json({ error: { code: 403, errors: [{ reason: "cannotDownloadFile" }] } }, 403);
      return new Response(Buffer.from(`BYTES export ${state.body} as:${account}`), { status: 200, headers: { "content-type": XLSX } });
    },
    (url, init) => {
      if (url.hostname !== "sheets.googleapis.com") return undefined;
      return json({ spreadsheetId: "sheet-1", properties: { title: "Budget" }, sheets: [{ properties: { title: "Q3" }, data: [{ rowData: [{ values: [{ formattedValue: `${state.body} as:${accountOf(init)}` }] }] }] }] });
    },
  ]);
}

async function withGoogle<T>(run: () => Promise<T>): Promise<{ value: T; calls: Array<{ url: string }> }> {
  const f = google();
  vi.stubGlobal("fetch", f.impl);
  try {
    return { value: await run(), calls: f.calls };
  } finally {
    vi.unstubAllGlobals();
  }
}
const poll = (reported: Record<string, boolean> = { [ALICE]: true, [BOB]: true }) => {
  feed = reported;
  return withGoogle(() => pollGoogleDocs(T));
};
const snapshotTasks = () => tasks.filter((t) => t.kind === "gdocs.account-snapshot");
async function runAccountTasks() {
  const handler = googleIntegration.taskHandlers!()["gdocs.account-snapshot"]!;
  return withGoogle(async () => {
    const out: Array<Record<string, unknown>> = [];
    for (const t of tasks.splice(0).filter((x) => x.kind === "gdocs.account-snapshot")) {
      out.push({ file: t.payload.docId, mailbox: t.payload.mailbox, ...(await handler(t.payload, { task: { id: "t", queue: "sync", tenantId: T } } as never) as Record<string, unknown>) });
    }
    return out;
  });
}

const P = accountFilePaths(accountFileDirectory(accountRoot(BOB), "sheets", "sheet-1", "Budget"));
const DIR = P.drive.replace(/\/drive\.json$/, "");
const tree = async () => (await heads(T, `${DIR}/`)).filter((h) => h.op === "put").map((h) => h.path.slice(DIR.length + 1)).sort();
const CONTENT = [P.content("Budget.xlsx"), P.native];

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  queryActivityMock.mockReset();
  queryActivityMock.mockResolvedValue([]);
  tasks.length = 0;
  changesFields.length = 0;
  override = null;
  resetGoogleRateLimitCooldownsForTests();
  resetExportFormatsCacheForTests();
  roster.mailboxes = [ALICE, BOB];
  state = { modifiedTime: "2026-10-01T10:00:00Z", restriction: "none", body: "Revenue 100" };
  await resetTenant(T);
  await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM google_account_owner_proofs WHERE tenant_id = $1`, [T]);
  for (const [m, sub] of [[ALICE, "user_alice"], [BOB, "user_bob"]]) {
    await query(`INSERT INTO google_account_owner_proofs (tenant_id, account_email, google_sub, proven_by_subject, proven_by_issuer) VALUES ($1, $2, $3, $4, $5)`, [T, m, `g-${sub}`, sub, "https://auth.example.test"]);
  }
  // Bob's view-only copy, captured while download/copy was allowed.
  await poll();
  expect((await runAccountTasks()).value).toEqual([expect.objectContaining({ file: "sheet-1", mailbox: BOB, status: "complete" })]);
  for (const p of CONTENT) expect(await liveFile(T, p)).not.toBeNull();
});

describe("N-1 post-fix: a download/copy restriction toggled without a new modifiedTime (real feed request)", () => {
  it("the production changes.list request asks Drive for every restriction field the hook reads", () => {
    const mask = parseMask(changesFields.at(-1)!);
    const file = (mask.get("changes") as Mask).get("file") as Mask;
    expect([...file.keys()]).toEqual(expect.arrayContaining(["modifiedTime", "copyRequiresWriterPermission", "downloadRestrictions", "capabilities"]));
    expect([...(file.get("capabilities") as Mask).keys()].sort()).toEqual(["canCopy", "canDownload", "canReadRevisions"]);
  });

  it.each(["copyRequiresWriterPermission", "downloadRestrictions", "capabilitiesOnly"] as const)(
    "%s switched on (metadata only): bob's own feed re-queues his capture, current content is retired, metadata and comments stay, history stays his",
    async (restriction) => {
      const before = await Promise.all(CONTENT.map(async (p) => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2`, [T, p]))[0]!.n));
      state = { ...state, restriction }; // same modifiedTime: Drive does not bump it for a restriction toggle
      await poll();
      // Only bob's capture is re-queued (alice reads the full unit); nothing needed a new version.
      expect(snapshotTasks().map((t) => [t.payload.docId, t.payload.mailbox])).toEqual([["sheet-1", BOB]]);
      const run = await runAccountTasks();
      expect(run.value).toEqual([expect.objectContaining({ file: "sheet-1", status: "blocked", reason: "copy_restricted_for_account" })]);
      // The restricted branch fetches no content: files.get only (comments are re-read by activity, not here).
      expect(run.calls.map((c) => new URL(c.url).pathname)).toEqual(["/drive/v3/files/sheet-1"]);
      expect(await tree()).toEqual(["capture.json", "comments.json", "drive.json"]);
      for (const p of CONTENT) expect(await liveFile(T, p)).toBeNull();
      expect(await liveJson(T, P.comments)).toMatchObject({ account: BOB, comments: [{ id: "c-1" }] });
      expect(await liveJson(T, P.capture)).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account", content: "not_exported: download/copy disabled for this account", capabilities: { canDownload: false } });
      expect(JSON.stringify(await liveJson(T, P.drive))).toContain('"canDownload":false');
      // Ordinary tombstones (reason copy_restricted_for_account, not *_withheld): earlier versions stay in bob's own
      // history (yc_msaw sources_history serves them to bob only); nothing is purged.
      const tomb = await query<{ path: string; deleted_reason: string; op: string }>(
        `SELECT DISTINCT ON (path) path, op, deleted_reason FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = ANY($2) ORDER BY path, seq DESC`, [T, CONTENT]);
      expect(tomb.map((r) => [r.op, r.deleted_reason])).toEqual([["delete", "copy_restricted_for_account"], ["delete", "copy_restricted_for_account"]]);
      for (const [i, p] of CONTENT.entries()) expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2 AND op = 'put'`, [T, p]))[0]!.n).toBe(before[i]);
      expect((await getAccountCapture(T, "sheet-1", BOB, deps))).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account" });

      // Still restricted on the next poll: no capture loop, no extra Google calls.
      await poll();
      expect(snapshotTasks()).toEqual([]);

      // Switched off again (still the same modifiedTime): bob's feed re-queues and the content is captured again.
      state = { ...state, restriction: "none" };
      await poll();
      expect((await runAccountTasks()).value).toEqual([expect.objectContaining({ file: "sheet-1", status: "complete" })]);
      for (const p of CONTENT) expect(await liveFile(T, p)).not.toBeNull();
      // And an unchanged, unrestricted file on the next poll costs nothing.
      await poll();
      expect(snapshotTasks()).toEqual([]);
    },
  );

  it("with no feed change at all, bob's own comment activity re-captures and still honours the restriction", async () => {
    state = { ...state, restriction: "copyRequiresWriterPermission" };
    await poll({ [ALICE]: false, [BOB]: false }); // Drive reported nothing
    expect(snapshotTasks()).toEqual([]);
    for (const p of CONTENT) expect(await liveFile(T, p)).not.toBeNull(); // nothing can retire it yet (see report: limits)
    queryActivityMock.mockImplementation(async (token: string) => token === `tok:${BOB}` ? [{ targets: [{ driveItem: { name: "items/sheet-1" } }], primaryActionDetail: { comment: {} }, timestamp: "2026-10-05T00:00:00Z", actors: [] }] : []);
    await withGoogle(() => sweepCommentActivity(T));
    expect(snapshotTasks().map((t) => t.payload.mailbox)).toEqual([BOB]);
    const run = await runAccountTasks();
    expect(run.value).toEqual([expect.objectContaining({ file: "sheet-1", status: "blocked", reason: "copy_restricted_for_account" })]);
    for (const p of CONTENT) expect(await liveFile(T, p)).toBeNull();
    expect(await tree()).toEqual(["capture.json", "comments.json", "drive.json"]);
    expect(run.calls.map((c) => new URL(c.url).pathname)).toEqual(["/drive/v3/files/sheet-1", "/drive/v3/files/sheet-1/comments"]);
  });

  it("a 403 rate limit on the restriction re-check is a retry: content kept, Retry-After floor kept, then retired", async () => {
    state = { ...state, restriction: "downloadRestrictions" };
    await poll();
    expect(snapshotTasks()).toHaveLength(1);
    override = {
      match: (u, account) => account === BOB && u.pathname === "/drive/v3/files/sheet-1",
      respond: () => json({ error: { code: 403, message: "User Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }] } }, 403, { "retry-after": "120" }),
    };
    const t0 = Date.now();
    const run = await runAccountTasks();
    expect(run.value).toEqual([expect.objectContaining({ file: "sheet-1" })]);
    const row = await getAccountCapture(T, "sheet-1", BOB, deps);
    expect(row).toMatchObject({ state: "pending" });
    expect(Date.parse(String(row!.retryAt)) - t0).toBeGreaterThanOrEqual(119_000);
    for (const p of CONTENT) expect(await liveFile(T, p)).not.toBeNull(); // a rate limit is not a restriction or access loss
    // Retry-After passes; the sweep's retry (or the task) re-checks and retires.
    override = null;
    resetGoogleRateLimitCooldownsForTests();
    await query(`UPDATE gdocs_account_captures SET retry_at = now() - interval '1 second' WHERE tenant_id = $1`, [T]);
    const again = await withGoogle(() => captureAccountView({ tenantId: T, docId: "sheet-1", mailbox: BOB, deps }));
    expect(again.value).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account" });
    for (const p of CONTENT) expect(await liveFile(T, p)).toBeNull();
  });
});
