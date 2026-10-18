import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { createInternalApp } from "../../../../src/source-lane/internal/app.js";
import { githubProvider } from "../../../../src/source-lane/providers/github/index.js";
import { registerGithubInternalRoutes, parseSelectionBody } from "../../../../src/source-lane/providers/github/routes.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { FakeGithub } from "./fake-github.js";
import { client, CONN, drain, MAIN, makeExporter, REPO, REPO_ID, sweepUntilQuiet, T } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

const SERVICE = "service-token-for-tests";
let fake: FakeGithub;
let app: ReturnType<typeof createInternalApp>;

function principal(tenantNs: string, scopes: string[]): string {
  return JSON.stringify({ tenantNs, subject: "user_1", issuer: "https://auth.example.test", scopes });
}

async function call(method: string, path: string, opts: { tenant?: string; scopes?: string[]; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${SERVICE}`,
      "x-procmem-principal": principal(opts.tenant ?? T, opts.scopes ?? ["memory:read", "memory:build"]),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeGithub();
  fake.repo(REPO_ID, REPO);
  for (let i = 1; i <= 150; i++) fake.repo(100 + i, `acme/extra-${String(i).padStart(3, "0")}`);
  fake.repo(555, "other/private", { connections: ["conn-other"] });
  await connect(T, CONN);
  const module = { ...githubProvider, internalRoutes: (a: never, deps: never) => registerGithubInternalRoutes(a, deps, { db: async () => db as never, client: () => client(fake) }) };
  const registry = new SourceProviderRegistry([module]);
  app = createInternalApp({ db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }), serviceTokenSha256: createHash("sha256").update(SERVICE).digest("hex") });
});

describe("github selection routes", () => {
  it("lists every installation repository across pages, with selection and content state", async () => {
    const r = await call("GET", `/tenants/${T}/github/repositories`);
    expect(r.status).toBe(200);
    expect(r.json.connections).toEqual([expect.objectContaining({ connectionId: CONN, installationRepositories: 151 })]);
    expect(r.json.repositories).toHaveLength(151);
    expect(r.json.repositories.at(-1)).toMatchObject({ fullName: REPO, syncing: false, content: null });
    expect(fake.log.filter((l) => l.startsWith("/installation/repositories"))).toEqual(["/installation/repositories?per_page=100&page=1", "/installation/repositories?per_page=100&page=2"]);
    await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: REPO, syncing: true } });
    const after = await call("GET", `/tenants/${T}/github/repositories`);
    expect(after.json.repositories.at(-1)).toMatchObject({ fullName: REPO, syncing: true, content: { repoId: String(REPO_ID), status: "active", defaultBranch: "main" } });
  });

  it("enables only repositories this tenant's own grant can read; never accepts a tenant in the body", async () => {
    expect((await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: "other/private", syncing: true } })).status).toBe(404);
    expect((await query(`SELECT count(*)::int AS n FROM github_repo_sync`))[0]!.n).toBe(0);
    const bad = await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: REPO, syncing: true, tenantId: "victim" } });
    expect(bad).toMatchObject({ status: 400, json: { error: { code: "invalid_body" } } });
    expect(parseSelectionBody({ repo: REPO, syncing: true, refs: ["../x"] })).toContain("refs");
    expect(parseSelectionBody({ repo: REPO, syncing: true, purge: true })).toContain("purge");
    const ok = await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: "ACME/Widgets", syncing: true, refs: ["release/1.x"] } });
    expect(ok.status).toBe(200);
    expect(await query(`SELECT tenant_id, repo_full_name, syncing FROM github_repo_sync`)).toEqual([{ tenant_id: T, repo_full_name: REPO, syncing: true }]);
    const row = (await query(`SELECT repo_id, connection_id, extra_refs FROM github_source_repos`))[0]!;
    expect(row).toEqual({ repo_id: String(REPO_ID), connection_id: CONN, extra_refs: ["release/1.x"] });
  });

  it("refuses a principal of another tenant, a missing scope and a missing service token", async () => {
    expect((await call("GET", `/tenants/${T}/github/repositories`, { tenant: "someone-else" })).status).toBe(403);
    expect((await call("PUT", `/tenants/${T}/github/repositories/selection`, { scopes: ["memory:read"], body: { repo: REPO, syncing: true } })).status).toBe(403);
    expect((await call("GET", `/tenants/${T}/github/repositories`, { scopes: [] })).status).toBe(403);
    const res = await app.request(`/tenants/${T}/github/repositories`, { headers: { "x-procmem-principal": principal(T, ["memory:read"]) } });
    expect(res.status).toBe(401);
  });

  it("disable keeps history (scope-out); purge removes the content lane and the donor rows for that repository only", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    fake.commit(101, "main", { "b.txt": "b" });
    await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: REPO, syncing: true } });
    await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: "acme/extra-001", syncing: true } });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/a.txt`)).toBe("a");

    await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: REPO, syncing: false } });
    await drain(exporter);
    expect(await yc.tombstone(`${MAIN}/files/a.txt`)).toMatchObject({ reason: "github_repo_out_of_scope" });
    expect((await query(`SELECT count(*)::int AS n FROM github_source_snapshots WHERE repo_id = $1`, [String(REPO_ID)]))[0]!.n).toBe(1);

    await query(`INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id) VALUES ($1, 'github', 'issue', now(), $2::jsonb, $3)`, [T, JSON.stringify({ repository_url: `https://api.github.com/repos/${REPO}` }), `github:issue:${REPO}:1:x`]);
    const purged = await call("PUT", `/tenants/${T}/github/repositories/selection`, { body: { repo: REPO, syncing: false, purge: true } });
    expect(purged.status).toBe(200);
    expect((await query(`SELECT count(*)::int AS n FROM github_source_files WHERE repo_id = $1`, [String(REPO_ID)]))[0]!.n).toBe(0);
    expect((await query(`SELECT count(*)::int AS n FROM github_source_snapshots WHERE repo_id = $1`, [String(REPO_ID)]))[0]!.n).toBe(0);
    expect((await query(`SELECT count(*)::int AS n FROM activity_events WHERE user_id = $1`, [T]))[0]!.n).toBe(0);
    // The other repository and its bytes are untouched.
    expect((await query(`SELECT count(*)::int AS n FROM github_source_files WHERE repo_id = '101'`))[0]!.n).toBe(1);
    expect((await query(`SELECT count(*)::int AS n FROM github_source_blobs`))[0]!.n).toBe(1);
    await drain(exporter);
    expect(await yc.text(`sources/github/acme/extra-001/code/main/files/b.txt`)).toBe("b");
    expect(await yc.file(`${MAIN}/_snapshots/g00000001.json`)).toBeNull();
  });
});
