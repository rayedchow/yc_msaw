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
 * View-only Google accounts read their OWN current Sheets, Slides, Drive files and PDFs (and the comments Google returns
 * to them), never the writer's units. alice writes the budget sheet and owns the contract PDF (full units: every byte
 * version, the permission list, the comment ledger); bob may only comment on the sheet and read the PDF, so the runtime
 * attributes both to him with `revisions:false` (withheld) and captured his own views under his own credential into
 * google-docs/_accounts/bob@acme.test/_drive/... (runtime account-capture.ts / account-files.ts). erin's only Google
 * file is the contract PDF, view-only. carol has no Google account. A loopback fake runtime implements the contract.
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
const tok: Record<"alice" | "bob" | "carol" | "erin", string> = { alice: "", bob: "", carol: "", erin: "" };
const mcp: Partial<Record<keyof typeof tok, Client>> = {};

const SHEET_UNIT = "google-docs/_drive/sheets/budget-aaaaaaaaaaaa";
const PDF_UNIT = "binary/drive-pdf/pdf-1";
const LEDGER = "google-docs/_raw/document:sheet-1";
const BOB_SHEET = "google-docs/_accounts/bob@acme.test/_drive/sheets/budget-aaaaaaaaaaaa";
const BOB_DECK = "google-docs/_accounts/bob@acme.test/_drive/slides/pitch-dddddddddddd";
const BOB_PDF = "google-docs/_accounts/bob@acme.test/_drive/pdf/contract-pdf-pppppppppppp";
const ERIN_PDF = "google-docs/_accounts/erin@acme.test/_drive/pdf/contract-pdf-pppppppppppp";

let bobRevisions = false;
const units = (subject: string) => {
  if (subject === "user_alice") return [
    { path: SHEET_UNIT, accounts: ["alice@acme.test"], revisions: true },
    { path: LEDGER, accounts: ["alice@acme.test"], revisions: true },
    { path: PDF_UNIT, accounts: ["alice@acme.test"], revisions: true },
  ];
  if (subject === "user_bob") return [
    { path: SHEET_UNIT, accounts: ["bob@acme.test"], revisions: bobRevisions },
    { path: LEDGER, accounts: ["bob@acme.test"], revisions: bobRevisions },
    { path: PDF_UNIT, accounts: ["bob@acme.test"], revisions: false },
  ];
  // erin's only Google file is the contract PDF, view-only: a binary/drive-pdf unit.
  if (subject === "user_erin") return [{ path: PDF_UNIT, accounts: ["erin@acme.test"], revisions: false }];
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
      { provider: "google-docs", scope: "drive-files", state: "partial", reason: "tenant-wide: 2 files" },
      { provider: "google-docs", scope: "account:bob@acme.test", state: "complete", reason: "current view of the Docs, Sheets, Slides, Drive files and PDFs this account may only read or comment on", counts: { complete: 3, sheets: 1, slides: 1, pdfs: 1 } },
      { provider: "google-docs", scope: "account:erin@acme.test", state: "blocked", reason: "copy_restricted_for_account", counts: { complete: 1, pdfs: 1 } },
    ],
    runtime: { reportIntervalSeconds: 300 },
    googleAccounts: [
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "bob@acme.test", subject: "user_bob", issuer: issuer.issuer },
      { account: "erin@acme.test", subject: "user_erin", issuer: issuer.issuer },
    ],
  });
  expect(r.status).toBe(200);
}

