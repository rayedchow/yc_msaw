import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * View-only Google accounts read their OWN current view of a Doc, never the writer's unit. alice writes the shared
 * roadmap (full unit: OT history, earlier writer snapshots, suggestions, permissions); bob may only read it, so the
 * runtime attributes it to him with `revisions:false` (withheld) and captured bob's current view under bob's own
 * credential into google-docs/_accounts/bob@acme.test/ (runtime account-capture.ts). carol has no Google account.
 * legacy@ is a mailbox nobody proved. A loopback fake runtime implements the attribution contract.
 */
let resource: string;
let issuer: MockIssuer;
let app: App;
let dir: string;
let base: string;
let mcpUrl: string;
let fakeRuntime: Server;
let runtimeToken = "";
let failAttribution = false;
const attributionCalls: string[] = [];
const tok: Record<"alice" | "bob" | "carol" | "dave", string> = { alice: "", bob: "", carol: "", dave: "" };
const mcp: Partial<Record<keyof typeof tok, Client>> = {};

const SHARED = "google-docs/Shared-roadmap-doc-ssssssssssss";
const BOB_DOC = "google-docs/Bob-notes-doc-bbbbbbbbbbbb";
const BOB_VIEW = "google-docs/_accounts/bob@acme.test/Shared-roadmap-doc-ssssssssssss";
const ALICE_VIEW = "google-docs/_accounts/alice@acme.test/Bob-notes-doc-bbbbbbbbbbbb";
const LEGACY_VIEW = "google-docs/_accounts/legacy@acme.test/Shared-roadmap-doc-ssssssssssss";
const DAVE_VIEW = "google-docs/_accounts/dave@acme.test/Shared-roadmap-doc-ssssssssssss";

let bobRevisions = false;
const units = (subject: string) => {
  if (subject === "user_alice") return [
    { path: SHARED, accounts: ["alice@acme.test"], revisions: true },
    { path: "google-docs/_raw/document:doc-s", accounts: ["alice@acme.test"], revisions: true },
    { path: BOB_DOC, accounts: ["alice@acme.test"], revisions: false },
  ];
  if (subject === "user_bob") return [
    { path: SHARED, accounts: ["bob@acme.test"], revisions: bobRevisions },
    { path: "google-docs/_raw/document:doc-s", accounts: ["bob@acme.test"], revisions: bobRevisions },
    { path: BOB_DOC, accounts: ["bob@acme.test"], revisions: true },
  ];
  // dave's only Google file is the roadmap, view-only.
  if (subject === "user_dave") return [{ path: SHARED, accounts: ["dave@acme.test"], revisions: false }];
  return [];
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const http = (method: string, route: string, token: string, body?: unknown) =>
  fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

let clock = Date.now() - 3_600_000;
function put(p: string, content: string, kind = "projection") {
  const bytes = Buffer.from(content);
  clock += 1000;
  return { op: "put", path: p, kind, contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(clock).toISOString() };
}

async function publish(batchId: string, changes: unknown[]) {
  expect((await http("POST", "/v1/sources/publish", runtimeToken, { batchId, changes })).status).toBe(200);
}

async function report() {
  const r = await http("POST", "/v1/sources/status-report", runtimeToken, {
    providers: [
      { provider: "google-docs", scope: "docs-content", state: "partial", reason: "tenant-wide: 3 docs" },
      { provider: "google-docs", scope: "account:bob@acme.test", state: "complete", reason: "current view of Docs this account may only read; writer-only revision history not part of it", counts: { complete: 1 } },
      { provider: "google-docs", scope: "account:alice@acme.test", state: "complete", reason: "current view", counts: { complete: 1 } },
      { provider: "google-docs", scope: "account:legacy@acme.test", state: "complete", reason: "current view", counts: { complete: 1 } },
      // An address the scope does not spell plainly is nobody's.
      { provider: "google-docs", scope: "account:carol%40acme.test", state: "complete", reason: "current view", counts: { complete: 1 } },
    ],
    runtime: { reportIntervalSeconds: 300 },
    googleAccounts: [
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "bob@acme.test", subject: "user_bob", issuer: issuer.issuer },
      { account: "dave@acme.test", subject: "user_dave", issuer: issuer.issuer },
      { account: "legacy@acme.test", subject: null, issuer: null },
    ],
  });
  expect(r.status).toBe(200);
}

