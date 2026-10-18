import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pollDriveChangesMock = vi.hoisted(() => vi.fn());
const tombstoneBinaryDocument = vi.hoisted(() => vi.fn(async () => 1));

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
const roster = vi.hoisted(() => ({ mailboxes: [] as string[] }));
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
vi.mock("../../../../src/queue/dispatch.js", () => ({ enqueueCollectedEventForProcessing: vi.fn(async () => {}), startGooglePolling: vi.fn(async () => {}) }));
vi.mock("../../../../src/polling/_archived-gdocs/gdocs-edits.js", () => ({ processEditActivity: vi.fn(async () => 0) }));
vi.mock("../../../../src/polling/_archived-gdocs/document-summary-tracker.js", () => ({ markGoogleDocSummaryDirty: vi.fn(async () => {}) }));
// Byte intake is the binary agent's (S3); here it records the donor row the real intake would upsert.
vi.mock("../../../../src/integrations/binary/intake.js", async () => {
  const h = await import("./harness.js");
  return {
    intakeBinaryDocument: vi.fn(async (input: { tenantId: string; provider: string; externalId: string; mimeType: string }) => {
      await h.query(
        `INSERT INTO binary_documents (tenant_id, provider, external_id, mime_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, provider, external_id) DO NOTHING`,
        [input.tenantId, input.provider, input.externalId, input.mimeType],
      );
      return { status: "stored" };
    }),
    tombstoneBinaryDocument,
  };
});

import { createHash } from "node:crypto";
import { db, query, ready, resetTenant } from "./harness.js";
import { pollGoogleDocs } from "../../../../src/polling/_archived-gdocs/gdocs.js";
import { setExportDirectory } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { docDirectory, driveFileDirectory } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { googleAttributionFor } from "../../../../src/source-lane/providers/google-auth/attribution.js";
import { googleAuthProvider } from "../../../../src/source-lane/providers/google-auth/index.js";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

/**
 * Owner-only reads of Google data whose path names no mailbox (Docs/Drive dirs, Drive PDFs) without the
 * "owns every Google account" rule: each unit belongs to the owners of the roster mailboxes that see it in Drive,
 * as recorded per mailbox by the real changes-feed poller. Two members each read their own files; a mailbox nobody
 * proved (legacy / DWD-only) keeps its files sealed; history needs that mailbox's canReadRevisions.
 */
const deps = { db: db as unknown as SqlDatabase };
const T = "tenant-attr";
const ISS = "https://auth.example.test";
const ADA = "ada@corp.example";
const BO = "bo@corp.example";
const LEGACY = "legacy@corp.example";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const PDF_MIME = "application/pdf";

const file = (id: string, mimeType: string, canReadRevisions?: boolean) => ({
  fileId: id,
  file: { name: `File ${id}`, mimeType, modifiedTime: "2026-10-01T00:00:00Z", trashed: false, parents: [], ...(canReadRevisions === undefined ? {} : { capabilities: { canReadRevisions } }) },
});

async function poll(perMailbox: Record<string, unknown[]>) {
  for (const m of roster.mailboxes) pollDriveChangesMock.mockResolvedValueOnce({ changes: perMailbox[m] ?? [], newPageToken: "pt-2" });
  await pollGoogleDocs(T);
}

async function owner(mailbox: string, subject: string) {
  await query(`INSERT INTO google_account_owner_proofs (tenant_id, account_email, google_sub, proven_by_subject, proven_by_issuer) VALUES ($1, $2, $3, $4, $5)`, [T, mailbox, `g-${subject}`, subject, ISS]);
}

