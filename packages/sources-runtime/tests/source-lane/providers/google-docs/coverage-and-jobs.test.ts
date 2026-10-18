import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
  getGoogleAccessToken: vi.fn(async () => "synthetic-bearer"),
}));

import { db, fakeFetch, json, liveJson, query, ready, resetTenant, xssi } from "./harness.js";
import { googleDocsProvider } from "../../../../src/source-lane/providers/google-docs/index.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { runGdocsContentSnapshot } from "../../../../src/integrations/google/gdocs/jobs.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint, recordDriveFileSeen, setContentState, setHistoryState, transitionLifecycle } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-cov";
const DOC_MIME = "application/vnd.google-apps.document";

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  await resetTenant(TENANT);
  await query(`DELETE FROM integration_tokens WHERE user_id = $1`, [TENANT]);
});

async function seedToken(metadata: Record<string, unknown>) {
  await query(`INSERT INTO integration_tokens (user_id, provider, access_token, metadata) VALUES ($1, 'google', 'enc', $2::jsonb)`, [TENANT, JSON.stringify(metadata)]);
}

/** final-audit M4: Docs coverage is complete only while gdocs.poll keeps succeeding; record one that just did. */
const polledNow = (tenant: string) =>
  query(`INSERT INTO source_sync_runs (user_id, provider, status, coverage_to, metadata, completed_at) VALUES ($1, 'google', 'completed', now(), '{"taskKind":"gdocs.poll"}', now())`, [tenant]);
const coverage = async () => {
  await polledNow(TENANT);
  return googleDocsProvider.coverage!({ tenantId: TENANT, executor: db as never });
};

describe("google-docs provider module", () => {
  it("is registered with the core registry and owns its export table", () => {
    const registry = defaultRegistry();
    expect(registry.get("google-docs")).toBe(googleDocsProvider);
    expect(registry.extraTable("gdocs_source_file_versions")?.provider).toBe(googleDocsProvider);
    expect(registry.forEventSource("gdocs")).toBe(googleDocsProvider);
  });
});

describe("coverage reflects checkpoints, errors and auth mode (never a static complete)", () => {
  it("is pending with nothing tracked and never claims the Drive inventory without a full listing", async () => {
    const reports = await coverage();
    // Coordinator: drive-inventory now comes from the full listing (inventory.ts); with no roster and no
    // listing it is pending, and it is complete only after a gap-free listing (inventory.test.ts).
    expect(reports.find((r) => r.scope === "drive-inventory")!.state).toBe("pending");
    expect(reports.find((r) => r.scope === "docs-content")!.state).toBe("pending");
  });

  it("never claims complete once gdocs.poll stopped succeeding (final-audit M4)", async () => {
    await seedToken({ authMode: "domain_wide_delegation" });
    await recordDriveFileSeen(TENANT, { fileId: "d1", mailbox: "m", mimeType: DOC_MIME, name: "d1", version: "v", modifiedTime: "2026-10-01T00:00:00Z" }, deps);
    await setContentState(TENANT, "d1", { state: "complete", version: "v" }, deps);
    await query(`DELETE FROM source_sync_runs WHERE user_id = $1`, [TENANT]);
    await query(`INSERT INTO source_sync_runs (user_id, provider, status, coverage_to, metadata, completed_at) VALUES ($1, 'google', 'completed', now(), '{"taskKind":"gdocs.poll"}', now() - interval '1 hour')`, [TENANT]);
    const stale = await googleDocsProvider.coverage!({ tenantId: TENANT, executor: db as never });
    expect(stale.find((r) => r.scope === "docs-poll")).toMatchObject({ state: "partial", expectedIntervalSeconds: 300 });
    expect(stale.find((r) => r.scope === "docs-content")).toMatchObject({ state: "partial" });
    expect(stale.find((r) => r.scope === "docs-content")!.reason).toContain("not current");
    const fresh = await coverage();
    expect(fresh.find((r) => r.scope === "docs-content")!.state).toBe("complete");
    expect(fresh.find((r) => r.scope === "docs-poll")!.state).toBe("complete");
  });

  it("surfaces a partial changelog and per-scope counts", async () => {
    await seedToken({ authMode: "domain_wide_delegation" });
    for (const id of ["d1", "d2"]) {
      await recordDriveFileSeen(TENANT, { fileId: id, mailbox: "m", mimeType: DOC_MIME, name: id, version: "v", modifiedTime: "2026-10-01T00:00:00Z" }, deps);
      await setContentState(TENANT, id, { state: "complete", version: "v" }, deps);
    }
    await setHistoryState(TENANT, "d1", { state: "complete", completeEntries: 10 }, deps);
    await setHistoryState(TENANT, "d2", { state: "partial", reason: "load_http_500", fetchedEntries: 1000, retryAt: new Date() }, deps);
    const reports = await coverage();
    expect(reports.find((r) => r.scope === "docs-content")).toMatchObject({ state: "complete", counts: { complete: 2, docs: 2 } });
    const history = reports.find((r) => r.scope === "docs-history")!;
    expect(history.state).toBe("partial");
    expect(history.reason).toContain("load_http_500");
    expect(history.counts).toMatchObject({ complete: 1, partial: 1 });
  });

  it("reports docs history blocked with ot_requires_bearer for a Composio connection", async () => {
    await seedToken({ authMode: "composio_proxy", composioConnectedAccountId: "ca_1" });
    await recordDriveFileSeen(TENANT, { fileId: "d1", mailbox: "m", mimeType: DOC_MIME, name: "d1", version: "v", modifiedTime: null }, deps);
    await setHistoryState(TENANT, "d1", { state: "complete", completeEntries: 1 }, deps);
    const history = (await coverage()).find((r) => r.scope === "docs-history")!;
    expect(history.state).toBe("blocked");
    expect(history.reason).toMatch(/^ot_requires_bearer/);
  });
});

