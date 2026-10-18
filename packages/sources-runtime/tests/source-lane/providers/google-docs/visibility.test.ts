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
const roster = vi.hoisted(() => ({ mailboxes: ["ada@corp.example", "bo@corp.example"] }));
vi.mock("../../../../src/integrations/google/mailboxes.js", () => ({
  listGoogleMailboxes: vi.fn(async () => roster.mailboxes),
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

import { db, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * Coordinator: lifecycle per mailbox. A `removed` change from one mailbox's changes feed (access lost there)
 * must not tombstone a file another mailbox of the same tenant still sees; it is retired only when the last
 * mailbox loses it. `trashed` stays tenant-wide.
 */
const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-vis";
const DOC = "doc-vis-1";
const DOC_MIME = "application/vnd.google-apps.document";
const ADA = "ada@corp.example";
const BO = "bo@corp.example";
const live = () => ({ fileId: DOC, file: { name: "Vis", mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00Z", trashed: false, parents: [] } });
const removed = () => ({ fileId: DOC, removed: true });

/** One poll; `perMailbox` gives each roster mailbox's changes page (in roster order). */
async function poll(perMailbox: Record<string, unknown[]>) {
  for (const m of roster.mailboxes) pollDriveChangesMock.mockResolvedValueOnce({ changes: perMailbox[m] ?? [], newPageToken: "pt-2" });
  await pollGoogleDocs(TENANT);
}

async function tombstones(): Promise<string[]> {
  return (await query<{ source_event_id: string }>(
    `SELECT source_event_id FROM activity_events WHERE user_id = $1 AND event_type IN ('doc_removed', 'doc_trashed') ORDER BY created_at`, [TENANT],
  )).map((r) => r.source_event_id);
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  pollDriveChangesMock.mockReset();
  roster.mailboxes = [ADA, BO];
  await resetTenant(TENANT);
});

describe("Drive lifecycle is tracked per mailbox", () => {
  it("keeps a file live (re-pointed) when one mailbox loses access and retires it when the last one does", async () => {
    await poll({ [ADA]: [live()], [BO]: [live()] });
    expect((await getCheckpoint(TENANT, DOC, deps))?.lifecycleState).toBe("active");

    await poll({ [ADA]: [removed()] });
    expect(await tombstones()).toEqual([]);
    expect(await getCheckpoint(TENANT, DOC, deps)).toMatchObject({ lifecycleState: "active", mailbox: BO });
    expect(await query(`SELECT mailbox, visible FROM gdocs_file_visibility WHERE tenant_id = $1 ORDER BY mailbox`, [TENANT]))
      .toEqual([{ mailbox: ADA, visible: false }, { mailbox: BO, visible: true }]);

    await poll({ [BO]: [removed()] });
    expect(await tombstones()).toEqual([`gdocs:tombstone:${DOC}:removed`]);
    expect((await getCheckpoint(TENANT, DOC, deps))?.lifecycleState).toBe("removed");
  });

  it("a trash is tenant-wide even while another mailbox still sees the file", async () => {
    await poll({ [ADA]: [live()], [BO]: [live()] });
    await poll({ [ADA]: [{ fileId: DOC, file: { ...live().file, trashed: true } }] });
    expect(await tombstones()).toEqual([`gdocs:tombstone:${DOC}:trashed`]);
    expect((await getCheckpoint(TENANT, DOC, deps))?.lifecycleState).toBe("trashed");
  });
});
