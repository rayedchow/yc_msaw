import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryObjectStore, type ObjectStore, type StoredObject } from "../src/store/objects.js";
import {
  childAudience,
  childAuthEnv,
  createCustomerIntegrationTools,
  createHostTestSandbox,
  createIntegrationCatalog,
  createIntegrationRuntime,
  evaluateExpect,
  exportChildSigningJwk,
  generateChildAuthKeys,
  IntegrationStore,
  loadChildAuthFromEnv,
  ManufactApi,
  ManufactPublisher,
  mintChildToken,
  parsePorcelainV2,
  RepoWorkspace,
  verifyChildToken,
  type IntegrationSandbox,
  type ProbeClient,
} from "../src/integrations/index.js";
import { normalizeRepoPath } from "../src/integrations/paths.js";
import { integrationCatalogFingerprint, isListed, restoreIntegration, retireIntegration } from "../src/integrations/index.js";
import { CachedObjectStore } from "../src/store/objects.js";
import { CHILD_ALLOWED_DEPENDENCIES, integrationImageCommands } from "../src/integrations/sandbox.js";
import { childTemplateFiles } from "../src/integrations/template.js";
import { validateWorkspace } from "../src/integrations/validate.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "integ-unit-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const vars = { slug: "demo-int", title: "Demo", description: "Demo integration", upstreamName: "Demo API" };

describe("paths", () => {
  it("normalizes safe repo paths and rejects traversal / host-owned trees", () => {
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath(".gitignore")).toBe(".gitignore");
    expect(normalizeRepoPath("", { allowRoot: true })).toBe("");
    for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", ".git/config", "src/.git", "node_modules/x", ".mcp-use/build/index.js", ".gitmodules", "a b", "$(x)"]) {
      expect(() => normalizeRepoPath(bad), bad).toThrow();
    }
  });
});

describe("porcelain v2", () => {
  it("parses branch, changes, renames and untracked entries", () => {
    const raw = ["# branch.oid 0123456789012345678901234567890123456789", "# branch.head codex/build-x", "1 .M N... 100644 100644 100644 aaa bbb src/a.ts", "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts", "src/old.ts", "? notes.md", ""].join("\0");
    const s = parsePorcelainV2(raw);
    expect(s.branch).toBe("codex/build-x");
    expect(s.clean).toBe(false);
    expect(s.entries).toEqual([
      { kind: "changed", xy: ".M", path: "src/a.ts" },
      { kind: "renamed", xy: "R.", path: "src/new.ts", origPath: "src/old.ts" },
      { kind: "untracked", xy: "??", path: "notes.md" },
    ]);
  });
});

describe("image + dependencies", () => {
  it("pins the pre-baked set and keeps the harness client out of child deps", () => {
    expect(CHILD_ALLOWED_DEPENDENCIES["mcp-use"]).toBe("2.10.0");
    expect(CHILD_ALLOWED_DEPENDENCIES["@modelcontextprotocol/client"]).toBeUndefined();
    const cmds = integrationImageCommands().join("\n");
    expect(cmds).toContain("chmod 0750 /srv/integ/harness");
    expect(cmds).toContain("core.hooksPath /dev/null");
  });
});

/** ObjectStore wrapper that fails the next put touching a matching key (one shot), like a crash/network error. */
function failingPutStore(inner: ObjectStore, match: RegExp): ObjectStore & { armed: boolean } {
  const w = {
    kind: "fault-injecting",
    armed: true,
    put: async (ns: string, objects: StoredObject[]) => {
      if (w.armed && objects.some((o) => match.test(o.key))) {
        w.armed = false;
        throw new Error("injected put failure");
      }
      return inner.put(ns, objects);
    },
    get: (ns: string, keys: string[]) => inner.get(ns, keys),
    list: (ns: string, prefix: string, opts?: { after?: string; limit?: number }) => inner.list(ns, prefix, opts),
    getRef: (ns: string, name: string) => inner.getRef(ns, name),
    casRef: (ns: string, name: string, v: number | null, value: unknown) => inner.casRef(ns, name, v, value),
  };
  return w;
}

describe("IntegrationStore create recovery", () => {
  const base = { slug: "demo-int", title: "Demo", description: "d", createdAt: "2026-10-17T00:00:00.000Z", createdByBuild: "b-1" };

  it("a failed marker put is surfaced, and the retry repairs discovery with the legacy marker bytes", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const faulty = failingPutStore(objects, /\/created\.json$/);
    const s = new IntegrationStore(faulty, "tenant-a");
    await expect(s.create(base)).rejects.toThrow(/injected put failure/);
    expect(await s.get("demo-int")).not.toBeNull(); // ref won the CAS
    expect(await s.list()).toEqual([]); // ...but is not discoverable yet
    // A later process retries with a different timestamp: it must not overwrite the winner,
    // and it must repair the marker from the WINNING record.
    const retry = await new IntegrationStore(objects, "tenant-a").create({ ...base, createdAt: "2026-10-18T00:00:00.000Z", createdByBuild: "b-2" });
    expect(retry.created).toBe(false);
    expect(retry.record.createdAt).toBe(base.createdAt);
    expect(await s.list()).toEqual(["demo-int"]);
    const marker = (await objects.get("tenant-a", ["integrations/demo-int/created.json"])).get("integrations/demo-int/created.json")!;
    expect(JSON.parse(marker.toString())).toEqual({ createdAt: base.createdAt, createdByBuild: "b-1", slug: "demo-int" });
  });

  it("concurrent creates produce one winner, identical markers, and one listed slug", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => new IntegrationStore(objects, "tenant-a").create({ ...base, createdAt: `2026-10-17T00:00:0${i}.000Z`, createdByBuild: `b-${i}` })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)!.record;
    for (const r of results) expect(r.record.createdAt).toBe(winner.createdAt);
    expect(await new IntegrationStore(objects, "tenant-a").list()).toEqual(["demo-int"]);
  });

  it("runtime integration_open repairs a crashed create (retry with the same create, or plain open)", async () => {
    const objects = new DirectoryObjectStore(tmp);
    await expect(new IntegrationStore(failingPutStore(objects, /\/created\.json$/), "tenant-a").create({ ...base, title: "Demo", description: "Demo integration" })).rejects.toThrow();
    const rt = createIntegrationRuntime({ ns: "tenant-a", store: objects, buildId: "b-3", sandboxFactory: createHostTestSandbox, allowHostTestSandbox: true, exa: null, publisher: null });
    try {
      expect((await rt.invoke("integration_list", "{}")).data).toEqual({ integrations: [] });
      const reopened = await rt.invoke("integration_open", JSON.stringify({ slug: "demo-int", create: { title: "Demo", description: "Demo integration", upstreamName: "x" } }));
      expect(reopened.status).toBe("succeeded");
      expect(((await rt.invoke("integration_list", "{}")).data as { integrations: Array<{ slug: string }> }).integrations.map((i) => i.slug)).toEqual(["demo-int"]);
      expect(await rt.invoke("integration_open", JSON.stringify({ slug: "other-int", create: { title: "X", description: "Y", upstreamName: "z" } }))).toMatchObject({ status: "succeeded" });
    } finally {
      await rt.close();
    }
    const rt2 = createIntegrationRuntime({ ns: "tenant-a", store: objects, buildId: "b-4", sandboxFactory: createHostTestSandbox, allowHostTestSandbox: true, exa: null, publisher: null });
    try {
      expect(await rt2.invoke("integration_open", JSON.stringify({ slug: "demo-int", create: { title: "Different", description: "Demo integration", upstreamName: "x" } }))).toMatchObject({ status: "failed", error: { code: "already_exists" } });
    } finally {
      await rt2.close();
    }
  });
});

