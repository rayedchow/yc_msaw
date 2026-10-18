import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pollDriveChangesMock = vi.hoisted(() => vi.fn());
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
  queryActivity: vi.fn(async () => []),
  getDriveFileParents: vi.fn(async () => []),
  INTER_DOC_DELAY_MS: 0,
}));
vi.mock("../../../../src/integrations/google/mailboxes.js", () => ({
  listGoogleMailboxes: vi.fn(async () => roster.mailboxes),
  getGoogleMailboxState: vi.fn(async () => ({ drivePageToken: "pt-1" })),
  updateGoogleMailboxState: vi.fn(async () => {}),
}));
vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ email: "alice@corp.example", authMode: "oauth_direct" })),
  mergeTokenMetadata: vi.fn(async () => {}),
}));
// Every Google call carries the bearer of the account it runs as, so the fake Google below answers per account.
// The tenant default credential (no mailbox) is alice's grant, as getGoogleApiCredential resolves it.
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
    // Composio's proxy runs the call as the connected account; the fake marks that account's bearer on the request.
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
// The run recorder reads postgres-js array results (PGlite returns {rows}); the handler's own wiring still runs.
vi.mock("../../../../src/integrations/source-sync-task.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/integrations/source-sync-task.js")>(),
  runRecordedSourceSyncTask: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
}));

import { allStoredText, db, fakeFetch, heads, json, liveFile, liveJson, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { snapshotDocContent } from "../../../../src/integrations/google/gdocs/content-snapshot.js";
import { googleIntegration } from "../../../../src/integrations/google/index.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { accountDocDirectory, accountDocPaths, captureAccountDocView, getAccountCapture } from "../../../../src/source-lane/providers/google-docs/account-capture.js";
import { googleAttributionFor } from "../../../../src/source-lane/providers/google-auth/attribution.js";
import { googleDocsCoverage } from "../../../../src/source-lane/providers/google-docs/coverage.js";
import { runGdocsSourceSweep } from "../../../../src/source-lane/providers/google-docs/sweep.js";
import { gdocsVersionsExport } from "../../../../src/source-lane/providers/google-docs/export-map.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { runDocHistoryAfterSnapshot } from "../../../../src/source-lane/providers/google-docs/sweep.js";
import { runGdocsContentSnapshot } from "../../../../src/integrations/google/gdocs/jobs.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * A view-only (reader/commenter) account reads the CURRENT document it may legitimately read, captured under its own
 * credential, and nothing of the writer's shared unit: no OT history, no earlier writer snapshots, no suggestions
 * Google hides from it, no permission list, no other account's image bytes, no baseline shared with another account.
 */
const deps = { db: db as unknown as SqlDatabase };
const T = "tenant-viewer";
const ISS = "https://auth.example.test";
const ALICE = "alice@corp.example";
const BOB = "bob@corp.example";
const DOC = "doc-plan";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const ALICE_URI = "https://lh3.googleusercontent.com/docs/ALICE-REQUESTER-TAGGED";
const BOB_URI = "https://lh3.googleusercontent.com/docs/BOB-REQUESTER-TAGGED";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

interface GoogleState {
  modifiedTime: string;
  revisionId: string;
  body: string;
  /** Per account: what Drive says that account may do. */
  caps: Record<string, { canReadRevisions: boolean; canComment?: boolean; canCopy?: boolean; canDownload?: boolean } | "forbidden" | "error">;
  copyRequiresWriterPermission?: boolean;
  docsStatus?: Record<string, number>;
  retryAfter?: string;
  /**
   * What comments.list returns to each account (google-native-views). Default: writers and commenters see the
   * thread, readers get 403. The runtime never assumes either way; it records what Google answers.
   */
  comments?: Record<string, "forbidden" | unknown[]>;
}

const THREAD = [{ id: "c-1", content: "Please check the numbers", author: { displayName: "Alice", emailAddress: "alice@corp.example" }, createdTime: "2026-10-01T09:00:00Z", modifiedTime: "2026-10-01T09:00:00Z", resolved: false, replies: [] }];

function docJson(s: GoogleState, account: string, inline: boolean) {
  const elements: unknown[] = [{ textRun: { content: `${s.body}\n` } }];
  if (inline) elements.push({ textRun: { content: "SUGGESTED-SECRET ", suggestedInsertionIds: ["sug-1"] } });
  return {
    documentId: DOC,
    title: "Plan",
    revisionId: s.revisionId,
    suggestionsViewMode: inline ? "SUGGESTIONS_INLINE" : "PREVIEW_WITHOUT_SUGGESTIONS",
    tabs: [{
      tabProperties: { tabId: "t.0", title: "Overview", index: 0 },
      documentTab: {
        body: { content: [{ paragraph: { elements } }, { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "kix.img" } }] } }] },
        inlineObjects: { "kix.img": { inlineObjectProperties: { embeddedObject: { title: "Chart", imageProperties: { contentUri: account === ALICE ? ALICE_URI : BOB_URI } } } } },
      },
    }],
  };
}

