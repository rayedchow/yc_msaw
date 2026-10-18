import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processBitbucketRepositoryRecord } from "../../../../src/integrations/bitbucket/processors.js";
import { MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { createInternalApp } from "../../../../src/source-lane/internal/app.js";
import { BitbucketApiError, nextPage, srcEndpoint } from "../../../../src/source-lane/providers/bitbucket/api.js";
import { BITBUCKET_CONTENT_TASK, bitbucketContentTaskHandlers } from "../../../../src/source-lane/providers/bitbucket/content.js";
import { bitbucketProvider, mapBitbucketMirror } from "../../../../src/source-lane/providers/bitbucket/index.js";
import { contentFilePath, repoSourceDirectory } from "../../../../src/source-lane/providers/bitbucket/paths.js";
import { parseSelectionBody, registerBitbucketInternalRoutes } from "../../../../src/source-lane/providers/bitbucket/routes.js";
import { SOURCE_PROVIDERS } from "../../../../src/source-lane/providers/index.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { FakeBitbucket, fakeUuid } from "./fake-bitbucket.js";
import { clientFor } from "./fixtures.js";
import { connect, db, pg, query, ready, resetAll } from "./harness.js";

const SERVICE = "s".repeat(48);

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
});

describe("bitbucket source module", () => {
  it("is registered with its extra tables, task handler and journal triggers", async () => {
    const registry = new SourceProviderRegistry(SOURCE_PROVIDERS);
    const m = registry.get("bitbucket")!;
    expect(m).toBe(bitbucketProvider);
    expect(registry.forEventSource("bitbucket")).toBe(bitbucketProvider);
    for (const t of ["bitbucket_source_repos", "bitbucket_source_refs", "bitbucket_source_files", "bitbucket_source_snapshots"]) {
      expect(registry.extraTable(t)?.provider).toBe(bitbucketProvider);
    }
    expect(Object.keys(m.taskHandlers!())).toEqual([BITBUCKET_CONTENT_TASK]);
    const triggers = (await query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_source_lane_journal_bitbucket_%' ORDER BY 1`)).map((r) => r.tgname);
    expect(triggers).toEqual(["trg_source_lane_journal_bitbucket_files", "trg_source_lane_journal_bitbucket_refs", "trg_source_lane_journal_bitbucket_repos", "trg_source_lane_journal_bitbucket_snapshots"]);
  });

  it("sweep bookkeeping does not journal, content changes do", async () => {
    await pg.query(`INSERT INTO bitbucket_source_refs (tenant_id, row_key, repo_uuid, ref_name) VALUES ('t', 'k', '{x}', 'main')`);
    await pg.query(`DELETE FROM source_lane_journal`);
    await pg.query(`UPDATE bitbucket_source_refs SET observed_head_sha = 'abc', last_success_at = now(), scan_cursor = 'x', scan_pages = 3 WHERE row_key = 'k'`);
    expect(await query(`SELECT * FROM source_lane_journal`)).toEqual([]);
    await pg.query(`UPDATE bitbucket_source_refs SET committed_generation = 1 WHERE row_key = 'k'`);
    expect((await query(`SELECT table_name, row_key FROM source_lane_journal`))[0]).toMatchObject({ table_name: "bitbucket_source_refs", row_key: "k" });
  });

  it("schedules the content sweep for tenants already connected when the lane is installed (9351)", async () => {
    await connect("t-a", "c-a");
    await connect("t-b", "c-b", "bitbucket", "revoked");
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, "9351_bitbucket_content_schedules.sql"), "utf8"));
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, "9351_bitbucket_content_schedules.sql"), "utf8"));
    const rows = await query(`SELECT tenant_id, queue, group_key, kind, payload, frequency_seconds FROM task_schedules WHERE kind = 'bitbucket.content_sweep'`);
    expect(rows).toEqual([{ tenant_id: "t-a", queue: "sync", group_key: "t-a:bitbucket:content", kind: "bitbucket.content_sweep", payload: { tenantId: "t-a" }, frequency_seconds: 300 }]);
  });

  it("the task takes its tenant from the task row and refuses a mismatching payload", async () => {
    const handler = bitbucketContentTaskHandlers()[BITBUCKET_CONTENT_TASK]!;
    await expect(handler({ tenantId: "other" }, { task: { tenantId: "t-a" }, heartbeat: async () => {} } as never)).rejects.toThrow(/does not match/);
    // No connection: a no-op report for the task's own tenant.
    await expect(handler({}, { task: { tenantId: "t-a" }, heartbeat: async () => {} } as never)).resolves.toMatchObject({ tenantId: "t-a", connections: 0 });
  });

  it("uses the donor's repository directory exactly (pinned against the donor materializer)", async () => {
    const ctx = { tenantId: "t-a", providerConfigKey: "bitbucket", connectionId: "c-a" };
    for (const fullName of ["team/api", "Team Space/My Repo!", "ws/repo.with.dots"]) {
      await processBitbucketRepositoryRecord(db as never, { uuid: fakeUuid(), full_name: fullName, updated_on: "2026-07-01T00:00:00.000Z" }, ctx);
      const path = (await query<{ path: string }>(`SELECT path FROM mirror_files WHERE user_id = 't-a' AND content LIKE $1`, [`%Repository: ${fullName}%`]))[0]!.path;
      expect(path).toBe(`${repoSourceDirectory(fullName)}/repo.md`);
    }
    expect(mapBitbucketMirror("sources/bitbucket/unknown-repo/pr-7.md")).toEqual([]);
    expect(mapBitbucketMirror("sources/bitbucket/team/api/pr-7.md")).toBeNull();
  });

  it("maps every repository path injectively under files/ and refuses unsafe upstream URLs", () => {
    expect(contentFilePath("team/api", "main", "src/a b/%x.ts")).toBe("sources/bitbucket/team/api/code/main/files/src/a b/%25x.ts");
    expect(contentFilePath("team/api", "feature/x", "a.md")).toBe("sources/bitbucket/team/api/code/feature%2Fx/files/a.md");
    expect(contentFilePath("team/api", "main", "..")).toMatch(/files\/%2E%2E$/u);
    expect(contentFilePath("team/api", "main", `${"d/".repeat(70)}f`)).toMatch(/\/_overflow\/[0-9a-f]{40}$/u);
    const ep = srcEndpoint("team/api", "a".repeat(40), "docs", true);
    expect(ep).toBe(`/repositories/team/api/src/${"a".repeat(40)}/docs/`);
    expect(nextPage(`https://api.bitbucket.org/2.0${ep}?page=2`, ep)).toEqual({ endpoint: ep, params: { page: "2" } });
    expect(() => nextPage(`https://evil.example/2.0${ep}?page=2`, ep)).toThrow(BitbucketApiError);
    expect(() => nextPage(`http://api.bitbucket.org/2.0${ep}?page=2`, ep)).toThrow(BitbucketApiError);
    expect(() => nextPage(`https://api.bitbucket.org/2.0/repositories/other/repo/src/${"a".repeat(40)}/docs/?page=2`, ep)).toThrow(BitbucketApiError);
    expect(() => srcEndpoint("team/api", "main", "", true)).toThrow(BitbucketApiError);
  });
});