describe("IntegrationStore", () => {
  it("create is idempotent, update is CAS, receipts are content-addressed", async () => {
    const s = new IntegrationStore(new DirectoryObjectStore(tmp), "tenant-a");
    const base = { slug: "demo-int", title: "Demo", description: "d", createdAt: "2026-10-17T00:00:00.000Z", createdByBuild: "b-1" };
    expect((await s.create(base)).created).toBe(true);
    expect((await s.create({ ...base, title: "Other" })).created).toBe(false);
    expect((await s.get("demo-int"))!.title).toBe("Demo");
    expect(await s.list()).toEqual(["demo-int"]);
    const r1 = await s.putReceipt("demo-int", "val", { a: 1, b: [2] });
    const r2 = await s.putReceipt("demo-int", "val", { b: [2], a: 1 });
    expect(r1.receiptId).toBe(r2.receiptId);
    expect(r1.receiptId).toMatch(/^val-[0-9a-f]{24}$/);
    expect((await s.getReceipt("demo-int", r1.receiptId))!.a).toBe(1);
    const blob = await s.putBlob(Buffer.from("bundle-bytes"));
    expect((await s.getBlob(blob.key)).toString()).toBe("bundle-bytes");
    await s.update("demo-int", (cur) => ({ ...cur, title: "Renamed" }));
    expect((await s.get("demo-int"))!.title).toBe("Renamed");
    // A different tenant namespace sees nothing.
    expect(await new IntegrationStore(new DirectoryObjectStore(tmp), "tenant-b").list()).toEqual([]);
  });
});

describe("child auth", () => {
  it("mints tokens only valid for the exact tenant+integration audience", () => {
    const keys = generateChildAuthKeys("issuer-x");
    const t = mintChildToken(keys, { ns: "tenant-a", slug: "demo-int", subject: "user-1", ttlSeconds: 120 });
    expect(t.audience).toBe(childAudience("tenant-a", "demo-int"));
    expect(verifyChildToken(keys.publicJwk, t.token, { issuer: "issuer-x", audience: t.audience }).ok).toBe(true);
    expect(verifyChildToken(keys.publicJwk, t.token, { issuer: "issuer-x", audience: childAudience("tenant-b", "demo-int") })).toEqual({ ok: false, reason: "audience" });
    expect(verifyChildToken(generateChildAuthKeys("issuer-x").publicJwk, t.token, { issuer: "issuer-x", audience: t.audience })).toEqual({ ok: false, reason: "signature" });
    expect(verifyChildToken(keys.publicJwk, t.token, { issuer: "issuer-x", audience: t.audience, now: new Date(Date.now() + 3600_000) })).toEqual({ ok: false, reason: "expired" });
    const env = childAuthEnv(keys, "tenant-a", "demo-int");
    expect(env.CHILD_AUTH_PUBLIC_JWK).not.toContain('"d"');
    const loaded = loadChildAuthFromEnv({ INTEGRATION_CHILD_SIGNING_JWK: exportChildSigningJwk(keys), INTEGRATION_CHILD_ISSUER: "issuer-x" });
    expect(loaded!.kid).toBe(keys.kid);
  });
});

describe("evaluateExpect", () => {
  it("supports fan-out paths and reports exact mismatches", () => {
    const r = { structuredContent: { count: 3, items: [{ id: "a" }, { id: "b" }, { id: "a" }] } };
    expect(evaluateExpect(r, [{ path: "structuredContent.count", op: "equals", value: 3 }])).toEqual([]);
    expect(evaluateExpect(r, [{ path: "structuredContent.items[*].id", op: "unique" }])).toHaveLength(1);
    expect(evaluateExpect(r, [{ path: "structuredContent.items", op: "lengthEquals", value: 3 }])).toEqual([]);
  });
});

// ---------------------------------------------------------------- Manufact client / publisher

const ORG = { id: "org-id-1", slug: "org-good", profile_name: "Good Org" };
const KEY = "mcp-use-test-key-SECRET-0123456789";

