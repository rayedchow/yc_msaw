import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialProvider } from "../src/sdk/live/parent.js";
import {
  FileTokenStore,
  MemoryTokenStore,
  OAuthRefreshError,
  OAuthRefreshProvider,
  acquireFileLock,
  createOAuthCredential,
  readSecretFile,
  tokensFromTokenResponse,
  type OAuthRefreshEvent,
  type OAuthRefreshProviderOptions,
  type OAuthTokens,
  type TokenStore,
} from "../src/sdk/oauth-refresh.js";

// ---------------------------------------------------------------------------------------------------------------
// Real HTTP token endpoint fixture with refresh-token rotation (a used refresh token becomes invalid_grant).
// ---------------------------------------------------------------------------------------------------------------

type Mode =
  | "ok"
  | "503"
  | "500"
  | "429"
  | "redirect"
  | "drop_after_rotate"
  | "garbage_200"
  | "bad_token_type"
  | "zero_expiry"
  | "missing_expiry"
  | "omit_refresh"
  | "echo_secret_error"
  | "invalid_client";

interface TokenServer {
  url: string;
  origin: string;
  requests: Array<{ body: URLSearchParams; authorization: string | undefined }>;
  mode: Mode;
  delayMs: number;
  expiresIn: number;
  /** Currently valid refresh tokens. */
  valid: Set<string>;
  issued: string[];
  grant(): string;
  revokeAll(): void;
  close(): Promise<void>;
}

const tok = (p: string) => `${p}_${randomBytes(18).toString("base64url")}`;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function startTokenServer(redirectTo?: string): Promise<TokenServer> {
  const ts = { requests: [], mode: "ok", delayMs: 0, expiresIn: 300, valid: new Set<string>(), issued: [] as string[] } as unknown as TokenServer;
  const { server, origin } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = new URLSearchParams(raw);
      ts.requests.push({ body, authorization: req.headers.authorization });
      if (ts.delayMs) await new Promise((r) => setTimeout(r, ts.delayMs));
      const json = (status: number, o: unknown, headers: Record<string, string> = {}) => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(o));
      };
      const mode = ts.mode;
      if (mode === "redirect") {
        res.writeHead(307, { location: `${redirectTo}/oauth2/token` });
        return res.end();
      }
      if (mode === "503") return json(503, { error: "temporarily_unavailable" });
      if (mode === "429") return json(429, { error: "slow_down" }, { "retry-after": "2" });
      if (mode === "invalid_client") return json(401, { error: "invalid_client", error_description: "client unknown" });
      const rt = body.get("refresh_token") ?? "";
      if (body.get("grant_type") !== "refresh_token" || !ts.valid.has(rt)) {
        if (mode === "echo_secret_error") return json(400, { error: "invalid_grant", error_description: `bad token ${rt} Bearer ${rt}` });
        return json(400, { error: "invalid_grant", error_description: "refresh token is invalid or revoked" });
      }
      if (mode === "echo_secret_error") return json(400, { error: "invalid_grant", error_description: `bad token ${rt}` });
      // Rotation: the presented refresh token is consumed by every mode below.
      ts.valid.delete(rt);
      const next = tok("rt");
      const access = tok("at");
      if (mode === "omit_refresh") {
        ts.valid.add(rt);
        return json(200, { access_token: access, token_type: "Bearer", expires_in: ts.expiresIn });
      }
      ts.valid.add(next);
      ts.issued.push(next);
      if (mode === "drop_after_rotate") return req.socket.destroy();
      if (mode === "500") return json(500, { error: "server_error" });
      if (mode === "garbage_200") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html>oops</html>");
      }
      if (mode === "bad_token_type") return json(200, { access_token: access, token_type: "mac", expires_in: 300, refresh_token: next });
      if (mode === "zero_expiry") return json(200, { access_token: access, token_type: "Bearer", expires_in: 0, refresh_token: next });
      if (mode === "missing_expiry") return json(200, { access_token: access, token_type: "Bearer", refresh_token: next });
      return json(200, { access_token: access, token_type: "bearer", expires_in: ts.expiresIn, refresh_token: next, id_token: tok("idt"), scope: "openid offline_access" });
    });
  });
  ts.origin = origin;
  ts.url = `${origin}/oauth2/token`;
  ts.grant = () => {
    const rt = tok("rt");
    ts.valid.add(rt);
    ts.issued.push(rt);
    return rt;
  };
  ts.revokeAll = () => ts.valid.clear();
  ts.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return ts;
}

// ---------------------------------------------------------------------------------------------------------------

const RESOURCE = "https://parent.example.com/mcp";
let server: TokenServer;
let dir: string;
const cleanups: Array<() => Promise<unknown> | unknown> = [];

