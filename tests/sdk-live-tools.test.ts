/**
 * Live tool exposure (src/sdk/live) over REAL MCP connections on loopback:
 *  - parent: the real procmem app (memory /mcp + /v1/integrations auth/routes); catalog CONTENTS are simulated;
 *  - children: SIMULATED upstream integration MCPs built on the official MCP server SDK, verifying real child tokens.
 * One registry (and its MCP client connections) is retained while children are added, changed and removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveToolRegistry, ToolBoundary, assignStableNames, hashedToolName, stableToolName, TOOL_NAME_RE, scrubSecrets, trustedUrl } from "../src/sdk/live/index.js";
import { scrubKnownDeep } from "../src/sdk/live/security.js";
import type { LiveToolResult, ToolsChange } from "../src/sdk/live/index.js";
import { echoTool, LoopbackParent, PNG_1PX, type SimTool, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}
const text = (r: LiveToolResult) => r.content.filter((c) => c.type === "text").map((c) => String(c.text)).join("\n");

describe("stable names", () => {
  it("are deterministic, provider-valid, namespaced and collision-free", () => {
    expect(stableToolName("memory", "open_memory")).toBe("memory__open_memory");
    expect(stableToolName("integration:notify-hub", "deliver")).toBe("integration__notify-hub__deliver");
    const weird = stableToolName("integration:notify-hub", "list.items/v2");
    expect(weird).toMatch(TOOL_NAME_RE);
    expect(weird).toBe(stableToolName("integration:notify-hub", "list.items/v2"));
    const long = stableToolName("integration:a-very-long-integration-slug-name-here", "x".repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(TOOL_NAME_RE);
    // Two upstream names that sanitize to the same string still get distinct names.
    const names = assignStableNames([
      { source: "integration:s", upstream: "a.b" },
      { source: "integration:s", upstream: "a/b" },
      { source: "integration:s", upstream: "a_b" },
    ]);
    expect(new Set(names).size).toBe(3);
    expect(names.every((n) => n && TOOL_NAME_RE.test(n))).toBe(true);
    // A plain name that equals another tool's hashed form is not silently merged.
    const clash = hashedToolName("integration:s", "a.b").slice("integration__s__".length);
    const resolved = assignStableNames([
      { source: "integration:s", upstream: "a.b" },
      { source: "integration:s", upstream: clash },
    ]);
    expect(new Set(resolved.filter(Boolean)).size).toBe(resolved.filter(Boolean).length);
  });

  it("URL policy: https only, loopback http only when explicitly allowed, no embedded credentials", () => {
    expect(() => trustedUrl("http://example.com/mcp", {}, "x")).toThrow(/https/);
    expect(() => trustedUrl("http://127.0.0.1:1/mcp", {}, "x")).toThrow(/allowInsecureLocalhost/);
    expect(() => trustedUrl("http://127.0.0.1:1/mcp", { allowInsecureLocalhost: true }, "x")).not.toThrow();
    expect(() => trustedUrl("http://evil.example:80/mcp", { allowInsecureLocalhost: true }, "x")).toThrow();
    expect(() => trustedUrl("https://u:p@example.com/mcp", {}, "x")).toThrow(/credentials/);
    expect(() => new LiveToolRegistry({ parent: { baseUrl: "http://example.com", credential: () => "k" } })).toThrow(/https/);
  });

  it("exact-value deep scrub: every value and key, no exempt field names; ordinary bytes untouched", () => {
    const secret = "pmk_SECRETsecretSECRET123";
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const input = {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: `AAAA${secret}AAAA`, mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x", blob: secret } },
      ],
      structuredContent: { blob: secret, data: `x ${secret}`, [`key_${secret}`]: 1, normal: "Bearer is a word; eyJ-like text stays" },
    };
    const out = scrubKnownDeep(input, [secret]);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.content[0]).toEqual({ type: "image", data: png, mimeType: "image/png" }); // ordinary image byte-identical
    expect(out.content[1]).toEqual({ type: "text", text: "[REDACTED image content: it contained a credential]" });
    expect((out.content[2] as { resource: { blob: string } }).resource.blob).toBe("[REDACTED]");
    expect(out.structuredContent.blob).toBe("[REDACTED]");
    expect(Object.keys(out.structuredContent)).toContain("key_[REDACTED]");
    expect(out.structuredContent.normal).toBe("Bearer is a word; eyJ-like text stays");
    const untouched = { content: [{ type: "image", data: png, mimeType: "image/png" }] };
    expect(scrubKnownDeep(untouched, [secret])).toBe(untouched); // same object when nothing matched
  });

  it("exact-value deep scrub keeps a parsed __proto__ key as own JSON data (never a prototype)", () => {
    const secret = "fixture_known_secret_123";
    const input = JSON.parse(`{"annotations":{"__proto__":{"readOnlyHint":true}},"description":"uses ${secret}"}`) as { annotations: Record<string, unknown>; description: string };
    const out = scrubKnownDeep(input, [secret]);
    expect(out).not.toBe(input); // the secret forced a clone
    expect(out.description).toBe("uses [REDACTED]");
    expect(Object.getPrototypeOf(out.annotations)).toBe(Object.prototype);
    expect(Object.hasOwn(out.annotations, "__proto__")).toBe(true);
    expect(Object.hasOwn(out.annotations, "readOnlyHint")).toBe(false);
    expect((out.annotations as { readOnlyHint?: unknown }).readOnlyHint).toBeUndefined();
    expect(JSON.stringify(out.annotations)).toBe('{"__proto__":{"readOnlyHint":true}}');
  });

  it("scrubs bearer tokens, JWTs and procmem keys", () => {
    const s = scrubSecrets("Authorization: Bearer abc.def.ghijklmnop pmk_abcdefghijkl eyJhbGciOi.eyJzdWIiOiJ4.c2lnbmF0dXJl secretvalue123", ["secretvalue123"]);
    expect(s).not.toMatch(/abc\.def|pmk_abcdefgh|eyJhbGciOi|secretvalue123/);
  });
});

describe("live registry over real loopback MCP", () => {
  const parent = new LoopbackParent();
  let alpha: SimulatedChild;
  let beta: SimulatedChild;
  let registry: LiveToolRegistry;
  const changes: ToolsChange[] = [];
  const logs: string[] = [];

  const alphaTools = (version: 1 | 2): SimTool[] => [
    echoTool("echo"),
    {
      tool: {
        name: "chart",
        title: "Render chart",
        description: "Return an image and structured stats (simulated).",
        inputSchema: { type: "object", properties: { label: { type: "string" } } },
        outputSchema: { type: "object", properties: { points: { type: "number" } }, required: ["points"] },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: { "example/vendor": { tier: "gold" } },
      },
      handler: () => ({ content: [{ type: "text", text: "chart ready" }, { type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "resource_link", uri: "file:///chart.png", name: "chart.png" }], structuredContent: { points: 3 } }),
    },
    {
      tool: { name: "fails", description: "Always reports a tool error (simulated).", inputSchema: { type: "object", properties: {} } },
      handler: () => ({ content: [{ type: "text", text: "upstream said no: quota exceeded" }], isError: true }),
    },
    version === 1
      ? { tool: { name: "lookup", description: "Look up an order (v1).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, handler: (a: Record<string, unknown>) => ({ content: [{ type: "text", text: `v1:${String(a.id)}` }] }) }
      : { tool: { name: "lookup", description: "Look up an order (v2: adds region).", inputSchema: { type: "object", properties: { id: { type: "string" }, region: { type: "string", enum: ["eu", "us"] } }, required: ["id", "region"] } }, handler: (a: Record<string, unknown>) => ({ content: [{ type: "text", text: `v2:${String(a.id)}@${String(a.region)}` }] }) },
  ];

  beforeAll(async () => {
    await parent.start();
    alpha = await parent.child("alpha", alphaTools(1));
    parent.publish(alpha);
    registry = new LiveToolRegistry({
      parent: { baseUrl: parent.baseUrl, credential: () => parent.key.key, allowInsecureLocalhost: true },
      pollIntervalMs: 60_000, // the test drives refresh() explicitly; polling is covered separately
      listChangedDebounceMs: 20,
      onLog: (e) => logs.push(e.message),
    });
    registry.onToolsChanged((c) => changes.push(c));
    await registry.start();
  }, 30_000);

  afterAll(async () => {
    await registry?.dispose();
    await alpha?.close();
    await beta?.close();
    await parent.close();
  });

  it("exposes memory and integration tools with full schemas, outputSchema, annotations and _meta", () => {
    const names = registry.getTools().map((t) => t.name);
    expect(names).toContain("memory__open_memory");
    expect(names).toContain("memory__read");
    expect(names).toContain("memory__write");
    expect(names).toEqual(expect.arrayContaining(["integration__alpha__echo", "integration__alpha__chart", "integration__alpha__fails", "integration__alpha__lookup"]));
    const chart = registry.getTools().find((t) => t.name === "integration__alpha__chart")!;
    expect(chart.outputSchema).toEqual({ type: "object", properties: { points: { type: "number" } }, required: ["points"] });
    expect(chart.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(chart.title).toBe("Render chart");
    expect(chart.upstream._meta).toEqual({ "example/vendor": { tier: "gold" } });
    expect(chart.integration).toMatchObject({ slug: "alpha", deploymentId: "d1" });
    expect(alpha.listCalls).toBeGreaterThanOrEqual(2); // 4 tools at 2 per page
  });

  it("memory tools work end to end: open_memory, read published wiki, write and read private scratch", async () => {
    const open = await registry.callTool("memory__open_memory", {});
    expect(open.isError).toBeFalsy();
    const workspaceId = (open.structuredContent as { workspaceId?: string } | undefined)?.workspaceId ?? /"workspaceId"\s*:\s*"([^"]+)"/.exec(text(open))?.[1] ?? /workspaceId[^A-Za-z0-9]+([A-Za-z0-9_-]+)/.exec(text(open))?.[1];
    expect(workspaceId).toBeTruthy();
    const page = await registry.callTool("memory__read", { workspaceId, path: "$KNOWLEDGE/deliveries.md" });
    expect(text(page)).toContain("Idempotency-Key");
    const w = await registry.callTool("memory__write", { workspaceId, path: "$WORK/scratch/notes.txt", content: "scratch ok" });
    expect(w.isError).toBeFalsy();
    const back = await registry.callTool("memory__read", { workspaceId, path: "$WORK/scratch/notes.txt" });
    expect(text(back)).toContain("scratch ok");
    const denied = await registry.callTool("memory__write", { workspaceId, path: "$KNOWLEDGE/index.md", content: "tamper" });
    expect(denied.isError).toBe(true);
  });

  it("passes through text, images, resource links, structuredContent and tool errors verbatim", async () => {
    const chart = await registry.callTool("integration__alpha__chart", { label: "x" });
    expect(chart.content).toEqual([{ type: "text", text: "chart ready" }, { type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "resource_link", uri: "file:///chart.png", name: "chart.png" }]);
    expect(chart.structuredContent).toEqual({ points: 3 });
    const fails = await registry.callTool("integration__alpha__fails", {});
    expect(fails.isError).toBe(true);
    expect(text(fails)).toBe("upstream said no: quota exceeded");
  });

  it("adds a new child on the same retained registry without restart", async () => {
    const before = changes.length;
    beta = await parent.child("beta", [echoTool("ping")]);
    parent.publish(beta);
    await registry.refresh();
    expect(registry.getTools().map((t) => t.name)).toContain("integration__beta__ping");
    const c = changes.slice(before).flatMap((x) => x.added.map((t) => t.name));
    expect(c).toContain("integration__beta__ping");
    expect(text(await registry.callTool("integration__beta__ping", { message: "hi" }))).toBe("echo:hi");
  });

  it("picks up a full schema change via notifications/tools/list_changed on the same connection", async () => {
    const sessionsBefore = alpha.sessionCount;
    alpha.setTools(alphaTools(2));
    await alpha.notifyListChanged();
    await until(() => (registry.getTools().find((t) => t.name === "integration__alpha__lookup")?.inputSchema as { required?: string[] }).required?.includes("region") === true);
    const lookup = registry.getTools().find((t) => t.name === "integration__alpha__lookup")!;
    expect(lookup.description).toContain("v2: adds region");
    expect(registry.getTools().filter((t) => t.name === "integration__alpha__lookup")).toHaveLength(1);
    expect(changes.at(-1)!.updated.map((t) => t.name)).toEqual(["integration__alpha__lookup"]);
    expect(alpha.sessionCount).toBe(sessionsBefore); // no reconnect needed
    expect(text(await registry.callTool("integration__alpha__lookup", { id: "o-1", region: "eu" }))).toBe("v2:o-1@eu");
  });

  it("re-lists an unchanged deployment periodically, catching silent schema changes", async () => {
    alpha.setTools([...alphaTools(2), echoTool("silent_add")]);
    parent.publish(alpha, { tools: [...alphaTools(2), echoTool("silent_add")].map((t) => t.tool.name) });
    // No notification. A refresh (as the poller does) re-lists every source even though the deployment is unchanged.
    const r = new LiveToolRegistry({ parent: { baseUrl: parent.baseUrl, credential: () => parent.key.key, allowInsecureLocalhost: true }, pollIntervalMs: 60_000, relistIntervalMs: 0 });
    try {
      await r.start();
      expect(r.getTools().map((t) => t.name)).toContain("integration__alpha__silent_add");
    } finally {
      await r.dispose();
    }
    await registry.refresh(); // relistIntervalMs defaults to the poll interval; force via a list_changed-equivalent:
    await alpha.notifyListChanged();
    await until(() => registry.getTools().some((t) => t.name === "integration__alpha__silent_add"));
  });

  it("only exposes tools attested by the catalog manifest", async () => {
    alpha.setTools([...alphaTools(2), echoTool("silent_add"), echoTool("unattested")]);
    await alpha.notifyListChanged();
    await until(() => registry.getSnapshot().sources.find((s) => s.source === "integration:alpha")?.skippedTools?.some((s) => s.name === "unattested") === true);
    expect(registry.getTools().map((t) => t.name)).not.toContain("integration__alpha__unattested");
  });

  it("reconnects on a deployment change and removes tools when a child leaves the catalog", async () => {
    parent.publish(beta, { deploymentId: "d2", commit: "c2" });
    await registry.refresh();
    expect(registry.getSnapshot().sources.find((s) => s.source === "integration:beta")).toMatchObject({ deploymentId: "d2", state: "ready" });
    const callsBefore = beta.calls.get("ping") ?? 0;
    parent.unpublish("beta");
    await registry.refresh();
    expect(registry.getTools().some((t) => t.source === "integration:beta")).toBe(false);
    expect(changes.at(-1)!.removed.map((t) => t.name)).toContain("integration__beta__ping");
    const r = await registry.callTool("integration__beta__ping", { message: "x" });
    expect(r.isError).toBe(true);
    expect(r._meta?.["procmem/error"]).toMatchObject({ code: "tool_not_found" });
    expect(beta.calls.get("ping") ?? 0).toBe(callsBefore);
  });

  it("ToolBoundary applies registry changes only at sync() and refuses tools outside the applied turn", async () => {
    const view = new ToolBoundary(registry);
    let pending = 0;
    view.onPending(() => pending++);
    beta.setTools([echoTool("ping")]);
    parent.publish(beta);
    await registry.refresh();
    expect(pending).toBeGreaterThan(0);
    expect(view.pending).toBe(true);
    expect(view.getTools().some((t) => t.name === "integration__beta__ping")).toBe(false); // mid-turn view unchanged
    expect((await view.callTool("integration__beta__ping", { message: "a" }))._meta?.["procmem/error"]).toMatchObject({ code: "tool_not_available" });
    const change = view.sync();
    expect(change?.added.map((t) => t.name)).toContain("integration__beta__ping");
    expect(text(await view.callTool("integration__beta__ping", { message: "a" }))).toBe("echo:a");
    // Removed in the registry but still in the applied view: refused by the registry (fail closed).
    parent.unpublish("beta");
    await registry.refresh();
    expect(view.getTools().some((t) => t.name === "integration__beta__ping")).toBe(true);
    expect((await view.callTool("integration__beta__ping", { message: "a" })).isError).toBe(true);
    view.dispose();
  });

  it("distinguishes a transient catalog failure (keep last good set) from a valid empty catalog (remove all)", async () => {
    const before = registry.getTools().filter((t) => t.source === "integration:alpha").length;
    expect(before).toBeGreaterThan(0);
    parent.failCatalog = 1;
    expect(await registry.refresh()).toBe(false);
    expect(registry.getSnapshot().catalog.state).toBe("transient_error");
    expect(registry.getTools().filter((t) => t.source === "integration:alpha").length).toBe(before);
    const saved = parent.entries;
    parent.entries = [];
    expect(await registry.refresh()).toBe(true);
    expect(registry.getTools().some((t) => t.source !== "memory")).toBe(false);
    expect(registry.getTools().some((t) => t.source === "memory")).toBe(true);
    parent.entries = saved;
    await registry.refresh();
    expect(registry.getTools().some((t) => t.source === "integration:alpha")).toBe(true);
  });

  it("never leaks credentials into tools, results, statuses or logs", () => {
    const blob = JSON.stringify({ tools: registry.getTools(), snapshot: registry.getSnapshot(), changes: changes.map((c) => c.next), logs });
    expect(blob).not.toContain(parent.key.key);
    for (const t of [...alpha.tokensSeen, ...beta.tokensSeen]) expect(blob).not.toContain(t);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });
});
