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
 * Owner-only Google data without the "owns every Google account" rule (owner audit F4/F5): alice, bob, carol and
 * dana are verified members of one organization. Google Docs/Drive dirs and Drive PDFs carry no mailbox in their
 * path; the runtime attributes each to the owners of the mailboxes that see it in Drive (asked as the viewer, over
 * the service-token internal API; a loopback fake runtime implements that contract here, the real query is tested
 * in the runtime package). dana's mailbox is domain-wide-delegation only and was proven with the identity-only
 * Google sign-in, so the collector reports her as its owner while it stays collected by DWD.
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
const ownershipStarts: Array<{ principal: Record<string, unknown>; body: unknown }> = [];
const tok: Record<"alice" | "bob" | "carol" | "dana", string> = { alice: "", bob: "", carol: "", dana: "" };
const mcp: Partial<Record<keyof typeof tok, Client>> = {};

const DOC_A = "google-docs/Alice-plan-doc-aaaaaaaaaaaa";
const DOC_B = "google-docs/Bob-notes-doc-bbbbbbbbbbbb";
const SHARED = "google-docs/Shared-roadmap-doc-ssssssssssss";
const LEGACY = "google-docs/Legacy-doc-llllllllllll";
const SHEET_B = "google-docs/_drive/sheets/bob-budget-bbbbbbbbbbbb";

const UNITS: Record<string, Array<{ path: string; accounts: string[]; revisions: boolean }>> = {
  user_alice: [
    { path: DOC_A, accounts: ["alice@acme.test"], revisions: true },
    { path: "google-docs/_raw/document:doc-a", accounts: ["alice@acme.test"], revisions: true },
    { path: SHARED, accounts: ["alice@acme.test"], revisions: false }, // view-only for alice: withheld
    { path: "binary/drive-pdf/pdf-a", accounts: ["alice@acme.test"], revisions: true },
  ],
  user_bob: [
    { path: DOC_B, accounts: ["bob@acme.test"], revisions: true },
    { path: SHARED, accounts: ["bob@acme.test"], revisions: true },
    { path: SHEET_B, accounts: ["bob@acme.test"], revisions: true },
  ],
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

function put(p: string, content: string) {
  const bytes = Buffer.from(content);
  return { op: "put", path: p, kind: "projection", contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString() };
}

async function publish(batchId: string, changes: unknown[]) {
  expect((await http("POST", "/v1/sources/publish", runtimeToken, { batchId, changes })).status).toBe(200);
}

async function report() {
  const r = await http("POST", "/v1/sources/status-report", runtimeToken, {
    providers: [{ provider: "google-docs", scope: "drive", state: "partial", reason: "inventory running" }],
    runtime: { reportIntervalSeconds: 300 },
    googleAccounts: [
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "bob@acme.test", subject: "user_bob", issuer: issuer.issuer },
      { account: "dana@acme.test", subject: "user_dana", issuer: issuer.issuer }, // DWD mailbox, ownership proof
      { account: "legacy@acme.test", subject: null, issuer: null }, // DWD mailbox nobody proved
    ],
  });
  expect(r.status).toBe(200);
}