describe("donor content-snapshot task drives the history lane", () => {
  const DOC = "doc-job-1";
  const docBody = { documentId: DOC, title: "Job Doc", revisionId: "rev-1", tabs: [{ tabProperties: { tabId: "t.0", title: "Main" }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "hi\n" } }] } }] } } }] };
  const routes = () => fakeFetch([
    (url) => url.hostname === "docs.googleapis.com" ? json(docBody) : undefined,
    (url) => url.hostname === "www.googleapis.com" ? json({ id: DOC, name: "Job Doc", mimeType: DOC_MIME, permissions: [] }) : undefined,
    (url) => url.pathname.endsWith("/revisions/tiles") ? xssi({ tileInfo: [{ start: 1, end: 1, endMillis: 1, users: ["u"] }], userMap: { u: { name: "U" } } }) : undefined,
    (url) => url.pathname.endsWith("/revisions/load") ? xssi({ changelog: [[{ ty: "is", ibi: 1, s: "hi" }, Date.UTC(2026, 0, 1), "u", 1, "s", 1, null, null, false]], chunkedSnapshot: [[]] }) : undefined,
  ]);

  it("captures content, then the complete changelog, and skips history on a redelivered version", async () => {
    await seedToken({ authMode: "domain_wide_delegation", email: "ada@corp.example" });
    const f = routes();
    vi.stubGlobal("fetch", f.impl);
    try {
      await runGdocsContentSnapshot(TENANT, DOC, { modifiedTime: "2026-10-01T00:00:00Z" });
      const P = docPaths(docDirectory(DOC, "Job Doc"));
      expect(await liveJson(TENANT, P.changelogStatus)).toMatchObject({ state: "complete", totalEntries: 1 });
      const cp = await getCheckpoint(TENANT, DOC, deps);
      expect(cp).toMatchObject({ contentState: "complete", historyState: "complete", historyCompleteEntries: 1 });

      const loadsBefore = f.calls.filter((c) => c.url.includes("/revisions/")).length;
      await runGdocsContentSnapshot(TENANT, DOC, { modifiedTime: "2026-10-01T00:00:00Z" });
      expect(f.calls.filter((c) => c.url.includes("/revisions/")).length).toBe(loadsBefore);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-materializes the donor mirror for a restored doc", async () => {
    await seedToken({ authMode: "domain_wide_delegation", email: "ada@corp.example" });
    const f = routes();
    vi.stubGlobal("fetch", f.impl);
    try {
      await runGdocsContentSnapshot(TENANT, DOC, { modifiedTime: "2026-10-01T00:00:00Z" });
      await transitionLifecycle(TENANT, DOC, "trashed", {}, deps);
      await query(`DELETE FROM mirror_files WHERE user_id = $1`, [TENANT]);
      await transitionLifecycle(TENANT, DOC, "active", {}, deps);
      expect((await getCheckpoint(TENANT, DOC, deps))!.rematerializePending).toBe(true);
      // Same modifiedTime as before: without the restore flag this would be skipped_fresh.
      await runGdocsContentSnapshot(TENANT, DOC, { modifiedTime: "2026-10-01T00:00:00Z" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await query(`SELECT path FROM mirror_files WHERE user_id = $1`, [TENANT])).length).toBeGreaterThan(0);
    expect((await getCheckpoint(TENANT, DOC, deps))!.rematerializePending).toBe(false);
  });
});
