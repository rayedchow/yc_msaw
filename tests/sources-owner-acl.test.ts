import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";
import { tenantNsFor } from "../src/auth/tenant.js";
import { personalSegment } from "../src/sources/access.js";
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
const connectedProviders = new Set<string>(["zoom"]); // zoom: connected before owner scopes existed (legacy, organization-level)
/** Personal accounts per owner segment (the runtime connects them into the caller's owner scope). */
const personalConnected = new Map<string, Set<string>>();
/** The caller's owner segment, as the runtime derives it from the forwarded verified principal. */
function callerSegment(req: { headers: Record<string, string | string[] | undefined> }): string {
  const p = JSON.parse(String(req.headers["x-procmem-principal"])) as { tenantNs: string; subject: string; issuer: string };
  return personalSegment(p.tenantNs, p);
}
const PERSONAL = new Set(["granola", "zoom", "cursor_background_agents", "whatsapp_personal", "instagram_personal"]);
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
      { provider: "granola", scope: "notes", state: "complete", lastSuccessAt: now }, // organization-level (legacy)
      { provider: "granola", scope: `owner:${seg("user_bob")}/notes`, state: "complete", lastSuccessAt: now },
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
/** `$SOURCES/<provider>/<segment>/`: where a member's connected personal accounts are published. */
const seg = (sub: string) => personalSegment(tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: sub }), { subject: sub, issuer: issuer.issuer });

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
    if (req.method === "POST" && /\/devices\/(imessage|office-audio)$/.test(url)) return void res.writeHead(201).end(JSON.stringify({ device: { id: "dev-1" } }));
    const personalConnect = /\/connect\/([a-z_]+)$/.exec(url);
    if (req.method === "POST" && personalConnect && ["granola", "zoom", "cursor_background_agents"].includes(personalConnect[1]!)) {
      const seg = callerSegment(req);
      personalConnected.set(seg, new Set([...(personalConnected.get(seg) ?? []), personalConnect[1]!]));
      return void res.writeHead(200).end(JSON.stringify({ connected: true }));
    }
    if (req.method === "DELETE" && /\/devices\/[a-z-]+\/sb-[0-9a-f]{16}$/.test(url)) return void res.writeHead(200).end(JSON.stringify({ revoked: true }));
    const disconnect = /\/connections\/([a-z_]+)(\?legacy=organization)?$/.exec(url);
    if (req.method === "DELETE" && disconnect && PERSONAL.has(disconnect[1]!)) {
      // Organization-level legacy connection, or the caller's own account (never another member's).
      if (disconnect[2]) return void res.writeHead(connectedProviders.delete(disconnect[1]!) ? 200 : 404).end(JSON.stringify({ status: "revoked" }));
      const mine = personalConnected.get(callerSegment(req));
      return void res.writeHead(mine?.delete(disconnect[1]!) ? 200 : 404).end(JSON.stringify(mine ? { status: "revoked" } : { error: { code: "not_connected" } }));
    }
    if (req.method === "GET" && /\/status$/.test(url) && failStatus) return void res.writeHead(500).end(JSON.stringify({ connections: [{ provider: "google", external_account_id: "bob@acme.test" }] }));
    if (req.method === "GET" && /\/status$/.test(url)) {
      const seg = callerSegment(req);
      return void res.writeHead(200).end(JSON.stringify({
        personal: personalConnected.has(seg) ? { segment: seg, connections: [...personalConnected.get(seg)!].map((provider) => ({ provider, status: "active" })) } : null,
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
          { provider: "granola", scope: "account:api-key", state: "complete" }, // organization-level (legacy)
          ...[...personalConnected].filter(([, ps]) => ps.has("granola")).map(([s]) => ({ provider: "granola", scope: `owner:${s}/account:api-key`, state: "complete" })),
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

  it("enrols each member's own devices and connects each member's own personal accounts side by side", async () => {
    // Devices: each member enrols their own Mac into their own owner scope (data under imessage/<their segment>/).
    expect((await http("POST", "/v1/sources/devices/imessage/setup", tok.alice, {})).status).toBe(201);
    expect((await http("POST", "/v1/sources/devices/imessage/setup", tok.bob, {})).status).toBe(201);
    // A second Mac of the same owner is fine.
    expect((await http("POST", "/v1/sources/devices/imessage/setup", tok.alice, { label: "second Mac" })).status).toBe(201);
    // Connected personal accounts: every member connects their own, into their own owner scope (no first claimer).
    expect((await http("POST", "/v1/sources/connect/granola", tok.bob, { apiKey: "grn_synthetic" })).status).toBe(200);
    expect((await http("POST", "/v1/sources/connect/granola", tok.alice, { apiKey: "grn_synthetic_2" })).status).toBe(200);
    // Data that predates owner records is not adopted by whoever enrols next: a new device writes under its own
    // segment, and the unsegmented legacy file stays sealed.
    expect((await http("POST", "/v1/sources/devices/office-audio/setup", tok.alice, {})).status).toBe(201);
    expect((await tool("alice", "read", { path: "$SOURCES/office-audio/2026-09/s1/transcript.md" })).code).toBe("not_found");
    expect((await tool("alice", "sources_history", { path: "$SOURCES/office-audio/2026-09/s1/transcript.md" })).versions).toEqual([]);
    await publish("after-enrolment", [
      put(`sources/imessage/${seg("user_alice")}/Mom-chat-1/2026-10.md`, "messages: needle-imessage\n"),
      put(`sources/imessage/${seg("user_bob")}/Mom-chat-1/2026-10.md`, "bob's own chat with the same name: needle-bob-imessage\n"),
      put(`sources/granola/${seg("user_bob")}/Board-meeting-1/summary.md`, "meeting notes: needle-granola\n"),
      put(`sources/granola/${seg("user_alice")}/Standup-meeting-2/summary.md`, "alice notes: needle-alice-granola\n"),
      // Captured before owner scopes (organization-level, unsegmented): nobody's, whoever connects later.
      put("sources/granola/Legacy-meeting-0/summary.md", "legacy notes: needle-legacy-granola\n"),
    ]);
    // Google owners come from the runtime's verified OAuth grants (a DWD-only mailbox has none).
    await report([
      { account: "alice@acme.test", subject: "user_alice", issuer: issuer.issuer },
      { account: "bob@acme.test", subject: "user_bob", issuer: issuer.issuer },
    ]);
  });

  it("lists, reads, finds and greps only the caller's own personal sources", async () => {
    const aliceRoot = names(await tool("alice", "ls", { path: "$SOURCES" }));
    expect(aliceRoot).toEqual(["calendar/", "gmail/", "granola/", "imessage/", "jira/", "slack/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES" }))).toEqual(["calendar/", "gmail/", "granola/", "imessage/", "jira/", "slack/"]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES/imessage" }))).toEqual([`${seg("user_bob")}/`]);
    expect(names(await tool("carol", "ls", { path: "$SOURCES" }))).toEqual(["jira/", "slack/"]);

    const gmail = await tool("alice", "ls", { path: "$SOURCES/gmail" });
    expect(names(gmail)).toEqual(["_raw/", "alice@acme.test/"]);
    expect(gmail.liveFiles).toBeNull(); // the directory total would count bob's mail
    expect((await tool("alice", "read", { path: `$SOURCES/${ALICE_MAIL.slice(8)}` })).content).toContain("needle-alice");
    expect((await tool("alice", "read", { path: "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json" })).content).toContain("needle-alice-raw");
    expect((await tool("bob", "read", { path: "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json" })).code).toBe("not_found");
    expect(names(await tool("alice", "ls", { path: "$SOURCES/granola" }))).toEqual([`${seg("user_alice")}/`]);
    expect(names(await tool("bob", "ls", { path: "$SOURCES/granola" }))).toEqual([`${seg("user_bob")}/`]);
    for (const p of [BOB_MAIL, `sources/granola/${seg("user_bob")}/Board-meeting-1/summary.md`, "sources/granola/Legacy-meeting-0/summary.md", "sources/google-docs/Plan-doc-1/document.md", "sources/calendar/2026/10/standup.md", "sources/slack/D0123ABCD/2026-10-01.md"]) {
      const r = await tool("alice", "read", { path: `$SOURCES/${p.slice(8)}` });
      expect(r.code, p).toBe("not_found");
      expect(r.error).toBe(`No such file or directory: $SOURCES/${p.slice(8)}`);
    }
    expect((await tool("alice", "ls", { path: "$SOURCES/gmail/bob@acme.test" })).code).toBe("not_found");
    expect((await tool("bob", "read", { path: `$SOURCES/imessage/${seg("user_alice")}/Mom-chat-1/2026-10.md` })).code).toBe("not_found");
    expect((await tool("bob", "read", { path: `$SOURCES/granola/${seg("user_bob")}/Board-meeting-1/summary.md` })).content).toContain("needle-granola");
    expect((await tool("bob", "read", { path: `$SOURCES/granola/${seg("user_alice")}/Standup-meeting-2/summary.md` })).code).toBe("not_found");
    expect((await tool("bob", "read", { path: "$SOURCES/granola/Legacy-meeting-0/summary.md" })).code).toBe("not_found");
    expect((await tool("alice", "read", { path: `$SOURCES/imessage/${seg("user_alice")}/Mom-chat-1/2026-10.md` })).content).toContain("needle-imessage");

    const grep = await tool("alice", "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" });
    const hits = grep.matches.map((m: any) => m.path).sort();
    expect(hits).toEqual([
      "$SOURCES/calendar/accounts/alice@acme.test/calendars/primary/events/e1.md",
      "$SOURCES/gmail/_raw/mailbox:alice@acme.test/message:m1/2026-10/gmail:m1.json",
      `$SOURCES/${ALICE_MAIL.slice(8)}`,
      `$SOURCES/granola/${seg("user_alice")}/Standup-meeting-2/summary.md`,
      `$SOURCES/imessage/${seg("user_alice")}/Mom-chat-1/2026-10.md`,
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
    expect(providers).not.toContain("google-docs");
    // Her own Granola subtree: its own totals; the organization-level (legacy) and bob's coverage are not hers.
    const granola = st.providers.find((p: any) => p.provider === "granola");
    expect(granola.files).toBe(1);
    expect(granola.coverage).toEqual([]);
    const bobGranola = (await tool("bob", "sources_status", {})).providers.find((p: any) => p.provider === "granola");
    expect(bobGranola.coverage.map((c: any) => c.scope)).toEqual([`owner:${seg("user_bob")}/notes`]);
    const g = st.providers.find((p: any) => p.provider === "gmail");
    expect(g.files).toBeNull();
    expect(g.coverage.map((c: any) => c.scope)).toEqual(["mailbox:alice@acme.test"]);
    expect(JSON.stringify(st)).not.toContain("bob@acme.test");
    expect(st.bindings.filter((b: any) => b.kind === "device")).toHaveLength(3); // two Macs + office audio
    expect((await tool("bob", "sources_status", {})).bindings.filter((b: any) => b.kind === "device")).toHaveLength(1);
    expect((await tool("carol", "sources_status", {})).providers.map((p: any) => p.provider)).toEqual(["jira", "slack"]);

    const admin = (await (await http("GET", "/v1/sources/status", tok.bob)).json()) as any;
    expect(admin.providers.map((p: any) => p.provider)).toContain("granola");
    // bob's own Mac data only: alice's iMessage files are not counted in his totals.
    expect(admin.providers.find((p: any) => p.provider === "imessage")).toMatchObject({ files: 1 });
    expect(JSON.stringify(admin.providers)).not.toContain("alice@acme.test");
  });

  it("filters the runtime status, Google auth status and office-audio consent relays", async () => {
    const rt = async (who: keyof typeof tok, route: string) => (await http("GET", route, tok[who])).json() as Promise<any>;
    const carol = await rt("carol", "/v1/sources/runtime/status");
    expect(carol.coverage.map((c: any) => c.provider)).toEqual(["jira"]);
    expect(carol.connections.map((c: any) => c.provider)).toEqual(["jira"]);
    const alice = await rt("alice", "/v1/sources/runtime/status");
    expect(alice.coverage.map((c: any) => c.scope)).toEqual(["mailbox:alice@acme.test", `owner:${seg("user_alice")}/account:api-key`, "site:acme"]);
    expect(JSON.stringify(alice)).not.toContain("bob@acme.test");
    expect(JSON.stringify(alice)).not.toContain(seg("user_bob"));
    const bob = await rt("bob", "/v1/sources/runtime/status");
    // The organization-level (legacy) zoom connection is nobody's; bob's own accounts come in `personal`.
    expect(bob.connections.map((c: any) => c.provider)).toEqual(["google", "jira"]);
    expect(bob.personal).toEqual({ segment: seg("user_bob"), connections: [{ provider: "granola", status: "active" }] });
    expect(carol.personal).toBeNull();
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
    // NEW-4: nor one for a provider whose data lives in members' owner segments (a personal Nango source).
    expect(await (await http("POST", "/v1/sources/bindings", tok.alice, { providers: ["outlook"] })).json()).toMatchObject({ error: { code: "use_runtime_provision" } });
    // A manual binding of a shared provider cannot write into, or report coverage for, a member's owner segment.
    const manual = ((await (await http("POST", "/v1/sources/bindings", tok.alice, { providers: ["jira"], label: "manual" })).json()) as { token: string }).token;
    const send = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${manual}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const seg of ["@u-0123456789abcdef01234567", "%40u-0123456789abcdef01234567", "\uFF20u-0123456789abcdef01234567"]) {
      const r = await send("/v1/sources/publish", { batchId: `seg-${seg.length}-${seg.charCodeAt(0)}`, changes: [put(`sources/jira/${seg}/forged.json`, "forged\n")] });
      expect(r.status, seg).toBe(403);
    }
    expect((await send("/v1/sources/status-report", { providers: [{ provider: "jira", scope: "owner:@u-0123456789abcdef01234567/forged", state: "complete" }] })).status).toBe(403);
    expect((await send("/v1/sources/status-report", { providers: [{ provider: "jira", scope: "site:acme", state: "complete" }] })).status).toBe(200);
    // F3: content the collector withheld after publishing (a group DM) is gone from read AND history.
    await publish("mpim", [put("sources/slack/mpdm-a--b-channel-9f/threads/t1.md", "group dm: needle-mpim\n")]);
    const at = new Date().toISOString();
    await publish("mpim-withheld", [{ op: "delete", path: "sources/slack/mpdm-a--b-channel-9f/threads/t1.md", deletedAt: at, reason: "slack_direct_message_withheld", capturedAt: at }]);
    const p = "$SOURCES/slack/mpdm-a--b-channel-9f/threads/t1.md";
    expect((await tool("carol", "read", { path: p })).code).toBe("not_found");
    expect((await tool("carol", "sources_history", { path: p })).versions).toEqual([]);
    // F5/F6: a plain member connects their own personal account (underscore integration id); another member
    // connects theirs too (separate owner scopes, no owner slot to take).
    expect((await http("POST", "/v1/sources/connect/cursor_background_agents", tok.carol, { apiKey: "synthetic" })).status).toBe(200);
    expect((await http("POST", "/v1/sources/connect/cursor_background_agents", tok.bob, { apiKey: "synthetic" })).status).toBe(200);
    expect((await http("POST", "/v1/sources/connect/jira", tok.carol, {})).status).toBe(403); // shared tools stay admin-only
    expect((await http("POST", "/v1/sources/google/auth/oauth/start", tok.carol, { account: "self" })).status).toBe(201);
    // F6: a refused connect leaves no owner behind.
    expect((await http("POST", "/v1/sources/connect/whatsapp_personal", tok.carol, {})).status).toBe(400);
    expect((await http("POST", "/v1/sources/connect/whatsapp_personal", tok.bob, {})).status).toBe(400); // not 409
    // F7: a device enrolment the runtime refused confers no ownership.
    failNextCodingEnrol = true;
    expect((await http("POST", "/v1/sources/devices/coding-sessions/setup", tok.carol, {})).status).toBe(502);
    expect((await http("POST", "/v1/sources/devices/coding-sessions/setup", tok.bob, {})).status).toBe(201);
    // F8: data of a connection made before owner scopes (organization-level zoom) stays sealed after a member
    // connects their own Zoom, including rows exported only after that connect; the member reads only their own.
    await publish("zoom-legacy-1", [put("sources/zoom/Legacy-meeting-1/summary.md", "legacy zoom: needle-legacy-zoom\n")]);
    expect((await http("POST", "/v1/sources/connect/zoom", tok.carol, { mode: "oauth" })).status).toBe(200);
    await publish("zoom-legacy-2", [
      put("sources/zoom/Legacy-meeting-2/summary.md", "legacy zoom exported after the connect: needle-legacy-zoom-2\n"),
      put(`sources/zoom/${seg("user_carol")}/Carol-meeting-1/summary.md`, "carol zoom: needle-carol-zoom\n"),
    ]);
    for (const p of ["zoom/Legacy-meeting-1/summary.md", "zoom/Legacy-meeting-2/summary.md"]) {
      expect((await tool("carol", "read", { path: `$SOURCES/${p}` })).code).toBe("not_found");
      expect((await tool("carol", "sources_history", { path: `$SOURCES/${p}` })).versions).toEqual([]);
    }
    expect((await tool("carol", "read", { path: `$SOURCES/zoom/${seg("user_carol")}/Carol-meeting-1/summary.md` })).content).toContain("needle-carol-zoom");
    expect((await tool("bob", "read", { path: `$SOURCES/zoom/${seg("user_carol")}/Carol-meeting-1/summary.md` })).code).toBe("not_found");
    expect((await tool("carol", "grep", { path: "$SOURCES/zoom", pattern: "needle-[a-z0-9-]+" })).matches.map((m: any) => m.path)).toEqual([
      `$SOURCES/zoom/${seg("user_carol")}/Carol-meeting-1/summary.md`,
    ]);
  });

  it("closes the owner-acl re-audit findings (purged legacy, sticky withholding, owner self-service stop, relays)", async () => {
    // NEW-1: legacy data that was purged (ordinary deletes) keeps its history sealed whoever connects afterwards.
    await publish("legacy-wa", [put("sources/whatsapp-personal/acct/chat/2026-01/m.json", "legacy chat: needle-legacy-wa\n")]);
    const at = new Date().toISOString();
    await publish("legacy-wa-purge", [{ op: "delete", path: "sources/whatsapp-personal/acct/chat/2026-01/m.json", deletedAt: at, reason: "operator_purge", capturedAt: at }]);
    expect((await http("POST", "/v1/sources/connect/whatsapp_personal", tok.carol, {})).status).toBe(400); // fake runtime refuses
    await publish("carol-wa", [put(`sources/whatsapp-personal/${seg("user_carol")}/acct2/chat/2026-10/m.json`, "carol chat: needle-carol-wa\n")]);
    for (const who of ["carol", "alice"] as const) {
      expect((await tool(who, "sources_history", { path: "$SOURCES/whatsapp-personal/acct/chat/2026-01/m.json" })).versions).toEqual([]);
    }
    expect((await tool("carol", "read", { path: `$SOURCES/whatsapp-personal/${seg("user_carol")}/acct2/chat/2026-10/m.json` })).content).toContain("needle-carol-wa");
    expect(names(await tool("carol", "ls", { path: "$SOURCES/whatsapp-personal" }))).toEqual([`${seg("user_carol")}/`]);
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
    // Disconnect reaches only the caller's own account: carol has no Granola, so bob's stays connected.
    expect((await http("DELETE", "/v1/sources/connections/granola", tok.carol)).status).toBe(404);
    expect((await http("DELETE", "/v1/sources/connections/granola", tok.bob)).status).toBe(200);
    expect(personalConnected.get(seg("user_alice"))?.has("granola")).toBe(true);
    // A plain member disconnects her own account; a member of another organization reaches nothing here.
    expect((await http("DELETE", "/v1/sources/connections/cursor_background_agents", tok.outsider)).status).not.toBe(200);
    expect((await http("DELETE", "/v1/sources/connections/cursor_background_agents", tok.carol)).status).toBe(200);
    expect(personalConnected.get(seg("user_bob"))?.has("cursor_background_agents")).toBe(true);
    // Only an admin stops the organization-level legacy connection (its data stays sealed).
    expect((await http("DELETE", "/v1/sources/connections/zoom?legacy=organization", tok.carol)).status).toBe(403);
    expect((await http("DELETE", "/v1/sources/connections/zoom?legacy=organization", tok.alice)).status).toBe(200);
    expect(connectedProviders.has("zoom")).toBe(false);
    // N4: a failing runtime status is never relayed (its body could carry other owners' data).
    failStatus = true;
    const rs = await http("GET", "/v1/sources/runtime/status", tok.carol);
    failStatus = false;
    expect(rs.status).toBe(502);
    expect(await rs.text()).not.toContain("bob@acme.test");
  });
});

