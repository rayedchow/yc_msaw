/**
 * Pi adapter in a REAL @earendil-works/pi-coding-agent 1.3 session (createAgentSession + ExtensionAPI), with Pi's
 * built-in FAUX provider as a SCRIPTED model (no LLM; deterministic tool calls) and the real loopback MCP fixtures
 * (real parent app; SIMULATED upstream children). The live Fireworks run is scripts/sdk-live-tools-pi-live.ts.
 *
 * Checks in ONE session: tools added / changed / removed without restart; each model request sees the tool set
 * applied at the last safe boundary; a same-name change in the middle of a turn is refused (tool_changed) and the next
 * request in the same prompt carries the new schema; host tools untouched; user-disabled tools stay disabled across
 * updates, absences and reloads; extension re-binding into a new session registers everything again.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveToolRegistry } from "../src/sdk/live/index.js";
import { createPiLiveTools, type PiLiveTools } from "../src/sdk/live/pi.js";
import { echoTool, LoopbackParent, type SimTool, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}

const parent = new LoopbackParent();
let delta: SimulatedChild;
let epsilon: SimulatedChild;
let registry: LiveToolRegistry;
let live: PiLiveTools;
let session: AgentSession;
let dir: string;
const faux = fauxProvider({ models: [{ id: "scripted-faux" }] });
/** Tools (name -> parameters) the model was given, per model request. */
const requests: Array<Map<string, unknown>> = [];
const toolResults: Array<{ name: string; text: string; isError: boolean }> = [];

const deltaV1: SimTool = echoTool("echo");
const deltaV2: SimTool = {
  tool: { name: "echo", description: "Echo v2 (requires loud).", inputSchema: { type: "object", properties: { message: { type: "string" }, loud: { type: "boolean" } }, required: ["message", "loud"] }, annotations: { readOnlyHint: true } },
  handler: (a) => ({ content: [{ type: "text", text: `ECHO:${String(a.message).toUpperCase()}` }] }),
};

/** Scripted step: record the tools this request carries, then answer. */
const step = (answer: (tools: Map<string, unknown>) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>): FauxResponseFactory => async (context) => {
  const tools = new Map(getCurrentTools(context.messages).map((t) => [t.name, t.parameters as unknown]));
  requests.push(tools);
  return answer(tools);
};
const callTool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);

async function newSession(extension: ExtensionFactory, cwd: string): Promise<AgentSession> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.provider.id, "faux-not-a-secret").catch(() => undefined);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Scripted test agent.", extensionFactories: [extension] });
  await resourceLoader.reload();
  const hostTool = defineTool({
    name: "host_note",
    label: "Host note",
    description: "An unrelated host tool that must be left alone.",
    parameters: Type.Object({ text: Type.String() }),
    execute: async () => ({ content: [{ type: "text" as const, text: "noted" }], details: undefined }),
  });
  const { session: s } = await createAgentSession({ cwd, agentDir: cwd, model: faux.getModel() as never, modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager, customTools: [hostTool], noTools: "builtin" });
  s.subscribe((e) => {
    if (e.type === "tool_execution_end") {
      const r = e.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
      toolResults.push({ name: e.toolName, text: (r?.content ?? []).map((c) => c.text ?? "").join(""), isError: e.isError === true || r?.isError === true });
    }
  });
  await s.bindExtensions({});
  return s;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "procmem-live-pi-"));
  await parent.start();
  delta = await parent.child("delta", [deltaV1]);
  parent.publish(delta);
  registry = new LiveToolRegistry({ parent: { baseUrl: parent.baseUrl, credential: () => parent.key.key, allowInsecureLocalhost: true }, pollIntervalMs: 60_000, listChangedDebounceMs: 20, sourceRetryMs: 0 });
  await registry.start();
  live = createPiLiveTools(registry);
  session = await newSession(live.extension, dir);
}, 60_000);