beforeEach(async () => {
  server = await startTokenServer();
  dir = await mkdtemp(join(tmpdir(), "procmem-oauth-"));
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function expired(refreshToken: string, extra: Partial<OAuthTokens> = {}): OAuthTokens {
  return { accessToken: tok("at_old"), refreshToken, tokenType: "Bearer", expiresAt: 0, scope: "openid offline_access", ...extra };
}

function provider(opts: Partial<OAuthRefreshProviderOptions> & { store: TokenStore }): OAuthRefreshProvider {
  const p = new OAuthRefreshProvider({
    tokenEndpoint: server.url,
    clientId: "client_public_123",
    resource: RESOURCE,
    allowInsecureLocalhost: true,
    backoff: { initialMs: 1_000, maxMs: 4_000 },
    ...opts,
  });
  cleanups.push(() => p.dispose());
  return p;
}

function clock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function catchErr(p: Promise<unknown>): Promise<OAuthRefreshError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthRefreshError);
    return e as OAuthRefreshError;
  }
  throw new Error("expected rejection");
}

/** FileTokenStore whose writes can be made to fail (simulated full/broken disk). */
function flakyFileStore(path: string) {
  const inner = new FileTokenStore(path);
  const ctl = { failing: false, saves: 0 };
  const store: TokenStore = {
    load: () => inner.load(),
    save: async (t) => {
      ctl.saves++;
      if (ctl.failing) throw new Error(`ENOSPC writing ${t.refreshToken} ${t.accessToken}`);
      await inner.save(t);
    },
    acquireLock: (o) => inner.acquireLock(o),
  };
  return { store, ctl, inner };
}

describe("configuration validation", () => {
  const store = new MemoryTokenStore();
  it("requires https token endpoints; loopback http only with explicit opt-in", () => {
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "http://auth.example.com/token", clientId: "c", store })).toThrow(/https/);
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "http://127.0.0.1:1/token", clientId: "c", store })).toThrow(/allowInsecureLocalhost/);
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "http://10.0.0.1/token", clientId: "c", store, allowInsecureLocalhost: true })).toThrow(/https/);
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "https://u:p@auth.example.com/token", clientId: "c", store })).toThrow(/credentials/);
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "https://auth.example.com/token", clientId: "c", store, resource: "https://x/mcp#frag" })).toThrow(/fragment/);
    expect(() => new OAuthRefreshProvider({ tokenEndpoint: "https://auth.example.com/token", clientId: "c", store })).not.toThrow();
  });
  it("validates client authentication modes and scope", () => {
    const base = { tokenEndpoint: "https://auth.example.com/token", clientId: "c", store };
    expect(() => new OAuthRefreshProvider({ ...base, clientAuth: { method: "client_secret_post", clientSecret: "" } })).toThrow(/clientSecret/);
    expect(() => new OAuthRefreshProvider({ ...base, clientAuth: { method: "client_secret_basic" } as never })).toThrow(/clientSecret/);
    expect(() => new OAuthRefreshProvider({ ...base, clientAuth: { method: "none", clientSecret: "s3cretvalue" } as never })).toThrow(/none/);
    expect(() => new OAuthRefreshProvider({ ...base, clientAuth: { method: "private_key_jwt" } as never })).toThrow(/method/);
    expect(() => new OAuthRefreshProvider({ ...base, scope: "openid\tprofile" })).toThrow(/scope/);
    expect(() => new OAuthRefreshProvider({ ...base, clientId: "" })).toThrow(/clientId/);
  });
  it("getToken / forceRefresh are bound functions compatible with the parent client", () => {
    const p = new OAuthRefreshProvider({ tokenEndpoint: "https://auth.example.com/token", clientId: "c", store });
    const credential: CredentialProvider = p.getToken;
    const onUnauthorized: (rejected?: string) => Promise<string> = p.forceRefresh;
    expect(p.credential).toBe(credential);
    expect(typeof onUnauthorized).toBe("function");
  });
});