function fakeManufact(opts: { buildStatuses?: string[][]; failCreate?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  let deployments = 0;
  const statusQueues = new Map<string, string[]>();
  // Mirrors observed Manufact behaviour: POST /servers returns a placeholder "manual"
  // deployment that is stopped; the upload's webhook deployment does the real build.
  const listed: Array<{ id: string; gitCommitMessage: string | null; deploymentTrigger: string; createdAt: string }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/api/v1", "") + url.search;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body;
    if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<blob ${(v as Blob).size}>`]));
    else if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method: init.method ?? "GET", path: p, headers, body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (headers["x-api-key"] !== KEY) return json(401, { error: "bad key" });
    if (p === "/test-auth") return json(200, { email: "dev@example.test", profiles: [ORG, { id: "org-id-2", slug: "org-wrong", profile_name: "Wrong" }] });
    const nextDeployment = (message: string) => {
      const id = `dep-${++deployments}`;
      statusQueues.set(id, [...(opts.buildStatuses?.[deployments - 1] ?? ["building", "running"])]);
      listed.unshift({ id, gitCommitMessage: message, deploymentTrigger: "webhook", createdAt: new Date(Date.now() + deployments).toISOString() });
      return id;
    };
    const form = body as Record<string, string>;
    if (p === "/servers" && init.method === "POST") {
      if (opts.failCreate) return json(422, { message: `invalid ${KEY}` });
      statusQueues.set("placeholder", ["stopped"]);
      nextDeployment(form.commitMessage!);
      return json(200, { server: { id: "srv-1", slug: "srv-one", mcpUrl: "https://child.example.test/mcp" }, deploymentId: "placeholder" });
    }
    if (p === "/servers/srv-1/source") {
      nextDeployment(form.commitMessage!);
      return json(200, { ok: true });
    }
    if (p === "/deployments" && init.method === "POST") return json(200, { id: nextDeployment("explicit redeploy") });
    if (p.startsWith("/servers/srv-1/env-variables")) return init.method === "GET" || !init.method ? json(200, { items: [] }) : json(200, { ok: true });
    if (p === "/servers/srv-1") return json(200, { id: "srv-1", name: "procmem-int-demo-int", status: "running", mcpUrl: "https://child.example.test/mcp", activeDeploymentId: listed[0]?.id ?? null });
    const bl = p.match(/^\/deployments\/(dep-\d+)\/build-logs/);
    if (bl) {
      const q = statusQueues.get(bl[1]!)!;
      const status = q.length > 1 ? q.shift()! : q[0]!;
      return json(200, { logs: `step for ${bl[1]} status ${status}\n`, offset: 1, status });
    }
    if (p.startsWith("/deployments?")) {
      const items = listed.map((d) => {
        const q = statusQueues.get(d.id)!;
        const status = q.length > 1 ? q.shift()! : q[0]!;
        return { ...d, status };
      });
      return json(200, { items, total: items.length });
    }
    const stop = p.match(/^\/deployments\/(dep-\d+)\/stop$/);
    if (stop && init.method === "POST") {
      statusQueues.set(stop[1]!, ["stopped"]);
      return json(200, { stopped: stop[1] });
    }
    const dg = p.match(/^\/deployments\/(dep-\d+|placeholder)$/);
    if (dg) return json(200, { id: dg[1], serverId: "srv-1", status: statusQueues.get(dg[1]!)?.at(-1) });
    return json(404, { error: "not found" });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("ManufactApi", () => {
  it("pins the org, sends CLI-equivalent headers, and redacts secrets", async () => {
    const { fetchImpl, calls } = fakeManufact({ failCreate: true });
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl });
    const id = await api.identity();
    expect(id.orgId).toBe("org-id-1");
    await expect(api.createManagedServer({ name: "x", archive: Buffer.from("tgz"), branch: "main", commitMessage: "m", env: { A: "1" } })).rejects.toThrow(/\[REDACTED\]/);
    const create = calls.find((c) => c.path === "/servers")!;
    expect(create.headers["x-profile-id"]).toBe("org-id-1");
    expect(create.body).toMatchObject({ organizationId: "org-id-1", managed: "true", private: "true", branch: "main", sourceFile: "<blob 3>" });
    const wrong = new ManufactApi({ apiKey: KEY, orgSlug: "org-missing", source: "explicit" }, { fetchImpl });
    await expect(wrong.identity()).rejects.toThrow(/refusing to deploy/);
  });
});

async function seedPromoted(store: IntegrationStore, slug: string, commit: string, tools: string[]) {
  const archive = await store.putBlob(Buffer.from(`archive-${commit}`));
  const body = { kind: "integration_validation", slug, buildId: "b-1", branch: "codex/build-b-1", head: commit, tree: `tree-${commit}`, sourceSha256: `src-${commit}`, sourceFiles: 3, passed: true, failures: [], policy: {}, manifest: { tools, env: [], deployProbe: [{ name: "info", steps: [{ tool: "integration_info", arguments: {} }] }] }, commands: [], suites: [], cases: [], sandbox: {}, startedAt: "x", finishedAt: "y" };
  const { receiptId } = await store.putReceipt(slug, "val", body);
  await store.update(slug, (cur) => ({
    ...cur,
    promotedHistory: cur.promoted ? [...cur.promotedHistory, cur.promoted] : cur.promotedHistory,
    promoted: { commit, tree: `tree-${commit}`, sourceSha256: `src-${commit}`, validationReceiptId: receiptId, archiveKey: archive.key, archiveSha256: archive.sha256, archiveBytes: archive.bytes, promotedAt: "now", buildId: "b-1", previousCommit: cur.promoted?.commit ?? null },
  }));
}

function fakeProbe(behaviour: { unauth: number; badToken: number; tools: string[]; failCall?: boolean }) {
  const fetchImpl = (async (_u: string | URL, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    return new Response("{}", { status: auth ? behaviour.badToken : behaviour.unauth });
  }) as typeof fetch;
  const mcpConnect = async (): Promise<ProbeClient> => ({
    serverVersion: () => ({ name: "child" }),
    listTools: async () => behaviour.tools.map((name) => ({ name, annotations: { readOnlyHint: true } })),
    callTool: async () => (behaviour.failCall ? { isError: true, content: [{ type: "text", text: "boom" }] } : { content: [{ type: "text", text: "ok" }] }),
    close: async () => undefined,
  });
  return { fetchImpl, mcpConnect };
}

describe("ManufactPublisher", () => {
  it("publishes, refuses duplicates, and auto-rolls back a revision whose live probe fails", async () => {
    const store = new IntegrationStore(new DirectoryObjectStore(tmp), "tenant-a");
    await store.create({ slug: "demo-int", title: "Demo", description: "d", createdAt: "now", createdByBuild: "b-1" });
    const { fetchImpl, calls } = fakeManufact();
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl });
    const good = fakeProbe({ unauth: 401, badToken: 401, tools: ["integration_info"] });
    const pub = new ManufactPublisher({ api, childAuth: generateChildAuthKeys(), sleep: async () => undefined, ...good });
    await expect(pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" })).rejects.toThrow(/No promoted revision/);

    await seedPromoted(store, "demo-int", "c1", ["integration_info"]);
    const first = await pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" });
    expect(first.action).toBe("publish");
    expect(first.probe?.passed).toBe(true);
    expect(first.active?.deploymentId).toBe("dep-1");
    const createBody = calls.find((c) => c.path === "/servers")!.body as Record<string, string>;
    expect(JSON.parse(createBody.env!)).toHaveProperty("CHILD_AUTH_AUDIENCE", childAudience("tenant-a", "demo-int"));
    await expect(pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" })).rejects.toThrow(/already the active deployment/);

    // Revision c2 builds ("running") but its live MCP probe fails: previous archive is redeployed.
    await seedPromoted(store, "demo-int", "c2", ["integration_info"]);
    const broken = fakeProbe({ unauth: 200, badToken: 401, tools: ["integration_info"] });
    let n = 0;
    const flaky = new ManufactPublisher({
      api,
      childAuth: pub.childAuth,
      sleep: async () => undefined,
      fetchImpl: ((u: string | URL, i?: RequestInit) => (n++ < 3 ? broken.fetchImpl(u, i) : good.fetchImpl(u, i))) as typeof fetch,
      mcpConnect: good.mcpConnect,
    });
    const second = await flaky.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-2" });
    expect(second.probe?.passed).toBe(false);
    expect(second.probe?.failures.join(" ")).toMatch(/expected 401/);
    expect(second.autoRollback).toMatchObject({ deploymentId: "dep-3", probePassed: true });
    const rec = await store.get("demo-int");
    expect(rec!.manufact!.active).toMatchObject({ commit: "c1", action: "auto_rollback" });
    expect(rec!.manufact!.history.map((h) => [h.deploymentId, h.probe])).toEqual([["dep-1", "passed"], ["dep-2", "failed"], ["dep-3", "passed"]]);
    // Uploads carry the exact stored archive bytes; secrets never appear in receipts.
    const receipts = await new DirectoryObjectStore(tmp).list("tenant-a", "integrations/demo-int/receipts/");
    const all = (await new DirectoryObjectStore(tmp).get("tenant-a", receipts)).values();
    for (const b of all) expect(b.toString()).not.toContain(KEY);
  });

  it("does not activate a deployment whose build failed", async () => {
    const store = new IntegrationStore(new DirectoryObjectStore(tmp), "tenant-a");
    await store.create({ slug: "demo-int", title: "Demo", description: "d", createdAt: "now", createdByBuild: "b-1" });
    await seedPromoted(store, "demo-int", "c1", ["integration_info"]);
    const { fetchImpl } = fakeManufact({ buildStatuses: [["building", "failed"]] });
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl });
    const pub = new ManufactPublisher({ api, childAuth: generateChildAuthKeys(), sleep: async () => undefined, ...fakeProbe({ unauth: 401, badToken: 401, tools: ["integration_info"] }) });
    const out = await pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" });
    expect(out.status).toBe("failed");
    expect(out.probe).toBeNull();
    expect(out.active).toBeNull();
  });
});

// ---------------------------------------------------------------- workspace + runtime (host-test sandbox: git/fs logic only)

async function openRepo(sb: IntegrationSandbox, slug = "demo-int", buildId = "b-1") {
  await RepoWorkspace.prepareSandbox(sb);
  const ws = new RepoWorkspace(sb, slug, buildId);
  await ws.hydrate({ files: await childTemplateFiles({ ...vars, slug }), message: "scaffold" });
  return ws;
}

describe("RepoWorkspace (host-test sandbox)", () => {
  it("keeps the git dir outside the worktree and ignores agent-made .git entries", async () => {
    const sb = await createHostTestSandbox();
    try {
      const ws = await openRepo(sb);
      expect(ws.gitDir.startsWith(sb.layout.gitDir)).toBe(true);
      await expect(fs.stat(path.join(ws.repoDir, ".git"))).rejects.toThrow();
      expect((await ws.status()).branch).toBe("codex/build-b-1");
      // An agent-planted .git with a malicious fsmonitor is not consulted by host git.
      await fs.mkdir(path.join(ws.repoDir, ".git"), { recursive: true });
      const marker = path.join(tmp, "pwned");
      await fs.writeFile(path.join(ws.repoDir, ".git", "config"), `[core]\n\tfsmonitor = "touch ${marker}"\n`);
      await ws.write("src/extra.ts", "export const x = 1;\n");
      const tree = await ws.worktreeTree();
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      await expect(fs.stat(marker)).rejects.toThrow();
      const scan = await ws.scan();
      expect(scan.nestedGit).toEqual([".git"]);
      await fs.writeFile(path.join(ws.repoDir, ".gitattributes"), "* filter=evil\n");
      expect((await ws.scan()).gitattributes).toEqual([".gitattributes"]);
    } finally {
      await sb.terminate();
    }
  });

  it("validation stops at policy failures before running any repo command", async () => {
    const sb = await createHostTestSandbox();
    try {
      const ws = await openRepo(sb);
      await fs.symlink("/etc/passwd", path.join(ws.repoDir, "leak"));
      await ws.write("build/out.js", "x");
      const v = await validateWorkspace(ws, { suites: [] });
      expect(v.passed).toBe(false);
      expect(v.failures.join("\n")).toMatch(/symlinks are not allowed: leak/);
      expect(v.failures.join("\n")).toMatch(/excluded by Manufact managed uploads.*build\/out\.js/);
      expect(v.sourceSha256).toBe("");
      expect(v.commands).toEqual([]);
      await fs.rm(path.join(ws.repoDir, "leak"));
      await ws.remove("build/out.js");
      const pkg = JSON.parse((await ws.read("package.json")).text);
      pkg.dependencies["left-pad"] = "1.3.0";
      await ws.write("package.json", JSON.stringify(pkg));
      const v2 = await validateWorkspace(ws, { suites: [] });
      expect(v2.failures).toEqual(["dependencies.left-pad is not in the pre-baked offline dependency set"]);
      expect(v2.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(v2.commands).toEqual([]);
      expect(v2.cases).toEqual([]);
    } finally {
      await sb.terminate();
    }
  });

  it("a test phase that rewrites source can never yield a passing attestation", async () => {
    const sb = await createHostTestSandbox();
    try {
      const ws = await openRepo(sb);
      const pkg = JSON.parse((await ws.read("package.json")).text);
      // Host-test has no uid separation, so the write succeeds here; detection must catch it.
      pkg.scripts.test = `node -e "require('fs').appendFileSync('src/tools.ts', '\\n// rewritten by test\\n')"`;
      await ws.write("package.json", JSON.stringify(pkg));
      const v = await validateWorkspace(ws, { suites: [] });
      expect(v.passed).toBe(false);
      expect(v.commands.map((c) => [c.name, c.exitCode])).toEqual([["npm test", 0]]);
      expect(v.sourceChecks).toHaveLength(1);
      expect(v.sourceChecks[0]).toMatchObject({ phase: "npm test", matches: false });
      expect(v.failures.join("\n")).toMatch(/source changed during npm test/);
      expect(v.cases).toEqual([]);
      expect(v.buildOutputSha256).toBeNull();
    } finally {
      await sb.terminate();
    }
  }, 120_000);

  it("commits only the exact validated tree and persists/restores full history via bundles", async () => {
    const sb = await createHostTestSandbox();
    try {
      const ws = await openRepo(sb);
      await ws.write("src/a.ts", "export const a = 1;\n");
      const tree = await ws.worktreeTree();
      await ws.write("src/b.ts", "export const b = 2;\n");
      await expect(ws.commit("feat: a", tree)).rejects.toThrow(/differs from validated tree/);
      await ws.remove("src/b.ts");
      const c = await ws.commit("feat: a", tree);
      expect(c.tree).toBe(tree);
      await ws.fastForwardMain(c.commit);
      const { bytes, refs } = await ws.bundle();
      expect(refs.main).toBe(c.commit);
      // Restore into a fresh sandbox on a new build branch.
      const sb2 = await createHostTestSandbox();
      try {
        await RepoWorkspace.prepareSandbox(sb2);
        const ws2 = new RepoWorkspace(sb2, "demo-int", "b-2");
        const h = await ws2.hydrate({ bundle: bytes });
        expect(h.resumedBranch).toBe(false);
        expect(h.head).toBe(c.commit);
        expect((await ws2.log({ ref: "main" })).map((l) => l.subject)).toEqual(["feat: a", "scaffold"]);
        expect(await ws2.verifyHistoryPreserved(refs)).toEqual({ ok: true });
        expect(await ws2.verifyHistoryPreserved({ ...refs, gone: c.commit })).toMatchObject({ ok: false });
      } finally {
        await sb2.terminate();
      }
    } finally {
      await sb.terminate();
    }
  });
});

describe("IntegrationRuntime", () => {
  it("refuses a non-isolated sandbox unless explicitly allowed for tests", async () => {
    const rt = createIntegrationRuntime({ ns: "tenant-a", store: new DirectoryObjectStore(tmp), buildId: "b-1", sandboxFactory: createHostTestSandbox, exa: null, publisher: null });
    const r = await rt.invoke("integration_open", JSON.stringify({ slug: "demo-int", create: { title: "Demo", description: "d", upstreamName: "x" } }));
    expect(r).toMatchObject({ status: "failed", error: { code: "sandbox_not_isolated" } });
    await rt.close();
  });

  it("exposes exact tool names with strict JSON schemas and explicit failures", async () => {
    const rt = createIntegrationRuntime({ ns: "tenant-a", store: new DirectoryObjectStore(tmp), buildId: "b-1", sandboxFactory: createHostTestSandbox, allowHostTestSandbox: true, exa: null, publisher: null });
    try {
      const names = rt.tools.map((t) => t.name);
      for (const n of ["integration_open", "integration_validate", "integration_git_commit", "integration_promote", "integration_publish", "integration_rollback", "integration_deployment_logs", "research_exa_search"]) expect(names).toContain(n);
      for (const t of rt.tools) expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(rt.toolSpecs()[0]).toMatchObject({ type: "function" });
      expect(await rt.invoke("nope", "{}")).toMatchObject({ status: "failed", error: { code: "unknown_tool" } });
      expect(await rt.invoke("integration_open", "{bad")).toMatchObject({ status: "failed", error: { code: "invalid_json" } });
      expect(await rt.invoke("integration_open", JSON.stringify({ slug: "demo-int", ns: "other-tenant" }))).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
      expect(await rt.invoke("integration_open", JSON.stringify({ slug: "demo-int" }))).toMatchObject({ status: "failed", error: { code: "unknown_integration" } });
      const opened = await rt.invoke("integration_open", JSON.stringify({ slug: "demo-int", create: { title: "Demo", description: "Demo integration", upstreamName: "Demo API" } }));
      expect(opened.status).toBe("succeeded");
      expect(await rt.invoke("integration_write", JSON.stringify({ slug: "demo-int", path: "../escape.ts", content: "x" }))).toMatchObject({ status: "failed", error: { code: "invalid_path" } });
      expect(await rt.invoke("integration_write", JSON.stringify({ slug: "demo-int", path: ".git/config", content: "x" }))).toMatchObject({ status: "failed", error: { code: "forbidden_path" } });
      expect(await rt.invoke("integration_git_commit", JSON.stringify({ slug: "demo-int", message: "unvalidated change", validationReceiptId: "val-000000000000000000000000" }))).toMatchObject({ status: "failed", error: { code: "unknown_receipt" } });
      expect(await rt.invoke("integration_publish", JSON.stringify({ slug: "demo-int" }))).toMatchObject({ status: "failed", error: { code: "publisher_not_configured" } });
      const list = await rt.invoke("integration_list", "{}");
      expect((list.data as { integrations: Array<{ slug: string; snapshot: unknown }> }).integrations[0]).toMatchObject({ slug: "demo-int" });
    } finally {
      const closed = await rt.close();
      expect(closed.errors).toEqual([]);
    }
  });
});

describe("customer catalog", () => {
  it("lists only probe-passed deployments and mints audience-bound tokens for the host principal", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = new IntegrationStore(objects, "tenant-a");
    await store.create({ slug: "demo-int", title: "Demo", description: "d", createdAt: "now", createdByBuild: "b-1" });
    await seedPromoted(store, "demo-int", "c1", ["integration_info"]);
    const keys = generateChildAuthKeys();
    const catalog = createIntegrationCatalog({ ns: "tenant-a", store: objects, childAuth: keys });
    expect(await catalog.listDeployed()).toEqual([]);
    const rec = (await store.get("demo-int"))!;
    await store.update("demo-int", (cur) => ({ ...cur, manufact: { orgSlug: "org-good", serverId: "srv-1", serverSlug: null, name: "n", mcpUrl: "https://child.example.test/mcp", dashboardUrl: null, envNames: [], history: [], active: { deploymentId: "dep-1", commit: "c1", archiveSha256: rec.promoted!.archiveSha256, validationReceiptId: rec.promoted!.validationReceiptId, status: "running", probe: "passed", receiptId: "pub-x", at: "now", action: "publish" } } }));
    const tools = createCustomerIntegrationTools(catalog, { tenant: "tenant-a", subject: "alice" });
    const listed = await tools[0]!.invoke({});
    expect((listed.data as { integrations: Array<{ tools: string[] }> }).integrations[0]!.tools).toEqual(["integration_info"]);
    const tok = await tools[1]!.invoke({ slug: "demo-int" });
    const t = tok.data as { token: string; audience: string };
    expect(verifyChildToken(keys.publicJwk, t.token, { issuer: keys.issuer, audience: childAudience("tenant-a", "demo-int") })).toMatchObject({ ok: true, claims: { sub: "alice" } });
    expect(() => createCustomerIntegrationTools(catalog, { tenant: "tenant-b", subject: "mallory" })).toThrow();
  });
});

// ---------------------------------------------------------------- retirement lifecycle

async function deployedFixture(objects: ObjectStore, ns = "tenant-a", slug = "demo-int") {
  const store = new IntegrationStore(objects, ns);
  await store.create({ slug, title: "Demo", description: "d", createdAt: "now", createdByBuild: "b-1" });
  await seedPromoted(store, slug, "c1", ["integration_info"]);
  const rec = (await store.get(slug))!;
  await store.update(slug, (cur) => ({
    ...cur,
    bundle: { key: "blobs/x", sha256: "x", bytes: 1, refs: { main: "c1" }, savedAt: "now", buildId: "b-1" },
    manufact: { orgSlug: "org-good", serverId: "srv-1", serverSlug: null, name: "n", mcpUrl: "https://child.example.test/mcp", dashboardUrl: null, envNames: [], history: [], active: { deploymentId: "dep-1", commit: "c1", archiveSha256: rec.promoted!.archiveSha256, validationReceiptId: rec.promoted!.validationReceiptId, status: "running", probe: "passed", receiptId: "pub-x", at: "now", action: "publish" } },
  }));
  return store;
}

describe("retirement lifecycle", () => {
  it("retire hides the child from the catalog and token exchange at once; restore brings back the same entry; nothing is deleted", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = await deployedFixture(objects);
    const keys = generateChildAuthKeys();
    const catalog = createIntegrationCatalog({ ns: "tenant-a", store: objects, childAuth: keys });
    const before = await catalog.listDeployed();
    expect(before.map((e) => e.slug)).toEqual(["demo-int"]);
    // Only public connection metadata is exposed: no source, receipts, traces, repo or env.
    expect(Object.keys(before[0]!).sort()).toEqual(["audience", "commit", "deployedAt", "deploymentId", "description", "mcpUrl", "slug", "title", "tools"]);
    const fp0 = integrationCatalogFingerprint(before);
    expect(await catalog.accessToken("demo-int", { subject: "alice" })).not.toBeNull();

    const r = await retireIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "superseded by notify-hub-v2" });
    expect(r).toMatchObject({ state: "retired", changed: true, listed: false, stop: { requested: false } });
    expect(r.receiptId).toMatch(/^life-[0-9a-f]{24}$/);
    expect(await catalog.listDeployed()).toEqual([]);
    expect(integrationCatalogFingerprint(await catalog.listDeployed())).not.toBe(fp0);
    expect(await catalog.accessToken("demo-int", { subject: "alice" })).toBeNull();
    const customer = createCustomerIntegrationTools(catalog, { tenant: "tenant-a", subject: "alice" });
    expect(await customer[1]!.invoke({ slug: "demo-int" })).toMatchObject({ status: "failed", error: { code: "unknown_integration" } });
    // Durable state kept: record, discovery marker, bundle pointer, promoted revision, receipts.
    const kept = (await store.get("demo-int"))!;
    expect(await store.list()).toEqual(["demo-int"]);
    expect(kept.bundle?.refs.main).toBe("c1");
    expect(kept.promoted?.commit).toBe("c1");
    expect(kept.manufact?.active?.deploymentId).toBe("dep-1");
    expect(await store.getReceipt("demo-int", kept.promoted!.validationReceiptId)).not.toBeNull();
    expect(await store.getReceipt("demo-int", r.receiptId!)).toMatchObject({ kind: "integration_lifecycle", action: "retire", reason: "superseded by notify-hub-v2" });
    // Idempotent.
    expect(await retireIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "again, no-op" })).toMatchObject({ changed: false, receiptId: null });

    const back = await restoreIntegration({ store, slug: "demo-int", buildId: "b-3", reason: "customer still needs it" });
    expect(back).toMatchObject({ state: "active", changed: true, listed: true });
    const after = await catalog.listDeployed();
    expect(after).toEqual(before);
    expect(integrationCatalogFingerprint(after)).toBe(fp0);
    expect((await store.get("demo-int"))!.lifecycle!.history.map((h) => h.state)).toEqual(["retired", "active"]);
  });

  it("is visible across cold store instances and read-through caches immediately", async () => {
    const dir = path.join(tmp, "authority");
    const a = new DirectoryObjectStore(dir);
    const store = await deployedFixture(a);
    const coldCatalog = () => createIntegrationCatalog({ ns: "tenant-a", store: new CachedObjectStore(new DirectoryObjectStore(dir), new DirectoryObjectStore(path.join(tmp, `cache-${Math.random()}`))), childAuth: null });
    const warm = createIntegrationCatalog({ ns: "tenant-a", store: new CachedObjectStore(new DirectoryObjectStore(dir), new DirectoryObjectStore(path.join(tmp, "cache-warm"))), childAuth: null });
    expect((await warm.listDeployed()).length).toBe(1);
    await retireIntegration({ store: new IntegrationStore(new DirectoryObjectStore(dir), "tenant-a"), slug: "demo-int", buildId: "b-2", reason: "retire from another process" });
    expect(await warm.listDeployed()).toEqual([]);
    expect(await coldCatalog().listDeployed()).toEqual([]);
    await restoreIntegration({ store: new IntegrationStore(new DirectoryObjectStore(dir), "tenant-a"), slug: "demo-int", buildId: "b-3", reason: "restore from a third process" });
    expect((await warm.listDeployed()).length).toBe(1);
    expect((await coldCatalog().listDeployed()).length).toBe(1);
    // Tenant isolation unchanged.
    expect(await createIntegrationCatalog({ ns: "tenant-b", store: a, childAuth: null }).listDeployed()).toEqual([]);
    void store;
  });

  it("concurrent retires apply exactly once", async () => {
    const objects = new DirectoryObjectStore(tmp);
    await deployedFixture(objects);
    const outs = await Promise.all(Array.from({ length: 5 }, (_, i) => retireIntegration({ store: new IntegrationStore(objects, "tenant-a"), slug: "demo-int", buildId: `b-${i}`, reason: `concurrent retire ${i}` })));
    expect(outs.filter((o) => o.changed)).toHaveLength(1);
    expect((await new IntegrationStore(objects, "tenant-a").get("demo-int"))!.lifecycle!.history).toHaveLength(1);
  });

  it("publish and rollback refuse a retired integration; after explicit restore publishing works", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = new IntegrationStore(objects, "tenant-a");
    await store.create({ slug: "demo-int", title: "Demo", description: "d", createdAt: "now", createdByBuild: "b-1" });
    await seedPromoted(store, "demo-int", "c1", ["integration_info"]);
    const { fetchImpl } = fakeManufact();
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl });
    const pub = new ManufactPublisher({ api, childAuth: generateChildAuthKeys(), sleep: async () => undefined, ...fakeProbe({ unauth: 401, badToken: 401, tools: ["integration_info"] }) });
    await retireIntegration({ store, slug: "demo-int", buildId: "b-1", reason: "retired before first publish" });
    await expect(pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" })).rejects.toMatchObject({ code: "integration_retired" });
    await expect(pub.rollback({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-1" })).rejects.toThrow();
    await restoreIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "ready to publish" });
    const out = await pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-2" });
    expect(out.active?.deploymentId).toBe(out.deploymentId);
    expect(isListed((await store.get("demo-int"))!)).toBe(true);
    await retireIntegration({ store, slug: "demo-int", buildId: "b-3", reason: "retire after publish" });
    await expect(pub.rollback({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-3" })).rejects.toMatchObject({ code: "integration_retired" });
  });

  it("stopDeployment stops the active Manufact deployment; restore then needs a new publish to list it", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = await deployedFixture(objects);
    const { fetchImpl, calls } = fakeManufact();
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl });
    await expect(retireIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "stop it now please", stopDeployment: true, api: null })).rejects.toMatchObject({ code: "publisher_not_configured" });
    const r = await retireIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "stop it now please", stopDeployment: true, api });
    expect(r.stop).toMatchObject({ requested: true, deploymentId: "dep-1", stopped: true });
    expect(calls.some((c) => c.method === "POST" && c.path === "/deployments/dep-1/stop")).toBe(true);
    const rec = (await store.get("demo-int"))!;
    expect(rec.manufact!.active).toBeNull();
    expect(rec.manufact!.history.at(-1)).toMatchObject({ deploymentId: "dep-1", status: "stopped", action: "stop" });
    expect(rec.lifecycle!.history.at(-1)).toMatchObject({ state: "retired", stoppedDeploymentId: "dep-1" });
    expect(await store.getReceipt("demo-int", r.stop.receiptId!)).toMatchObject({ action: "stop_deployment", stopped: true });
    const back = await restoreIntegration({ store, slug: "demo-int", buildId: "b-3", reason: "bring it back later" });
    expect(back).toMatchObject({ state: "active", listed: false });
    expect(back.note).toMatch(/integration_publish/);
    expect(await createIntegrationCatalog({ ns: "tenant-a", store: objects, childAuth: null }).listDeployed()).toEqual([]);
  });

  it("runtime exposes retire/restore with explicit failures and lifecycle in integration_list", async () => {
    const objects = new DirectoryObjectStore(tmp);
    await deployedFixture(objects);
    const rt = createIntegrationRuntime({ ns: "tenant-a", store: objects, buildId: "b-9", sandboxFactory: createHostTestSandbox, allowHostTestSandbox: true, exa: null, publisher: null });
    try {
      expect(await rt.invoke("integration_retire", JSON.stringify({ slug: "nope-int", reason: "does not exist" }))).toMatchObject({ status: "failed", error: { code: "unknown_integration" } });
      expect(await rt.invoke("integration_retire", JSON.stringify({ slug: "demo-int", reason: "short" }))).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
      expect(await rt.invoke("integration_retire", JSON.stringify({ slug: "demo-int", reason: "stop without creds", stopDeployment: true }))).toMatchObject({ status: "failed", error: { code: "publisher_not_configured" } });
      expect((await rt.invoke("integration_retire", JSON.stringify({ slug: "demo-int", reason: "remove from discovery" }))).status).toBe("succeeded");
      const listed = (await rt.invoke("integration_list", "{}")).data as { integrations: Array<{ slug: string; lifecycle: { state: string }; listedForCustomers: boolean }> };
      expect(listed.integrations[0]).toMatchObject({ slug: "demo-int", lifecycle: { state: "retired" }, listedForCustomers: false });
      expect(await rt.invoke("integration_publish", JSON.stringify({ slug: "demo-int" }))).toMatchObject({ status: "failed" });
      const restored = await rt.invoke("integration_restore", JSON.stringify({ slug: "demo-int", reason: "bring it back now" }));
      expect(restored).toMatchObject({ status: "succeeded", data: { state: "active", listed: true } });
    } finally {
      await rt.close();
    }
  });
});

// ---------------------------------------------------------------- upload appearance grace (simulated clock)

/** Time-driven fake Manufact: deployments appear/finish at simulated times; nothing really waits. */
function timedManufact(mode: "no-webhook" | "late-webhook" | "prompt-webhook") {
  const clock = { t: 1_000_000 };
  const deps: Array<{ id: string; gitCommitMessage: string | null; trigger: string; appearAt: number; runningAt: number; stopped?: boolean }> = [];
  let redeploys = 0;
  let listCalls = 0;
  const statusOf = (d: (typeof deps)[number]) => (d.stopped ? "stopped" : clock.t >= d.runningAt ? "running" : "building");
  const visible = () => deps.filter((d) => clock.t >= d.appearAt);
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/api/v1", "");
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (p === "/test-auth") return json(200, { email: "dev@example.test", profiles: [ORG] });
    if (p.startsWith("/servers/srv-1/env-variables")) return !init.method || init.method === "GET" ? json(200, { items: [] }) : json(200, {});
    if (p === "/servers/srv-1/source") {
      const msg = (init.body as FormData).get("commitMessage") as string;
      // Identical tree => no managed commit => no deployment (the observed live case).
      if (mode === "late-webhook") {
        deps.push({ id: "placeholder-1", gitCommitMessage: msg, trigger: "manual", appearAt: clock.t, runningAt: Infinity, stopped: true });
        deps.push({ id: "webhook-1", gitCommitMessage: msg, trigger: "webhook", appearAt: clock.t + 40_000, runningAt: clock.t + 10 * 60_000 });
      }
      if (mode === "prompt-webhook") deps.push({ id: "webhook-1", gitCommitMessage: msg, trigger: "webhook", appearAt: clock.t + 2_000, runningAt: clock.t + 4 * 60_000 });
      return json(200, { ok: true, commitSha: mode === "no-webhook" ? null : "abc" });
    }
    if (p === "/deployments" && init.method === "POST") {
      redeploys++;
      const id = `redeploy-${redeploys}`;
      deps.push({ id, gitCommitMessage: "previous upload message", trigger: "redeploy", appearAt: clock.t, runningAt: clock.t + 3 * 60_000 });
      return json(200, { id });
    }
    if (p === "/deployments") {
      listCalls++;
      return json(200, { items: visible().map((d) => ({ id: d.id, gitCommitMessage: d.gitCommitMessage, deploymentTrigger: d.trigger, status: statusOf(d), createdAt: new Date(d.appearAt).toISOString() })), total: visible().length });
    }
    const bl = p.match(/^\/deployments\/([^/]+)\/build-logs$/);
    if (bl) {
      const d = deps.find((x) => x.id === bl[1])!;
      return json(200, { logs: url.searchParams.get("offset") === "0" ? `build log ${d.id}\n` : "", offset: 1, status: statusOf(d) });
    }
    const dg = p.match(/^\/deployments\/([^/]+)$/);
    if (dg) {
      const d = deps.find((x) => x.id === dg[1])!;
      return json(200, { id: d.id, serverId: "srv-1", status: statusOf(d), gitCommitMessage: d.gitCommitMessage, deploymentTrigger: d.trigger });
    }
    if (p === "/servers/srv-1") {
      const running = [...visible()].reverse().find((d) => statusOf(d) === "running");
      return json(200, { id: "srv-1", status: "running", mcpUrl: "https://child.example.test/mcp", activeDeploymentId: running?.id ?? null });
    }
    return json(404, { error: `unhandled ${p}` });
  }) as typeof fetch;
  return { fetchImpl, clock, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms), redeploys: () => redeploys, listCalls: () => listCalls };
}

describe("upload appearance grace", () => {
  it("no deployment for an identical-tree upload: gives up after ~60 s (not 15 min) and reports appeared=false", async () => {
    const m = timedManufact("no-webhook");
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl: m.fetchImpl });
    const t0 = m.clock.t;
    const r = await api.awaitUploadBuild("srv-1", "msg-that-never-appears", { timeoutMs: 15 * 60_000, appearanceGraceMs: 60_000, sleep: m.sleep, now: m.now });
    expect(r).toMatchObject({ deployment: null, appeared: false, timedOut: false });
    expect(m.clock.t - t0).toBeGreaterThanOrEqual(60_000);
    expect(m.clock.t - t0).toBeLessThan(70_000);
  });

  it("a stopped placeholder plus a late, slow webhook build keeps the FULL build budget (no premature fallback)", async () => {
    const m = timedManufact("late-webhook");
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl: m.fetchImpl });
    await api.uploadSource({ serverId: "srv-1", archive: Buffer.from("x"), branch: "main", commitMessage: "upload-42" });
    const t0 = m.clock.t;
    const r = await api.awaitUploadBuild("srv-1", "upload-42", { timeoutMs: 15 * 60_000, appearanceGraceMs: 30_000, sleep: m.sleep, now: m.now });
    expect(r.deployment?.id).toBe("webhook-1");
    expect(r).toMatchObject({ status: "running", appeared: true, timedOut: false });
    expect(r.members.map((x) => [x.id, x.status])).toEqual(expect.arrayContaining([["placeholder-1", "stopped"], ["webhook-1", "running"]]));
    expect(m.clock.t - t0).toBeGreaterThanOrEqual(10 * 60_000);
    expect(m.redeploys()).toBe(0);
  });

  async function publishWith(mode: "no-webhook" | "prompt-webhook") {
    const objects = new DirectoryObjectStore(tmp);
    const store = await deployedFixture(objects);
    const m = timedManufact(mode);
    const api = new ManufactApi({ apiKey: KEY, orgSlug: "org-good", source: "explicit" }, { fetchImpl: m.fetchImpl });
    const pub = new ManufactPublisher({ api, childAuth: generateChildAuthKeys(), sleep: m.sleep, now: m.now, appearanceGraceMs: 45_000, ...fakeProbe({ unauth: 401, badToken: 401, tools: ["integration_info"] }) });
    const t0 = m.clock.t;
    // Same commit as the active deployment (force): only env changes, the archive is identical.
    const out = await pub.publish({ store, ns: "tenant-a", slug: "demo-int", buildId: "b-5", force: true });
    const receipt = (await store.getReceipt("demo-int", out.receiptId))!;
    return { out, receipt, m, elapsed: m.clock.t - t0, rec: (await store.get("demo-int"))! };
  }

  it("publisher: identical re-upload falls back to ONE explicit redeploy after the grace and waits for its real build", async () => {
    const { out, receipt, m, elapsed, rec } = await publishWith("no-webhook");
    expect(m.redeploys()).toBe(1);
    expect(out).toMatchObject({ deploymentId: "redeploy-1", status: "running", probe: { passed: true } });
    expect(receipt).toMatchObject({ deploymentTrigger: "explicit_redeploy_after_no_upload_deployment:redeploy", uploadAppearance: { appeared: false, graceMs: 45_000 }, uploadResponse: { ok: true, commitSha: null } });
    expect(elapsed).toBeGreaterThanOrEqual(45_000 + 3 * 60_000);
    expect(elapsed).toBeLessThan(6 * 60_000); // not the 15-minute no-commit wait
    expect(rec.manufact!.active).toMatchObject({ deploymentId: "redeploy-1", status: "running", probe: "passed" });
  });

  it("publisher: when the upload's webhook appears, no explicit redeploy is triggered (no duplicate build)", async () => {
    const { out, receipt, m } = await publishWith("prompt-webhook");
    expect(m.redeploys()).toBe(0);
    expect(out.deploymentId).toBe("webhook-1");
    expect(receipt).toMatchObject({ uploadAppearance: { appeared: true } });
    expect(String(receipt.deploymentTrigger)).toMatch(/^upload:webhook$/);
  });

  it("catalog requires the active deployment to be recorded running AND probe-passed", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = await deployedFixture(objects);
    const catalog = createIntegrationCatalog({ ns: "tenant-a", store: objects, childAuth: null });
    expect((await catalog.listDeployed()).length).toBe(1);
    await store.update("demo-int", (cur) => ({ ...cur, manufact: { ...cur.manufact!, active: { ...cur.manufact!.active!, status: "failed" } } }));
    expect(await catalog.listDeployed()).toEqual([]);
    expect(isListed((await store.get("demo-int"))!)).toBe(false);
  });

  it("lifecycle outputs report the stored state, not the intended one, when a concurrent change wins", async () => {
    const objects = new DirectoryObjectStore(tmp);
    const store = await deployedFixture(objects);
    await retireIntegration({ store, slug: "demo-int", buildId: "b-1", reason: "first retire wins" });
    const again = await retireIntegration({ store, slug: "demo-int", buildId: "b-2", reason: "second retire is a no-op" });
    expect(again).toMatchObject({ state: "retired", changed: false, receiptId: null, note: "Already retired (no change)." });
    // Simulate a restore landing between this caller's read and its CAS: the stored state wins.
    const racing = new IntegrationStore(objects, "tenant-a");
    const realUpdate = racing.update.bind(racing);
    racing.update = async (slug, fn) => {
      await restoreIntegration({ store: new IntegrationStore(objects, "tenant-a"), slug, buildId: "b-3", reason: "concurrent restore" });
      return realUpdate(slug, fn);
    };
    const out = await restoreIntegration({ store: racing, slug: "demo-int", buildId: "b-4", reason: "my restore" });
    expect(out).toMatchObject({ state: "active", changed: false, receiptId: null, listed: true });
    expect(out.note).toMatch(/restored concurrently/);
  });
});
