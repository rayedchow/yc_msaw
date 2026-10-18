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
 * Owner-only personal sources (src/sources/access.ts) over the real app and MCP, with WorkOS-style OIDC tokens:
 * alice, bob and carol are three verified members of ONE organization (same org_id, so one tenant namespace).
 * alice and bob are admins. Personal data (mail, Docs, Messages, notes) is served only to its owner, through
 * every verb (ls/find/grep/read/sources_history/sources_status and the admin status route); shared providers
 * stay readable by everyone; unowned or ambiguous personal data is readable by nobody. A loopback fake source
 * runtime accepts device enrolment and connects. Synthetic data only.
 */

let resource: string;
let issuer: MockIssuer;
let app: App;
let dir: string;
let base: string;
let mcpUrl: string;
let fakeRuntime: Server;
let runtimeToken: string;
let provisioned = "";
const connectedProviders = new Set<string>(["zoom"]); // zoom: connected before owners were recorded (legacy)
let failNextCodingEnrol = false;
let failStatus = false;
const tok: Record<"alice" | "bob" | "carol" | "outsider", string> = { alice: "", bob: "", carol: "", outsider: "" };
const mcp: Partial<Record<keyof typeof tok, Client>> = {};

const ALICE_MAIL = "sources/gmail/alice@acme.test/messages/2026-10/m1/message.md";
const BOB_MAIL = "sources/gmail/bob@acme.test/messages/2026-10/m2/message.md";

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
  const r = await http("POST", "/v1/sources/publish", runtimeToken, { batchId, changes });
  expect(r.status).toBe(200);
}

async function report(googleAccounts?: Array<{ account: string; subject: string | null; issuer: string | null }>) {
  const now = new Date().toISOString();
  const r = await http("POST", "/v1/sources/status-report", runtimeToken, {
    providers: [
      { provider: "gmail", scope: "mailbox:alice@acme.test", state: "complete", lastSuccessAt: now },
      { provider: "gmail", scope: "mailbox:bob@acme.test", state: "partial", reason: "bob@acme.test backfill running", lastSuccessAt: now },
      { provider: "gmail", scope: "export", state: "pending", reason: "7 change(s) waiting to be exported" },
      { provider: "granola", scope: "notes", state: "complete", lastSuccessAt: now },
      { provider: "jira", scope: "site:acme", state: "complete", lastSuccessAt: now },
    ],
    runtime: { reportIntervalSeconds: 300 },
    ...(googleAccounts ? { googleAccounts } : {}),
  });
  expect(r.status).toBe(200);
}