describe("bitbucket repository selection routes", () => {
  function app(fake: FakeBitbucket) {
    const module = { ...bitbucketProvider, internalRoutes: (a: never, deps: never) => registerBitbucketInternalRoutes(a, deps, { db: async () => db as never, client: () => clientFor(fake) }) };
    const registry = new SourceProviderRegistry([module]);
    return createInternalApp({ db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }), serviceTokenSha256: createHash("sha256").update(SERVICE).digest("hex") });
  }

  function call(a: ReturnType<typeof app>, method: string, tenant: string, path: string, body?: unknown, scopes = ["memory:read", "memory:build"], principalTenant = tenant) {
    return a.request(`/tenants/${tenant}/bitbucket/repositories${path}`, {
      method,
      headers: {
        authorization: `Bearer ${SERVICE}`,
        "x-procmem-principal": JSON.stringify({ tenantNs: principalTenant, subject: "user-1", issuer: "https://issuer.test", scopes }),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("enables only repositories this tenant's own grant can read; the tenant comes from the verified principal", async () => {
    const fake = new FakeBitbucket();
    fake.accounts.set("c-a", fakeUuid());
    fake.accounts.set("c-b", fakeUuid());
    const mine = fake.addRepo("team/api", { readers: ["c-a"] });
    fake.addRepo("other/secret", { readers: ["c-b"] });
    await connect("t-a", "c-a");
    await connect("t-b", "c-b");
    const a = app(fake);

    expect((await call(a, "PUT", "t-a", "/selection", { repo: "other/secret", syncing: true })).status).toBe(404);
    expect((await call(a, "PUT", "t-a", "/selection", { repo: "team/api", syncing: true, tenantId: "t-b" })).status).toBe(400);
    expect((await call(a, "PUT", "t-a", "/selection", { repo: "team/api", syncing: true }, ["memory:read"])).status).toBe(403);
    expect((await call(a, "GET", "t-a", "", undefined, ["memory:read"], "t-b")).status).toBe(403); // principal of another tenant

    const ok = await call(a, "PUT", "t-a", "/selection", { repo: "team/api", syncing: true, refs: ["release/1.x"] });
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as any;
    expect(view.repositories).toEqual([expect.objectContaining({ repo: "team/api", syncing: true, extraRefs: ["release/1.x"], content: expect.objectContaining({ repoUuid: mine.uuid, status: "active" }) })]);
    expect(new Set(fake.requests.map((r) => r.connectionId))).toEqual(new Set(["c-a"]));
    expect((await query(`SELECT tenant_id FROM bitbucket_source_selection`)).map((r) => r.tenant_id)).toEqual(["t-a"]);

    const off = await call(a, "PUT", "t-a", "/selection", { repo: "team/api", syncing: false, purge: true });
    expect(off.status).toBe(200);
    expect(await query(`SELECT * FROM bitbucket_source_repos`)).toEqual([]);
  });

  it("parses selection bodies strictly", () => {
    expect(parseSelectionBody({ repo: "team/api", syncing: true })).toEqual({ repo: "team/api", syncing: true, purge: false });
    expect(parseSelectionBody({ repo: "team", syncing: true })).toMatch(/workspace\/repository/);
    expect(parseSelectionBody({ repo: "team/api", syncing: true, refs: ["../x"] })).toMatch(/branch names/);
    expect(parseSelectionBody({ repo: "team/api", syncing: true, purge: true })).toMatch(/purge/);
    expect(parseSelectionBody({ repo: "team/api", syncing: false, tenant: "x" })).toMatch(/unknown field/);
  });
});
