import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pollDriveChangesMock = vi.hoisted(() => vi.fn());

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
  listGoogleMailboxes: vi.fn(async () => ["ada@corp.example"]),
  getGoogleMailboxState: vi.fn(async () => ({ drivePageToken: "pt-1" })),
  updateGoogleMailboxState: vi.fn(async () => {}),
}));
vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ email: "ada@corp.example", authMode: "domain_wide_delegation" })),
  mergeTokenMetadata: vi.fn(async () => {}),
}));
vi.mock("../../../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: vi.fn(async () => "tok"),
  GOOGLE_DOCS_DELEGATION_SCOPES: ["scope"],
  GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES: ["scope"],
}));
vi.mock("../../../../src/queue/queue.js", () => ({ enqueueTask: vi.fn(async () => "task-1") }));
vi.mock("../../../../src/queue/dispatch.js", () => ({ enqueueCollectedEventForProcessing: vi.fn(async () => {}) }));
vi.mock("../../../../src/polling/_archived-gdocs/gdocs-edits.js", () => ({ processEditActivity: vi.fn(async () => 0) }));
vi.mock("../../../../src/polling/_archived-gdocs/document-summary-tracker.js", () => ({ markGoogleDocSummaryDirty: vi.fn(async () => {}) }));
vi.mock("../../../../src/integrations/binary/intake.js", () => ({
  intakeBinaryDocument: vi.fn(async () => ({ status: "stored" })),
  tombstoneBinaryDocument: vi.fn(async () => 0),
}));

import { db, heads, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint, setExportDirectory } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { jsonBytes, putSourceFile, type SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-life";
const DOC = "doc-life-1";
const DOC_MIME = "application/vnd.google-apps.document";
const DIR = docDirectory(DOC, "Life");

const live = (modifiedTime = "2026-10-01T00:00:00Z") => ({ fileId: DOC, file: { name: "Life", mimeType: DOC_MIME, modifiedTime, trashed: false, parents: [] } });
const trashed = () => ({ fileId: DOC, file: { name: "Life", mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00Z", trashed: true } });
const removed = () => ({ fileId: DOC, removed: true });

async function poll(...changes: unknown[]) {
  pollDriveChangesMock.mockResolvedValueOnce({ changes, newPageToken: "pt-2" });
  await pollGoogleDocs(TENANT);
}

async function eventKeys(): Promise<string[]> {
  return (await query<{ source_event_id: string }>(
    `SELECT source_event_id FROM activity_events WHERE user_id = $1 AND (event_type LIKE 'doc_%ed' AND event_type <> 'doc_edited') ORDER BY created_at`, [TENANT],
  )).map((r) => r.source_event_id);
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  pollDriveChangesMock.mockReset();
  await resetTenant(TENANT);
});

describe("Drive lifecycle: re-trash, restore, removal", () => {
  it("writes one tombstone per dead episode, a restore event per return, and retires exports + mirror", async () => {
    await poll(live());
    // Exported state for the doc: one source file + one donor mirror file.
    await setExportDirectory(TENANT, DOC, DIR, deps);
    await putSourceFile({ tenantId: TENANT, fileId: DOC, path: docPaths(DIR).nativeDocument, kind: "raw", contentType: "application/json", bytes: jsonBytes({ v: 1 }) }, deps);
    await query(`INSERT INTO mirror_files (user_id, path, content) VALUES ($1, $2, 'tab')`, [TENANT, `${DIR}/tabs/tab-x.md`]);

    await poll(trashed());
    expect(await eventKeys()).toEqual([`gdocs:tombstone:${DOC}:trashed`]);
    expect(await heads(TENANT, `${DIR}/`)).toEqual([expect.objectContaining({ path: docPaths(DIR).nativeDocument, op: "delete" })]);
    const reason = await query<{ deleted_reason: string }>(`SELECT deleted_reason FROM gdocs_source_file_versions WHERE tenant_id = $1 AND op = 'delete'`, [TENANT]);
    expect(reason.map((r) => r.deleted_reason)).toEqual(["drive_trashed"]);
    expect(await query(`SELECT path FROM mirror_files WHERE user_id = $1`, [TENANT])).toEqual([]);

    // Redelivery of the same trashed state: no new episode, no new event.
    await poll(trashed());
    expect(await eventKeys()).toEqual([`gdocs:tombstone:${DOC}:trashed`]);

    await poll(live("2026-10-03T00:00:00Z"));
    expect(await eventKeys()).toEqual([`gdocs:tombstone:${DOC}:trashed`, `gdocs:restored:${DOC}:g1`]);
    const restored = await getCheckpoint(TENANT, DOC, deps);
    expect(restored).toMatchObject({ lifecycleState: "active", rematerializePending: true, contentState: "pending" });

    await poll(trashed());
    await poll(removed());
    expect(await eventKeys()).toEqual([
      `gdocs:tombstone:${DOC}:trashed`,
      `gdocs:restored:${DOC}:g1`,
      `gdocs:tombstone:${DOC}:trashed:g2`,
      `gdocs:tombstone:${DOC}:removed:g2`,
    ]);
    const restoreRow = await query<{ raw_payload: Record<string, unknown> }>(
      `SELECT raw_payload FROM activity_events WHERE user_id = $1 AND event_type = 'doc_restored'`, [TENANT]);
    expect(restoreRow[0].raw_payload).toMatchObject({ _restored: true, _restored_from: "trashed", _lifecycle_generation: 1 });
  });

  it("checkpoints Sheets/Slides/binary files for export and leaves PDFs/folders to their own lanes", async () => {
    await poll(
      { fileId: "sheet-1", file: { name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-01T00:00:00Z", headRevisionId: "h1", trashed: false } },
      { fileId: "png-1", file: { name: "a.png", mimeType: "image/png", modifiedTime: "2026-10-01T00:00:00Z", md5Checksum: "m1", trashed: false } },
      { fileId: "pdf-1", file: { name: "a.pdf", mimeType: "application/pdf", modifiedTime: "2026-10-01T00:00:00Z", trashed: false } },
      { fileId: "dir-1", file: { name: "folder", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-01T00:00:00Z", trashed: false } },
    );
    const rows = await query<{ file_id: string; content_state: string; drive_version: string; mailbox: string }>(
      `SELECT file_id, content_state, drive_version, mailbox FROM gdocs_file_checkpoints WHERE tenant_id = $1 ORDER BY file_id`, [TENANT]);
    expect(rows).toEqual([
      { file_id: "png-1", content_state: "pending", drive_version: "m1", mailbox: "ada@corp.example" },
      { file_id: "sheet-1", content_state: "pending", drive_version: "h1", mailbox: "ada@corp.example" },
    ]);
  });

  it("an older (out-of-order) change never rolls the Drive version back", async () => {
    await poll({ fileId: "sheet-2", file: { name: "S", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-05T00:00:00Z", headRevisionId: "h5", trashed: false } });
    await poll({ fileId: "sheet-2", file: { name: "S-old", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-01T00:00:00Z", headRevisionId: "h1", trashed: false } });
    const cp = await getCheckpoint(TENANT, "sheet-2", deps);
    expect(cp).toMatchObject({ driveVersion: "h5", name: "S" });
  });
});