describe("refresh against a real HTTP token endpoint", () => {
  it("refreshes an expired token, rotates and persists before returning; sends resource + client_id, no scope", async () => {
    const store = new FileTokenStore(join(dir, "store", "tokens.json"));
    const rt0 = server.grant();
    const order: string[] = [];
    const watched: TokenStore = {
      load: () => store.load(),
      save: async (t) => {
        await store.save(t);
        order.push("saved");
      },
      acquireLock: (o) => store.acquireLock(o),
    };
    const p = provider({ store: watched, initialTokens: expired(rt0) });
    const token = await p.getToken();
    order.push("returned");
    expect(order).toEqual(["saved", "saved", "returned"]); // seed, then the rotated set strictly before return
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.body.get("grant_type")).toBe("refresh_token");
    expect(req.body.get("refresh_token")).toBe(rt0);
    expect(req.body.get("client_id")).toBe("client_public_123");
    expect(req.body.get("resource")).toBe(RESOURCE);
    expect(req.body.has("scope")).toBe(false);
    expect(req.body.has("client_secret")).toBe(false);
    expect(req.authorization).toBeUndefined();

    const persisted = await store.load();
    expect(persisted?.accessToken).toBe(token);
    expect(persisted?.refreshToken).toBe(server.issued.at(-1));
    expect(persisted?.binding).toEqual({ tokenEndpoint: server.url, clientId: "client_public_123", resource: RESOURCE });
    expect(((await stat(store.path)).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(join(dir, "store"))).mode & 0o777).toString(8)).toBe("700");
    expect((await readdir(join(dir, "store"))).sort()).toEqual(["tokens.json"]); // no tmp or lock files left

    expect(await p.getToken()).toBe(token);
    expect(server.requests).toHaveLength(1);
  });

  it("refreshes before expiry (300 s TTL, 60 s skew) and scales margins for short-lived tokens", async () => {
    const c = clock();
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), now: c.now });
    const t1 = await p.getToken();
    c.advance(200_000);
    expect(await p.getToken()).toBe(t1);
    c.advance(45_000); // 245 s: inside the refresh window, still valid
    const t2 = await p.getToken();
    expect(t2).not.toBe(t1);
    expect(server.requests).toHaveLength(2);

    server.expiresIn = 2; // 2 s tokens: refresh at half-life
    c.advance(400_000);
    const t3 = await p.getToken();
    c.advance(900);
    expect(await p.getToken()).toBe(t3);
    c.advance(200);
    expect(await p.getToken()).not.toBe(t3);
    expect(server.requests).toHaveLength(4);
  });

  it("deduplicates concurrent refreshes into exactly one token request", async () => {
    server.delayMs = 150;
    const store = new FileTokenStore(join(dir, "tokens.json"));
    const p = provider({ store, initialTokens: expired(server.grant()) });
    const tokens = await Promise.all(Array.from({ length: 25 }, () => p.getToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect((await store.load())?.accessToken).toBe(tokens[0]);
  });

  it("preserves the previous refresh token when the server omits refresh_token", async () => {
    server.mode = "omit_refresh";
    const store = new MemoryTokenStore();
    const rt0 = server.grant();
    const p = provider({ store, initialTokens: expired(rt0) });
    await p.getToken();
    expect((await store.load())?.refreshToken).toBe(rt0);
  });

  it("sends scope only when configured and refuses to widen the granted scope", async () => {
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), scope: "openid" });
    await p.getToken();
    expect(server.requests[0]!.body.get("scope")).toBe("openid");
    const wide = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant(), { scope: "openid" }), scope: "openid admin" });
    expect((await catchErr(wide.getToken())).code).toBe("scope_not_granted");
    expect(server.requests).toHaveLength(1);
  });

  it("supports client_secret_basic and client_secret_post without leaking the secret", async () => {
    const secret = "cs_" + randomBytes(16).toString("hex") + ":/+";
    const basic = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), clientAuth: { method: "client_secret_basic", clientSecret: secret } });
    await basic.getToken();
    const r0 = server.requests[0]!;
    expect(r0.authorization).toBe(`Basic ${Buffer.from(`client_public_123:${encodeURIComponent(secret)}`).toString("base64")}`);
    expect(r0.body.has("client_id")).toBe(false);
    expect(r0.body.has("client_secret")).toBe(false);

    const post = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), clientAuth: { method: "client_secret_post", clientSecret: secret } });
    await post.getToken();
    const r1 = server.requests[1]!;
    expect(r1.body.get("client_secret")).toBe(secret);
    expect(r1.body.get("client_id")).toBe("client_public_123");
    expect(r1.authorization).toBeUndefined();

    const scrubbed = basic.scrub(`x ${secret} y ${r0.authorization!}`);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain(r0.authorization!.slice(6));
  });

  it("works as a callable credential", async () => {
    const credential = createOAuthCredential({ tokenEndpoint: server.url, clientId: "c1", allowInsecureLocalhost: true, store: new MemoryTokenStore(), initialTokens: expired(server.grant()) });
    cleanups.push(() => credential.provider.dispose());
    expect(await credential()).toMatch(/^at_/);
    expect(credential.provider.status().state).toBe("valid");
  });
});

describe("forceRefresh (401 hook)", () => {
  it("forces one refresh of an unexpired token; concurrent and later calls with the same rejected token do not storm", async () => {
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()) });
    const t1 = await p.getToken();
    server.delayMs = 100;
    const forced = await Promise.all(Array.from({ length: 10 }, () => p.forceRefresh(t1)));
    expect(new Set(forced).size).toBe(1);
    expect(forced[0]).not.toBe(t1);
    expect(server.requests).toHaveLength(2);
    // Late 401s for the old token: already rotated, no request.
    expect(await p.forceRefresh(t1)).toBe(forced[0]);
    expect(server.requests).toHaveLength(2);
    // Without a rejected token: rate limited by forceMinIntervalMs.
    expect(await p.forceRefresh()).toBe(forced[0]);
    expect(server.requests).toHaveLength(2);
  });

  it("a second provider adopts the newer token another provider forced, without a second request", async () => {
    const path = join(dir, "tokens.json");
    await new FileTokenStore(path).save(expired(server.grant()));
    const a = provider({ store: new FileTokenStore(path) });
    const b = provider({ store: new FileTokenStore(path) });
    const t1 = await a.getToken();
    expect(await b.getToken()).toBe(t1);
    const ta = await a.forceRefresh(t1);
    const tb = await b.forceRefresh(t1);
    expect(tb).toBe(ta);
    expect(server.requests).toHaveLength(2);
  });

  it("does not force through a sticky failure or backoff", async () => {
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()) });
    const t1 = await p.getToken();
    server.revokeAll();
    expect((await catchErr(p.forceRefresh(t1))).code).toBe("invalid_grant");
    expect((await catchErr(p.forceRefresh(t1))).code).toBe("invalid_grant");
    expect(server.requests).toHaveLength(2);
  });
});

