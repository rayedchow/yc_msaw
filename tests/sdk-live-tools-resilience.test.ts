/**
 * Live tools resilience over REAL loopback MCP (real parent app + token route, SIMULATED upstream children):
 * polling/backoff/disposal, child token refresh (short TTL, concurrent dedupe, clock skew, expired tokens), 401 handling
 * (one fresh-credential retry, then fail closed), token-route failures without hot loops, preflight minting outside the
 * MCP transport, single-flight reconnect, no replay of mutating calls, stale-definition refusal, credential scrubbing of
 * results and tool metadata, namespace mismatch and redirect defenses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LiveToolRegistry, ToolBoundary } from "../src/sdk/live/index.js";
import type { LiveToolResult } from "../src/sdk/live/index.js";
import { echoTool, LoopbackParent, redirectingServer, type SimTool, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}
const text = (r: LiveToolResult) => r.content.filter((c) => c.type === "text").map((c) => String(c.text)).join("\n");
const err = (r: LiveToolResult) => (r._meta?.["procmem/error"] ?? {}) as { code?: string; mayHaveExecuted?: boolean; retried?: boolean };

const parent = new LoopbackParent();
let child: SimulatedChild;
const registries: LiveToolRegistry[] = [];
let dropReadOnce = true;

const childTools = (): SimTool[] => [
  echoTool("echo"),
  {
    // Mutating (no readOnlyHint): executes, then the connection dies before the response is written.
    tool: { name: "charge", description: "Charge a card (simulated, mutating).", inputSchema: { type: "object", properties: { cents: { type: "number" } } } },
    handler: (_a, ctl) => {
      ctl.dropConnection();
      return { content: [{ type: "text", text: "charged" }] };
    },
  },
  {
    tool: { name: "flaky_read", description: "Read-only; the first call's connection drops (simulated).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    handler: (_a, ctl) => {
      if (dropReadOnce) {
        dropReadOnce = false;
        ctl.dropConnection();
      }
      return { content: [{ type: "text", text: "read ok" }] };
    },
  },
  {
    // A careless upstream that echoes the bearer it received (and the parent key it should never know) back.
    tool: { name: "leaky", description: "Echo request auth (simulated careless upstream).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    handler: (_a, ctl) => ({
      content: [
        { type: "text", text: `you sent ${ctl.authorization}; parent key ${parent.key.key}` },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      structuredContent: {
        header: ctl.authorization,
        nested: { k: parent.key.key },
        blob: ctl.authorization.slice(7),
        [`by_${ctl.authorization.slice(7)}`]: true,
        normal: "Bearer is a word; tokenized text stays",
      },
    }),
  },
];
const names = () => childTools().map((t) => t.tool.name);

function make(over: Partial<ConstructorParameters<typeof LiveToolRegistry>[0]> = {}, credential: () => string = () => parent.key.key): LiveToolRegistry {
  const r = new LiveToolRegistry({ parent: { baseUrl: parent.baseUrl, credential, allowInsecureLocalhost: true }, pollIntervalMs: 60_000, listChangedDebounceMs: 20, sourceRetryMs: 0, ...over });
  registries.push(r);
  return r;
}

beforeAll(async () => {
  await parent.start();
  child = await parent.child("gamma", childTools());
  parent.publish(child);
}, 30_000);

afterEach(() => {
  parent.tokenTtlSeconds = 900;
  parent.tokenMcpUrlOverride = null;
  parent.tokenFailure = null;
  parent.tokenExpired = false;
  parent.childAuthConfigured = true;
  parent.failCatalog = 0;
  child.rejectAll = false;
  child.rejectNext = 0;
  child.setTools(childTools());
  parent.publish(child);
});

afterAll(async () => {
  for (const r of registries) await r.dispose();
  await child?.close();
  await parent.close();
});

describe("polling", () => {
  it("polls the catalog and re-lists unchanged deployments without any notification", async () => {
    const r = make({ pollIntervalMs: 50 });
    await r.start();
    expect(r.getTools().map((t) => t.name)).not.toContain("integration__gamma__added_later");
    child.setTools([...childTools(), echoTool("added_later")]);
    parent.publish(child, { tools: [...names(), "added_later"] }); // same deployment id
    await until(() => r.getTools().some((t) => t.name === "integration__gamma__added_later"));
    child.setTools(childTools());
    parent.publish(child);
    await until(() => !r.getTools().some((t) => t.name === "integration__gamma__added_later"));
    await r.dispose();
  });

  it("backs off on repeated catalog failures (bounded) and recovers", async () => {
    const r = make({ pollIntervalMs: 20, maxBackoffMs: 160 });
    await r.start();
    const start = parent.catalogCalls;
    parent.failCatalog = 1_000;
    await sleep(1200);
    const failedCalls = parent.catalogCalls - start;
    // Without backoff ~60 polls would happen; with 20,40,80,160,160... far fewer.
    expect(failedCalls).toBeGreaterThan(2);
    expect(failedCalls).toBeLessThan(16);
    expect(r.getSnapshot().catalog.state).toBe("transient_error");
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(true); // last good set kept
    parent.failCatalog = 0;
    await until(() => r.getSnapshot().catalog.state === "ok", 3000);
    await r.dispose();
  });

  it("drops the last good integration set once the catalog stays unreachable beyond maxStaleMs", async () => {
    const r = make({ maxStaleMs: 50 });
    await r.start();
    parent.failCatalog = 5;
    await sleep(80);
    await r.refresh();
    expect(r.getSnapshot().catalog.state).toBe("stale_dropped");
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
    expect(r.getTools().some((t) => t.source === "memory")).toBe(true);
  });

  it("dispose() stops polling, timers and further upstream traffic", async () => {
    const r = make({ pollIntervalMs: 20 });
    await r.start();
    await sleep(100);
    await r.dispose();
    const calls = parent.catalogCalls;
    const lists = child.listCalls;
    await sleep(250);
    expect(parent.catalogCalls).toBe(calls);
    expect(child.listCalls).toBe(lists);
    expect(r.disposed).toBe(true);
    expect(err(await r.callTool("integration__gamma__echo", { message: "x" })).code).toBe("disposed");
    expect(await r.refresh()).toBe(false);
  });
});

describe("child credentials", () => {
  it("refreshes a short-lived child bearer before expiry; concurrent calls share one mint", async () => {
    parent.tokenTtlSeconds = 30; // the product minimum
    let offset = 0;
    const r = make({ now: () => Date.now() + offset, tokenRefreshSkewMs: 60_000 });
    await r.start();
    expect(r.tokenMints("gamma")).toBe(1);
    expect(text(await r.callTool("integration__gamma__echo", { message: "a" }))).toBe("echo:a");
    expect(r.tokenMints("gamma")).toBe(1); // still fresh
    offset = 16_000; // past half the 30s lifetime: refresh before expiry
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => r.callTool("integration__gamma__echo", { message: `c${i}` })));
    expect(results.map(text)).toEqual(Array.from({ length: 8 }, (_, i) => `echo:c${i}`));
    expect(r.tokenMints("gamma")).toBe(2);
    expect(child.tokensSeen.size).toBeGreaterThanOrEqual(2);
  });

  it("measures token lifetime on the server clock, so a client clock running 20 minutes ahead does not re-mint per request", async () => {
    const r = make({ now: () => Date.now() + 20 * 60_000 });
    await r.start();
    for (let i = 0; i < 4; i++) expect(text(await r.callTool("integration__gamma__echo", { message: `s${i}` }))).toBe(`echo:s${i}`);
    expect(r.tokenMints("gamma")).toBe(1);
  });

  it("rejects an already-expired token response before any MCP traffic", async () => {
    parent.tokenExpired = true;
    const seen = child.authHeadersSeen.length;
    const r = make();
    await r.start();
    const src = r.getSnapshot().sources.find((s) => s.source === "integration:gamma");
    expect(src?.state).toBe("excluded");
    expect(src?.error).toMatch(/already expired/);
    expect(child.authHeadersSeen.length).toBe(seen);
  });

  it("a single 401 (rotated/expired token) gets one fresh-credential retry and the toolset does not flap", async () => {
    const r = make();
    await r.start();
    const version = r.getSnapshot().version;
    const mints = r.tokenMints("gamma");
    child.rejectNext = 1;
    expect(text(await r.callTool("integration__gamma__echo", { message: "rotated" }))).toBe("echo:rotated");
    expect(r.tokenMints("gamma")).toBe(mints + 1);
    expect(r.getSnapshot().version).toBe(version);
    expect(r.getTools().some((t) => t.name === "integration__gamma__echo")).toBe(true);
  });

  it("a persistent child 401 fails closed after the one retry, without leaking credentials, and recovers on refresh", async () => {
    const r = make();
    await r.start();
    const before = child.calls.get("echo") ?? 0;
    child.rejectAll = true;
    const res = await r.callTool("integration__gamma__echo", { message: "x" });
    expect(res.isError).toBe(true);
    expect(err(res).code).toBe("unauthorized");
    expect(child.calls.get("echo") ?? 0).toBe(before);
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
    expect(r.getSnapshot().sources.find((s) => s.source === "integration:gamma")?.state).toBe("auth_failed");
    const blob = JSON.stringify({ res, snap: r.getSnapshot() });
    expect(blob).not.toContain(parent.key.key);
    for (const t of child.tokensSeen) expect(blob).not.toContain(t);
    child.rejectAll = false;
    await r.refresh({ force: true });
    expect(r.getTools().some((t) => t.name === "integration__gamma__echo")).toBe(true);
  });

  it("fails closed on a parent 401 (catalog and memory) and calls the credential provider fresh", async () => {
    let key = parent.key.key;
    let provided = 0;
    const r = make({}, () => {
      provided++;
      return key;
    });
    await r.start();
    const p0 = provided;
    key = "pmk_revokedrevokedrevokedrevokedrevoked0000000";
    await r.refresh();
    expect(r.getSnapshot().catalog.state).toBe("unauthorized");
    expect(r.getTools().some((t) => t.source !== "memory")).toBe(false);
    expect(JSON.stringify(r.getSnapshot())).not.toContain(key);
    const mem = await r.callTool("memory__open_memory", {});
    expect(mem.isError).toBe(true);
    expect(JSON.stringify(mem)).not.toContain(key);
    expect(provided).toBeGreaterThan(p0);
    key = parent.key.key;
    await r.refresh({ force: true });
    expect(r.getSnapshot().catalog.state).toBe("ok");
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(true);
    expect(r.getTools().some((t) => t.source === "memory")).toBe(true);
  });

  it("never sends the parent credential to a child", () => {
    expect(child.authHeadersSeen.length).toBeGreaterThan(0);
    expect(child.authHeadersSeen.some((h) => h.includes(parent.key.key))).toBe(false);
  });

  it("excludes a child whose token response names a different URL (namespace mismatch)", async () => {
    parent.tokenMcpUrlOverride = "http://127.0.0.1:9/elsewhere";
    const r = make();
    await r.start();
    const src = r.getSnapshot().sources.find((s) => s.source === "integration:gamma");
    expect(src?.state).toBe("excluded");
    expect(src?.error).toMatch(/differs from the catalog entry/);
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
  });
});

describe("token route failures do not hot-loop", () => {
  for (const failure of ["not_found", "child_auth_not_configured", "throw"] as const) {
    it(`persistent ${failure} token failure: bounded token requests, no refresh storm`, async () => {
      parent.tokenFailure = failure;
      const r = make({ sourceRetryMs: 60_000 });
      const req0 = parent.tokenRequests;
      const cat0 = parent.catalogCalls;
      await r.start();
      await sleep(400);
      await r.refresh(); // a poll inside the backoff window must not mint again
      expect(parent.tokenRequests - req0).toBeLessThanOrEqual(1);
      expect(parent.catalogCalls - cat0).toBeLessThanOrEqual(2);
      const src = r.getSnapshot().sources.find((s) => s.source === "integration:gamma");
      expect(src?.state).toBe(failure === "throw" ? "error" : "excluded");
      expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
      expect(r.getTools().some((t) => t.source === "memory")).toBe(true);
    });
  }

  it("childAuthConfigured:false: no token is ever requested and integrations are excluded", async () => {
    parent.childAuthConfigured = false;
    const req0 = parent.tokenRequests;
    const r = make();
    await r.start();
    await r.refresh({ force: true });
    expect(parent.tokenRequests).toBe(req0);
    expect(r.getSnapshot().sources.find((s) => s.source === "integration:gamma")).toMatchObject({ state: "excluded" });
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
  });

  it("an expired bearer on an EXISTING connection is re-minted outside the MCP transport; a 404 fails closed without sending the call", async () => {
    parent.tokenTtlSeconds = 30;
    let offset = 0;
    const r = make({ now: () => Date.now() + offset });
    await r.start();
    expect(text(await r.callTool("integration__gamma__echo", { message: "warm" }))).toBe("echo:warm");
    const calls = child.calls.get("echo") ?? 0;
    parent.tokenFailure = "not_found"; // retired between the catalog read and the mint
    offset = 40_000; // token now expired
    const res = await r.callTool("integration__gamma__echo", { message: "late" });
    expect(err(res)).toMatchObject({ code: "integration_removed", mayHaveExecuted: false });
    expect(child.calls.get("echo") ?? 0).toBe(calls);
    expect(r.getTools().some((t) => t.source === "integration:gamma")).toBe(false);
    parent.tokenFailure = "throw"; // 502 token_failed -> transient, reported as not executed
    parent.tokenFailure = null;
  });

  it("a transient (502) mint failure on a call is reported as not executed and keeps the tools", async () => {
    parent.tokenTtlSeconds = 30;
    let offset = 0;
    const r = make({ now: () => Date.now() + offset });
    await r.start();
    parent.tokenFailure = "throw";
    offset = 40_000;
    const res = await r.callTool("integration__gamma__echo", { message: "x" });
    expect(err(res)).toMatchObject({ code: "token_unavailable", mayHaveExecuted: false });
    expect(r.getTools().some((t) => t.name === "integration__gamma__echo")).toBe(true);
  });
});

describe("connections", () => {
  it("reconnects once (single flight) when many calls hit an expired session at the same time", async () => {
    const r = make();
    await r.start();
    expect(text(await r.callTool("integration__gamma__echo", { message: "w" }))).toBe("echo:w");
    await child.dropSessions(); // server forgets the session: next requests get 404
    const created = child.sessionsCreated;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => r.callTool("integration__gamma__echo", { message: `p${i}` })));
    expect(results.map(text)).toEqual(Array.from({ length: 6 }, (_, i) => `echo:p${i}`));
    expect(child.sessionsCreated - created).toBe(1);
  });
});

describe("ambiguous transport failures", () => {
  it("does not replay a mutating tool after the connection dropped mid-call", async () => {
    const r = make();
    await r.start();
    const before = child.calls.get("charge") ?? 0;
    const res = await r.callTool("integration__gamma__charge", { cents: 500 });
    expect(res.isError).toBe(true);
    expect(err(res)).toMatchObject({ code: "ambiguous_failure", mayHaveExecuted: true, retried: false });
    expect(text(res)).toMatch(/NOT retried/);
    expect((child.calls.get("charge") ?? 0) - before).toBe(1);
    expect(text(await r.callTool("integration__gamma__echo", { message: "after" }))).toBe("echo:after");
  });

  it("retries a readOnlyHint tool once", async () => {
    dropReadOnce = true;
    const r = make();
    await r.start();
    const before = child.calls.get("flaky_read") ?? 0;
    const res = await r.callTool("integration__gamma__flaky_read", {});
    expect(text(res)).toBe("read ok");
    expect((child.calls.get("flaky_read") ?? 0) - before).toBe(2);
  });

  it("concurrent token refresh + a mutating call: the call executes exactly once", async () => {
    parent.tokenTtlSeconds = 30;
    let offset = 0;
    const r = make({ now: () => Date.now() + offset });
    await r.start();
    child.setTools([...childTools(), { tool: { name: "transfer", description: "Mutating (simulated).", inputSchema: { type: "object", properties: {} } }, handler: () => ({ content: [{ type: "text", text: "moved" }] }) }]);
    parent.publish(child, { tools: [...names(), "transfer"] });
    await r.refresh({ force: true });
    offset = 20_000;
    const before = child.calls.get("transfer") ?? 0;
    const out = await Promise.all([r.callTool("integration__gamma__transfer", {}), ...Array.from({ length: 4 }, () => r.callTool("integration__gamma__echo", { message: "r" }))]);
    expect(text(out[0]!)).toBe("moved");
    expect((child.calls.get("transfer") ?? 0) - before).toBe(1);
    expect(r.tokenMints("gamma")).toBe(2);
  });
});

describe("stale definitions are refused, never forwarded", () => {
  it("a same-name schema change mid-turn is refused for the old view until sync()", async () => {
    const r = make();
    await r.start();
    const view = new ToolBoundary(r);
    const before = child.calls.get("echo") ?? 0;
    child.setTools([{ ...echoTool("echo"), tool: { ...echoTool("echo").tool, inputSchema: { type: "object", properties: { message: { type: "string" }, loud: { type: "boolean" } }, required: ["message", "loud"] } } }, ...childTools().slice(1)]);
    await child.notifyListChanged();
    await until(() => (r.getTools().find((t) => t.name === "integration__gamma__echo")?.inputSchema as { required?: string[] }).required?.includes("loud") === true);
    const stale = await view.callTool("integration__gamma__echo", { message: "old-args" });
    expect(err(stale)).toMatchObject({ code: "tool_changed", mayHaveExecuted: false });
    expect(child.calls.get("echo") ?? 0).toBe(before);
    expect(view.sync()?.updated.map((t) => t.name)).toEqual(["integration__gamma__echo"]);
    expect(text(await view.callTool("integration__gamma__echo", { message: "new", loud: true }))).toBe("echo:new");
    view.dispose();
  });

  it("a deployment or catalog-title change with identical schemas still changes the fingerprint", async () => {
    const r = make();
    await r.start();
    const fp = r.getTools().find((t) => t.name === "integration__gamma__echo")!.fingerprint;
    parent.publish(child, { deploymentId: "d9", commit: "c9" });
    await r.refresh();
    const fp2 = r.getTools().find((t) => t.name === "integration__gamma__echo")!.fingerprint;
    expect(fp2).not.toBe(fp);
    expect(err(await r.callTool("integration__gamma__echo", { message: "x" }, { expectedFingerprint: fp })).code).toBe("tool_changed");
    parent.publish(child, { deploymentId: "d9", commit: "c9", title: "Renamed title" });
    await r.refresh();
    expect(r.getTools().find((t) => t.name === "integration__gamma__echo")!.fingerprint).not.toBe(fp2);
  });
});

describe("credential scrubbing", () => {
  it("removes known credentials from results (text and structuredContent) and tool metadata; images and ordinary text intact", async () => {
    child.setTools([...childTools().slice(0, 3), { ...childTools()[3]!, tool: { ...childTools()[3]!.tool, description: `Echo auth. debug key=${parent.key.key}` } }]);
    const r = make();
    await r.start();
    const res = await r.callTool("integration__gamma__leaky", {});
    const blob = JSON.stringify(res);
    expect(blob).not.toContain(parent.key.key);
    for (const t of child.tokensSeen) expect(blob).not.toContain(t);
    expect(text(res)).toContain("[REDACTED]");
    expect(res.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect((res.structuredContent as { normal: string }).normal).toBe("Bearer is a word; tokenized text stays");
    expect((res.structuredContent as { blob: string }).blob).toBe("[REDACTED]");
    expect(Object.keys(res.structuredContent as object)).toContain("by_[REDACTED]");
    const def = JSON.stringify(r.getTools().find((t) => t.name === "integration__gamma__leaky"));
    expect(def).not.toContain(parent.key.key);
    expect(def).toContain("[REDACTED]");
  });
});

describe("credential defenses", () => {
  it("rejects untrusted child URLs from the catalog and never follows redirects with credentials", async () => {
    const redir = await redirectingServer();
    try {
      const evil = await parent.child("redirected", [echoTool("x")]);
      parent.publish(evil, { mcpUrl: redir.url });
      parent.entries.push({ slug: "plainhttp", title: "", description: "", mcpUrl: "http://example.com/mcp", tools: ["x"], commit: "c", deploymentId: "d" });
      const r = make();
      await r.start();
      expect(r.getSnapshot().catalog.rejected?.some((x) => x.slug === "plainhttp" && /https/.test(x.reason))).toBe(true);
      expect(r.getTools().some((t) => t.source === "integration:redirected")).toBe(false);
      expect(r.getSnapshot().sources.find((s) => s.source === "integration:redirected")?.state).toBe("error");
      expect(redir.targetHits).toEqual([]);
      // The parent itself behind a redirect: the catalog fetch fails (transient), nothing reaches the target.
      const viaRedirect = new LiveToolRegistry({ parent: { baseUrl: redir.url.replace(/\/mcp$/, ""), credential: () => parent.key.key, allowInsecureLocalhost: true }, pollIntervalMs: 60_000 });
      registries.push(viaRedirect);
      await viaRedirect.start();
      expect(viaRedirect.getSnapshot().catalog.state).toBe("transient_error");
      expect(redir.targetHits).toEqual([]);
      await evil.close();
    } finally {
      parent.unpublish("redirected");
      parent.unpublish("plainhttp");
      await redir.close();
    }
  });
});