const who = (subject: string) => ({ subject, issuer: ISS });
const paths = (a: { units: Array<{ path: string; revisions: boolean }> }) => a.units.map((u) => `${u.path}${u.revisions ? "" : " (no revisions)"}`).sort();

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  pollDriveChangesMock.mockReset();
  tombstoneBinaryDocument.mockClear();
  roster.mailboxes = [ADA, BO, LEGACY];
  await resetTenant(T);
  for (const t of ["google_account_owner_proofs", "google_oauth_grants", "connections"]) await query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
  await query(`DELETE FROM binary_documents WHERE tenant_id = $1`, [T]);
  for (const m of roster.mailboxes) await query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ($1, 'google', $2, 'active')`, [T, m]);
});

describe("Google-wide units are attributed per mailbox from the runtime's own visibility rows", () => {
  it("two members each read their own Docs/Drive/PDF units; shared files go to both; legacy and unproven stay sealed", async () => {
    await poll({
      [ADA]: [file("doc-a", DOC_MIME, true), file("shared", DOC_MIME, false), file("pdf-a", PDF_MIME, true)],
      [BO]: [file("doc-b", DOC_MIME, true), file("shared", DOC_MIME, true), file("sheet-b", SHEET_MIME, true)],
      [LEGACY]: [file("doc-l", DOC_MIME, true), file("pdf-l", PDF_MIME, true)],
    });
    for (const id of ["doc-a", "shared", "doc-b", "doc-l"]) await setExportDirectory(T, id, docDirectory(id, `File ${id}`), deps);
    await setExportDirectory(T, "sheet-b", driveFileDirectory("sheets", "sheet-b", "File sheet-b"), deps);
    await owner(ADA, "user_ada");
    await owner(BO, "user_bo");

    const dir = (id: string) => docDirectory(id, `File ${id}`).replace(/^sources\//, "");
    const ada = await googleAttributionFor(T, who("user_ada"), db as never);
    expect(ada.accounts).toEqual([ADA]);
    expect(paths(ada)).toEqual([
      "binary/drive-pdf/pdf-a",
      dir("doc-a"),
      `${dir("shared")} (no revisions)`,
      "google-docs/_raw/document:doc-a",
      "google-docs/_raw/document:shared (no revisions)",
    ].sort());

    const bo = await googleAttributionFor(T, who("user_bo"), db as never);
    expect(paths(bo)).toEqual([
      dir("doc-b"),
      dir("shared"),
      driveFileDirectory("sheets", "sheet-b", "File sheet-b").replace(/^sources\//, ""),
      "google-docs/_raw/document:doc-b",
      "google-docs/_raw/document:sheet-b",
      "google-docs/_raw/document:shared",
    ].sort());

    // Nobody proved legacy@ (DWD-only): its files belong to no one; a member with no Google account owns nothing.
    for (const a of [ada, bo]) expect(JSON.stringify(a)).not.toMatch(/doc-l|pdf-l/);
    expect(await googleAttributionFor(T, who("user_carol"), db as never)).toEqual({ schema: "procmem.google-attribution/v1", accounts: [], units: [], truncated: false });
    // Same subject, other issuer: not the owner.
    expect((await googleAttributionFor(T, { subject: "user_ada", issuer: "https://evil.example" }, db as never)).units).toEqual([]);
  });

  it("follows Drive: a mailbox that loses access loses the unit; a capability seen later is kept (not reset by a poll that omits it)", async () => {
    roster.mailboxes = [ADA, BO];
    await poll({ [ADA]: [file("doc-a", DOC_MIME, true)], [BO]: [file("doc-a", DOC_MIME, false)] });
    await setExportDirectory(T, "doc-a", docDirectory("doc-a", "File doc-a"), deps);
    await owner(ADA, "user_ada");
    await owner(BO, "user_bo");
    expect((await googleAttributionFor(T, who("user_bo"), db as never)).units.map((u) => u.revisions)).toEqual([false, false]);

    await poll({ [ADA]: [file("doc-a", DOC_MIME)], [BO]: [] });
    expect((await googleAttributionFor(T, who("user_ada"), db as never)).units.every((u) => u.revisions)).toBe(true);

    await poll({ [ADA]: [{ fileId: "doc-a", removed: true }], [BO]: [] });
    expect((await googleAttributionFor(T, who("user_ada"), db as never)).units).toEqual([]);
    expect((await googleAttributionFor(T, who("user_bo"), db as never)).units).toHaveLength(2);
  });

  it("a Drive PDF that one mailbox lost stays live while another still sees it (was: tombstoned tenant-wide)", async () => {
    roster.mailboxes = [ADA, BO];
    await poll({ [ADA]: [file("pdf-s", PDF_MIME, true)], [BO]: [file("pdf-s", PDF_MIME, true)] });
    await poll({ [ADA]: [{ fileId: "pdf-s", removed: true }], [BO]: [] });
    expect(tombstoneBinaryDocument).not.toHaveBeenCalled();
    expect(await query(`SELECT mailbox, visible FROM gdocs_file_visibility WHERE tenant_id = $1 AND file_id = 'pdf-s' ORDER BY mailbox`, [T]))
      .toEqual([{ mailbox: ADA, visible: false }, { mailbox: BO, visible: true }]);
    await poll({ [ADA]: [], [BO]: [{ fileId: "pdf-s", removed: true }] });
    expect(tombstoneBinaryDocument).toHaveBeenCalledTimes(1);
    // Trash is a file property: tenant-wide at once.
    await poll({ [ADA]: [{ fileId: "pdf-t", file: { ...file("pdf-t", PDF_MIME).file, trashed: true } }], [BO]: [] });
    expect(tombstoneBinaryDocument).toHaveBeenCalledTimes(2);
  });

  it("is served only for the forwarded verified principal over the service-token internal API", async () => {
    roster.mailboxes = [ADA];
    await poll({ [ADA]: [file("doc-a", DOC_MIME, true)] });
    await setExportDirectory(T, "doc-a", docDirectory("doc-a", "File doc-a"), deps);
    await owner(ADA, "user_ada");
    const token = "synthetic-service-token-0123456789abcdef0123456789";
    const app = createRuntimeApp({
      db: db as never, exporter: {} as never, registry: new SourceProviderRegistry([googleAuthProvider]),
      serviceTokenSha256: createHash("sha256").update(token).digest("hex"), integrations: [], mountInternal: true,
    });
    const get = (p: Record<string, unknown> | null, auth = `Bearer ${token}`, q = "") =>
      app.request(`/internal/v1/tenants/${T}/google/auth/attribution${q}`, { headers: { authorization: auth, ...(p ? { "x-procmem-principal": JSON.stringify(p) } : {}) } });
    const ada = { tenantNs: T, subject: "user_ada", issuer: ISS, scopes: ["memory:read"] };
    const ok = await get(ada);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as { units: unknown[] }).units).toHaveLength(2);
    // A query naming someone else is ignored: only the forwarded principal counts.
    const carol = await get({ ...ada, subject: "user_carol" }, undefined, "?subject=user_ada&account=ada%40corp.example");
    expect(((await carol.json()) as { units: unknown[] }).units).toEqual([]);
    expect((await get(ada, "Bearer wrong")).status).toBe(401);
    expect((await get({ ...ada, tenantNs: "tenant-other" })).status).toBe(403);
    expect((await get({ ...ada, scopes: [] })).status).toBe(403);
    // Revalidation: an unchanged answer is a body-less 304 for the same principal; another principal's ETag is not.
    const etag = ok.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await app.request(`/internal/v1/tenants/${T}/google/auth/attribution`, { headers: { authorization: `Bearer ${token}`, "x-procmem-principal": JSON.stringify(ada), "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const other = await app.request(`/internal/v1/tenants/${T}/google/auth/attribution`, { headers: { authorization: `Bearer ${token}`, "x-procmem-principal": JSON.stringify({ ...ada, subject: "user_carol" }), "if-none-match": etag } });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { units: unknown[] }).units).toEqual([]);
  });
});