describe("failures", () => {
  it("retryable failure (503) before expiry returns the still-valid token and backs off without a request storm", async () => {
    const c = clock();
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), now: c.now });
    const t1 = await p.getToken();
    c.advance(250_000);
    server.mode = "503";
    expect(await p.getToken()).toBe(t1);
    for (let i = 0; i < 20; i++) expect(await p.getToken()).toBe(t1);
    expect(server.requests).toHaveLength(2);
    expect(p.status().state).toBe("backoff");
    server.mode = "ok";
    c.advance(5_000);
    expect(await p.getToken()).not.toBe(t1);
    expect(server.requests).toHaveLength(3);
    expect(p.status().consecutiveFailures).toBe(0);
  });

  it("never returns an expired token: 429 after expiry throws and honors Retry-After", async () => {
    const c = clock();
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()), now: c.now, backoff: { initialMs: 100, maxMs: 10_000 } });
    const t1 = await p.getToken();
    c.advance(296_000); // 4 s left: below the 10 s minimum validity
    server.mode = "429";
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("rate_limited");
    expect(e.kind).toBe("transient");
    expect(e.retryAfterMs).toBe(2_000);
    c.advance(1_000);
    expect((await catchErr(p.getToken())).retryAfterMs).toBeGreaterThan(0);
    expect(server.requests).toHaveLength(2);
    server.mode = "ok";
    c.advance(1_500);
    expect(await p.getToken()).not.toBe(t1);
  });

  it("connection refused (provably not sent) is retryable and leaves the grant intact", async () => {
    const closed = await listen(() => undefined);
    await new Promise((r) => closed.server.close(r));
    const store = new MemoryTokenStore(expired(server.grant()));
    const p = new OAuthRefreshProvider({ tokenEndpoint: `${closed.origin}/token`, clientId: "c", allowInsecureLocalhost: true, store });
    cleanups.push(() => p.dispose());
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("network_error");
    expect(e.kind).toBe("transient");
    expect((await store.load())?.quarantine).toBeUndefined();
  });

  for (const [mode, label] of [
    ["drop_after_rotate", "server rotates then drops the connection"],
    ["500", "server rotates then answers 500"],
    ["garbage_200", "server rotates then answers an unreadable 200"],
  ] as const) {
    it(`unknown outcome (${label}): quarantines the grant and never resends the old refresh token`, async () => {
      const path = join(dir, "tokens.json");
      const rt0 = server.grant();
      await new FileTokenStore(path).save(expired(rt0));
      const a = provider({ store: new FileTokenStore(path) });
      const b = provider({ store: new FileTokenStore(path) });
      server.mode = mode;
      const e = await catchErr(a.getToken());
      expect(e.code).toBe("refresh_outcome_unknown");
      expect(e.reauthRequired).toBe(true);
      expect(server.requests).toHaveLength(1);
      server.mode = "ok";
      for (let i = 0; i < 5; i++) expect((await catchErr(a.getToken())).code).toBe("refresh_outcome_unknown");
      expect((await catchErr(b.getToken())).code).toBe("refresh_outcome_unknown");
      expect((await catchErr(b.forceRefresh())).code).toBe("refresh_outcome_unknown");
      expect(server.requests).toHaveLength(1);
      expect(server.requests.filter((r) => r.body.get("refresh_token") === rt0)).toHaveLength(1);
      expect((await new FileTokenStore(path).load())?.quarantine?.code).toBe("refresh_outcome_unknown");

      // A new grant (fresh login) recovers both.
      await a.replaceGrant(expired(server.grant()));
      expect(await a.getToken()).toMatch(/^at_/);
      await new Promise((r) => setTimeout(r, 1_050)); // sticky recheck interval
      expect(await b.getToken()).toMatch(/^at_/);
    });
  }

  it("timeout after dispatch is an unknown outcome (no resend)", async () => {
    server.delayMs = 1_000;
    const store = new MemoryTokenStore(expired(server.grant()));
    const p = provider({ store, timeoutMs: 150 });
    expect((await catchErr(p.getToken())).code).toBe("refresh_outcome_unknown");
    server.delayMs = 0;
    expect((await catchErr(p.getToken())).code).toBe("refresh_outcome_unknown");
    expect(server.requests).toHaveLength(1);
  });

  it("invalid_grant (revocation) fails closed, is sticky, and recovers only with a new grant", async () => {
    const c = clock();
    const store = new FileTokenStore(join(dir, "tokens.json"));
    const events: OAuthRefreshEvent[] = [];
    const p = provider({ store, initialTokens: expired(server.grant()), now: c.now, onEvent: (e) => events.push(e) });
    await p.getToken();
    server.revokeAll();
    c.advance(250_000); // old access token still valid, but the grant is revoked: fail closed
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("invalid_grant");
    expect(e.reauthRequired).toBe(true);
    for (let i = 0; i < 10; i++) expect((await catchErr(p.getToken())).code).toBe("invalid_grant");
    expect(server.requests).toHaveLength(2);
    expect(p.status().state).toBe("reauth_required");
    expect(events.some((ev) => ev.type === "reauth_required")).toBe(true);
    await p.reload(); // same revoked grant: still failed
    expect(p.status().state).toBe("reauth_required");

    const fresh = server.grant();
    await store.save(expired(fresh)); // external login wrote a new grant
    c.advance(2_000);
    expect(await p.getToken()).toMatch(/^at_/);
    expect(server.requests.at(-1)!.body.get("refresh_token")).toBe(fresh);

    server.revokeAll();
    c.advance(400_000);
    expect((await catchErr(p.getToken())).code).toBe("invalid_grant");
    await p.replaceGrant(expired(server.grant()));
    expect(await p.getToken()).toMatch(/^at_/);
  });

  it("invalid_client is sticky (client_rejected)", async () => {
    server.mode = "invalid_client";
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()) });
    expect((await catchErr(p.getToken())).code).toBe("client_rejected");
    expect((await catchErr(p.getToken())).code).toBe("client_rejected");
    expect(server.requests).toHaveLength(1);
  });

  it("blocks redirects; the redirect target never receives the refresh token", async () => {
    const hits: string[] = [];
    const evil = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.end("{}");
    });
    cleanups.push(() => new Promise((r) => evil.server.close(r)));
    const redirecting = await startTokenServer(evil.origin);
    cleanups.push(() => redirecting.close());
    redirecting.mode = "redirect";
    const p = new OAuthRefreshProvider({ tokenEndpoint: redirecting.url, clientId: "c", allowInsecureLocalhost: true, store: new MemoryTokenStore(), initialTokens: expired(redirecting.grant()) });
    cleanups.push(() => p.dispose());
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("redirect_blocked");
    expect(e.status).toBe(307);
    expect(hits).toEqual([]);
  });

  it("validates 200 responses strictly; a well-formed rotated refresh token is salvaged, the access token never used", async () => {
    for (const mode of ["bad_token_type", "zero_expiry", "missing_expiry"] as const) {
      server.mode = mode;
      const store = new MemoryTokenStore();
      const p = provider({ store, initialTokens: expired(server.grant()) });
      expect((await catchErr(p.getToken())).code).toBe("invalid_response");
      const saved = await store.load();
      expect(saved?.refreshToken).toBe(server.issued.at(-1));
      expect(saved?.expiresAt).toBe(0);
      expect(saved?.quarantine).toBeUndefined();
    }
  });

  it("dispose during an in-flight refresh rejects pending callers and all later calls", async () => {
    server.delayMs = 1_000;
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(server.grant()) });
    const pending = p.getToken();
    await new Promise((r) => setTimeout(r, 50));
    await p.dispose();
    expect(["refresh_outcome_unknown", "disposed"]).toContain((await catchErr(pending)).code);
    expect((await catchErr(p.getToken())).code).toBe("disposed");
    expect(p.status().state).toBe("disposed");
  });

  it("persist failure: holds the rotated tokens and the lock, returns nothing, retries the write before any new request", async () => {
    const { store, ctl, inner } = flakyFileStore(join(dir, "tokens.json"));
    await inner.save(expired(server.grant()));
    const p = provider({ store });
    ctl.failing = true;
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("persist_failed");
    expect(e.message).not.toMatch(/rt_|at_/);
    expect(server.requests).toHaveLength(1);
    expect(p.status().state).toBe("persist_pending");
    expect((await catchErr(p.getToken())).code).toBe("persist_failed");
    expect(server.requests).toHaveLength(1);
    ctl.failing = false;
    const t = await p.getToken();
    expect(server.requests).toHaveLength(1);
    const stored = await inner.load();
    expect(stored?.accessToken).toBe(t);
    expect(server.valid.has(stored!.refreshToken!)).toBe(true);
    await expect(stat(inner.lockPath)).rejects.toThrow(); // lock released after the write
  });

  it("two instances: rotation then persistent disk failure; the other instance never POSTs the consumed refresh token", async () => {
    const path = join(dir, "shared", "tokens.json");
    const { store, ctl, inner } = flakyFileStore(path);
    const rt0 = server.grant();
    await inner.save(expired(rt0));
    const a = provider({ store });
    const b = provider({ store: new FileTokenStore(path), lockTimeoutMs: 300 });
    ctl.failing = true;
    expect((await catchErr(a.getToken())).code).toBe("persist_failed");
    expect(server.requests).toHaveLength(1);
    expect(server.valid.has(rt0)).toBe(false); // rt0 is consumed; the store still holds it

    // B needs a token: it waits for the lock A still holds and gives up without any request.
    for (let i = 0; i < 3; i++) expect((await catchErr(b.getToken())).code).toBe("lock_timeout");
    expect(server.requests).toHaveLength(1);

    ctl.failing = false;
    const ta = await a.getToken(); // flushes, releases
    expect(await b.getToken()).toBe(ta); // adopts; no request
    expect(server.requests).toHaveLength(1);
    expect(server.requests.filter((r) => r.body.get("refresh_token") === rt0)).toHaveLength(1);
  });

  it("a pending flush never overwrites a newer grant written by someone else", async () => {
    const path = join(dir, "tokens.json");
    const { store, ctl, inner } = flakyFileStore(path);
    await inner.save(expired(server.grant()));
    const a = provider({ store });
    ctl.failing = true;
    expect((await catchErr(a.getToken())).code).toBe("persist_failed");
    // An external login (outside the lock protocol) writes a brand-new grant.
    const newer = server.grant();
    await inner.save(expired(newer));
    ctl.failing = false;
    const savesBefore = ctl.saves;
    const t = await a.getToken();
    expect(t).toMatch(/^at_/);
    expect(server.requests.at(-1)!.body.get("refresh_token")).toBe(newer); // used the newer grant
    expect(ctl.saves).toBe(savesBefore + 1); // only the refresh of the newer grant was written
    expect((await inner.load())?.refreshToken).toBe(server.issued.at(-1));
  });

  it("concurrent recovery flushes are single-flight: no late flush overwrites a newer grant another provider wrote", async () => {
    const path = join(dir, "race", "tokens.json");
    const inner = new FileTokenStore(path);
    await inner.save(expired(server.grant()));
    let failing = true;
    let holdSaves = false;
    let saveCalls = 0;
    const held: Array<() => void> = [];
    const deferred: TokenStore = {
      load: async () => {
        await new Promise((r) => setTimeout(r, 20)); // widen the load/save window
        return inner.load();
      },
      save: async (t) => {
        saveCalls++;
        if (failing) throw new Error("ENOSPC");
        if (holdSaves) await new Promise<void>((r) => held.push(r));
        await inner.save(t);
      },
      acquireLock: (o) => inner.acquireLock(o),
    };
    const a = provider({ store: deferred });
    const b = provider({ store: new FileTokenStore(path) });
    expect((await catchErr(a.getToken())).code).toBe("persist_failed");
    expect(server.requests).toHaveLength(1);

    failing = false;
    holdSaves = true;
    saveCalls = 0;
    const p1 = a.getToken();
    const p2 = a.getToken();
    const p3 = a.forceRefresh("not-the-current-token");
    for (let i = 0; i < 100 && held.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100)); // give any second (buggy) flush time to queue a save
    expect(held).toHaveLength(1);
    held.shift()!(); // the single flush writes X and releases the lock
    const [x1, x2, x3] = await Promise.all([p1, p2, p3]);
    expect(new Set([x1, x2, x3]).size).toBe(1);

    // B now holds the lock legitimately and rotates X -> Y.
    const y = await b.forceRefresh(x1);
    expect(y).not.toBe(x1);
    expect(server.requests).toHaveLength(2);
    holdSaves = false;
    while (held.length) held.shift()!();
    await new Promise((r) => setTimeout(r, 100));

    expect(saveCalls).toBe(1);
    const stored = await inner.load();
    expect(stored?.accessToken).toBe(y);
    expect(stored?.refreshToken).toBe(server.issued.at(-1));
    expect(server.valid.has(stored!.refreshToken!)).toBe(true);
    expect(await a.forceRefresh(x1)).toBe(y); // A adopts Y from the store, no request
    expect(server.requests).toHaveLength(2);
  });

  it("replaceGrant and dispose are serialized with a pending flush", async () => {
    const { store, ctl, inner } = flakyFileStore(join(dir, "tx", "tokens.json"));
    await inner.save(expired(server.grant()));
    const a = provider({ store });
    ctl.failing = true;
    expect((await catchErr(a.getToken())).code).toBe("persist_failed");
    ctl.failing = false;
    const fresh = server.grant();
    const flushing = a.getToken();
    const replacing = a.replaceGrant(expired(fresh));
    await flushing;
    await replacing;
    expect((await inner.load())?.refreshToken).toBe(fresh); // the replacement wins, flush did not overwrite it
    await expect(stat(inner.lockPath)).rejects.toThrow();

    ctl.failing = true;
    expect((await catchErr(a.getToken())).code).toBe("persist_failed");
    ctl.failing = false;
    const flush2 = a.getToken().catch(() => undefined);
    await a.dispose();
    await flush2;
    await expect(stat(inner.lockPath)).rejects.toThrow(); // persisted once and released, not left locked
    expect((await inner.load())?.refreshToken).toBe(server.issued.at(-1));
  });

  it("an emptied store fails closed (grant_removed); tokens bound to another client are refused", async () => {
    const c = clock();
    const store = new FileTokenStore(join(dir, "tokens.json"));
    const p = provider({ store, initialTokens: expired(server.grant()), now: c.now });
    await p.getToken();
    await store.clear();
    c.advance(400_000);
    expect((await catchErr(p.getToken())).code).toBe("grant_removed");

    const other = provider({ store: new MemoryTokenStore({ ...expired(server.grant()), binding: { tokenEndpoint: server.url, clientId: "someone_else" } }) });
    expect((await catchErr(other.getToken())).code).toBe("grant_binding_mismatch");
    expect(server.requests).toHaveLength(1);
  });
});