async function tool(who: keyof typeof tok, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  if (!mcp[who]) {
    const c = new Client({ name: `native-${who}`, version: "1" });
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
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-google-native-"));
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
  // Alice's shared units: two byte versions of the sheet export (the first is an "old writer version" bob must never get),
  // the permission list, the comment ledger, and the shared PDF unit with its byte history.
  await publish("writer-v1", [
    put(`sources/${SHEET_UNIT}/content/Budget.xlsx`, "XLSX needle-writer-sheet-v1\n", "binary"),
    put(`sources/${PDF_UNIT}/current.pdf`, "%PDF needle-writer-pdf-v1\n", "binary"),
  ]);
  await publish("writer-v2", [
    put(`sources/${SHEET_UNIT}/content/Budget.xlsx`, "XLSX needle-writer-sheet-v2\n", "binary"),
    put(`sources/${SHEET_UNIT}/native.json`, "{\"grid\":\"needle-writer-native\"}\n", "raw"),
    put(`sources/${SHEET_UNIT}/drive.json`, "{\"permissions\":\"needle-writer-permissions\"}\n", "raw"),
    put(`sources/${LEDGER}/comment:c9/2026-10/gdocs:c9.json`, "{\"comment\":\"needle-writer-private-comment\"}\n", "raw"),
    put(`sources/${PDF_UNIT}/current.pdf`, "%PDF needle-writer-pdf-v2\n", "binary"),
    put(`sources/${PDF_UNIT}/versions/20261001T000000Z-aaaa.pdf`, "%PDF needle-writer-pdf-v1\n", "binary"),
  ]);
  // Bob's own views, captured under bob's credential (two of his own sheet captures).
  await publish("bob-v1", [put(`sources/${BOB_SHEET}/content/Budget.xlsx`, "XLSX needle-bob-sheet-v1\n", "binary")]);
  await publish("bob-v2", [
    put(`sources/${BOB_SHEET}/content/Budget.xlsx`, "XLSX needle-bob-sheet-current\n", "binary"),
    put(`sources/${BOB_SHEET}/native.json`, "{\"grid\":\"needle-bob-native\"}\n", "raw"),
    put(`sources/${BOB_SHEET}/comments.json`, "{\"comments\":[\"needle-bob-visible-comment\"]}\n", "raw"),
    put(`sources/${BOB_SHEET}/drive.json`, "{\"capabilities\":{\"canReadRevisions\":false},\"x\":\"needle-bob-drive\"}\n", "raw"),
    put(`sources/${BOB_DECK}/content/Pitch.pptx`, "PPTX needle-bob-deck\n", "binary"),
    put(`sources/${BOB_PDF}/content/Contract.pdf`, "%PDF needle-bob-pdf\n", "binary"),
    // erin's PDF is download-restricted for her: metadata only.
    put(`sources/${ERIN_PDF}/drive.json`, "{\"name\":\"Contract.pdf\",\"x\":\"needle-erin-drive\"}\n", "raw"),
    put(`sources/${ERIN_PDF}/capture.json`, "{\"state\":\"blocked\",\"reason\":\"copy_restricted_for_account\"}\n", "projection"),
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

describe("view-only accounts read their own Sheets, Slides and PDFs and nothing of the writer's units", () => {
  it("bob reads his own current sheet, deck, PDF and comments, and his own earlier sheet capture", async () => {
    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["_accounts/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs/_accounts" }))).toEqual(["bob@acme.test/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES/google-docs/_accounts/bob@acme.test/_drive" }))).toEqual(["pdf/", "sheets/", "slides/"]);
    expect((await read("bob", `${BOB_SHEET}/content/Budget.xlsx`)).content).toContain("needle-bob-sheet-current");
    expect((await read("bob", `${BOB_SHEET}/comments.json`)).content).toContain("needle-bob-visible-comment");
    expect((await read("bob", `${BOB_PDF}/content/Contract.pdf`)).content).toContain("needle-bob-pdf");
    expect(await grep("bob")).toEqual([
      `${BOB_SHEET}/comments.json`, `${BOB_SHEET}/content/Budget.xlsx`, `${BOB_SHEET}/drive.json`, `${BOB_SHEET}/native.json`,
      `${BOB_PDF}/content/Contract.pdf`, `${BOB_DECK}/content/Pitch.pptx`,
    ].sort());
    expect((await tool("bob", "sources_history", { path: `$SOURCES/${BOB_SHEET}/content/Budget.xlsx` })).versions).toHaveLength(2);
  });

  it("an owner whose only Google file is a view-only PDF still finds, lists and greps her own view", async () => {
    expect(names(await tool("erin", "ls", { path: "$SOURCES" }))).toEqual(["google-docs/"]);
    expect(names(await tool("erin", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["_accounts/"]);
    expect(names(await tool("erin", "ls", { path: "$SOURCES/google-docs/_accounts" }))).toEqual(["erin@acme.test/"]);
    expect(await grep("erin")).toEqual([`${ERIN_PDF}/drive.json`]);
    // Download-restricted for her: no bytes were captured, and the writer's shared PDF unit is not lent to her.
    for (const p of [`${ERIN_PDF}/content/Contract.pdf`, `${PDF_UNIT}/current.pdf`, `${PDF_UNIT}/versions/20261001T000000Z-aaaa.pdf`]) expect((await read("erin", p)).code, p).toBe("not_found");
  });

  it("bob gets none of alice's byte versions, native grid, permissions, private comment ledger, PDF unit or erin's view", async () => {
    for (const p of [
      `${SHEET_UNIT}/content/Budget.xlsx`, `${SHEET_UNIT}/native.json`, `${SHEET_UNIT}/drive.json`,
      `${LEDGER}/comment:c9/2026-10/gdocs:c9.json`, `${PDF_UNIT}/current.pdf`, `${PDF_UNIT}/versions/20261001T000000Z-aaaa.pdf`,
      `${ERIN_PDF}/drive.json`,
    ]) expect((await read("bob", p)).code, p).toBe("not_found");
    const writer = await tool("alice", "sources_history", { path: `$SOURCES/${SHEET_UNIT}/content/Budget.xlsx` });
    expect(writer.versions).toHaveLength(2);
    for (const v of writer.versions) {
      expect((await tool("bob", "sources_history", { path: `$SOURCES/${SHEET_UNIT}/content/Budget.xlsx`, versionId: v.versionId })).code).toBe("not_found");
    }
    expect(names(await tool("bob", "ls", { path: "$SOURCES" }))).not.toContain("binary/");
    const st = JSON.stringify(await tool("bob", "sources_status", {}));
    expect(st).not.toContain("alice@acme.test");
    expect(st).not.toContain("erin@acme.test");
  });

  it("alice keeps her full units (byte history, permissions, comment ledger, PDF versions) and reads no account view", async () => {
    expect((await read("alice", `${SHEET_UNIT}/drive.json`)).content).toContain("needle-writer-permissions");
    expect((await read("alice", `${LEDGER}/comment:c9/2026-10/gdocs:c9.json`)).content).toContain("needle-writer-private-comment");
    expect((await read("alice", `${PDF_UNIT}/versions/20261001T000000Z-aaaa.pdf`)).content).toContain("needle-writer-pdf-v1");
    for (const p of [`${BOB_SHEET}/content/Budget.xlsx`, `${BOB_PDF}/content/Contract.pdf`, `${ERIN_PDF}/drive.json`]) expect((await read("alice", p)).code, p).toBe("not_found");
    expect(names(await tool("alice", "ls", { path: "$SOURCES/google-docs" }))).toEqual(["_drive/", "_raw/"]);
  });

  it("carol (no Google account) sees nothing and costs no runtime call; account coverage goes to its owner only", async () => {
    const before = attributionCalls.filter((s) => s === "user_carol").length;
    expect(names(await tool("carol", "ls", { path: "$SOURCES" }))).toEqual([]);
    for (const p of [`${BOB_SHEET}/content/Budget.xlsx`, `${ERIN_PDF}/drive.json`, `${PDF_UNIT}/current.pdf`]) expect((await read("carol", p)).code).toBe("not_found");
    expect(await grep("carol")).toEqual([]);
    expect(attributionCalls.filter((s) => s === "user_carol").length).toBe(before);
    const scopes = async (who: keyof typeof tok) => ((await tool(who, "sources_status", {})).providers.find((p: any) => p.provider === "google-docs")?.coverage ?? []).map((c: any) => c.scope);
    expect(await scopes("bob")).toEqual(["account:bob@acme.test"]);
    expect(await scopes("erin")).toEqual(["account:erin@acme.test"]);
    expect(await scopes("carol")).toEqual([]);
  });

  it("follows the role: upgraded bob reads alice's full sheet unit; downgraded he is back to his own view", async () => {
    bobRevisions = true;
    await report();
    expect((await read("bob", `${SHEET_UNIT}/content/Budget.xlsx`)).content).toContain("needle-writer-sheet-v2");
    expect((await read("bob", `${PDF_UNIT}/current.pdf`)).code).toBe("not_found");
    bobRevisions = false;
    await report();
    expect((await read("bob", `${SHEET_UNIT}/content/Budget.xlsx`)).code).toBe("not_found");
    expect((await read("bob", `${BOB_SHEET}/content/Budget.xlsx`)).content).toContain("needle-bob-sheet-current");
  });
});
