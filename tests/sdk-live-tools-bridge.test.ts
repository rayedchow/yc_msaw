/**
 * The SDK-owned stdio MCP bridge (`procmem-live-mcp`, src/sdk/live/bridge-cli.ts) spawned as a real child process and
 * driven by the official MCP client over stdio. ONE client initialization; children are added, changed and removed
 * (real parent app on loopback; SIMULATED upstream children) and the client sees it via notifications/tools/list_changed
 * + tools/list on the same connection. Also: fixed fallback tools, stale-schema refusal, stdout carries only protocol,
 * no credentials in stderr, credentials never accepted as arguments.
 */
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echoTool, LoopbackParent, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(25);
  }
}
type Res = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> };
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("");
const code = (r: Res) => (r._meta?.["procmem/error"] as { code?: string } | undefined)?.code;

const parent = new LoopbackParent();
let zeta: SimulatedChild;
let eta: SimulatedChild;
let client: Client;
let transport: StdioClientTransport;
let notifications = 0;
let stderr = "";
const CLI = ["--import", "tsx", "src/sdk/live/bridge-cli.ts"];

async function names(): Promise<string[]> {
  return (await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.map((t) => t.name);
}
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<Res>;

beforeAll(async () => {
  await parent.start();
  zeta = await parent.child("zeta", [echoTool("echo")]);
  parent.publish(zeta);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: CLI,
    cwd: process.cwd(),
    env: { ...getDefaultEnvironment(), PROCMEM_BASE_URL: parent.baseUrl, PROCMEM_API_KEY: parent.key.key, PROCMEM_ALLOW_INSECURE_LOCALHOST: "1", PROCMEM_POLL_MS: "1000" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  client = new Client({ name: "bridge-test", version: "1.0.0" });
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications++;
  });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await zeta?.close();
  await eta?.close();
  await parent.close();
});

describe("procmem-live-mcp stdio bridge", () => {
  it("serves the fallback pair immediately and announces discovered tools with list_changed", async () => {
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await until(async () => (await names()).includes("integration__zeta__echo"));
    const n = await names();
    expect(n).toEqual(expect.arrayContaining(["procmem_list_live_tools", "procmem_call_live_tool", "memory__open_memory", "memory__read", "integration__zeta__echo"]));
    expect(notifications).toBeGreaterThanOrEqual(1);
    const echo = (await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.find((t) => t.name === "integration__zeta__echo")!;
    expect(echo.annotations).toEqual({ readOnlyHint: true });
    expect((echo._meta as Record<string, unknown>)["procmem/upstreamName"]).toBe("echo");
    expect(text(await call("integration__zeta__echo", { message: "hi" }))).toBe("echo:hi");
  });

  it("memory tools work through the bridge", async () => {
    const open = await call("memory__open_memory", {});
    expect(open.isError).toBeFalsy();
  });

  it("adds a child on the same connection (no reinitialize)", async () => {
    const before = notifications;
    eta = await parent.child("eta", [echoTool("ping")]);
    parent.publish(eta);
    await until(() => notifications > before);
    expect(await names()).toContain("integration__eta__ping");
    expect(text(await call("integration__eta__ping", { message: "new" }))).toBe("echo:new");
  });

  it("refuses a call built for a changed schema until the client lists again", async () => {
    const before = notifications;
    zeta.setTools([{ ...echoTool("echo"), tool: { ...echoTool("echo").tool, description: "v2", inputSchema: { type: "object", properties: { message: { type: "string" }, n: { type: "number" } }, required: ["message", "n"] } } }]);
    await zeta.notifyListChanged();
    await until(() => notifications > before);
    const calls = zeta.calls.get("echo") ?? 0;
    const stale = await call("integration__zeta__echo", { message: "old" });
    expect(code(stale)).toBe("tool_changed");
    expect(zeta.calls.get("echo") ?? 0).toBe(calls);
    const echo = (await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.find((t) => t.name === "integration__zeta__echo")!;
    expect((echo.inputSchema as { required?: string[] }).required).toContain("n");
    expect(text(await call("integration__zeta__echo", { message: "fresh", n: 1 }))).toBe("echo:fresh");
  });

  it("fallback tools reach current tools for clients that ignore list_changed", async () => {
    const listed = await call("procmem_list_live_tools", { source: "eta" });
    const sc = listed.structuredContent as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(sc.tools.map((t) => t.name)).toEqual(["integration__eta__ping"]);
    expect(text(await call("procmem_call_live_tool", { name: "integration__eta__ping", arguments: { message: "via-fallback" } }))).toBe("echo:via-fallback");
  });

  it("removes a child: list_changed, gone from tools/list, calls refused", async () => {
    const before = notifications;
    parent.unpublish("eta");
    await until(() => notifications > before);
    expect(await names()).not.toContain("integration__eta__ping");
    const pings = eta.calls.get("ping") ?? 0;
    expect(code(await call("integration__eta__ping", { message: "x" }))).toBe("tool_not_found");
    expect(code(await call("procmem_call_live_tool", { name: "integration__eta__ping", arguments: { message: "x" } }))).toBe("tool_not_found");
    expect(eta.calls.get("ping") ?? 0).toBe(pings);
  });

  it("keeps credentials out of stderr diagnostics", () => {
    expect(stderr).not.toContain(parent.key.key);
    expect(stderr).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  it("refuses command-line arguments (credentials only via environment) and writes nothing to stdout", () => {
    const r = spawnSync(process.execPath, [...CLI, "--api-key", "pmk_should_never_be_an_arg"], { cwd: process.cwd(), env: { ...process.env, PROCMEM_BASE_URL: "https://example.invalid", PROCMEM_API_KEY: "x" }, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/environment variables/);
    expect(r.stderr).not.toContain("pmk_should_never_be_an_arg");
    const insecure = spawnSync(process.execPath, CLI, { cwd: process.cwd(), env: { ...process.env, PROCMEM_BASE_URL: "http://example.com", PROCMEM_API_KEY: "x" }, encoding: "utf8", timeout: 30_000 });
    expect(insecure.status).toBe(2);
    expect(insecure.stderr).toMatch(/https/);
    expect(insecure.stdout).toBe("");
  });
});