describe("no secret leaks", () => {
  it("scrubs server-echoed tokens from errors, events, status, JSON and inspect output", async () => {
    server.mode = "echo_secret_error";
    const rt0 = server.grant();
    const events: OAuthRefreshEvent[] = [];
    const p = provider({ store: new MemoryTokenStore(), initialTokens: expired(rt0), onEvent: (e) => events.push(e) });
    const e = await catchErr(p.getToken());
    expect(e.code).toBe("invalid_grant");
    for (const s of [e.message, e.stack ?? "", JSON.stringify(events), JSON.stringify(p), inspect(p, { depth: 5 }), String(e)]) {
      expect(s).not.toContain(rt0);
      expect(s).not.toMatch(/rt_[A-Za-z0-9_-]{10,}/);
    }
    expect(e.message).toContain("[REDACTED]");
  });

  it("successful refresh leaves no token values in events/status/inspect", async () => {
    const events: OAuthRefreshEvent[] = [];
    const store = new FileTokenStore(join(dir, "t.json"));
    const p = provider({ store, initialTokens: expired(server.grant()), onEvent: (e) => events.push(e) });
    const t = await p.getToken();
    const blob = JSON.stringify(events) + JSON.stringify(p) + inspect(p) + inspect(store);
    expect(blob).not.toContain(t);
    for (const rt of server.issued) expect(blob).not.toContain(rt);
    expect(events.find((ev) => ev.type === "refresh_succeeded")).toMatchObject({ rotated: true });
  });

  it("file store errors never include file contents", async () => {
    const path = join(dir, "bad.json");
    const secret = tok("rt");
    await writeFile(path, `{"tokens": "${secret}"`, { mode: 0o600 });
    const err = (await new FileTokenStore(path).load().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/not valid JSON/);
    expect(err.message).not.toContain(secret);
  });
});