async function tool(who: keyof typeof tok, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  if (!mcp[who]) {
    const c = new Client({ name: `views-${who}`, version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
    mcp[who] = c;
  }
  const r = (await mcp[who]!.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...(JSON.parse(r.content[0]!.text) as Record<string, any>), isError: r.isError === true };
}
const names = (ls: Record<string, any>) => (ls.entries ?? []).map((e: any) => e.name);
const read = async (who: keyof typeof tok, p: string) => tool(who, "read", { path: `$SOURCES/${p}` });
const grep = async (who: keyof typeof tok) => (await tool(who, "grep", { path: "$SOURCES", pattern: "needle-[a-z0-9-]+" })).matches.map((m: any) => m.path.replace("$SOURCES/", "")).sort();

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-google-views-"));
  fakeRuntime = createHttpServer(async (req, res) => {
    const url = req.url ?? "";
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer synthetic-runtime-service-token-0123456789") return void res.writeHead(401).end("{}");
    const principal = JSON.parse(String(req.headers["x-procmem-principal"] ?? "{}")) as Record<string, unknown>;
    if (req.method === "PUT" && /\/binding$/.test(url)) {
      runtimeToken = (JSON.parse(raw) as { token: string }).token;
      return void res.writeHead(200).end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && /\/google\/auth\/attribution$/.test(url)) {
      attributionCalls.push(String(principal.subject));
      if (failAttribution) return void res.writeHead(503).end(JSON.stringify({ error: "db down" }));
      if (principal.issuer !== issuer.issuer) return void res.writeHead(403).end("{}");
      return void res.writeHead(200).end(JSON.stringify({ schema: "procmem.google-attribution/v1", accounts: [], units: units(String(principal.subject)), truncated: false }));
    }
    res.writeHead(404).end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await new Promise<void>((r) => fakeRuntime.listen(0, "127.0.0.1", r));
  const runtimeUrl = `http://127.0.0.1:${(fakeRuntime.address() as { port: number }).port}`;
  const port = await freePort();
  resource = `http://127.0.0.1:${port}/mcp`;
  issuer = await startMockIssuer();
  app = await createApp({
    env: {
      HOST: "127.0.0.1", PORT: "0", AUTH_MODE: "oidc", MCP_PUBLIC_URL: resource, OIDC_ISSUER: issuer.issuer,
      PROCMEM_ADMIN_SUBJECTS: "user_alice", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir,
      SOURCES_RUNTIME_URL: `${runtimeUrl}/internal/v1`, SOURCES_RUNTIME_SERVICE_TOKEN: "synthetic-runtime-service-token-0123456789",
      SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`, SOURCES_DEVICE_API_URL: runtimeUrl,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => { throw new Error("no builds"); },
    leaseFactory: async () => { throw new Error("$SOURCES reads never open a sandbox"); },
    log: () => undefined,
  });
  ({ url: base, mcpUrl } = await app.listen(port));
  for (const who of Object.keys(tok) as Array<keyof typeof tok>) tok[who] = await issuer.mint({ sub: `user_${who}`, aud: resource, scope: "openid", claims: { org_id: "org_acme", email: `${who}@acme.test` } });
  expect((await http("POST", "/v1/sources/runtime/provision", tok.alice)).status).toBe(201);
  // Alice's shared unit, two writer revisions (the first is an "old writer snapshot" bob must never get).
  await publish("writer-v1", [
    put(`sources/${SHARED}/native/document.json`, "{\"body\":\"needle-writer-v1-snapshot\"}\n", "raw"),
    put(`sources/${SHARED}/history/operations.jsonl`, "{\"op\":\"needle-writer-ot\"}\n"),
  ]);
  await publish("writer-v2", [
    put(`sources/${SHARED}/native/document.json`, "{\"body\":\"current\",\"suggestion\":\"needle-writer-suggestion\"}\n", "raw"),
    put(`sources/${SHARED}/drive.json`, "{\"permissions\":\"needle-writer-permissions\"}\n", "raw"),
    put(`sources/${SHARED}/history/snapshot-diffs/2026-rev-2.json`, "{\"diff\":\"needle-writer-diff\"}\n"),
    put("sources/google-docs/_raw/document:doc-s/comment:c1/2026-10/gdocs:c1.json", "{\"comment\":\"needle-writer-comment\"}\n", "raw"),
    put(`sources/${BOB_DOC}/native/document.json`, "{\"body\":\"needle-bob-own-doc\"}\n", "raw"),
    // Bob's own current view of the roadmap, captured under bob's credential (two of his own captures).
    put(`sources/${BOB_VIEW}/native/document.json`, "{\"body\":\"needle-bob-view-v1\"}\n", "raw"),
  ]);
  await publish("bob-view", [
    put(`sources/${BOB_VIEW}/native/document.json`, "{\"body\":\"needle-bob-view-current\",\"suggestionsViewMode\":\"PREVIEW_WITHOUT_SUGGESTIONS\"}\n", "raw"),
    put(`sources/${BOB_VIEW}/tabs/t.0.md`, "Roadmap text needle-bob-view-text\n"),
    put(`sources/${BOB_VIEW}/images/kix.img.png`, "PNG needle-bob-view-image\n", "binary"),
    // Alice's own current view of bob's notes (she may only read them).
    put(`sources/${ALICE_VIEW}/tabs/t.0.md`, "Notes needle-alice-view-text\n"),
    // A mailbox nobody proved: nobody's.
    put(`sources/${LEGACY_VIEW}/tabs/t.0.md`, "needle-legacy-view-text\n"),
    put(`sources/${DAVE_VIEW}/tabs/t.0.md`, "Roadmap needle-dave-view-text\n"),
  ]);
  await report();
});

afterAll(async () => {
  await Promise.allSettled(Object.values(mcp).map((c) => c!.close()));
  await app?.close();
  await issuer?.close();
  await new Promise<void>((r) => fakeRuntime.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe("a view-only account reads its own current view of a Doc and nothing of the writer's unit", () => {
  it("bob reads exactly his authorized current snapshot/text/image and his own earlier captures", async () => {
    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["Bob-notes-doc-bbbbbbbbbbbb/", "_accounts/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs/_accounts" }))).toEqual(["bob@acme.test/"]);
    expect((await read("bob", `${BOB_VIEW}/tabs/t.0.md`)).content).toContain("needle-bob-view-text");
    expect((await read("bob", `${BOB_VIEW}/native/document.json`)).content).toContain("needle-bob-view-current");
    expect(await grep("bob")).toEqual([
      `${BOB_DOC}/native/document.json`,
      `${BOB_VIEW}/images/kix.img.png`,
      `${BOB_VIEW}/native/document.json`,
      `${BOB_VIEW}/tabs/t.0.md`,
    ]);
    const own = await tool("bob", "sources_history", { path: `$SOURCES/${BOB_VIEW}/native/document.json` });
    expect(own.versions).toHaveLength(2);
  });

  it("an owner whose only Google files are view-only still finds, lists and greps his own views", async () => {
    expect(names(await tool("dave", "ls", { path: "$SOURCES" }))).toEqual(["google-docs/"]);
    expect(names(await tool("dave", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["_accounts/"]);
    expect(await grep("dave")).toEqual([`${DAVE_VIEW}/tabs/t.0.md`]);
    expect((await read("dave", `${SHARED}/native/document.json`)).code).toBe("not_found");
  });

  it("bob gets none of alice's OT/history, old writer snapshots, suggestions, permissions, comments or her own views", async () => {
    for (const p of [
      `${SHARED}/native/document.json`, `${SHARED}/history/operations.jsonl`, `${SHARED}/drive.json`,
      `${SHARED}/history/snapshot-diffs/2026-rev-2.json`, "google-docs/_raw/document:doc-s/comment:c1/2026-10/gdocs:c1.json",
      `${ALICE_VIEW}/tabs/t.0.md`, `${LEGACY_VIEW}/tabs/t.0.md`,
    ]) expect((await read("bob", p)).code, p).toBe("not_found");
    expect((await tool("bob", "sources_history", { path: `$SOURCES/${SHARED}/native/document.json` })).versions).toEqual([]);
    const writer = await tool("alice", "sources_history", { path: `$SOURCES/${SHARED}/native/document.json` });
    expect(writer.versions).toHaveLength(2);
    for (const v of writer.versions) {
      expect((await tool("bob", "sources_history", { path: `$SOURCES/${SHARED}/native/document.json`, versionId: v.versionId })).code).toBe("not_found");
    }
    expect((await tool("bob", "ls", { path: "$SOURCES/google-docs/_accounts/alice@acme.test" })).code).toBe("not_found");
    const st = JSON.stringify(await tool("bob", "sources_status", {}));
    expect(st).not.toContain("alice@acme.test");
    expect(st).not.toContain("legacy@acme.test");
  });

  it("alice keeps her full rich unit (history, old snapshots, comments) and her own view; bob's view is not hers", async () => {
    expect((await read("alice", `${SHARED}/history/operations.jsonl`)).content).toContain("needle-writer-ot");
    expect((await read("alice", `${SHARED}/native/document.json`)).content).toContain("needle-writer-suggestion");
    const v = (await tool("alice", "sources_history", { path: `$SOURCES/${SHARED}/native/document.json` })).versions;
    const old = await tool("alice", "sources_history", { path: `$SOURCES/${SHARED}/native/document.json`, versionId: v[v.length - 1].versionId });
    expect(JSON.stringify(old)).toContain("needle-writer-v1-snapshot");
    expect(await grep("alice")).toEqual([
      `${ALICE_VIEW}/tabs/t.0.md`,
      "google-docs/_raw/document:doc-s/comment:c1/2026-10/gdocs:c1.json",
      `${SHARED}/drive.json`,
      `${SHARED}/history/operations.jsonl`,
      `${SHARED}/history/snapshot-diffs/2026-rev-2.json`,
      `${SHARED}/native/document.json`,
    ].sort());
    // Bob's notes are view-only for alice: the unit is withheld, her own view is served.
    expect((await read("alice", `${BOB_DOC}/native/document.json`)).code).toBe("not_found");
    expect((await read("alice", `${BOB_VIEW}/tabs/t.0.md`)).code).toBe("not_found");
  });

  it("a member with no Google account and an unproven mailbox's views stay sealed; no extra runtime calls", async () => {
    const before = attributionCalls.filter((s) => s === "user_carol").length;
    expect(names(await tool("carol", "ls", { path: "$SOURCES" }))).toEqual([]);
    for (const p of [`${BOB_VIEW}/tabs/t.0.md`, `${LEGACY_VIEW}/tabs/t.0.md`, `${SHARED}/native/document.json`]) expect((await read("carol", p)).code).toBe("not_found");
    expect(attributionCalls.filter((s) => s === "user_carol").length).toBe(before);
    expect(await grep("carol")).toEqual([]);
    // Account views cost no runtime call of their own: one attribution per principal per heartbeat/TTL, as before.
    await report();
    const n = attributionCalls.length;
    for (let i = 0; i < 5; i++) await read("bob", `${BOB_VIEW}/tabs/t.0.md`);
    await tool("bob", "ls", { path: "$SOURCES/google-docs" });
    expect(attributionCalls.length - n).toBe(1);
  });

  it("per-account coverage goes to that mailbox's owner only", async () => {
    const scopes = async (who: keyof typeof tok) => ((await tool(who, "sources_status", {})).providers.find((p: any) => p.provider === "google-docs")?.coverage ?? []).map((c: any) => c.scope);
    expect(await scopes("bob")).toEqual(["account:bob@acme.test"]);
    expect(await scopes("alice")).toEqual(["account:alice@acme.test"]);
    expect(await scopes("carol")).toEqual([]);
    expect(await scopes("dave")).toEqual([]);
  });

  it("follows the role: upgraded bob reads the full unit, downgraded he is back to his own view; outage keeps per-mailbox views", async () => {
    bobRevisions = true;
    await report();
    expect((await read("bob", `${SHARED}/history/operations.jsonl`)).content).toContain("needle-writer-ot");
    bobRevisions = false;
    await report();
    expect((await read("bob", `${SHARED}/history/operations.jsonl`)).code).toBe("not_found");
    expect((await read("bob", `${BOB_VIEW}/tabs/t.0.md`)).content).toContain("needle-bob-view-text");

    failAttribution = true;
    await report();
    try {
      // No attribution: no shared unit and no listing of google-docs; bob's own mailbox-attributed view is like his mail.
      expect((await tool("bob", "ls", { path: "$SOURCES/google-docs" })).code).toBe("not_found");
      expect((await read("bob", `${BOB_DOC}/native/document.json`)).code).toBe("not_found");
      expect((await read("bob", `${BOB_VIEW}/tabs/t.0.md`)).content).toContain("needle-bob-view-text");
      expect((await read("alice", `${BOB_VIEW}/tabs/t.0.md`)).code).toBe("not_found");
    } finally {
      failAttribution = false;
      await report();
    }
  });
});