function google(s: GoogleState) {
  const accountOf = (init?: RequestInit) => new Headers(init?.headers).get("authorization")?.replace(/^Bearer tok:/, "") ?? "anonymous";
  return fakeFetch([
    (url, init) => {
      if (url.hostname !== "www.googleapis.com" || url.pathname !== `/drive/v3/files/${DOC}`) return undefined;
      const account = accountOf(init);
      const caps = s.caps[account];
      if (!caps || caps === "forbidden") return json({ error: { code: 404, message: "File not found" } }, 404);
      if (caps === "error") return json({ error: { code: 500, message: "backend" } }, 500);
      return json({
        id: DOC, name: "Plan", mimeType: DOC_MIME, modifiedTime: s.modifiedTime,
        copyRequiresWriterPermission: s.copyRequiresWriterPermission ?? false,
        capabilities: { canDownload: true, canCopy: true, ...caps },
        // Only a writer sees the full sharing list.
        ...(caps.canReadRevisions ? { permissions: [{ id: "p9", type: "user", role: "writer", emailAddress: "hidden-collaborator@corp.example" }] } : {}),
      });
    },
    (url, init) => {
      if (url.hostname !== "www.googleapis.com" || url.pathname !== `/drive/v3/files/${DOC}/comments`) return undefined;
      const account = accountOf(init);
      const caps = s.caps[account];
      if (!caps || typeof caps === "string") return json({ error: { code: 404 } }, 404);
      const answer = s.comments?.[account] ?? (caps.canReadRevisions || caps.canComment ? THREAD : "forbidden");
      if (answer === "forbidden") return json({ error: { code: 403, message: "The user does not have sufficient permissions for this file." } }, 403);
      return json({ comments: answer });
    },
    (url, init) => {
      if (url.hostname !== "docs.googleapis.com") return undefined;
      const account = accountOf(init);
      const forced = s.docsStatus?.[account];
      if (forced) return json({ error: { code: forced } }, forced, s.retryAfter ? { "retry-after": s.retryAfter } : {});
      const caps = s.caps[account];
      if (!caps || typeof caps === "string") return json({ error: { code: 404 } }, 404);
      const mode = url.searchParams.get("suggestionsViewMode");
      const viewOnly = !caps.canReadRevisions && !caps.canComment;
      // Documented: SUGGESTIONS_INLINE is 403 for an account that may not see suggestions; DEFAULT_FOR_CURRENT_ACCESS
      // applies PREVIEW_WITHOUT_SUGGESTIONS to view-only access and SUGGESTIONS_INLINE otherwise.
      if (mode === "SUGGESTIONS_INLINE" && viewOnly) return json({ error: { code: 403, message: "The caller does not have permission" } }, 403);
      const inline = mode === "SUGGESTIONS_INLINE" || (mode === "DEFAULT_FOR_CURRENT_ACCESS" && !viewOnly);
      return json(docJson(s, account, inline));
    },
    (url) => url.href === ALICE_URI || url.href === BOB_URI ? new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } }) : undefined,
    (url) => url.hostname === "docs.google.com" ? new Response("", { status: 403 }) : undefined,
  ]);
}

const change = (canReadRevisions?: boolean, modifiedTime = "2026-10-01T10:00:00Z", mimeType = DOC_MIME, id = DOC) => ({
  fileId: id,
  file: { name: "Plan", mimeType, modifiedTime, trashed: false, parents: [], ...(canReadRevisions === undefined ? {} : { capabilities: { canReadRevisions } }) },
});