describe("FileTokenStore security and locking", () => {
  it("rejects symlinked token files, insecure permissions and insecure directories", async () => {
    const real = join(dir, "real.json");
    const good = new FileTokenStore(real);
    await good.save(expired(tok("rt")));
    const link = join(dir, "link.json");
    await symlink(real, link);
    await expect(new FileTokenStore(link).load()).rejects.toThrow(/symlink/);
    await expect(new FileTokenStore(link).save(expired(tok("rt")))).rejects.toThrow(/symlink/);
    expect(await readSecretFile(link).catch((e: Error) => e.message)).toMatch(/symlink/);

    await chmod(real, 0o644);
    await expect(good.load()).rejects.toThrow(/0600/);
    await chmod(real, 0o600);

    const open = join(dir, "open");
    await mkdir(open);
    await chmod(open, 0o777);
    await expect(new FileTokenStore(join(open, "t.json")).save(expired(tok("rt")))).rejects.toThrow(/writable/);

    await mkdir(join(dir, "target-dir"), { mode: 0o700 });
    await symlink(join(dir, "target-dir"), join(dir, "linked-dir"));
    await expect(new FileTokenStore(join(dir, "linked-dir", "t.json")).save(expired(tok("rt")))).rejects.toThrow(/symlink/);
  });

  it("never steals a lock: neither an old timestamp from a live holder nor a dead pid triggers takeover", async () => {
    const store = new FileTokenStore(join(dir, "tokens.json"));
    for (const holder of [
      { pid: process.pid, host: hostname(), nonce: "live-but-old", createdAt: 0 },
      { pid: 2_147_483_000, host: hostname(), nonce: "dead-pid", createdAt: Date.now() - 3_600_000 },
    ]) {
      const body = JSON.stringify(holder);
      await writeFile(store.lockPath, body, { mode: 0o600 });
      const err = (await store.acquireLock({ timeoutMs: 250 }).catch((e: OAuthRefreshError) => e)) as OAuthRefreshError;
      expect(err.code).toBe("lock_timeout");
      expect(err.message).toMatch(/remove the lock file/);
      expect(await readFile(store.lockPath, "utf8")).toBe(body); // untouched
    }
    // Explicit operator recovery.
    await store.removeLock();
    const lock = await store.acquireLock({ timeoutMs: 250 });
    await lock.release();
    await expect(stat(store.lockPath)).rejects.toThrow();
  });

  it("lock waiters time out while a live holder keeps the lock; release hands it over", async () => {
    const lockPath = join(dir, "y.lock");
    const held = await acquireFileLock(lockPath);
    const err = (await acquireFileLock(lockPath, { timeoutMs: 150 }).catch((e: OAuthRefreshError) => e)) as OAuthRefreshError;
    expect(err.code).toBe("lock_timeout");
    const waiter = acquireFileLock(lockPath, { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 50));
    await held.release();
    await (await waiter).release();
  });
});