async function tool(who: keyof typeof tok, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  if (!mcp[who]) {
    const c = new Client({ name: `attr-${who}`, version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
    mcp[who] = c;
  }
  const r = (await mcp[who]!.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...(JSON.parse(r.content[0]!.text) as Record<string, any>), isError: r.isError === true };
}
const names = (ls: Record<string, any>) => (ls.entries ?? []).map((e: any) => e.name);
const read = async (who: keyof typeof tok, p: string) => tool(who, "read", { path: `$SOURCES/${p}` });

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-google-attr-"));
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
      if (!(principal.scopes as string[] | undefined)?.includes("memory:read") || principal.issuer !== issuer.issuer) return void res.writeHead(403).end("{}");
      return void res.writeHead(200).end(JSON.stringify({ schema: "procmem.google-attribution/v1", accounts: [], units: UNITS[String(principal.subject)] ?? [], truncated: false }));
    }
    if (req.method === "POST" && /\/google\/auth\/ownership\/start$/.test(url)) {
      ownershipStarts.push({ principal, body: JSON.parse(raw || "{}") });
      return void res.writeHead(201).end(JSON.stringify({ mode: "oauth_direct", launchUrl: "https://runtime.example.test/auth/google/oauth/launch?state=s", expectedEmail: "dana@acme.test", scopes: [] }));
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
  await publish("seed", [
    put(`sources/${DOC_A}/native/document.json`, "{\"title\":\"needle-doc-a\"}\n"),
    put(`sources/${DOC_A}/history/operations.jsonl`, "{\"op\":\"needle-doc-a-history\"}\n"),
    put(`sources/${DOC_B}/native/document.json`, "{\"title\":\"needle-doc-b\"}\n"),
    put(`sources/${SHARED}/native/document.json`, "{\"title\":\"needle-shared\"}\n"),
    put(`sources/${SHARED}/history/operations.jsonl`, "{\"op\":\"needle-shared-history\"}\n"),
    put(`sources/${LEGACY}/native/document.json`, "{\"title\":\"needle-legacy\"}\n"),
    put(`sources/${SHEET_B}/drive.json`, "{\"name\":\"needle-sheet-b\"}\n"),
    put("sources/google-docs/_raw/document:doc-a/comment:c1/2026-10/gdocs:c1.json", "{\"comment\":\"needle-comment-a\"}\n"),
    put("sources/google-docs/_raw/_/_/2026-10/gdocs:edit-1.json", "{\"edit\":\"needle-unattributed-edit\"}\n"),
    put("sources/binary/drive-pdf/pdf-a/current.pdf", "%PDF needle-pdf-a\n"),
    put("sources/binary/drive-pdf/pdf-l/current.pdf", "%PDF needle-pdf-legacy\n"),
    put("sources/gmail/dana@acme.test/messages/2026-10/m1/message.md", "dana dwd mail: needle-dana\n"),
    put("sources/gmail/legacy@acme.test/messages/2026-10/m1/message.md", "legacy dwd mail: needle-legacy-mail\n"),
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

describe("Google-wide units are read by the owners of the mailboxes that see them", () => {
  it("two members each read their own Docs/Drive/PDF units (incl. history and comments); view-only, legacy and unattributed stay sealed", async () => {
    expect(names(await tool("alice", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["Alice-plan-doc-aaaaaaaaaaaa/", "_raw/"]);
    expect((await read("alice", `${DOC_A}/native/document.json`)).content).toContain("needle-doc-a");
    expect((await read("alice", `${DOC_A}/history/operations.jsonl`)).content).toContain("needle-doc-a-history");
    expect((await read("alice", "google-docs/_raw/document:doc-a/comment:c1/2026-10/gdocs:c1.json")).content).toContain("needle-comment-a");
    expect(names(await tool("alice", "ls", { path: "$SOURCES/binary/drive-pdf" }))).toEqual(["pdf-a/"]);
    expect((await read("alice", "binary/drive-pdf/pdf-a/current.pdf")).content).toContain("needle-pdf-a");
    for (const p of [`${DOC_B}/native/document.json`, `${SHARED}/native/document.json`, `${SHARED}/history/operations.jsonl`, `${LEGACY}/native/document.json`, `${SHEET_B}/drive.json`, "binary/drive-pdf/pdf-l/current.pdf", "google-docs/_raw/_/_/2026-10/gdocs:edit-1.json"]) {
      expect((await read("alice", p)).code, p).toBe("not_found");
    }
    const aliceGrep = (await tool("alice", "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" })).matches.map((m: any) => m.path).sort();
    expect(aliceGrep).toEqual([
      "$SOURCES/binary/drive-pdf/pdf-a/current.pdf",
      `$SOURCES/${DOC_A}/history/operations.jsonl`,
      `$SOURCES/${DOC_A}/native/document.json`,
      "$SOURCES/google-docs/_raw/document:doc-a/comment:c1/2026-10/gdocs:c1.json",
    ]);

    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["Bob-notes-doc-bbbbbbbbbbbb/", "Shared-roadmap-doc-ssssssssssss/", "_drive/"]);
    expect((await read("bob", `${SHARED}/history/operations.jsonl`)).content).toContain("needle-shared-history");
    expect((await read("bob", `${SHEET_B}/drive.json`)).content).toContain("needle-sheet-b");
    expect((await read("bob", `${DOC_A}/native/document.json`)).code).toBe("not_found");
    expect((await tool("bob", "ls", { path: "$SOURCES/binary" })).code).toBe("not_found");

    // History follows the same unit boundary.
    const own = await tool("alice", "sources_history", { path: `$SOURCES/${DOC_A}/native/document.json` });
    expect(own.versions).toHaveLength(1);
    expect((await tool("bob", "sources_history", { path: `$SOURCES/${DOC_A}/native/document.json` })).versions).toEqual([]);
    expect((await tool("bob", "sources_history", { path: `$SOURCES/${DOC_A}/native/document.json`, versionId: own.versions[0].versionId })).code).toBe("not_found");
    // Directory totals of a partly readable provider are withheld.
    expect((await tool("alice", "ls", { path: "$SOURCES/google-docs" })).liveFiles).toBeNull();
  });

  it("a member with no proven Google account sees no Google data and costs no runtime call; a DWD owner reads their own mailbox", async () => {
    const before = attributionCalls.filter((s) => s === "user_carol").length;
    expect(names(await tool("carol", "ls", { path: "$SOURCES" }))).toEqual([]);
    expect((await read("carol", `${DOC_A}/native/document.json`)).code).toBe("not_found");
    expect(attributionCalls.filter((s) => s === "user_carol").length).toBe(before);
    // dana proved her DWD mailbox (identity-only sign-in): her mail is hers, legacy@ (unproven DWD) is nobody's.
    expect((await read("dana", "gmail/dana@acme.test/messages/2026-10/m1/message.md")).content).toContain("needle-dana");
    expect((await read("dana", "gmail/legacy@acme.test/messages/2026-10/m1/message.md")).code).toBe("not_found");
    expect(names(await tool("dana", "ls", { path: "$SOURCES/gmail" }))).toEqual(["dana@acme.test/"]);
  });

  it("fails closed when the runtime cannot attribute: no Google-wide unit, per-mailbox data unaffected", async () => {
    failAttribution = true;
    await report(); // new heartbeat: cached attributions are dropped
    try {
      expect((await read("alice", `${DOC_A}/native/document.json`)).code).toBe("not_found");
      expect((await tool("alice", "ls", { path: "$SOURCES/google-docs" })).code).toBe("not_found");
      expect((await read("dana", "gmail/dana@acme.test/messages/2026-10/m1/message.md")).content).toContain("needle-dana");
    } finally {
      failAttribution = false;
      await report();
    }
    expect((await read("alice", `${DOC_A}/native/document.json`)).content).toContain("needle-doc-a");
  });

  it("caches per principal like owner evidence (one runtime call per principal per heartbeat/TTL)", async () => {
    await report();
    const n = attributionCalls.length;
    for (let i = 0; i < 5; i++) await read("alice", `${DOC_A}/native/document.json`);
    expect(attributionCalls.length - n).toBe(1);
  });

  it("any plain member starts their own identity-only ownership proof; the runtime gets the verified principal, not a body", async () => {
    const r = await http("POST", "/v1/sources/google/auth/ownership/start", tok.carol, { account: "self" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).scopes).toEqual([]);
    expect(ownershipStarts.at(-1)!.principal).toMatchObject({ subject: "user_carol", issuer: issuer.issuer, scopes: expect.arrayContaining(["memory:read"]) });
    expect((await http("POST", "/v1/sources/google/auth/ownership/start", tok.carol, { account: "self", tenantNs: "t-other" })).status).toBe(400);
    expect((await http("POST", "/v1/sources/google/auth/ownership/start", "not-a-token", {})).status).toBe(401);
  });
});
