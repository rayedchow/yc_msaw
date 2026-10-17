/**
 * Parent OAuth refresh + live tools together, over REAL loopback HTTP/MCP:
 *  - SIMULATED authorization server with ROTATING refresh tokens and 3 s access tokens (WorkOS issues 300 s);
 *  - a bearer-checking proxy in front of the REAL parent app (memory /mcp, catalog, token route);
 *  - SIMULATED child MCP with real short-lived EdDSA child tokens;
 *  - the SDK OAuthRefreshProvider (src/sdk/oauth-refresh.ts, owned by the OAuth worker) wired with oauthParentCredential.
 * Covers: rotating parent refresh and child re-mint at the same time under concurrent calls, server-side revocation
 * (one forceRefresh, retry), grant revocation (reauth -> fail closed, no storm), and no replay of a mutating call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryTokenStore, OAuthRefreshProvider, tokensFromTokenResponse } from "../src/sdk/oauth-refresh.js";
import { LiveToolRegistry, oauthParentCredential } from "../src/sdk/live/index.js";
import type { LiveToolResult } from "../src/sdk/live/index.js";
import { echoTool, LoopbackParent, SimulatedOAuthParent, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: LiveToolResult) => r.content.filter((c) => c.type === "text").map((c) => String(c.text)).join("\n");
const err = (r: LiveToolResult) => (r._meta?.["procmem/error"] ?? {}) as { code?: string; mayHaveExecuted?: boolean };

const parent = new LoopbackParent();
let oauth: SimulatedOAuthParent;
let child: SimulatedChild;
let provider: OAuthRefreshProvider;
let registry: LiveToolRegistry;
let offset = 0;
let transfers = 0;
const logs: string[] = [];

beforeAll(async () => {
  await parent.start();
  child = await parent.child("omega", [
    echoTool("echo"),
    { tool: { name: "transfer", description: "Mutating (simulated).", inputSchema: { type: "object", properties: {} } }, handler: () => ((transfers += 1), { content: [{ type: "text", text: "moved" }] }) },
  ]);
  parent.tokenTtlSeconds = 30;
  parent.publish(child);
  oauth = new SimulatedOAuthParent(parent.baseUrl, parent.key.key);
  await oauth.start();
  provider = new OAuthRefreshProvider({
    tokenEndpoint: oauth.tokenEndpoint,
    clientId: "public-cli-client",
    resource: `${oauth.url}/mcp`,
    store: new MemoryTokenStore(),
    initialTokens: tokensFromTokenResponse(oauth.issueInitial()),
    allowInsecureLocalhost: true,
  });
  registry = new LiveToolRegistry({
    parent: { baseUrl: oauth.url, ...oauthParentCredential(provider), allowInsecureLocalhost: true },
    pollIntervalMs: 60_000,
    sourceRetryMs: 0,
    now: () => Date.now() + offset, // child-token clock only; the OAuth provider uses real time
    onLog: (e) => logs.push(e.message),
  });
  await registry.start();
}, 60_000);

afterAll(async () => {
  await registry?.dispose();
  await provider?.dispose();
  await oauth?.close();
  await child?.close();
  await parent.close();
});

describe("parent OAuth refresh with live tools", () => {
  it("discovers memory and child tools through the OAuth-protected parent", () => {
    expect(registry.getTools().some((t) => t.name === "memory__open_memory")).toBe(true);
    expect(registry.getTools().some((t) => t.name === "integration__omega__echo")).toBe(true);
  });

  it("keeps working while parent access tokens rotate (3 s) and child tokens re-mint, under concurrent calls; mutating calls run exactly once", async () => {
    const refreshes0 = provider.status().refreshCount;
    const posts0 = oauth.tokenPosts;
    const mints0 = registry.tokenMints("omega");
    let issued = 0;
    const deadline = Date.now() + 7_000;
    let round = 0;
    while (Date.now() < deadline) {
      round++;
      if (round === 4) offset = 16_000; // child token past half-life -> re-mint while parent tokens also rotate
      const out = await Promise.all([
        registry.callTool("memory__ls", { path: "$KNOWLEDGE" }),
        registry.callTool("integration__omega__echo", { message: `r${round}` }),
        registry.callTool("integration__omega__echo", { message: `s${round}` }),
        registry.callTool("integration__omega__transfer", {}),
      ]);
      issued++;
      for (const r of out) expect(r.isError, JSON.stringify(r).slice(0, 300)).toBeFalsy();
      if (round % 3 === 0) expect(await registry.refresh()).toBe(true); // catalog + memory relist with the current token
      await sleep(400);
    }
    expect(transfers).toBe(issued);
    expect(provider.status().refreshCount - refreshes0).toBeGreaterThanOrEqual(2);
    expect(oauth.tokenPosts - posts0).toBe(provider.status().refreshCount - refreshes0); // no extra token requests
    expect(registry.tokenMints("omega") - mints0).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("server-side access-token revocation: one forceRefresh shared by concurrent calls, the rejected requests retried", async () => {
    const posts0 = oauth.tokenPosts;
    const t0 = transfers;
    oauth.revokeAccessTokens();
    const out = await Promise.all([registry.callTool("memory__ls", { path: "$KNOWLEDGE" }), registry.callTool("memory__ls", { path: "$KNOWLEDGE" }), registry.refresh()]);
    expect((out[0] as LiveToolResult).isError).toBeFalsy();
    expect((out[1] as LiveToolResult).isError).toBeFalsy();
    expect(out[2]).toBe(true);
    expect(oauth.tokenPosts - posts0).toBe(1);
    // The child bearer is independent of the parent access token and keeps working; a mutating call runs once.
    expect(text(await registry.callTool("integration__omega__transfer", {}))).toBe("moved");
    expect(transfers - t0).toBe(1);
  });

  describe("a LATE 401 for an old token after a newer one is in use (exact rejected credential per request)", () => {
    let forced: string[];
    let reg: LiveToolRegistry;
    beforeAll(async () => {
      oauth.accessTtlSeconds = 60; // no expiry-driven refresh during these scenarios
      await provider.forceRefresh(await provider.getToken());
      forced = [];
      const cred = oauthParentCredential(provider);
      reg = new LiveToolRegistry({
        parent: { baseUrl: oauth.url, credential: cred.credential, onUnauthorized: (r) => (forced.push(r ?? "<unknown>"), cred.onUnauthorized(r)), allowInsecureLocalhost: true },
        pollIntervalMs: 60_000,
        sourceRetryMs: 0,
        now: () => Date.now() + offset,
      });
      await reg.start();
    });
    afterAll(async () => {
      await reg?.dispose();
    });

    it("memory MCP: the delayed old-token 401 adopts the new token (1 refresh POST total, no flap)", async () => {
      const old = await provider.getToken();
      const posts0 = oauth.tokenPosts;
      const v0 = reg.getSnapshot().version;
      oauth.delayNext(old, 700);
      oauth.revokeAccessTokens();
      const late = reg.callTool("memory__ls", { path: "$KNOWLEDGE" }); // carries `old`, answered 401 after 700 ms
      await sleep(150);
      const early = await reg.callTool("memory__ls", { path: "$KNOWLEDGE" }); // carries `old`, 401 now -> refresh -> retry
      expect(early.isError).toBeFalsy();
      const fresh = await provider.getToken();
      expect(fresh).not.toBe(old);
      expect((await late).isError).toBeFalsy();
      expect(oauth.tokenPosts - posts0).toBe(1);
      expect(forced.length).toBeGreaterThanOrEqual(2);
      expect(forced.every((r) => r === old)).toBe(true); // never the NEW token
      expect(reg.getSnapshot().version).toBe(v0);
    });

    it("catalog GET: a delayed old-token 401 after the refresh retries with the new token (1 POST, catalog ok)", async () => {
      const old = await provider.getToken();
      const posts0 = oauth.tokenPosts;
      forced.length = 0;
      oauth.delayNext(old, 700);
      oauth.revokeAccessTokens();
      const late = reg.refresh(); // catalog GET carries `old`
      await sleep(150);
      expect((await reg.callTool("memory__ls", { path: "$KNOWLEDGE" })).isError).toBeFalsy();
      expect(await late).toBe(true);
      expect(reg.getSnapshot().catalog.state).toBe("ok");
      expect(reg.getTools().some((t) => t.source === "integration:omega")).toBe(true);
      expect(oauth.tokenPosts - posts0).toBe(1);
      expect(forced.every((r) => r === old)).toBe(true);
    });

    it("child token route: a delayed old-token 401 on the mint retries with the new token; the mutating call runs once", async () => {
      const old = await provider.getToken();
      const posts0 = oauth.tokenPosts;
      const t0 = transfers;
      forced.length = 0;
      offset += 40_000; // child token expired: the next call must mint (POST /v1/integrations/omega/token)
      oauth.delayNext(old, 700);
      oauth.revokeAccessTokens();
      const late = reg.callTool("integration__omega__transfer", {}); // mint carries `old`, 401 after 700 ms
      await sleep(150);
      expect((await reg.callTool("memory__ls", { path: "$KNOWLEDGE" })).isError).toBeFalsy();
      const r = await late;
      expect(text(r)).toBe("moved");
      expect(transfers - t0).toBe(1);
      expect(oauth.tokenPosts - posts0).toBe(1);
      expect(forced.every((x) => x === old)).toBe(true);
    });

    it("two providers sharing one token store: concurrent 401s on both registries cause ONE refresh POST", async () => {
      const store = new MemoryTokenStore();
      oauth.accessTtlSeconds = 60;
      const seed = tokensFromTokenResponse(oauth.issueInitial());
      const pa = new OAuthRefreshProvider({ tokenEndpoint: oauth.tokenEndpoint, clientId: "public-cli-client", resource: `${oauth.url}/mcp`, store, initialTokens: seed, allowInsecureLocalhost: true });
      const pb = new OAuthRefreshProvider({ tokenEndpoint: oauth.tokenEndpoint, clientId: "public-cli-client", resource: `${oauth.url}/mcp`, store, initialTokens: seed, allowInsecureLocalhost: true });
      const ra = new LiveToolRegistry({ parent: { baseUrl: oauth.url, ...oauthParentCredential(pa), allowInsecureLocalhost: true }, pollIntervalMs: 60_000, integrations: false });
      const rb = new LiveToolRegistry({ parent: { baseUrl: oauth.url, ...oauthParentCredential(pb), allowInsecureLocalhost: true }, pollIntervalMs: 60_000, integrations: false });
      try {
        await ra.start();
        await rb.start();
        expect(await pa.getToken()).toBe(await pb.getToken());
        const posts0 = oauth.tokenPosts;
        oauth.revokeAccessTokens();
        const out = await Promise.all([ra.callTool("memory__ls", { path: "$KNOWLEDGE" }), rb.callTool("memory__ls", { path: "$KNOWLEDGE" }), ra.callTool("memory__ls", { path: "$KNOWLEDGE" }), rb.callTool("memory__ls", { path: "$KNOWLEDGE" })]);
        for (const r of out) expect(r.isError).toBeFalsy();
        expect(oauth.tokenPosts - posts0).toBe(1);
        expect(await pa.getToken()).toBe(await pb.getToken());
      } finally {
        await ra.dispose();
        await rb.dispose();
        await pa.dispose();
        await pb.dispose();
      }
    });
  });

  it("grant revocation (invalid_grant) fails closed without a refresh storm and without executing mutating calls", async () => {
    oauth.revokeGrant();
    oauth.revokeAccessTokens();
    const posts0 = oauth.tokenPosts;
    const mem = await registry.callTool("memory__ls", { path: "$KNOWLEDGE" });
    expect(mem.isError).toBe(true);
    expect(["reauth_required", "unauthorized"]).toContain(err(mem).code);
    expect(err(mem).mayHaveExecuted).toBe(false);
    await registry.refresh();
    await registry.refresh();
    expect(registry.getSnapshot().catalog.state).toBe("unauthorized");
    expect(registry.getTools().some((t) => t.source === "memory")).toBe(false);
    const t0 = transfers;
    // The integration was retired with the catalog: the mutating call is refused before any traffic.
    expect(err(await registry.callTool("integration__omega__transfer", {})).code).toBe("tool_not_found");
    expect(transfers).toBe(t0);
    expect(oauth.tokenPosts - posts0).toBeLessThanOrEqual(1);
    expect(provider.status().state).toBe("reauth_required");
  });

  it("no access/refresh token or key appears in results, snapshots or logs", () => {
    const blob = JSON.stringify({ snap: registry.getSnapshot(), tools: registry.getTools(), logs, status: provider.status() });
    for (const t of [...oauth.knownTokens, parent.key.key, ...child.tokensSeen]) expect(blob).not.toContain(t);
    expect(blob).not.toMatch(/oat_\d+_|ort_\d+_/);
  });
});