describe("multiple instances sharing one file store", () => {
  it("two providers refreshing concurrently make exactly one token request and share the rotated grant", async () => {
    server.delayMs = 100;
    const path = join(dir, "shared", "tokens.json");
    await new FileTokenStore(path).save(expired(server.grant()));
    const a = provider({ store: new FileTokenStore(path) });
    const b = provider({ store: new FileTokenStore(path) });
    const results = await Promise.all([...Array.from({ length: 10 }, () => a.getToken()), ...Array.from({ length: 10 }, () => b.getToken())]);
    expect(new Set(results).size).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(a.status().refreshCount + b.status().refreshCount).toBe(1);
    expect(a.status().adoptedCount + b.status().adoptedCount).toBe(1);
    expect((await new FileTokenStore(path).load())?.refreshToken).toBe(server.issued.at(-1));
  });

  it("an instance with a stale in-memory grant adopts the rotated refresh token instead of replaying the old one", async () => {
    const c = clock();
    const path = join(dir, "tokens.json");
    await new FileTokenStore(path).save(expired(server.grant()));
    const a = provider({ store: new FileTokenStore(path), now: c.now });
    const b = provider({ store: new FileTokenStore(path), now: c.now });
    const ta = await a.getToken(); // A rotates rt0 -> rt1
    expect(await b.getToken()).toBe(ta);
    expect(server.requests).toHaveLength(1);
    c.advance(400_000); // both expired; B refreshes with rt1 from the store
    const tb = await b.getToken();
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.body.get("refresh_token")).toBe(server.issued.at(-2));
    expect(await a.getToken()).toBe(tb);
    expect(server.requests).toHaveLength(2);
  });

  it("serializes refresh across two OS processes sharing the file store", async () => {
    server.delayMs = 300;
    const path = join(dir, "xproc", "tokens.json");
    await new FileTokenStore(path).save(expired(server.grant()));
    const moduleUrl = new URL("../src/sdk/oauth-refresh.ts", import.meta.url).href;
    const script = join(dir, "child.mts");
    await writeFile(
      script,
      `import { OAuthRefreshProvider, FileTokenStore } from ${JSON.stringify(moduleUrl)};
import { createHash } from "node:crypto";
const p = new OAuthRefreshProvider({ tokenEndpoint: process.env.TE, clientId: "client_public_123", resource: ${JSON.stringify(RESOURCE)}, allowInsecureLocalhost: true, store: new FileTokenStore(process.env.TP) });
const toks = await Promise.all(Array.from({ length: 5 }, () => p.getToken()));
process.stdout.write(JSON.stringify({ distinct: new Set(toks).size, refreshCount: p.status().refreshCount, fp: createHash("sha256").update(toks[0]).digest("hex") }));
`,
    );
    const tsxLoader = resolve("node_modules/tsx/dist/esm/index.mjs");
    const runChild = () =>
      new Promise<{ distinct: number; refreshCount: number; fp: string }>((res, rej) => {
        const child = spawn(process.execPath, ["--import", tsxLoader, script], { env: { ...process.env, TE: server.url, TP: path }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`child exited ${code}: ${err.slice(0, 500)}`))));
      });
    const [x, y] = await Promise.all([runChild(), runChild()]);
    expect(x.distinct).toBe(1);
    expect(y.distinct).toBe(1);
    expect(x.fp).toBe(y.fp);
    expect(x.refreshCount + y.refreshCount).toBe(1);
    expect(server.requests).toHaveLength(1);
    const stored = await new FileTokenStore(path).load();
    expect(server.valid.has(stored!.refreshToken!)).toBe(true);
    expect((await readdir(join(dir, "xproc"))).sort()).toEqual(["tokens.json"]);
  }, 30_000);
});

