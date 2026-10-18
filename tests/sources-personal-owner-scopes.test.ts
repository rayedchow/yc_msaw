import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { tenantNsFor } from "../src/auth/tenant.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";
import { personalSegment, providerOwners, SourceViewer } from "../src/sources/access.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * Personal owner segments (personal-connection-attribution): connected personal accounts, personal Nango sources and
 * owner-scoped devices are published by the runtime under `<provider>/<owner segment>/`, the segment derived from the
 * verified principal on both sides. A member reads exactly their own segment; other members' segments and anything
 * unsegmented (captured before owner scopes) are not theirs. Synthetic data only.
 */

const alice = { subject: "user_alice", issuer: "https://issuer.test" };
const bob = { subject: "user_bob", issuer: "https://issuer.test" };
const NS = "t-0123456789abcdef0123";

describe("owner-segment access rules", () => {
  const segA = personalSegment(NS, alice);
  const segB = personalSegment(NS, bob);

  it("derives the same segment as the runtime, per tenant and principal", async () => {
    const runtime = await import(/* @vite-ignore */ "../packages/sources-runtime/src/source-lane/core/personal-scope.js");
    expect(runtime.personalSegment({ tenantNs: NS, ...alice })).toBe(segA);
    expect(segA).toMatch(/^@u-[0-9a-f]{24}$/);
    expect(segA).not.toBe(segB);
    expect(personalSegment("t-other", alice)).not.toBe(segA);
    expect(personalSegment(NS, { ...alice, issuer: "https://other-issuer.test" })).not.toBe(segA);
  });

  it("serves connect-owned and personal Nango providers per segment, and nothing unsegmented", () => {
    const v = new SourceViewer(alice, { providerOwners: new Map(), googleAccounts: [], personalSegment: segA, personalDirs: ["granola", "outlook"] });
    for (const p of ["granola", "outlook"]) {
      expect(v.access(p)).toBe("mixed");
      expect(v.access(`${p}/${segA}/x/y.json`)).toBe("allow");
      expect(v.access(`${p}/${segB}/x/y.json`)).toBe("deny");
      expect(v.access(`${p}/Legacy-meeting-1/summary.md`)).toBe("deny");
      expect(v.access(`${p}/_raw/tenant/x.json`)).toBe("deny");
    }
    // Without a subtree of their own, the provider directory is not even listed (no "a colleague uses X" hint).
    expect(v.access("zoom")).toBe("deny");
    expect(v.access(`zoom/${segA}/m/summary.md`)).toBe("allow");
    // Declared shared by the operator: the whole provider, for everyone (explicit organization policy).
    const shared = new SourceViewer(bob, { providerOwners: new Map(), googleAccounts: [], personalSegment: segB, sharedProviders: ["outlook"] });
    expect(shared.access("outlook/acme-outlook/conn/1.json")).toBe("allow");
    // Coverage: only the caller's own owner scope.
    expect(v.coverageVisible("outlook", { scope: `owner:${segA}/nango:acme-outlook:conn:OutlookMessage` })).toBe(true);
    expect(v.coverageVisible("outlook", { scope: `owner:${segB}/nango:acme-outlook:conn:OutlookMessage` })).toBe(false);
    expect(v.coverageVisible("granola", { scope: "account:api-key" })).toBe(false);
    expect(v.personalDir("granola")).toBe(`granola/${segA}`);
    // Google and shared workspace providers keep their own rules.
    expect(v.access(`gmail/${segA}/x.md`)).toBe("deny");
    expect(v.access("jira/ACME-1.md")).toBe("allow");
  });

  it("keeps legacy device data with its single legacy enroller; owner-segment devices own only their segment", () => {
    const legacy = { kind: "device" as const, providers: ["imessage"], createdBy: alice, enrolmentFailed: false };
    const scoped = { kind: "device" as const, providers: ["imessage"], createdBy: bob, enrolmentFailed: false, layout: "owner-segment" as const };
    const owners = providerOwners([legacy, scoped]);
    expect(owners.get("imessage")).toEqual([alice]); // bob's owner-segment Mac does not make the legacy directory ambiguous
    const a = new SourceViewer(alice, { providerOwners: owners, googleAccounts: [], personalSegment: segA });
    const b = new SourceViewer(bob, { providerOwners: owners, googleAccounts: [], personalSegment: segB, personalDirs: ["imessage"] });
    expect(a.access("imessage")).toBe("mixed");
    expect(a.access("imessage/Mom-chat-1/2026-10.md")).toBe("allow");
    expect(a.access(`imessage/${segB}/Mom-chat-1/2026-10.md`)).toBe("deny");
    expect(b.access("imessage/Mom-chat-1/2026-10.md")).toBe("deny");
    expect(b.access(`imessage/${segB}/Mom-chat-1/2026-10.md`)).toBe("allow");
    expect(b.coverageVisible("imessage", { scope: `owner:${segB}/device:sb-1:messages` })).toBe(true);
    expect(b.coverageVisible("imessage", { scope: "device:sb-0:messages" })).toBe(false);
    expect(a.coverageVisible("imessage", { scope: "device:sb-0:messages" })).toBe(true);
    // Only owner-segment devices: nobody owns the provider directory itself.
    const none = new SourceViewer(bob, { providerOwners: providerOwners([scoped]), googleAccounts: [], personalSegment: segB, personalDirs: ["imessage"] });
    expect(none.access("imessage/Old-chat/2026-01.md")).toBe("deny");
  });
});

