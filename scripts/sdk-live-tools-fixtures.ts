/**
 * Loopback fixtures for the live-tools SDK tests and live Pi script.
 *
 *  - REAL parent: createApp() (real /mcp memory filesystem MCP, real /v1/integrations routes and static-key auth)
 *    with an injected SIMULATED catalog port, so tests can add/change/remove children. Child bearer tokens are the
 *    product's real EdDSA tokens (mintChildToken) with the real audience binding.
 *  - SIMULATED children: real MCP servers (@modelcontextprotocol/server low-level Server + the Web-standard Streamable
 *    HTTP transport, stateful sessions with a GET SSE stream for list_changed) on 127.0.0.1, verifying the token with
 *    the product's verifyChildToken. Their tools and behaviour are scripted by the test ("simulated upstream").
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import { childAudience, generateChildAuthKeys, mintChildToken, verifyChildToken, type ChildAuthKeys } from "../src/integrations/child-auth.js";
import { LocalLease } from "../src/sandbox/local.js";
import { MemoryRepo } from "../src/store/memory.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

type Json = Record<string, unknown>;

export interface SimTool {
  tool: Json & { name: string; inputSchema: Json };
  handler: (args: Json, ctl: { dropConnection(): void; authorization: string }) => Promise<Json> | Json;
}

interface Session {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

/** SIMULATED integration child MCP (real MCP server SDK over real loopback HTTP). */
export class SimulatedChild {
  url = "";
  calls = new Map<string, number>();
  listCalls = 0;
  authFailures = 0;
  tokensSeen = new Set<string>();
  /** Every Authorization header received, accepted or not (to prove the parent credential never reaches a child). */
  authHeadersSeen: string[] = [];
  rejectAll = false;
  /** Reject the next N requests with 401 (e.g. a rotated/expired token), then accept again. */
  rejectNext = 0;
  sessionsCreated = 0;
  #tools: SimTool[] = [];
  #sessions = new Map<string, Session>();
  #http: http.Server | null = null;
  readonly #als = new AsyncLocalStorage<{ res: http.ServerResponse; authorization: string }>();

  constructor(readonly keys: ChildAuthKeys, readonly ns: string, readonly slug: string, tools: SimTool[] = []) {
    this.#tools = tools;
  }

  get toolNames(): string[] {
    return this.#tools.map((t) => t.tool.name);
  }

  setTools(tools: SimTool[]): void {
    this.#tools = tools;
  }