async function client(who: keyof typeof tok): Promise<Client> {
  if (mcp[who]) return mcp[who]!;
  const c = new Client({ name: `owner-acl-${who}`, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
  mcp[who] = c;
  return c;
}

async function tool(who: keyof typeof tok, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = (await (await client(who)).callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...(JSON.parse(r.content[0]!.text) as Record<string, any>), isError: r.isError === true };
}

const names = (ls: Record<string, any>) => (ls.entries ?? []).map((e: any) => e.name);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-owner-acl-"));
  // Fake source runtime: enrols devices and accepts connects; everything else 404.
  fakeRuntime = createHttpServer(async (req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "PUT" && /\/binding$/.test(url)) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      provisioned = (JSON.parse(raw) as { token: string }).token;
      return void res.writeHead(200).end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && /\/devices\/imessage$/.test(url)) return void res.writeHead(201).end(JSON.stringify({ device: { id: "dev-1" } }));
    if (req.method === "POST" && /\/connect\/granola$/.test(url)) {
      connectedProviders.add("granola");
      return void res.writeHead(200).end(JSON.stringify({ connected: true }));
    }
    if (req.method === "DELETE" && /\/devices\/[a-z-]+\/sb-[0-9a-f]{16}$/.test(url)) return void res.writeHead(200).end(JSON.stringify({ revoked: true }));
    if (req.method === "DELETE" && /\/connections\/(granola|cursor_background_agents)$/.test(url)) return void res.writeHead(200).end(JSON.stringify({ status: "revoked" }));
    if (req.method === "GET" && /\/status$/.test(url) && failStatus) return void res.writeHead(500).end(JSON.stringify({ connections: [{ provider: "google", external_account_id: "bob@acme.test" }] }));
    if (req.method === "GET" && /\/status$/.test(url)) {
      return void res.writeHead(200).end(JSON.stringify({
        tenantId: "t",
        connections: [
          { provider: "google", status: "active", external_account_id: "alice@acme.test" },
          { provider: "google", status: "active", external_account_id: "bob@acme.test" },
          ...[...connectedProviders].map((provider) => ({ provider, status: "active", external_account_id: null })),
          { provider: "jira", status: "active", external_account_id: "acme" },
        ],
        coverage: [
          { provider: "gmail", scope: "mailbox:alice@acme.test", state: "complete" },
          { provider: "gmail", scope: "mailbox:bob@acme.test", state: "partial" },
          { provider: "google-auth", scope: "account:bob@acme.test", state: "complete" },
          { provider: "granola", scope: "account:api-key", state: "complete" },
          { provider: "jira", scope: "site:acme", state: "complete" },
        ],
      }));
    }
    if (req.method === "GET" && /\/google\/auth$/.test(url)) {
      return void res.writeHead(200).end(JSON.stringify({
        accounts: [{ email: "alice@acme.test", authMode: "oauth_direct" }, { email: "bob@acme.test", authMode: "oauth_direct" }],
        pendingAuthorizations: [{ expectedEmail: "dave@acme.test" }],
        modes: { domain_wide_delegation: { configured: true, approved: { domains: ["acme.test"], mailboxes: ["ceo@acme.test"] }, directoryAdmin: "admin@acme.test" } },
      }));
    }
    if (req.method === "POST" && /\/devices\/coding-sessions$/.test(url)) {
      if (failNextCodingEnrol) {
        failNextCodingEnrol = false;
        return void res.writeHead(500).end(JSON.stringify({ error: "boom" }));
      }
      return void res.writeHead(201).end(JSON.stringify({ device: { id: "dev-cs" } }));
    }
    if (req.method === "POST" && /\/connect\/cursor_background_agents$/.test(url)) {
      connectedProviders.add("cursor_background_agents");
      return void res.writeHead(200).end(JSON.stringify({ connected: true }));
    }
    if (req.method === "POST" && /\/connect\/whatsapp_personal$/.test(url)) return void res.writeHead(400).end(JSON.stringify({ error: "invalid Unipile account" }));
    if (req.method === "POST" && /\/google\/auth\/oauth\/start$/.test(url)) return void res.writeHead(201).end(JSON.stringify({ launchUrl: "https://runtime.example.test/launch" }));
    if (req.method === "GET" && /\/office-audio\/consents$/.test(url)) return void res.writeHead(200).end(JSON.stringify({ consents: [{ participantKey: "p1" }] }));
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
      PROCMEM_ADMIN_SUBJECTS: "user_alice,user_bob", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir,
      SOURCES_RUNTIME_URL: `${runtimeUrl}/internal/v1`, SOURCES_RUNTIME_SERVICE_TOKEN: "synthetic-runtime-service-token-0123456789",
      SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`, SOURCES_DEVICE_API_URL: runtimeUrl,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => { throw new Error("no builds"); },
    leaseFactory: async () => { throw new Error("$SOURCES reads never open a sandbox"); },
    log: () => undefined,
  });
  ({ url: base, mcpUrl } = await app.listen(port));
  const mint = (sub: string, org: string) => issuer.mint({ sub, aud: resource, scope: "openid", claims: { org_id: org } });
  tok.alice = await mint("user_alice", "org_acme");
  tok.bob = await mint("user_bob", "org_acme");
  tok.carol = await mint("user_carol", "org_acme");
  tok.outsider = await mint("user_outsider", "org_other");

  // The collector's runtime binding: provisioned, so its token goes to the (fake) runtime and is never returned.
  const created = await http("POST", "/v1/sources/runtime/provision", tok.alice);
  expect(created.status).toBe(201);
  expect(JSON.stringify(await created.json())).not.toContain("psb_");
  runtimeToken = provisioned;
  expect(runtimeToken.startsWith("psb_")).toBe(true);
  await publish("seed", [
    put(ALICE_MAIL, "alice private mail: needle-alice\n"),
    put(BOB_MAIL, "bob private mail: needle-bob\n"),
    put("sources/google-docs/Plan-doc-1/document.md", "docs of two mailboxes: needle-docs\n"),
    put("sources/calendar/2026/10/standup.md", "donor month file mixing mailboxes: needle-cal\n"),
    put("sources/calendar/accounts/alice@acme.test/calendars/primary/events/e1.md", "alice event: needle-alice-cal\n"),
    put("sources/office-audio/2026-09/s1/transcript.md", "captured before owners were recorded: needle-legacy\n"),
    put("sources/slack/C1/2026-10-01.md", "team channel: needle-slack\n"),
    put("sources/slack/D0123ABCD/2026-10-01.md", "direct message: needle-dm\n"),
    put("sources/jira/ACME/ACME-1.md", "shared issue: needle-jira\n"),
    // The runtime's raw ledger for Gmail uses a `mailbox:` namespace (activity-event-source.ts).
    put("sources/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json", "{\"raw\":\"needle-alice-raw\"}\n"),
  ]);
});

afterAll(async () => {
  await Promise.allSettled(Object.values(mcp).map((c) => c!.close()));
  await app?.close();
  await issuer?.close();
  await new Promise<void>((r) => fakeRuntime.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe("owner-only personal sources for members of one organization", () => {
  it("fails closed before any owner is known: personal data is unreadable for every member, shared data is not", async () => {
    await report(); // a heartbeat without account owners
    for (const who of ["alice", "bob", "carol"] as const) {
      const root = await tool(who, "ls", { path: "$SOURCES" });
      expect(names(root)).toEqual(["jira/", "slack/"]);
      expect((await tool(who, "read", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` })).code).toBe("not_found");
      expect((await tool(who, "read", { path: "$SOURCES/jira/ACME/ACME-1.md" })).content).toContain("needle-jira");
    }
  });

  it("enrols each personal source to exactly one member and refuses a second owner", async () => {
    const aliceMac = await http("POST", "/v1/sources/devices/imessage/setup", tok.alice, {});
    expect(aliceMac.status).toBe(201);
    const bobMac = await http("POST", "/v1/sources/devices/imessage/setup", tok.bob, {});
    expect(bobMac.status).toBe(409);
    expect(((await bobMac.json()) as any).error.code).toBe("owner_conflict");
    // A second Mac of the same owner is fine.
    expect((await http("POST", "/v1/sources/devices/imessage/setup", tok.alice, { label: "second Mac" })).status).toBe(201);
    expect((await http("POST", "/v1/sources/connect/granola", tok.bob, { apiKey: "grn_synthetic" })).status).toBe(200);
    const aliceGranola = await http("POST", "/v1/sources/connect/granola", tok.alice, { apiKey: "grn_synthetic_2" });
    expect(aliceGranola.status).toBe(409);
    // Data that predates owner records cannot be adopted by whoever enrols first: it stays sealed.
    const legacy = await http("POST", "/v1/sources/devices/office-audio/setup", tok.alice, {});
    expect(legacy.status).toBe(409);
    expect(((await legacy.json()) as any).error.reason).toBe("unowned_legacy_data");
    expect((await tool("alice", "read", { path: "$SOURCES/office-audio/2026-09/s1/transcript.md" })).code).toBe("not_found");
    await publish("after-enrolment", [
      put("sources/imessage/Mom-chat-1/2026-10.md", "messages: needle-imessage\n"),
      put("sources/granola/Board-meeting-1/summary.md", "meeting notes: needle-granola\n"),
    ]);
    // Google owners come from the runtime's verified OAuth grants (a DWD-only mailbox has none).
    await report([
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "bob@acme.test", subject: "user_bob", issuer: issuer.issuer },
    ]);
  });

  it("lists, reads, finds and greps only the caller's own personal sources", async () => {
    const aliceRoot = names(await tool("alice", "ls", { path: "$SOURCES" }));
    expect(aliceRoot).toEqual(["calendar/", "gmail/", "imessage/", "jira/", "slack/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES" }))).toEqual(["calendar/", "gmail/", "granola/", "jira/", "slack/"]);
    expect(names(await tool("carol", "ls", { path: "$SOURCES" }))).toEqual(["jira/", "slack/"]);

    const gmail = await tool("alice", "ls", { path: "$SOURCES/gmail" });
    expect(names(gmail)).toEqual(["_raw/", "alice@acme.test/"]);
    expect(gmail.liveFiles).toBeNull(); // the directory total would count bob's mail
    expect((await tool("alice", "read", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` })).content).toContain("needle-alice");
    expect((await tool("alice", "read", { path: "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json" })).content).toContain("needle-alice-raw");
    expect((await tool("bob", "read", { path: "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json" })).code).toBe("not_found");
    for (const p of [BOB_MAIL, "sources/granola/Board-meeting-1/summary.md", "sources/google-docs/Plan-doc-1/document.md", "sources/calendar/2026/10/standup.md", "sources/slack/D0123ABCD/2026-10-01.md"]) {
      const r = await tool("alice", "read", { path: `$SOURCES/${p.slice(8)}` });
      expect(r.code, p).toBe("not_found");
      expect(r.error).toBe(`No such file or directory: $SOURCES/${p.slice(8)}`);
    }
    expect((await tool("alice", "ls", { path: "$SOURCES/gmail/bob@acme.test" })).code).toBe("not_found");
    expect((await tool("bob", "read", { path: "$SOURCES/imessage/Mom-chat-1/2026-10.md" })).code).toBe("not_found");
    expect((await tool("bob", "read", { path: "$SOURCES/granola/Board-meeting-1/summary.md" })).content).toContain("needle-granola");
    expect((await tool("alice", "read", { path: "$SOURCES/imessage/Mom-chat-1/2026-10.md" })).content).toContain("needle-imessage");

    const grep = await tool("alice", "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" });
    const hits = grep.matches.map((m: any) => m.path).sort();
    expect(hits).toEqual([
      "$SOURCES/calendar/accounts/alice@acme.test/calendars/primary/events/e1.md",
      "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json",
      `$SOURCES/${ALICE_MAIL.slice(8)}`,
      "$SOURCES/imessage/Mom-chat-1/2026-10.md",
      "$SOURCES/jira/ACME/ACME-1.md",
      "$SOURCES/slack/C1/2026-10-01.md",
    ]);
    const found = (await tool("carol", "find", { path: "$SOURCES", pattern: "**/*.md" })).matches;
    expect(found.sort()).toEqual(["$SOURCES/jira/ACME/ACME-1.md", "$SOURCES/slack/C1/2026-10-01.md"]);
    expect((await tool("bob", "find", { path: "$SOURCES/gmail", pattern: "**" })).matches.some((m: string) => m.includes("alice@acme.test"))).toBe(false);
  });

  it("keeps immutable history, status and the admin status route to the owner", async () => {
    const own = await tool("alice", "sources_history", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` });
    expect(own.versions).toHaveLength(1);
    const theirs = await tool("bob", "sources_history", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` });
    expect(theirs.versions).toEqual([]);
    const v = await tool("bob", "sources_history", { path: `$SOURCES/${ALICE_MAIL.slice(8)}`, versionId: own.versions[0].versionId });
    expect(v.code).toBe("not_found");
    // Probing alice's version id through bob's own path answers exactly like an unknown id.
    const probe = await tool("bob", "sources_history", { path: `$SOURCES/${BOB_MAIL.slice(8)}`, versionId: own.versions[0].versionId });
    const unknown = await tool("bob", "sources_history", { path: `$SOURCES/${BOB_MAIL.slice(8)}`, versionId: own.versions[0].versionId.replace(/.$/, (c: string) => (c === "0" ? "1" : "0")) });
    expect(probe.code).toBe("not_found");
    expect(probe.error.replace(own.versions[0].versionId, "X")).toBe(unknown.error.replace(/Version \S+ /, "Version X "));

    const st = await tool("alice", "sources_status", {});
    const providers = st.providers.map((p: any) => p.provider);
    expect(providers).not.toContain("granola");
    expect(providers).not.toContain("google-docs");
    const g = st.providers.find((p: any) => p.provider === "gmail");
    expect(g.files).toBeNull();
    expect(g.coverage.map((c: any) => c.scope)).toEqual(["mailbox:alice@acme.test"]);
    expect(JSON.stringify(st)).not.toContain("bob@acme.test");
    expect(st.bindings.filter((b: any) => b.kind === "device")).toHaveLength(2);
    expect((await tool("bob", "sources_status", {})).bindings.filter((b: any) => b.kind === "device")).toHaveLength(0);
    expect((await tool("carol", "sources_status", {})).providers.map((p: any) => p.provider)).toEqual(["jira", "slack"]);

    const admin = (await (await http("GET", "/v1/sources/status", tok.bob)).json()) as any;
    expect(admin.providers.map((p: any) => p.provider)).toContain("granola");
    expect(admin.providers.map((p: any) => p.provider)).not.toContain("imessage");
    expect(JSON.stringify(admin.providers)).not.toContain("alice@acme.test");
  });

  it("filters the runtime status, Google auth status and office-audio consent relays", async () => {
    const rt = async (who: keyof typeof tok, route: string) => (await http("GET", route, tok[who])).json() as Promise<any>;
    const carol = await rt("carol", "/v1/sources/runtime/status");
    expect(carol.coverage.map((c: any) => c.provider)).toEqual(["jira"]);
    expect(carol.connections.map((c: any) => c.provider)).toEqual(["jira"]);
    const alice = await rt("alice", "/v1/sources/runtime/status");
    expect(alice.coverage.map((c: any) => c.scope)).toEqual(["mailbox:alice@acme.test", "site:acme"]);
    expect(JSON.stringify(alice)).not.toContain("bob@acme.test");
    expect((await rt("bob", "/v1/sources/runtime/status")).connections.map((c: any) => c.provider)).toEqual(["google", "granola", "jira"]);
    // Members see only their own Google accounts; admins manage every grant (auth metadata only, never data).
    const member = await rt("carol", "/v1/sources/google/auth");
    expect(member.accounts).toEqual([]);
    expect(member.pendingAuthorizations).toEqual([]);
    expect(member.modes.domain_wide_delegation.approved).toBeNull();
    // Owner-scoped for admins too: alice (admin) sees her own account, not bob's.
    expect((await rt("alice", "/v1/sources/google/auth")).accounts.map((a: any) => a.email)).toEqual(["alice@acme.test"]);
    expect((await http("GET", "/v1/sources/office-audio/consents", tok.carol)).status).toBe(403);
    expect((await http("GET", "/v1/sources/office-audio/consents", tok.bob)).status).toBe(200);
  });

  it("serves Google-wide files only to the member who owns every Google account, and never across organizations", async () => {
    await report([{ account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer }]);
    // bob@'s mailbox is still in $SOURCES but no longer reported: it is an unowned account, so alice does not own
    // every Google account and Google-wide files stay sealed (no retroactive unlock of legacy data).
    expect((await tool("alice", "read", { path: "$SOURCES/google-docs/Plan-doc-1/document.md" })).code).toBe("not_found");
    // bob@ is no longer reported: even the owner of every reported account does not see the unowned mailbox.
    const gmailLs = await tool("alice", "ls", { path: "$SOURCES/gmail" });
    expect(names(gmailLs)).toEqual(["_raw/", "alice@acme.test/"]);
    expect(gmailLs.liveFiles).toBeNull();
    // bob's mailbox is no longer reported with an owner: unowned data is sealed, not handed to someone else.
    expect((await tool("bob", "read", { path: `$SOURCES/${BOB_MAIL.slice(8)}` })).code).toBe("not_found");
    // A DWD-only mailbox (no grant subject) makes Google-wide files unreadable again.
    await report([
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "dwd-only@acme.test", subject: null, issuer: null },
    ]);
    expect((await tool("alice", "read", { path: "$SOURCES/google-docs/Plan-doc-1/document.md" })).code).toBe("not_found");
    // The same subject from another issuer, or a member of another organization, owns nothing here.
    await report([{ account: "alice@acme.test", subject: "user_alice", issuer: "https://other-issuer.invalid" }]);
    expect((await tool("alice", "read", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` })).code).toBe("not_found");
    expect(names(await tool("outsider", "ls", { path: "$SOURCES" }))).toEqual([]);
  });

  it("does not accept account owners from a binding that is not the tenant's '*' runtime binding", async () => {
    const narrow = await http("POST", "/v1/sources/bindings", tok.bob, { providers: ["jira"], label: "narrow" });
    const narrowToken = ((await narrow.json()) as { token: string }).token;
    const r = await fetch(base + "/v1/sources/status-report", {
      method: "POST",
      headers: { Authorization: `Bearer ${narrowToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [], googleAccounts: [{ account: "alice@acme.test", subject: "user_bob", issuer: issuer.issuer }] }),
    });
    expect(r.status).toBe(200);
    expect((await tool("bob", "read", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` })).code).toBe("not_found");
  });

  it("closes the owner-acl audit findings (forged owners, withheld history, enrolment slots, legacy data)", async () => {
    // F1: an admin cannot mint a '*' (or personal) binding whose owner reports would be trusted.
    expect((await http("POST", "/v1/sources/bindings", tok.alice, { providers: ["*"], label: "my-collector" })).status).toBe(400);
    expect((await http("POST", "/v1/sources/bindings", tok.alice, { providers: ["gmail"] })).status).toBe(400);
    // F3: content the collector withheld after publishing (a group DM) is gone from read AND history.
    await publish("mpim", [put("sources/slack/mpdm-a--b-channel-9f/threads/t1.md", "group dm: needle-mpim\n")]);
    const at = new Date().toISOString();
    await publish("mpim-withheld", [{ op: "delete", path: "sources/slack/mpdm-a--b-channel-9f/threads/t1.md", deletedAt: at, reason: "slack_direct_message_withheld", capturedAt: at }]);
    const p = "$SOURCES/slack/mpdm-a--b-channel-9f/threads/t1.md";
    expect((await tool("carol", "read", { path: p })).code).toBe("not_found");
    expect((await tool("carol", "sources_history", { path: p })).versions).toEqual([]);
    // F5/F6: a plain member connects their own personal account (underscore integration id) and owns it.
    expect((await http("POST", "/v1/sources/connect/cursor_background_agents", tok.carol, { apiKey: "synthetic" })).status).toBe(200);
    expect((await http("POST", "/v1/sources/connect/cursor_background_agents", tok.bob, { apiKey: "synthetic" })).status).toBe(409);
    expect((await http("POST", "/v1/sources/connect/jira", tok.carol, {})).status).toBe(403); // shared tools stay admin-only
    expect((await http("POST", "/v1/sources/google/auth/oauth/start", tok.carol, { account: "self" })).status).toBe(201);
    // F6: a refused connect leaves no owner behind.
    expect((await http("POST", "/v1/sources/connect/whatsapp_personal", tok.carol, {})).status).toBe(400);
    expect((await http("POST", "/v1/sources/connect/whatsapp_personal", tok.bob, {})).status).toBe(400); // not 409
    // F7: a device enrolment the runtime refused confers no ownership.
    failNextCodingEnrol = true;
    expect((await http("POST", "/v1/sources/devices/coding-sessions/setup", tok.carol, {})).status).toBe(502);
    expect((await http("POST", "/v1/sources/devices/coding-sessions/setup", tok.bob, {})).status).toBe(201);
    // F8: a provider the runtime already holds a connection for (connected before owners existed) cannot be claimed.
    const zoom = await http("POST", "/v1/sources/connect/zoom", tok.carol, { mode: "oauth" });
    expect(zoom.status).toBe(409);
    expect(((await zoom.json()) as any).error.reason).toBe("unowned_legacy_data");
  });

  it("closes the owner-acl re-audit findings (purged legacy, sticky withholding, owner self-service stop, relays)", async () => {
    // NEW-1: legacy data that was purged (ordinary deletes) still has readable history: it blocks a first claim.
    await publish("legacy-wa", [put("sources/whatsapp-personal/acct/chat/2026-01/m.json", "legacy chat: needle-legacy-wa\n")]);
    const at = new Date().toISOString();
    await publish("legacy-wa-purge", [{ op: "delete", path: "sources/whatsapp-personal/acct/chat/2026-01/m.json", deletedAt: at, reason: "operator_purge", capturedAt: at }]);
    const wa = await http("POST", "/v1/sources/connect/instagram_personal", tok.carol, {});
    expect(wa.status).not.toBe(201); // unrelated provider: unaffected (fake runtime refuses it)
    const claim = await http("POST", "/v1/sources/connect/whatsapp_personal", tok.carol, {});
    expect(claim.status).toBe(409);
    expect(((await claim.json()) as any).error.reason).toBe("unowned_legacy_data");
    // NEW-2: once a path is withheld, a later put does not restore it (its earlier versions stay sealed).
    const p = "sources/slack/mpdm-x--y-channel-77/threads/t.md";
    await publish("dm-1", [put(p, "group dm v1: needle-sticky\n")]);
    const t1 = new Date().toISOString();
    await publish("dm-withheld", [{ op: "delete", path: p, deletedAt: t1, reason: "slack_direct_message_withheld", capturedAt: t1 }]);
    await new Promise((r) => setTimeout(r, 5));
    await publish("dm-republish", [{ ...put(p, "group dm v2\n"), capturedAt: new Date().toISOString() }]);
    expect((await tool("carol", "read", { path: `$SOURCES/${p.slice(8)}` })).code).toBe("not_found");
    expect((await tool("carol", "sources_history", { path: `$SOURCES/${p.slice(8)}` })).versions).toEqual([]);
    // Admins see every binding id (to manage them) but not another member's device label.
    const listed = ((await (await http("GET", "/v1/sources/bindings", tok.bob)).json()) as any).bindings;
    const alicesMac = listed.find((b: any) => b.kind === "device" && b.providers.includes("imessage") && b.createdBy.subject === "user_alice");
    expect(alicesMac.label).toBeNull();
    // N3: owners stop their own collection; nobody else can.
    const devices = ((await (await http("GET", "/v1/sources/status", tok.alice)).json()) as any).bindings.filter((b: any) => b.kind === "device" && b.providers.includes("imessage"));
    expect(devices.length).toBeGreaterThan(0);
    expect((await http("DELETE", `/v1/sources/bindings/${devices[0].bindingId}`, tok.carol)).status).toBe(403);
    expect((await http("DELETE", `/v1/sources/bindings/${devices[0].bindingId}`, tok.alice)).status).toBe(200);
    expect((await http("DELETE", "/v1/sources/connections/granola", tok.carol)).status).toBe(403);
    expect((await http("DELETE", "/v1/sources/connections/granola", tok.bob)).status).toBe(200);
    // A plain member (carol owns cursor-agents) disconnects her own account; another member cannot.
    expect((await http("DELETE", "/v1/sources/connections/cursor_background_agents", tok.outsider)).status).not.toBe(200);
    expect((await http("DELETE", "/v1/sources/connections/cursor_background_agents", tok.carol)).status).toBe(200);
    // N4: a failing runtime status is never relayed (its body could carry other owners' data).
    failStatus = true;
    const rs = await http("GET", "/v1/sources/runtime/status", tok.carol);
    failStatus = false;
    expect(rs.status).toBe(502);
    expect(await rs.text()).not.toContain("bob@acme.test");
  });
});