// ---------------------------------------------------------------- real app: personal Nango output over MCP

let issuer: MockIssuer;
let app: App;
let dir: string;
let base: string;
let mcpUrl: string;
let fakeRuntime: Server;
let runtimeToken = "";
const tok: Record<string, string> = {};
const clients: Client[] = [];

async function tool(who: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const c = new Client({ name: `pos-${who}`, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
  clients.push(c);
  const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text) as Record<string, any>;
}
const http = (method: string, route: string, token: string, body?: unknown) =>
  fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
function put(p: string, content: string) {
  const bytes = Buffer.from(content);
  return { op: "put", path: p, kind: "raw", contentType: "application/json", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString() };
}

describe("personal Nango source output through the real app", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sources-personal-owner-scopes-"));
    fakeRuntime = createHttpServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "PUT" && /\/binding$/.test(req.url ?? "")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        runtimeToken = (JSON.parse(raw) as { token: string }).token;
        return void res.writeHead(200).end("{}");
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => fakeRuntime.listen(0, "127.0.0.1", r));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const resource = `http://127.0.0.1:${port}/mcp`;
    issuer = await startMockIssuer();
    app = await createApp({
      env: {
        HOST: "127.0.0.1", PORT: "0", AUTH_MODE: "oidc", MCP_PUBLIC_URL: resource, OIDC_ISSUER: issuer.issuer,
        PROCMEM_ADMIN_SUBJECTS: "user_alice", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir,
        SOURCES_RUNTIME_URL: `http://127.0.0.1:${(fakeRuntime.address() as { port: number }).port}/internal/v1`,
        SOURCES_RUNTIME_SERVICE_TOKEN: "synthetic-runtime-service-token-0123456789", SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`,
      },
      store: new DirectoryObjectStore(path.join(dir, "objects")),
      builder: async () => { throw new Error("no builds"); },
      leaseFactory: async () => { throw new Error("$SOURCES reads never open a sandbox"); },
      log: () => undefined,
    });
    ({ url: base, mcpUrl } = await app.listen(port));
    for (const who of ["alice", "bob", "carol"]) tok[who] = await issuer.mint({ sub: `user_${who}`, aud: resource, scope: "openid", claims: { org_id: "org_acme" } });
    expect((await http("POST", "/v1/sources/runtime/provision", tok.alice!)).status).toBe(201);
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await app?.close();
    await issuer?.close();
    await new Promise<void>((r) => fakeRuntime.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each member's own Outlook segment only; legacy (unsegmented) records stay sealed", async () => {
    const ns = tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });
    const seg = (who: string) => personalSegment(ns, { subject: `user_${who}`, issuer: issuer.issuer });
    const rec = "acme-outlook/conn-x/OutlookMessage/m1.json";
    const r = await http("POST", "/v1/sources/publish", runtimeToken, {
      batchId: "outlook-1",
      changes: [
        put(`sources/outlook/${seg("bob")}/${rec}`, '{"subject":"bob mail needle-out-bob"}'),
        put(`sources/outlook/${seg("carol")}/${rec}`, '{"subject":"carol mail needle-out-carol"}'),
        put(`sources/outlook/${rec}`, '{"subject":"legacy org-level mail needle-out-legacy"}'),
      ],
    });
    expect(r.status).toBe(200);
    for (const [who, other] of [["bob", "carol"], ["carol", "bob"]] as const) {
      expect((await tool(who, "ls", { path: "$SOURCES/outlook" })).entries.map((e: any) => e.name)).toEqual([`${seg(who)}/`]);
      expect((await tool(who, "read", { path: `$SOURCES/outlook/${seg(who)}/${rec}` })).content).toContain(`needle-out-${who}`);
      expect((await tool(who, "read", { path: `$SOURCES/outlook/${seg(other)}/${rec}` })).code).toBe("not_found");
      expect((await tool(who, "read", { path: `$SOURCES/outlook/${rec}` })).code).toBe("not_found");
      expect((await tool(who, "sources_history", { path: `$SOURCES/outlook/${rec}` })).versions).toEqual([]);
      const hits = (await tool(who, "grep", { path: "$SOURCES", pattern: "needle-out-[a-z]+" })).matches.map((m: any) => m.path);
      expect(hits).toEqual([`$SOURCES/outlook/${seg(who)}/${rec}`]);
    }
    // An admin with no Outlook of her own reads none of it, and is not even shown the directory.
    expect((await tool("alice", "ls", { path: "$SOURCES" })).entries.map((e: any) => e.name)).not.toContain("outlook/");
    expect((await tool("alice", "grep", { path: "$SOURCES", pattern: "needle-out-[a-z]+" })).matches).toEqual([]);
  });
});