  /** Push notifications/tools/list_changed on every open session. */
  async notifyListChanged(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.server.sendToolListChanged().catch(() => undefined)));
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Forget every session server-side (clients then get 404 "session not found" and must reinitialize). */
  async dropSessions(): Promise<void> {
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const s of all) await s.server.close().catch(() => undefined);
  }

  #newSession(): Session {
    const server = new Server({ name: `sim-${this.slug}`, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler("tools/list", async (req) => {
      this.listCalls++;
      // Two pages, to exercise client pagination.
      const all = this.#tools.map((t) => t.tool);
      const offset = req.params?.cursor ? Number(req.params.cursor) : 0;
      const page = all.slice(offset, offset + 2);
      return { tools: page, ...(offset + 2 < all.length ? { nextCursor: String(offset + 2) } : {}) } as never;
    });
    server.setRequestHandler("tools/call", async (req) => {
      const t = this.#tools.find((x) => x.tool.name === req.params.name);
      this.calls.set(req.params.name, (this.calls.get(req.params.name) ?? 0) + 1);
      if (!t) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true } as never;
      const store = this.#als.getStore();
      return (await t.handler((req.params.arguments ?? {}) as Json, { dropConnection: () => store?.res.socket?.destroy(), authorization: store?.authorization ?? "" })) as never;
    });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
      },
    });
    const session = { server, transport };
    return session;
  }

  async start(): Promise<string> {
    this.#http = http.createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#http!.listen(0, "127.0.0.1", r));
    const port = (this.#http.address() as { port: number }).port;
    this.url = `http://127.0.0.1:${port}/mcp`;
    return this.url;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const auth = String(req.headers.authorization ?? "");
      this.authHeadersSeen.push(auth);
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const v = token ? verifyChildToken(this.keys.publicJwk, token, { issuer: this.keys.issuer, audience: childAudience(this.ns, this.slug) }) : { ok: false as const, reason: "missing" };
      const forced = this.rejectNext > 0;
      if (forced) this.rejectNext--;
      if (this.rejectAll || forced || !v.ok) {
        this.authFailures++;
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      this.tokensSeen.add(token);
      const sid = req.headers["mcp-session-id"];
      let session = typeof sid === "string" ? this.#sessions.get(sid) : undefined;
      if (!session) {
        if (req.method !== "POST" || sid) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          return;
        }
        session = this.#newSession();
        this.sessionsCreated++;
        await session.server.connect(session.transport);
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, val] of Object.entries(req.headers)) if (typeof val === "string") headers.set(k, val);
      const webReq = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      const r = await this.#als.run({ res, authorization: auth }, () => session!.transport.handleRequest(webReq));
      if (res.destroyed) return;
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) {
        res.end();
        return;
      }
      const reader = r.body.getReader();
      res.on("close", () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) break;
        res.write(value);
      }
      res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500);
        res.end();
      }
    }
  }

  async close(): Promise<void> {
    for (const s of this.#sessions.values()) await s.server.close().catch(() => undefined);
    this.#sessions.clear();
    if (this.#http) {
      this.#http.closeAllConnections();
      await new Promise<void>((r) => this.#http!.close(() => r()));
    }
  }
}

export interface SimCatalogEntry {
  slug: string;
  title: string;
  description: string;
  mcpUrl: string;
  tools: string[];
  commit: string;
  deploymentId: string;
}

/** Real parent app + SIMULATED catalog contents. */
export class LoopbackParent {
  app!: App;
  baseUrl = "";
  mcpUrl = "";
  dir = "";
  readonly tenant = "tenant-a";
  readonly key = generateStaticKey("tenant-a", ["memory:read", "integrations:read"]);
  readonly childKeys = generateChildAuthKeys();
  entries: SimCatalogEntry[] = [];
  catalogCalls = 0;
  tokenMints = 0;
  tokenTtlSeconds = 900;
  /** Make the next N catalog reads fail with a 502 (transient). */
  failCatalog = 0;
  /** Simulate a parent answering a token request with a different child URL (namespace mismatch). */
  tokenMcpUrlOverride: string | null = null;
  /** Simulate the catalog reporting that the host cannot mint child tokens. */
  childAuthConfigured = true;
  /** Simulated token-route failure (main's contract: not_found -> 404, child_auth_not_configured -> 503, throw -> 502). */
  tokenFailure: null | "not_found" | "child_auth_not_configured" | "throw" = null;
  /** Simulate a parent returning an already-expired token (expiresAt in the past). */
  tokenExpired = false;
  tokenRequests = 0;
  #leases: LocalLease[] = [];

  async start(): Promise<void> {
    this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-live-tools-"));
    const store = new DirectoryObjectStore(path.join(this.dir, "objects"));
    const repo = new MemoryRepo(store, this.tenant);
    const base = await repo.ensureHead();
    await repo.publish(
      base,
      new Map([
        ["index.md", "# Procedural memory\n\n- [Deliveries](deliveries.md): how to retry failed notifications without duplicates.\n"],
        ["deliveries.md", "# Deliveries\n\nBack to [root](index.md).\n\nAlways pass a stable Idempotency-Key when retrying a delivery.\n"],
      ]),
      { buildId: "fixture-build", summary: "loopback fixture memory (simulated)", sources: [] },
    );
    this.app = await createApp({
      env: {
        PORT: "0",
        HOST: "127.0.0.1",
        AUTH_MODE: "static",
        PROCMEM_STATIC_KEYS: this.key.entry,
        PROCMEM_STORE: "directory",
        PROCMEM_SANDBOX: "local",
        PROCMEM_DATA_DIR: this.dir,
      },
      store,
      leaseFactory: async () => {
        const lease = await LocalLease.create();
        this.#leases.push(lease);
        return lease;
      },
      integrationCatalog: {
        list: async (ns) => {
          this.catalogCalls++;
          if (this.failCatalog > 0) {
            this.failCatalog--;
            throw new Error("simulated catalog outage");
          }
          return { integrations: ns === this.tenant ? this.entries.map((e) => ({ ...e, deployedAt: new Date(0).toISOString(), audience: childAudience(ns, e.slug) })) : [], childAuthConfigured: this.childAuthConfigured };
        },
        accessToken: async (ns, subject, slug) => {
          this.tokenRequests++;
          if (this.tokenFailure === "throw") throw new Error("simulated token store outage");
          if (this.tokenFailure) return { ok: false as const, reason: this.tokenFailure };
          const e = this.entries.find((x) => x.slug === slug);
          if (!e || ns !== this.tenant) return { ok: false as const, reason: "not_found" as const };
          if (!this.childAuthConfigured) return { ok: false as const, reason: "child_auth_not_configured" as const };
          this.tokenMints++;
          const t = mintChildToken(this.childKeys, { ns, slug, subject, ttlSeconds: this.tokenTtlSeconds });
          const expiresAt = this.tokenExpired ? new Date(Date.now() - 1000).toISOString() : t.expiresAt;
          return { ok: true as const, token: { slug, mcpUrl: this.tokenMcpUrlOverride ?? e.mcpUrl, token: t.token, tokenType: "Bearer", expiresAt, audience: t.audience } };
        },
      },
      log: () => undefined,
    });
    const bound = await this.app.listen(0);
    this.baseUrl = bound.url.replace(/\/+$/, "");
    this.mcpUrl = bound.mcpUrl;
  }

  async child(slug: string, tools: SimTool[]): Promise<SimulatedChild> {
    const c = new SimulatedChild(this.childKeys, this.tenant, slug, tools);
    await c.start();
    return c;
  }

  publish(child: SimulatedChild, over: Partial<SimCatalogEntry> = {}): SimCatalogEntry {
    const entry: SimCatalogEntry = { slug: child.slug, title: `${child.slug} (simulated)`, description: "SIMULATED upstream child MCP", mcpUrl: child.url, tools: child.toolNames, commit: "c1", deploymentId: "d1", ...over };
    this.entries = [...this.entries.filter((e) => e.slug !== child.slug), entry];
    return entry;
  }

  unpublish(slug: string): void {
    this.entries = this.entries.filter((e) => e.slug !== slug);
  }

  async close(): Promise<void> {
    await this.app?.close();
    if (this.dir) await fs.rm(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- scripted tools

export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

export function echoTool(name = "echo", extra: Json = {}): SimTool {
  return {
    tool: { name, description: "Echo the message back (simulated).", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, annotations: { readOnlyHint: true }, ...extra },
    handler: (args) => ({ content: [{ type: "text", text: `echo:${String(args.message)}` }] }),
  };
}

/** A loopback server that redirects every request elsewhere, plus a recorder of what reaches the target. */
export async function redirectingServer(): Promise<{ url: string; targetHits: string[]; close(): Promise<void> }> {
  const targetHits: string[] = [];
  const target = http.createServer((req, res) => {
    targetHits.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const tport = (target.address() as { port: number }).port;
  const redirector = http.createServer((_req, res) => {
    res.writeHead(307, { location: `http://localhost:${tport}/mcp` });
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  const port = (redirector.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    targetHits,
    async close() {
      for (const s of [target, redirector]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

/**
 * SIMULATED OAuth-protected parent: an authorization server (POST /oauth2/token, refresh_token grant with ROTATING
 * refresh tokens; reuse -> invalid_grant) and a proxy that accepts only its short-lived access tokens and forwards to
 * the real parent app with the app's static key. Streams (SSE) pass through.
 */
export class SimulatedOAuthParent {
  url = "";
  tokenEndpoint = "";
  accessTtlSeconds = 3;
  tokenPosts = 0;
  rejected401 = 0;
  #access = new Map<string, { exp: number; revoked: boolean }>();
  #delays = new Map<string, number>();
  /** Every access token presented with a request, in arrival order (to prove which credential each request carried). */
  presented: string[] = [];
  #refresh: string | null = null;
  #server: http.Server | null = null;
  #n = 0;

  constructor(private readonly target: string, private readonly staticKey: string) {}

  /** Initial grant, as a login would have produced it (token endpoint response JSON). */
  issueInitial(): Json {
    return this.#issue();
  }

  /** Hold the NEXT request carrying `token` for `ms` before validating it (produces a late 401 for an old token). */
  delayNext(token: string, ms: number): void {
    this.#delays.set(token, ms);
  }

  revokeAccessTokens(): void {
    for (const v of this.#access.values()) v.revoked = true;
  }

  revokeGrant(): void {
    this.#refresh = null;
  }

  get knownTokens(): string[] {
    return [...this.#access.keys(), ...(this.#refresh ? [this.#refresh] : [])];
  }

  #issue(): Json {
    const at = `oat_${++this.#n}_${randomUUID().replace(/-/g, "")}`;
    const rt = `ort_${this.#n}_${randomUUID().replace(/-/g, "")}`;
    this.#access.set(at, { exp: Date.now() + this.accessTtlSeconds * 1000, revoked: false });
    this.#refresh = rt;
    return { access_token: at, token_type: "Bearer", expires_in: this.accessTtlSeconds, refresh_token: rt, scope: "memory:read integrations:read" };
  }

  async start(): Promise<void> {
    const target = new URL(this.target);
    this.#server = http.createServer((req, res) => void this.#handle(req, res, target));
    await new Promise<void>((r) => this.#server!.listen(0, "127.0.0.1", r));
    const port = (this.#server.address() as { port: number }).port;
    this.url = `http://127.0.0.1:${port}`;
    this.tokenEndpoint = `${this.url}/oauth2/token`;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse, target: URL): Promise<void> {
    {
      if (req.url === "/oauth2/token" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          this.tokenPosts++;
          const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const ok = form.get("grant_type") === "refresh_token" && !!this.#refresh && form.get("refresh_token") === this.#refresh;
          res.writeHead(ok ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(ok ? this.#issue() : { error: "invalid_grant", error_description: "refresh token is invalid or was rotated" }));
        });
        return;
      }
      const auth = String(req.headers.authorization ?? "");
      const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      this.presented.push(tok);
      const delay = this.#delays.get(tok);
      if (delay !== undefined) {
        this.#delays.delete(tok);
        await new Promise((r) => setTimeout(r, delay));
      }
      const rec = this.#access.get(tok);
      if (!rec || rec.revoked || rec.exp <= Date.now()) {
        this.rejected401++;
        req.resume();
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' });
        res.end(JSON.stringify({ error: { code: "invalid_token", message: "access token invalid or expired" } }));
        return;
      }
      const headers = { ...req.headers, host: target.host, authorization: `Bearer ${this.staticKey}` };
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
      res.on("close", () => up.destroy());
    }
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server!.close(() => r()));
  }
}