async function poll(perMailbox: Record<string, unknown[]>) {
  for (const m of roster.mailboxes) pollDriveChangesMock.mockResolvedValueOnce({ changes: perMailbox[m] ?? [], newPageToken: "pt-2" });
  await pollGoogleDocs(T);
}

/** Run the queued account-snapshot tasks through the production handler, then clear them. */
async function runAccountTasks(s: GoogleState) {
  const f = google(s);
  vi.stubGlobal("fetch", f.impl);
  const handler = googleIntegration.taskHandlers!()["gdocs.account-snapshot"]!;
  const results: unknown[] = [];
  try {
    for (const t of tasks.splice(0).filter((x) => x.kind === "gdocs.account-snapshot")) {
      results.push(await handler(t.payload, { task: { id: "t", queue: "sync", tenantId: T } } as never));
    }
  } finally {
    vi.unstubAllGlobals();
  }
  return { results, calls: f.calls };
}

async function aliceSharedSnapshot(s: GoogleState) {
  const f = google(s);
  vi.stubGlobal("fetch", f.impl);
  try {
    expect((await snapshotDocContent(T, DOC, { modifiedTime: s.modifiedTime })).status).toBe("captured");
  } finally {
    vi.unstubAllGlobals();
  }
}

const accountTasks = () => tasks.filter((t) => t.kind === "gdocs.account-snapshot");
const B = accountDocPaths(accountDocDirectory(BOB, DOC, "Plan"));
const A = docPaths(docDirectory(DOC, "Plan"));

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  pollDriveChangesMock.mockReset();
  tasks.length = 0;
  proxied.length = 0;
  credentialMode.byMailbox = {};
  resetGoogleRateLimitCooldownsForTests();
  roster.mailboxes = [ALICE, BOB];
  await resetTenant(T);
  await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM google_account_owner_proofs WHERE tenant_id = $1`, [T]);
  for (const [m, sub] of [[ALICE, "user_alice"], [BOB, "user_bob"]]) {
    await query(`INSERT INTO google_account_owner_proofs (tenant_id, account_email, google_sub, proven_by_subject, proven_by_issuer) VALUES ($1, $2, $3, $4, $5)`, [T, m, `g-${sub}`, sub, ISS]);
  }
});

describe("view-only accounts read their own current view of a Doc, never the writer's unit", () => {
  it("captures bob's current view under bob's credential, leaves alice's rich unit and baselines untouched", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Current body text", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    // The feed scheduled exactly one account capture: bob's (alice reads the full unit).
    expect(accountTasks().map((t) => [t.payload.mailbox, t.dedupeKey, t.groupKey]))
      .toEqual([[BOB, `gdocs-account-snapshot:${T}:${DOC}:${BOB}`, `${T}:gdocs`]]);

    await aliceSharedSnapshot(s);
    const sharedBefore = await heads(T, A.nativeDocument.replace(/\/native\/document\.json$/, "/"));
    const tabRowsBefore = await query(`SELECT revision_id, tab_id, content FROM google_doc_tab_snapshots WHERE user_id = $1 ORDER BY revision_id, tab_id`, [T]);
    const imagesBefore = await query(`SELECT object_id, sha256 FROM google_doc_images WHERE user_id = $1`, [T]);
    expect(JSON.stringify(await liveJson(T, A.nativeDocument))).toContain("SUGGESTED-SECRET");

    const run = await runAccountTasks(s);
    // google-native-views: the first capture also asks Google for the comments it shows bob (a reader: 403, none kept).
    expect(run.results).toEqual([{ status: "complete", reason: "suggestions_not_visible_to_account", apiCalls: 3, imageFetches: 1 }]);
    // Every Google call of the account capture ran as bob, never as alice or the tenant default.
    const apiCalls = run.calls.filter((c) => c.url.includes("googleapis.com"));
    expect(apiCalls.map((c) => c.headers.get("authorization"))).toEqual([`Bearer tok:${BOB}`, `Bearer tok:${BOB}`, `Bearer tok:${BOB}`]);
    expect(apiCalls.map((c) => new URL(c.url).searchParams.get("suggestionsViewMode"))).toEqual([null, "DEFAULT_FOR_CURRENT_ACCESS", null]);
    expect((await getAccountCapture(T, DOC, BOB, deps))).toMatchObject({ commentsState: "not_visible", commentsDue: false });
    expect(run.calls.map((c) => c.url)).not.toContain(ALICE_URI);

    // Bob's current view: what Google returns to a reader, rendered by the donor renderer.
    const native = await liveJson<{ suggestionsViewMode: string; revisionId: string }>(T, B.nativeDocument);
    expect(native).toMatchObject({ suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS", revisionId: "rev-1" });
    expect((await liveFile(T, B.tabText("t.0")))!.bytes.toString("utf8")).toContain("Current body text");
    expect((await liveFile(T, B.imageBytes("kix.img", ".png")))!.bytes.equals(PNG)).toBe(true);
    const drive = await liveJson<{ file: Record<string, unknown> }>(T, B.drive);
    expect(drive.file.capabilities).toMatchObject({ canReadRevisions: false });
    expect(drive.file).not.toHaveProperty("permissions");
    const capture = await liveJson<{ suggestionsViewMode: string; credentialMode: string; excludes: unknown[] }>(T, B.capture);
    expect(capture).toMatchObject({ suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS", credentialMode: "oauth_direct" });
    expect(capture.excludes.length).toBeGreaterThan(0);

    // Nothing of the writer-only material is in bob's tree.
    const bobTree = await heads(T, `${accountDocDirectory(BOB, DOC, "Plan")}/`);
    expect(bobTree.map((h) => h.path.slice(accountDocDirectory(BOB, DOC, "Plan").length + 1)).sort()).toEqual([
      "capture.json", "drive.json", `history/snapshot-diffs/${bobTree.find((h) => h.path.includes("snapshot-diffs"))!.path.split("/").pop()}`,
      "images/kix.img.json", "images/kix.img.png", "native/document.json", "native/tabs/t.0.json", "tabs/t.0.md",
    ].sort());
    for (const h of bobTree) {
      const text = (await liveFile(T, h.path))!.bytes.toString("latin1");
      expect(text).not.toContain("SUGGESTED-SECRET");
      expect(text).not.toContain("hidden-collaborator");
    }
    expect(await allStoredText(T)).not.toContain("BOB-REQUESTER-TAGGED");

    // Alice's shared unit, the donor tab-snapshot baseline and image table are exactly as before.
    expect(await heads(T, A.nativeDocument.replace(/\/native\/document\.json$/, "/"))).toEqual(sharedBefore);
    expect(await query(`SELECT revision_id, tab_id, content FROM google_doc_tab_snapshots WHERE user_id = $1 ORDER BY revision_id, tab_id`, [T])).toEqual(tabRowsBefore);
    expect(await query(`SELECT object_id, sha256 FROM google_doc_images WHERE user_id = $1`, [T])).toEqual(imagesBefore);

    // Attribution is unchanged: bob's shared unit stays view-only (withheld by the consumer), alice keeps hers.
    expect((await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units.every((u) => !u.revisions)).toBe(true);
    expect((await googleAttributionFor(T, { subject: "user_alice", issuer: ISS }, db as never)).units.every((u) => u.revisions)).toBe(true);

    // Every account file publishes through the normal versions export with the Drive file id as provenance.
    const [row] = await query<{ id: string }>(`SELECT id FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2`, [T, B.nativeDocument]);
    const changes = await gdocsVersionsExport.map({ tenantId: T, executor: db } as never, String(row!.id), { enqueuedAt: new Date().toISOString() } as never, []);
    expect(changes[0]).toMatchObject({ op: "put", path: B.nativeDocument, provenance: { externalId: DOC, account: BOB, credentialMode: "oauth_direct" } });
  });

  it("is idempotent per Drive version (1 files.get), diffs only against the account's own baseline, and follows edits", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "First", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    await runAccountTasks(s);
    const versionsAfterFirst = await query(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1`, [T]);

    // Same version again (redelivered change / inventory pass): no task; a forced run costs one files.get, writes nothing.
    await poll({ [ALICE]: [], [BOB]: [change(false)] });
    expect(accountTasks()).toEqual([]);
    const f = google(s);
    const again = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: f.impl });
    expect(again).toMatchObject({ state: "complete", reason: "already_captured_for_version", apiCalls: 1, imageFetches: 0 });
    expect(await query(`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = $1`, [T])).toEqual(versionsAfterFirst);

    // Alice's shared unit gets a later revision with writer-only edits; bob's baseline must not move.
    await aliceSharedSnapshot({ ...s, modifiedTime: "2026-10-02T10:00:00Z", revisionId: "rev-a2", body: "Writer draft" });

    // Bob's next own capture diffs rev-1 -> rev-2 of HIS view only.
    const s2 = { ...s, modifiedTime: "2026-10-03T10:00:00Z", revisionId: "rev-2", body: "Second" };
    await poll({ [ALICE]: [], [BOB]: [change(false, s2.modifiedTime)] });
    expect(accountTasks().map((t) => t.payload.modifiedTime)).toEqual([s2.modifiedTime]);
    await runAccountTasks(s2);
    expect((await liveFile(T, B.tabText("t.0")))!.bytes.toString("utf8")).toContain("Second");
    const diffs = (await heads(T, `${accountDocDirectory(BOB, DOC, "Plan")}/history/snapshot-diffs/`));
    expect(diffs).toHaveLength(2);
    const latest = await liveJson<{ previousRevisionId: string; revisionId: string; tabChanges: Array<{ unifiedDiff: string }>; account: string }>(T, diffs.map((d) => d.path).sort().pop()!);
    expect(latest).toMatchObject({ previousRevisionId: "rev-1", revisionId: "rev-2", account: BOB });
    expect(latest.tabChanges[0]!.unifiedDiff).toContain("-First");
    expect(latest.tabChanges[0]!.unifiedDiff).toContain("+Second");
    expect(JSON.stringify(latest)).not.toContain("Writer draft");
    expect(JSON.stringify(latest)).not.toContain("rev-a2");
  });

  it("follows the account's role: upgrade supersedes the copy (full unit), downgrade captures again, access loss retires it", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    await runAccountTasks(s);
    expect(await liveFile(T, B.nativeDocument)).not.toBeNull();

    // Bob becomes a writer: the full unit is now his read, his account copy is retired, nothing new is scheduled.
    await poll({ [ALICE]: [], [BOB]: [change(true, "2026-10-02T10:00:00Z")] });
    expect(accountTasks()).toEqual([]);
    expect(await liveFile(T, B.nativeDocument)).toBeNull();
    expect((await getAccountCapture(T, DOC, BOB, deps))!.state).toBe("superseded");
    expect((await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units.every((u) => u.revisions)).toBe(true);

    // Back to reader: the unit is withheld again and his own current view is captured again.
    await poll({ [ALICE]: [], [BOB]: [change(false, "2026-10-03T10:00:00Z")] });
    expect((await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units.every((u) => !u.revisions)).toBe(true);
    await runAccountTasks({ ...s, modifiedTime: "2026-10-03T10:00:00Z" });
    expect(await liveFile(T, B.nativeDocument)).not.toBeNull();

    // Bob loses the file: only his copy is tombstoned; alice's unit and her visibility are untouched.
    await aliceSharedSnapshot(s);
    await poll({ [ALICE]: [], [BOB]: [{ fileId: DOC, removed: true }] });
    expect(await liveFile(T, B.nativeDocument)).toBeNull();
    expect((await getAccountCapture(T, DOC, BOB, deps))!.state).toBe("retired");
    expect(await liveFile(T, A.nativeDocument)).not.toBeNull();
    expect((await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units).toEqual([]);

    // Trash is tenant-wide: the shared unit and every account copy go together.
    await poll({ [ALICE]: [change(true, "2026-10-04T10:00:00Z")], [BOB]: [change(false, "2026-10-04T10:00:00Z")] });
    await runAccountTasks({ ...s, modifiedTime: "2026-10-04T10:00:00Z" });
    expect(await liveFile(T, B.nativeDocument)).not.toBeNull();
    await poll({ [ALICE]: [{ fileId: DOC, file: { ...change(true).file, trashed: true } }], [BOB]: [] });
    expect(await liveFile(T, B.nativeDocument)).toBeNull();
    expect((await getAccountCapture(T, DOC, BOB, deps))!.state).toBe("retired");
  });

  it("fails closed under the account's own credential and never falls back to another copy", async () => {
    const base: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    await aliceSharedSnapshot(base);

    // Transient Docs failure: error + backoff, nothing exported for bob, nothing borrowed from alice's copy.
    const err = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google({ ...base, docsStatus: { [BOB]: 500 } }).impl });
    expect(err).toMatchObject({ state: "error", reason: "documents.get_http_500" });
    expect(await heads(T, `${accountDocDirectory(BOB, DOC, "Plan")}/`)).toEqual([]);
    expect((await getAccountCapture(T, DOC, BOB, deps))!.retryAt).not.toBeNull();

    // Rate limit: Retry-After is the floor of the retry time.
    resetGoogleRateLimitCooldownsForTests();
    const now = new Date("2026-10-18T12:00:00Z");
    const limited = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, now, fetchImpl: google({ ...base, docsStatus: { [BOB]: 429 }, retryAfter: "600" }).impl });
    expect(limited).toMatchObject({ state: "pending", reason: "rate_limited" });
    expect(Date.parse((await getAccountCapture(T, DOC, BOB, deps))!.retryAt!)).toBeGreaterThanOrEqual(now.getTime() + 600_000);
    resetGoogleRateLimitCooldownsForTests();

    // Google refuses bob the doc (both views): blocked, and still nothing for bob.
    const refused = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google({ ...base, docsStatus: { [BOB]: 403 } }).impl });
    expect(refused).toMatchObject({ state: "blocked", reason: "access_lost:documents.get_http_403" });
    expect(await heads(T, `${accountDocDirectory(BOB, DOC, "Plan")}/`)).toEqual([]);

    // A successful capture, then Drive says bob no longer sees it: his copy is retired at capture time.
    await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google(base).impl });
    expect(await liveFile(T, B.nativeDocument)).not.toBeNull();
    const gone = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google({ ...base, modifiedTime: "2026-10-02T00:00:00Z", caps: { ...base.caps, [BOB]: "forbidden" } }).impl });
    expect(gone).toMatchObject({ state: "blocked", reason: "access_lost:files.get_http_404" });
    expect(await liveFile(T, B.nativeDocument)).toBeNull();

    // Owner disabled copy/download for readers and commenters: bob may look at it in Google, not keep a copy.
    const restricted = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google({ ...base, modifiedTime: "2026-10-03T00:00:00Z", copyRequiresWriterPermission: true }).impl });
    expect(restricted).toMatchObject({ state: "blocked", reason: "copy_restricted_for_account" });
    expect(await liveFile(T, B.nativeDocument)).toBeNull();

    // Shared unit untouched throughout.
    expect(JSON.stringify(await liveJson(T, A.nativeDocument))).toContain("SUGGESTED-SECRET");
  });

  it("a commenter gets exactly what Google gives a commenter: suggestions inline, still no history or permission list", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false, canComment: true } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    const run = await runAccountTasks(s);
    expect(run.results).toEqual([{ status: "complete", reason: null, apiCalls: 3, imageFetches: 1 }]);
    expect((await liveJson<{ suggestionsViewMode: string }>(T, B.capture)).suggestionsViewMode).toBe("SUGGESTIONS_INLINE");
    // google-native-views: the comments Google returns to the commenter, read as the commenter.
    expect(await liveJson(T, B.comments)).toMatchObject({ account: BOB, complete: true, comments: [{ id: "c-1", content: "Please check the numbers" }] });
    expect(JSON.stringify(await liveJson(T, B.tabSuggestions("t.0")))).toContain("SUGGESTED-SECRET");
    expect(await liveJson<{ file: Record<string, unknown> }>(T, B.drive)).not.toHaveProperty("file.permissions");
    expect((await heads(T, `${accountDocDirectory(BOB, DOC, "Plan")}/history/`)).every((h) => h.path.includes("/history/snapshot-diffs/"))).toBe(true);
  });

  it("never captures on an unknown capability, for a mailbox outside the roster, or before the mailbox is seen", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    // A feed entry without capabilities (older poller fields / donor mocks): nothing scheduled, nothing captured.
    await poll({ [ALICE]: [change(true)], [BOB]: [change(undefined)] });
    expect(accountTasks()).toEqual([]);
    expect(await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google(s).impl })).toMatchObject({ state: "skipped", reason: "capability_not_observed", apiCalls: 0 });
    // A mailbox that never saw the file through its own Drive view.
    expect(await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: "carol@corp.example", deps, fetchImpl: google(s).impl })).toMatchObject({ state: "skipped", reason: "not_visible_to_account", apiCalls: 0 });
    // Bob seen view-only, then disconnected (out of the roster): blocked without any Google call.
    await poll({ [ALICE]: [], [BOB]: [change(false)] });
    roster.mailboxes = [ALICE];
    expect(await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google(s).impl })).toMatchObject({ state: "blocked", reason: "mailbox_not_in_roster", apiCalls: 0 });
  });

  it("uses the account's own lane: DWD impersonates that mailbox; Composio goes through the existing proxy as that account", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    credentialMode.byMailbox[BOB] = "domain_wide_delegation";
    const dwd = await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: google(s).impl });
    expect(dwd.state).toBe("complete");
    expect((await liveJson<{ credentialMode: string }>(T, B.capture)).credentialMode).toBe("domain_wide_delegation");

    credentialMode.byMailbox[BOB] = "composio_proxy";
    const f = google({ ...s, modifiedTime: "2026-10-02T10:00:00Z", revisionId: "rev-2", body: "Via proxy" });
    vi.stubGlobal("fetch", f.impl);
    try {
      expect((await captureAccountDocView({ tenantId: T, docId: DOC, mailbox: BOB, deps, fetchImpl: f.impl })).state).toBe("complete");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(proxied.some((u) => u.startsWith("https://docs.googleapis.com/"))).toBe(true);
    expect((await liveJson<{ credentialMode: string }>(T, B.capture)).credentialMode).toBe("composio_proxy");
    expect((await liveFile(T, B.tabText("t.0")))!.bytes.toString("utf8")).toContain("Via proxy");
  });

  // google-native-views: view-only Sheets/Slides/Drive files/PDFs are no longer withheld; they are captured as the account
  // (account-native-views.test.ts). Here the fake Google has no route for the sheet, so its capture as bob fails, is
  // recorded as an error with a retry time, and the account scope is `partial`, never complete.
  it("is retried by the hourly sweep and reported per account in coverage, other view-only files attempted as the account", async () => {
    const s: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false), change(false, "2026-10-01T10:00:00Z", SHEET_MIME, "sheet-1")] });
    tasks.length = 0; // the queued task is lost and the doc predates this lane (no capture row): the sweep must still capture it
    await query(`DELETE FROM gdocs_account_captures WHERE tenant_id = $1`, [T]);
    const f = google(s);
    vi.stubGlobal("fetch", f.impl);
    try {
      const sweep = await runGdocsSourceSweep(T, { maxFiles: 5, budgetMs: 60_000, includeDocs: true, deps });
      expect(sweep.results.filter((r) => r.lane === "doc-account")).toEqual([
        { fileId: DOC, lane: "doc-account", state: "complete", reason: "suggestions_not_visible_to_account" },
        { fileId: "sheet-1", lane: "doc-account", state: "error", reason: "files.get_http_599" },
      ]);
      expect((await getAccountCapture(T, "sheet-1", BOB, deps))!.retryAt).not.toBeNull();
      // Both the shared `_drive` export (bob is the only mailbox that sees it) and bob's own capture ran as bob.
      expect(new Set(f.calls.filter((c) => c.url.includes("sheet-1")).map((c) => c.headers.get("authorization")))).toEqual(new Set([`Bearer tok:${BOB}`]));
      // The 60 s poll sweep (non-Doc files only) never runs account captures.
      await query(`UPDATE gdocs_account_captures SET state = 'pending' WHERE tenant_id = $1`, [T]);
      expect((await runGdocsSourceSweep(T, { maxFiles: 5, budgetMs: 60_000, includeDocs: false, deps })).results.filter((r) => r.lane === "doc-account")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    const reports = await googleDocsCoverage({ tenantId: T, executor: db } as never);
    const bob = reports.find((r) => r.scope === `account:${BOB}`)!;
    // Everything was reset to pending above: pending (never complete), with no type left uncaptured or withheld.
    expect(bob).toMatchObject({ state: "pending", counts: { pending: 2, docs: 1, sheets: 1, notYetCaptured: 0 } });
    expect(bob.reason).not.toContain("viewer_current_content_not_captured");
    expect(bob.reason).toContain("writer-only revision history");
    expect(reports.find((r) => r.scope === `account:${ALICE}`)).toBeUndefined();
  });
});