afterAll(async () => {
  live?.dispose();
  session?.dispose();
  await registry?.dispose();
  await delta?.close();
  await epsilon?.close();
  await parent.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Pi live tools in one session (scripted faux model)", () => {
  it("registers memory + integration tools at session start next to the host tool", () => {
    const active = session.getActiveToolNames();
    expect(active).toContain("host_note");
    expect(active).toContain("memory__open_memory");
    expect(active).toContain("integration__delta__echo");
  });

  it("the model calls a live integration tool through Pi", async () => {
    faux.setResponses([step(() => callTool("integration__delta__echo", { message: "one" })), step(() => done())]);
    await session.prompt("call echo");
    expect(requests.at(-2)!.has("integration__delta__echo")).toBe(true);
    expect(toolResults.at(-1)).toMatchObject({ name: "integration__delta__echo", text: "echo:one", isError: false });
  });

  it("a child added at runtime is visible to the next request in the same session and callable", async () => {
    epsilon = await parent.child("epsilon", [echoTool("ping")]);
    parent.publish(epsilon);
    await registry.refresh(); // session is idle: the adapter applies immediately
    expect(session.getActiveToolNames()).toContain("integration__epsilon__ping");
    faux.setResponses([step(() => callTool("integration__epsilon__ping", { message: "new" })), step(() => done())]);
    await session.prompt("call ping");
    expect(requests.at(-2)!.has("integration__epsilon__ping")).toBe(true);
    expect(toolResults.at(-1)).toMatchObject({ name: "integration__epsilon__ping", text: "echo:new", isError: false });
  });

  it("a same-name schema change DURING a turn is refused for the old call; the next request carries the new schema", async () => {
    faux.setResponses([
      step(async () => {
        // The registry changes while this model request is in flight.
        delta.setTools([deltaV2]);
        await delta.notifyListChanged();
        await until(() => (registry.getTools().find((t) => t.name === "integration__delta__echo")?.inputSchema as { required?: string[] }).required?.includes("loud") === true);
        return callTool("integration__delta__echo", { message: "stale" });
      }),
      step((tools) => {
        const params = tools.get("integration__delta__echo") as { required?: string[] };
        expect(params.required).toContain("loud");
        return callTool("integration__delta__echo", { message: "fresh", loud: true });
      }),
      step(() => done()),
    ]);
    const calls = delta.calls.get("echo") ?? 0;
    await session.prompt("echo twice");
    const [stale, fresh] = toolResults.slice(-2);
    expect(stale).toMatchObject({ name: "integration__delta__echo", isError: true });
    expect(stale!.text).toMatch(/changed/);
    expect(fresh).toMatchObject({ name: "integration__delta__echo", text: "ECHO:FRESH", isError: false });
    expect((delta.calls.get("echo") ?? 0) - calls).toBe(1); // the stale call never reached the child
    expect(session.getAllTools().filter((t) => t.name === "integration__delta__echo")).toHaveLength(1);
  });

  it("a removed tool leaves the active set and is not callable; a user-disabled tool stays disabled across updates, absence and re-add", async () => {
    parent.unpublish("epsilon");
    await registry.refresh();
    expect(session.getActiveToolNames()).not.toContain("integration__epsilon__ping");
    faux.setResponses([step(() => callTool("integration__epsilon__ping", { message: "gone" })), step(() => done())]);
    const pings = epsilon.calls.get("ping") ?? 0;
    await session.prompt("call removed ping");
    expect(requests.at(-2)!.has("integration__epsilon__ping")).toBe(false);
    expect(toolResults.at(-1)).toMatchObject({ name: "integration__epsilon__ping", isError: true });
    expect(epsilon.calls.get("ping") ?? 0).toBe(pings);

    // User disables delta echo.
    session.setActiveToolsByName(session.getActiveToolNames().filter((n) => n !== "integration__delta__echo"));
    delta.setTools([{ ...deltaV2, tool: { ...deltaV2.tool, description: "Echo v3." } }]);
    await delta.notifyListChanged();
    await until(() => registry.getTools().find((t) => t.name === "integration__delta__echo")?.description.includes("v3") === true);
    await sleep(50);
    expect(session.getActiveToolNames()).not.toContain("integration__delta__echo");
    // Absent, then back.
    const saved = parent.entries;
    parent.unpublish("delta");
    await registry.refresh();
    parent.entries = saved;
    await registry.refresh({ force: true });
    expect(registry.getTools().some((t) => t.name === "integration__delta__echo")).toBe(true);
    expect(session.getActiveToolNames()).not.toContain("integration__delta__echo");
    expect(session.getActiveToolNames()).toContain("host_note");
    // User re-enables: it stays enabled through the next update.
    session.setActiveToolsByName([...session.getActiveToolNames(), "integration__delta__echo"]);
    live.applyNow();
    delta.setTools([deltaV2]);
    await delta.notifyListChanged();
    await until(() => registry.getTools().find((t) => t.name === "integration__delta__echo")?.description.includes("v2") === true);
    await sleep(50);
    expect(session.getActiveToolNames()).toContain("integration__delta__echo");
  });

  it("re-binding the extension into a new session registers every live tool again", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "procmem-live-pi2-"));
    const s2 = await newSession(live.extension, dir2);
    try {
      expect(s2.getActiveToolNames()).toEqual(expect.arrayContaining(["host_note", "memory__open_memory", "integration__delta__echo"]));
      faux.setResponses([step(() => callTool("integration__delta__echo", { message: "rebound", loud: true })), step(() => done())]);
      await s2.prompt("echo after rebind");
      expect(toolResults.at(-1)).toMatchObject({ name: "integration__delta__echo", text: "ECHO:REBOUND", isError: false });
    } finally {
      s2.dispose();
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