describe("helpers", () => {
  it("tokensFromTokenResponse validates a standard token response", () => {
    const t = tokensFromTokenResponse({ access_token: "at_abcdefgh", token_type: "Bearer", expires_in: 300, refresh_token: "rt_abcdefgh" }, 1_000);
    expect(t).toMatchObject({ accessToken: "at_abcdefgh", refreshToken: "rt_abcdefgh", expiresAt: 301_000, obtainedAt: 1_000 });
    expect(() => tokensFromTokenResponse({ access_token: "x", token_type: "mac", expires_in: 1 })).toThrow(/Bearer/);
    expect(() => tokensFromTokenResponse({ access_token: "x", token_type: "Bearer", expires_in: -1 })).toThrow(/expires_in/);
  });

  it("keeps the file 0600 with the latest refresh token across many rotations", async () => {
    const store = new FileTokenStore(join(dir, "rot.json"));
    const c = clock();
    const p = provider({ store, initialTokens: expired(server.grant()), now: c.now });
    for (let i = 0; i < 5; i++) {
      await p.getToken();
      c.advance(400_000);
    }
    expect(server.requests).toHaveLength(5);
    expect(((await stat(store.path)).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await readFile(store.path, "utf8")).tokens.refreshToken).toBe(server.issued.at(-1));
  });
});