describe("the shared unit is captured as a mailbox that may read revisions, never as a viewer or the tenant default", () => {
  const S: GoogleState = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Body", caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: false } } };
  const historyAs = async (s: GoogleState) => {
    const f = google(s);
    vi.stubGlobal("fetch", f.impl);
    try {
      await runDocHistoryAfterSnapshot(T, DOC, "Plan", { modifiedTime: null, deps });
    } finally {
      vi.unstubAllGlobals();
    }
    return [...new Set(f.calls.filter((c) => c.url.includes("docs.google.com")).map((c) => c.headers.get("authorization")))];
  };

  it("a viewer's feed seeing the doc last does not make it the credential of alice's OT history (either order)", async () => {
    await poll({ [ALICE]: [change(true)], [BOB]: [change(false)] });
    expect((await getCheckpoint(T, DOC, deps))!.mailbox).toBe(ALICE);
    expect(await historyAs(S)).toEqual([`Bearer tok:${ALICE}`]);
    roster.mailboxes = [BOB, ALICE];
    await poll({ [BOB]: [change(false, "2026-10-02T10:00:00Z")], [ALICE]: [] });
    expect((await getCheckpoint(T, DOC, deps))!.mailbox).toBe(ALICE);
    // Only when no mailbox that may read revisions sees it any more does a viewer become the capture identity
    // (and then the shared unit is withheld from everyone; viewers read their own account views).
    await poll({ [BOB]: [], [ALICE]: [{ fileId: DOC, removed: true }] });
    expect((await getCheckpoint(T, DOC, deps))!.mailbox).toBe(BOB);
    expect((await googleAttributionFor(T, { subject: "user_bob", issuer: ISS }, db as never)).units.every((u) => !u.revisions)).toBe(true);
  });

  it("a capture mailbox without a bearer (Composio) falls back to the donor default credential instead of failing", async () => {
    roster.mailboxes = [ALICE, BOB];
    await poll({ [ALICE]: [change(true)], [BOB]: [change(true)] });
    expect((await getCheckpoint(T, DOC, deps))!.mailbox).toBe(BOB);
    credentialMode.byMailbox[BOB] = "composio_proxy";
    const f = google({ ...S, caps: { [ALICE]: { canReadRevisions: true }, [BOB]: { canReadRevisions: true } } });
    vi.stubGlobal("fetch", f.impl);
    try {
      expect(await runGdocsContentSnapshot(T, DOC, { modifiedTime: S.modifiedTime })).toMatchObject({ status: "captured" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect([...new Set(f.calls.filter((c) => c.url.includes("docs.googleapis.com")).map((c) => c.headers.get("authorization")))]).toEqual([`Bearer tok:${ALICE}`]);
  });

  it("a doc only bob sees is captured with bob's credential, not the tenant default (alice), and is refreshed", async () => {
    await poll({ [ALICE]: [], [BOB]: [change(true)] });
    const s: GoogleState = { ...S, body: "Bob private body", caps: { [BOB]: { canReadRevisions: true } } };
    const f = google(s);
    vi.stubGlobal("fetch", f.impl);
    try {
      expect(await runGdocsContentSnapshot(T, DOC, { modifiedTime: s.modifiedTime })).toMatchObject({ status: "captured" });
      expect(await runGdocsContentSnapshot(T, DOC, { modifiedTime: "2026-10-02T10:00:00Z" })).toMatchObject({ status: "deduped_revision" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect([...new Set(f.calls.filter((c) => c.url.includes("docs.googleapis.com")).map((c) => c.headers.get("authorization")))]).toEqual([`Bearer tok:${BOB}`]);
    expect(JSON.stringify(await liveJson(T, A.nativeDocument))).toContain("Bob private body");
  });
});
